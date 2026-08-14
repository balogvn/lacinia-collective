/**
 * Headless adversarial verification of the vouching engine.
 *
 * This is not a unit-test-coverage exercise. Every case below is an ATTACK or a
 * field failure mode, and each one asserts that the engine refuses it. If this
 * file passes, the protocol holds under the threat model documented in
 * protocol.ts and trust.ts.
 *
 *   npm run verify:protocol
 */

import {
  generateEphemeralKeyPair,
  generateRecoveryPhrase,
  keyPairFromPhrase,
  isValidRecoveryPhrase,
  fingerprint,
  sign,
  verify as edVerify,
  randomBytes,
  type KeyPair,
} from '../src/lib/crypto/keys'
import {
  toBase64Url,
  fromBase64Url,
  wrapForQR,
  ByteWriter,
  ByteReader,
} from '../src/lib/codec'
import { estimateQRVersion } from '../src/lib/qr/render'
import {
  createVouchRequest,
  parseVouchRequest,
  issueVoucher,
  parseVoucher,
  acceptVoucher,
  reverifyStoredVoucher,
  RejectReason,
  DEFAULT_VOUCHER_TTL_MS,
} from '../src/lib/vouch/protocol'
import { computeTrustGraph, lookupTrust } from '../src/lib/vouch/trust'
import { TrustTier, VoucherStatus, type TrustVoucher } from '../src/lib/db/schema'
import { createClock, now as hlcNow, receive as hlcReceive, compareHLC } from '../src/lib/hlc'
import { configureTelemetry } from '../src/lib/telemetry'

configureTelemetry({ mirrorToConsole: false })

/* ─────────────────────────── tiny harness ─────────────────────────── */

let passed = 0
let failed = 0
const failures: string[] = []

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ${GREEN}✓${RESET} ${name}${detail ? ` ${DIM}${detail}${RESET}` : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ${RED}✗ ${name}${RESET}${detail ? ` ${DIM}${detail}${RESET}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${BOLD}${title}${RESET}`)
}

/* ───────────────────────── 1. codec fuzz ───────────────────────── */

section('1. Byte codec — round-trip integrity')
{
  let allMatch = true
  for (let len = 0; len < 200; len++) {
    const original = randomBytes(len)
    const decoded = fromBase64Url(toBase64Url(original))
    if (decoded.length !== original.length || !original.every((b, i) => decoded[i] === b)) {
      allMatch = false
      console.log(`    mismatch at length ${len}`)
      break
    }
  }
  check('base64url round-trips for every length 0–199', allMatch)

  const w = new ByteWriter()
  const bigTimestamp = 4_102_444_800_000 // year 2100
  w.u8(255).u16(65535).u32(4294967295).u48(bigTimestamp).shortString('Adaeze Ọ.')
  const r = new ByteReader(w.finish())
  check('u8 round-trip', r.u8() === 255)
  check('u16 round-trip', r.u16() === 65535)
  check('u32 round-trip', r.u32() === 4294967295)
  check('u48 holds year-2100 timestamps', r.u48() === bigTimestamp, `${bigTimestamp}`)
  check('UTF-8 string round-trip', r.shortString() === 'Adaeze Ọ.')

  // Multi-byte truncation is the classic corruption bug: cutting a 3-byte
  // codepoint mid-sequence yields an undecodable payload on the far side.
  const w2 = new ByteWriter()
  w2.shortString('Ọ'.repeat(40), 10)
  const truncated = new ByteReader(w2.finish()).shortString()
  check(
    'truncation never splits a codepoint',
    !truncated.includes('�'),
    `→ "${truncated}" (${truncated.length} chars)`,
  )
}

/* ───────────────────────── 2. identity ───────────────────────── */

section('2. Identity — deterministic recovery')
{
  const phrase = generateRecoveryPhrase()
  check('generated phrase is 12 words', phrase.split(' ').length === 12)
  check('generated phrase validates', isValidRecoveryPhrase(phrase))

  const a = keyPairFromPhrase(phrase)
  const b = keyPairFromPhrase(phrase)
  check('same phrase → same key', a.pubKeyId === b.pubKeyId, a.pubKeyId.slice(0, 16) + '…')

  const messy = `  ${phrase.toUpperCase().replace(/ /g, '   ')}  `
  check('phrase survives case and whitespace mangling', keyPairFromPhrase(messy).pubKeyId === a.pubKeyId)

  check('different phrase → different key', keyPairFromPhrase(generateRecoveryPhrase()).pubKeyId !== a.pubKeyId)
  check('bad phrase rejected', !isValidRecoveryPhrase('not actually a valid bip39 phrase at all here'))

  const fp = fingerprint(a.publicKey)
  check('fingerprint is human-readable', /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(fp), fp)
  check('fingerprint excludes I/L/O/U', !/[ILOU]/.test(fp.replace(/-/g, '')))
}

/* ─────────────────── 3. happy path handshake ─────────────────── */

section('3. Vouching handshake — the honest path')

const adaeze = generateEphemeralKeyPair() // has trust
const bilkisu = generateEphemeralKeyPair() // new joiner
let voucherQR = ''
let bilkisuNonce = ''

{
  // Step 1 — Bilkisu mints a request on her phone.
  const { request, encoded } = createVouchRequest(bilkisu, 'Bilkisu A.')
  bilkisuNonce = request.nonce
  check('request encodes', encoded.bytes.length > 0, `${encoded.bytes.length} bytes`)
  check(
    'request QR fits a cheap camera',
    encoded.qr.length < 270,
    `${encoded.qr.length} chars → QR v${estimateQRVersion(encoded.qr.length).version}`,
  )

  // Step 2 — Adaeze scans it.
  const parsed = parseVouchRequest(encoded.qr)
  check('Adaeze parses the request', parsed.ok)
  if (!parsed.ok) throw new Error('handshake broken at step 2')
  check('proof-of-possession verified', parsed.value.subjectPub === bilkisu.pubKeyId)
  check('name survives the wire', parsed.value.displayName === 'Bilkisu A.')

  // Step 3 — Adaeze signs.
  const issued = issueVoucher(adaeze, parsed.value, TrustTier.Neighbour)
  voucherQR = issued.encoded.qr
  const vouVersion = estimateQRVersion(issued.encoded.qr.length)
  check(
    'voucher QR stays inside cheap-camera range',
    issued.encoded.qr.length < 270 && vouVersion.version <= 12,
    `${issued.encoded.qr.length} chars → QR v${vouVersion.version} · ${vouVersion.note}`,
  )
  check('voucher is exactly 153 bytes', issued.encoded.bytes.length === 153, `${issued.encoded.bytes.length}`)

  // Step 4 — Bilkisu scans it back.
  const back = parseVoucher(issued.encoded.qr)
  check('Bilkisu parses the voucher', back.ok)
  if (!back.ok) throw new Error('handshake broken at step 4')

  const accepted = acceptVoucher(back.value, bilkisu, bilkisuNonce, { deviceHlc: 'x' })
  check('voucher accepted and bound to Bilkisu', accepted.ok)
  check('nonce echoed correctly', back.value.nonce === bilkisuNonce)
  check('tier preserved', back.value.tier === TrustTier.Neighbour)

  // Content addressing — the same voucher via any route is one row.
  const again = parseVoucher(issued.encoded.qr)
  check('voucher id is deterministic (dedupes on merge)', again.ok && again.value.id === back.value.id)
}

/* ─────────────────── 4. attacks on the handshake ─────────────────── */

section('4. Attacks — every one of these must be refused')

const mallory = generateEphemeralKeyPair()

{
  // ATTACK: Mallory claims Bilkisu's public key in a request she cannot sign for.
  const forged = new ByteWriter(160)
  forged.u8(0x4c).u8(1).u8(1).u8(0)
  forged.fixed(bilkisu.publicKey, 32) // someone else's key…
  forged.fixed(randomBytes(8), 8)
  forged.u48(Date.now())
  forged.shortString('Bilkisu A.')
  const prefix = forged.snapshot()
  forged.fixed(sign(prefix, mallory.secretKey), 64) // …signed with Mallory's
  const result = parseVouchRequest(forged.finish())
  check(
    'impersonated request rejected (proof-of-possession)',
    !result.ok && result.reason === RejectReason.BadSignature,
    !result.ok ? result.reason : '',
  )
}

{
  // ATTACK: flip one bit of the tier field in a valid voucher.
  const bytes = fromBase64Url(voucherQR.slice(5))
  const tampered = new Uint8Array(bytes)
  tampered[88] = TrustTier.Anchor // tier byte — promote self to Anchor
  const result = parseVoucher(tampered)
  check(
    'tier tampering rejected',
    !result.ok && result.reason === RejectReason.BadSignature,
    !result.ok ? result.reason : 'ACCEPTED — CRITICAL',
  )
}

{
  // ATTACK: replay a voucher issued for Bilkisu into Mallory's device.
  const parsed = parseVoucher(voucherQR)
  if (parsed.ok) {
    const result = acceptVoucher(parsed.value, mallory, null, { deviceHlc: 'x' })
    check(
      'voucher for another subject rejected',
      !result.ok && result.reason === RejectReason.SubjectMismatch,
      !result.ok ? result.reason : 'ACCEPTED — CRITICAL',
    )
  }
}

{
  // ATTACK: replay an old voucher against a fresh request (screenshot attack).
  const parsed = parseVoucher(voucherQR)
  if (parsed.ok) {
    const freshNonce = toBase64Url(randomBytes(8))
    const result = acceptVoucher(parsed.value, bilkisu, freshNonce, { deviceHlc: 'x' })
    check(
      'replayed voucher rejected by nonce binding',
      !result.ok && result.reason === RejectReason.NonceMismatch,
      !result.ok ? result.reason : 'ACCEPTED — CRITICAL',
    )
  }
}

{
  // ATTACK: self-vouch to bootstrap out of nothing.
  const { request } = createVouchRequest(mallory, 'Mallory')
  let threw = false
  try {
    issueVoucher(mallory, request, TrustTier.Anchor)
  } catch {
    threw = true
  }
  check('self-vouch refused at issue time', threw)
}

{
  // FIELD CASE: expired voucher.
  const { request } = createVouchRequest(bilkisu, 'Bilkisu A.')
  const past = Date.now() - DEFAULT_VOUCHER_TTL_MS - 86_400_000
  const { encoded } = issueVoucher(adaeze, request, TrustTier.Neighbour, { now: past })
  const result = parseVoucher(encoded.qr)
  check(
    'expired voucher rejected',
    !result.ok && result.reason === RejectReason.Expired,
    !result.ok ? result.reason : '',
  )
}

{
  // FIELD CASE: the other phone's clock is a day fast.
  const { request } = createVouchRequest(bilkisu, 'Bilkisu A.')
  const { encoded } = issueVoucher(adaeze, request, TrustTier.Neighbour, {
    now: Date.now() + 86_400_000,
  })
  const result = parseVoucher(encoded.qr)
  check(
    'future-dated voucher rejected',
    !result.ok && result.reason === RejectReason.NotYetValid,
    !result.ok ? result.reason : '',
  )

  // …but small skew is tolerated, or nothing works in the real world.
  const { encoded: slight } = issueVoucher(adaeze, request, TrustTier.Neighbour, {
    now: Date.now() + 60_000,
  })
  check('1 minute of clock skew tolerated', parseVoucher(slight.qr).ok)
}

{
  // FIELD CASE: garbage in the camera.
  check('random string rejected cleanly', !parseVoucher('hello world').ok)
  check('empty string rejected cleanly', !parseVoucher('').ok)
  check('valid b64 of noise rejected cleanly', !parseVoucher(wrapForQR(randomBytes(153))).ok)
  check('wrong payload type reported precisely', (() => {
    const { encoded } = createVouchRequest(bilkisu, 'B')
    const r = parseVoucher(encoded.qr)
    return !r.ok && r.reason === RejectReason.WrongPayloadType
  })())
}

/* ─────────────────── 5. Sybil resistance ─────────────────── */

section('5. Sybil resistance — trust graph under attack')

function makeVoucher(issuer: string, subject: string, tier: TrustTier): TrustVoucher {
  return {
    id: `${issuer}->${subject}`,
    issuerPub: issuer,
    subjectPub: subject,
    tier,
    nonce: 'n',
    issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + DEFAULT_VOUCHER_TTL_MS,
    signature: 's',
    signedBytes: 's',
    status: VoucherStatus.Valid,
    receivedAt: Date.now(),
    direction: 'INBOUND',
    hlc: '0',
  }
}

{
  const ANCHOR = 'anchor-masjid-ikorodu'
  const vouchers: TrustVoucher[] = []

  // Honest community: anchor vouches 12 members; some cross-vouch.
  const honest = Array.from({ length: 12 }, (_, i) => `honest-${i}`)
  for (const h of honest) vouchers.push(makeVoucher(ANCHOR, h, TrustTier.Steward))
  vouchers.push(makeVoucher('honest-0', 'honest-1', TrustTier.Neighbour))
  vouchers.push(makeVoucher('honest-2', 'honest-1', TrustTier.Neighbour))

  // Attacker: honest-0 is compromised and vouches for 60 fake keys, which then
  // densely cross-vouch each other to try to bootstrap the clique.
  const fakes = Array.from({ length: 60 }, (_, i) => `sybil-${i}`)
  for (const f of fakes) vouchers.push(makeVoucher('honest-0', f, TrustTier.Steward))
  for (let i = 0; i < fakes.length; i++) {
    for (let j = 0; j < fakes.length; j++) {
      if (i !== j) vouchers.push(makeVoucher(fakes[i]!, fakes[j]!, TrustTier.Steward))
    }
  }

  const graph = computeTrustGraph(vouchers, [ANCHOR])
  check('graph converged', graph.converged, `${graph.rounds} rounds, ${graph.edgeCount} edges`)

  const anchorNode = lookupTrust(graph, ANCHOR)
  check('anchor holds score 1.0', anchorNode.score === 1 && anchorNode.tier === TrustTier.Anchor)

  const honestNode = lookupTrust(graph, 'honest-5')
  check(
    'honest member reaches Neighbour or better',
    honestNode.tier >= TrustTier.Neighbour,
    `score ${honestNode.score.toFixed(3)} → ${TrustTier[honestNode.tier]}`,
  )

  const sybilScores = fakes.map((f) => lookupTrust(graph, f).score)
  const worstSybil = Math.max(...sybilScores)
  const sybilTiers = fakes.map((f) => lookupTrust(graph, f).tier)
  const promotedSybils = sybilTiers.filter((t) => t >= TrustTier.Steward).length

  check(
    'no Sybil reaches Steward despite 3,540 mutual vouches',
    promotedSybils === 0,
    `best sybil score ${worstSybil.toFixed(3)}`,
  )
  check(
    'Sybil clique scores below the honest members it copied',
    worstSybil < honestNode.score,
    `${worstSybil.toFixed(3)} < ${honestNode.score.toFixed(3)}`,
  )

  // Mechanism 1 in isolation: same clique, but the mutual cross-vouches removed.
  // If layering works, they were contributing nothing, so scores must not move.
  const noCliqueEdges = vouchers.filter(
    (v) => !(v.issuerPub.startsWith('sybil') && v.subjectPub.startsWith('sybil')),
  )
  const withoutClique = computeTrustGraph(noCliqueEdges, [ANCHOR])
  check(
    'cross-vouching inside the clique buys exactly nothing',
    Math.abs(lookupTrust(withoutClique, 'sybil-0').score - lookupTrust(graph, 'sybil-0').score) < 1e-9,
    `${lookupTrust(withoutClique, 'sybil-0').score.toFixed(4)} either way`,
  )

  // Mechanism 2: spending capacity on 60 fakes must be worth less per-fake than
  // spending it on 5.
  const modest = [
    ...honest.map((h) => makeVoucher(ANCHOR, h, TrustTier.Steward)),
    ...Array.from({ length: 5 }, (_, i) => makeVoucher('honest-0', `few-${i}`, TrustTier.Steward)),
  ]
  const modestGraph = computeTrustGraph(modest, [ANCHOR])
  const perFakeWhenModest = lookupTrust(modestGraph, 'few-0').score
  const perFakeWhenGreedy = lookupTrust(graph, 'sybil-0').score
  check(
    'capacity constraint: 60 fakes are worth less each than 5',
    perFakeWhenGreedy < perFakeWhenModest,
    `${perFakeWhenGreedy.toFixed(3)} < ${perFakeWhenModest.toFixed(3)}`,
  )

  // Mechanism 4: a compromised Steward must not be able to mint more Stewards.
  check(
    'a Steward\'s vouch cannot itself confer Steward',
    lookupTrust(modestGraph, 'few-0').tier < TrustTier.Steward,
    `${TrustTier[lookupTrust(modestGraph, 'few-0').tier]}`,
  )
  check(
    'but an Anchor\'s vouch can',
    lookupTrust(graph, 'honest-3').tier >= TrustTier.Steward,
    `${TrustTier[lookupTrust(graph, 'honest-3').tier]}`,
  )

  // Tier ceiling: an unvouched key cannot confer standing.
  const ceiling = computeTrustGraph(
    [makeVoucher('nobody-at-all', 'aspirant', TrustTier.Anchor)],
    [ANCHOR],
  )
  check(
    'unvouched issuer confers nothing',
    lookupTrust(ceiling, 'aspirant').tier === TrustTier.Observer,
    `score ${lookupTrust(ceiling, 'aspirant').score.toFixed(3)}`,
  )
}

{
  // Determinism: two devices must agree, so shuffled input must not change output.
  const ANCHOR = 'anchor-x'
  const base = [
    makeVoucher(ANCHOR, 'a', TrustTier.Steward),
    makeVoucher(ANCHOR, 'b', TrustTier.Steward),
    makeVoucher('a', 'c', TrustTier.Neighbour),
    makeVoucher('b', 'c', TrustTier.Neighbour),
  ]
  const g1 = computeTrustGraph(base, [ANCHOR])
  const g2 = computeTrustGraph([...base].reverse(), [ANCHOR])
  check(
    'scoring is order-independent (devices agree offline)',
    lookupTrust(g1, 'c').score === lookupTrust(g2, 'c').score,
    `${lookupTrust(g1, 'c').score.toFixed(6)}`,
  )
}

/* ─────────────────── 6. stored-row integrity ─────────────────── */

section('6. Stored rows are not evidence')
{
  const { request } = createVouchRequest(bilkisu, 'Bilkisu A.')
  const { voucher } = issueVoucher(adaeze, request, TrustTier.Neighbour)
  const stored: TrustVoucher = {
    ...voucher,
    status: VoucherStatus.Valid,
    receivedAt: Date.now(),
    direction: 'INBOUND',
    hlc: '0',
  }
  check('honest stored row re-verifies', reverifyStoredVoucher(stored) === VoucherStatus.Valid)

  // ATTACK: edit IndexedDB directly to promote yourself to Anchor, leaving the
  // (still perfectly valid) signature untouched.
  check(
    'tier rewritten in IndexedDB is caught',
    reverifyStoredVoucher({ ...stored, tier: TrustTier.Anchor }) === VoucherStatus.Invalid,
  )
  check(
    'expiry extended in IndexedDB is caught',
    reverifyStoredVoucher({ ...stored, expiresAt: stored.expiresAt + 1e10 }) === VoucherStatus.Invalid,
  )
  check(
    'issuer swapped in IndexedDB is caught',
    reverifyStoredVoucher({ ...stored, issuerPub: mallory.pubKeyId }) === VoucherStatus.Invalid,
  )
  check(
    'id rewritten in IndexedDB is caught',
    reverifyStoredVoucher({ ...stored, id: 'deadbeef' }) === VoucherStatus.Invalid,
  )
  check(
    'truncated signedBytes is caught',
    reverifyStoredVoucher({ ...stored, signedBytes: stored.signedBytes.slice(0, 40) }) ===
      VoucherStatus.Invalid,
  )
}

/* ─────────────────── 7. clock behaviour ─────────────────── */

section('7. Hybrid logical clock')
{
  const clock = createClock('devA')
  const stamps = Array.from({ length: 5 }, () => hlcNow(clock, 1_700_000_000_000))
  check(
    'stamps within one millisecond stay ordered',
    stamps.every((s, i) => i === 0 || compareHLC(s, stamps[i - 1]!) > 0),
  )

  const local = createClock('devA')
  const remote = createClock('devB')
  const remoteStamp = hlcNow(remote, 1_700_000_500_000) // remote clock is ahead
  const merged = hlcReceive(local, remoteStamp, 1_700_000_000_000)
  check('receiving a future stamp advances the local clock', compareHLC(merged, remoteStamp) > 0)

  const skewed = createClock('devBroken')
  const wild = hlcNow(skewed, 4_000_000_000_000) // year 2096
  const sane = createClock('devSane')
  const afterWild = hlcReceive(sane, wild, 1_700_000_000_000)
  check('extreme skew is absorbed, not dropped', compareHLC(afterWild, wild) > 0)
}

/* ─────────────────────────── report ─────────────────────────── */

console.log(`\n${BOLD}${'─'.repeat(64)}${RESET}`)
if (failed === 0) {
  console.log(`${GREEN}${BOLD}  ${passed} checks passed.${RESET} Vouching engine holds.`)
} else {
  console.log(`${RED}${BOLD}  ${failed} failed${RESET}, ${passed} passed`)
  for (const f of failures) console.log(`   ${RED}·${RESET} ${f}`)
}
console.log(`${BOLD}${'─'.repeat(64)}${RESET}\n`)

process.exit(failed === 0 ? 0 : 1)
