/**
 * Headless adversarial verification of anchor governance.
 *
 * Anchors are the axioms of the trust graph, so the thing to prove is NEGATIVE:
 * that no combination of signed messages can change a device's anchor set on
 * its own. Every capture vector below produces evidence and nothing more.
 *
 *   npm run verify:anchors
 */

import {
  createAnchorAction,
  verifyAnchorAction,
  buildGovernanceView,
  applyRotation,
  applyRetirement,
  AnchorError,
} from '../src/lib/anchor/governance'
import { createSignedOp, verifySignedOp, OpRejectReason } from '../src/lib/sync/ops'
import { createBundle, verifyBundle } from '../src/lib/sync/bundle'
import { computeTrustGraph, lookupTrust } from '../src/lib/vouch/trust'
import { createVouchRequest, parseVouchRequest, issueVoucher } from '../src/lib/vouch/protocol'
import { generateEphemeralKeyPair, type KeyPair } from '../src/lib/crypto/keys'
import {
  AnchorActionKind,
  TrustTier,
  VoucherStatus,
  type AnchorAction,
  type TrustVoucher,
} from '../src/lib/db/schema'
import { createClock, now as hlcNow } from '../src/lib/hlc'
import { configureTelemetry } from '../src/lib/telemetry'

configureTelemetry({ mirrorToConsole: false })

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

const clock = createClock('anchortest')

const masjid = generateEphemeralKeyPair() // an anchor this device trusts
const market = generateEphemeralKeyPair() // a second trusted anchor
const parish = generateEphemeralKeyPair() // a candidate, not yet trusted
const mallory = generateEphemeralKeyPair() // no standing at all

const TRUSTED = [masjid.pubKeyId, market.pubKeyId]

const act = (
  by: KeyPair,
  kind: AnchorActionKind,
  targetPub?: string,
  note = '',
): AnchorAction => ({
  ...createAnchorAction(by, { kind, ...(targetPub ? { targetPub } : {}), note }),
  hlc: hlcNow(clock),
})

/* ─────────────────── 1. signatures ─────────────────── */

section('1. Actions are signed statements by the anchor itself')
{
  const a = act(masjid, AnchorActionKind.Endorse, parish.pubKeyId, 'St Peter, Ikorodu')
  check('an honest action verifies', verifyAnchorAction(a))
  check('re-attributing it to another anchor fails', !verifyAnchorAction({ ...a, anchorPub: mallory.pubKeyId }))
  check('swapping the target fails', !verifyAnchorAction({ ...a, targetPub: mallory.pubKeyId }))
  check('changing the kind fails', !verifyAnchorAction({ ...a, kind: AnchorActionKind.Retire }))
  check('editing the note fails', !verifyAnchorAction({ ...a, note: 'something else' }))
  check('rewriting the id fails', !verifyAnchorAction({ ...a, id: 'deadbeef' }))

  let selfEndorse = false
  try {
    createAnchorAction(masjid, { kind: AnchorActionKind.Endorse, targetPub: masjid.pubKeyId })
  } catch (e) {
    selfEndorse = e instanceof AnchorError
  }
  check('an anchor cannot endorse its own key', selfEndorse)

  let noTarget = false
  try {
    createAnchorAction(masjid, { kind: AnchorActionKind.Rotate })
  } catch (e) {
    noTarget = e instanceof AnchorError
  }
  check('a rotation without a target is refused', noTarget)
}

/* ─────────────────── 2. THE CAPTURE VECTORS ─────────────────── */

section('2. Nothing changes the anchor set on its own')
{
  // ATTACK: a key with no standing signs endorsements to inject its own
  // choices as candidate axioms. Everything it says must be ignored.
  const accomplice = generateEphemeralKeyPair()
  const selfPromotion = buildGovernanceView(TRUSTED, [
    act(mallory, AnchorActionKind.Endorse, accomplice.pubKeyId, 'my friend'),
    act(mallory, AnchorActionKind.Endorse, parish.pubKeyId, 'and this one'),
    act(accomplice, AnchorActionKind.Endorse, mallory.pubKeyId, 'vouching back'),
  ])
  check(
    'an untrusted key endorsing anyone is ignored entirely',
    selfPromotion.candidates.length === 0,
    'only trusted anchors are heard',
  )
  check(
    'two untrusted keys endorsing each other bootstrap nothing',
    selfPromotion.candidates.length === 0 && selfPromotion.rotations.length === 0,
    'no cartel can form from outside the set',
  )

  // ATTACK: a stolen anchor key signs a retirement to collapse the community.
  const stolen = buildGovernanceView(TRUSTED, [act(masjid, AnchorActionKind.Retire, undefined, 'goodbye')])
  check(
    'a retirement is surfaced, never applied',
    stolen.retirements.length === 1,
    'one signature must not be able to unroot a community',
  )
  check(
    'and the anchor set is untouched by building the view',
    TRUSTED.length === 2 && TRUSTED.includes(masjid.pubKeyId),
  )

  // ATTACK: a stolen key rotates the anchor to the attacker's key.
  const hijack = buildGovernanceView(TRUSTED, [
    act(masjid, AnchorActionKind.Rotate, mallory.pubKeyId, 'new committee'),
  ])
  check(
    'a rotation is surfaced for confirmation, never applied',
    hijack.rotations.length === 1 && hijack.rotations[0]!.to === mallory.pubKeyId,
  )

  // Endorsement by a genuinely trusted anchor is evidence — still not action.
  const endorsed = buildGovernanceView(TRUSTED, [
    act(masjid, AnchorActionKind.Endorse, parish.pubKeyId, 'St Peter'),
    act(market, AnchorActionKind.Endorse, parish.pubKeyId, 'known to us'),
  ])
  check(
    'endorsements from trusted anchors surface as a candidate',
    endorsed.candidates.length === 1 && endorsed.candidates[0]!.endorsedBy.length === 2,
    `${endorsed.candidates[0]?.endorsedBy.length} anchors recognise it`,
  )
  check(
    'the candidate is NOT in the anchor set',
    !TRUSTED.includes(parish.pubKeyId),
    'evidence, not authority',
  )
  check(
    'both notes are carried for the reader to weigh',
    endorsed.candidates[0]!.notes.length === 2,
  )

  // Already-trusted keys are not re-offered.
  const noise = buildGovernanceView(TRUSTED, [
    act(masjid, AnchorActionKind.Endorse, market.pubKeyId, 'already ours'),
  ])
  check('an already-trusted key is not offered again', noise.candidates.length === 0)

  // A forged action never reaches the view.
  const forged = { ...act(masjid, AnchorActionKind.Endorse, parish.pubKeyId), note: 'tampered' }
  const withForgery = buildGovernanceView(TRUSTED, [forged])
  check(
    'a tampered action is counted as rejected and dropped',
    withForgery.candidates.length === 0 && withForgery.rejected === 1,
  )
}

/* ─────────────────── 3. applying, when the owner chooses ─────────────────── */

section('3. Applying is the device owner’s act')
{
  const rotation = { from: masjid.pubKeyId, to: parish.pubKeyId }
  const rotated = applyRotation(TRUSTED, rotation)
  check('rotation replaces rather than adds', !rotated.includes(masjid.pubKeyId) && rotated.includes(parish.pubKeyId))
  check('the other anchor is untouched', rotated.includes(market.pubKeyId), `${rotated.length} anchors`)
  check('rotating twice is idempotent', applyRotation(rotated, rotation).length === rotated.length)

  const retired = applyRetirement(TRUSTED, masjid.pubKeyId)
  check('retirement removes exactly one', retired.length === 1 && retired[0] === market.pubKeyId)

  // A followed rotation stops being offered.
  const after = buildGovernanceView(rotated, [
    act(masjid, AnchorActionKind.Rotate, parish.pubKeyId, 'new committee'),
  ])
  check('a rotation already followed is no longer surfaced', after.rotations.length === 0)
}

/* ─────────────────── 4. effect on the trust graph ─────────────────── */

section('4. What accepting actually does to trust')
{
  function realVoucher(issuer: KeyPair, subject: KeyPair): TrustVoucher {
    const request = createVouchRequest(subject, 'Subject')
    const parsed = parseVouchRequest(request.encoded.qr)
    if (!parsed.ok) throw new Error('fixture failed')
    const { voucher } = issueVoucher(issuer, parsed.value, TrustTier.Steward)
    return {
      ...voucher,
      status: VoucherStatus.Valid,
      receivedAt: Date.now(),
      direction: 'INBOUND',
      hlc: hlcNow(clock),
    }
  }

  const member = generateEphemeralKeyPair()
  const vouchers = [realVoucher(masjid, member)]

  const before = computeTrustGraph(vouchers, [masjid.pubKeyId])
  check(
    'a member vouched by the anchor has standing',
    lookupTrust(before, member.pubKeyId).tier >= TrustTier.Neighbour,
    TrustTier[lookupTrust(before, member.pubKeyId).tier],
  )

  // Accepting a retirement removes the axiom — and everything it rooted.
  const afterRetire = computeTrustGraph(vouchers, applyRetirement([masjid.pubKeyId], masjid.pubKeyId))
  check(
    'accepting a retirement drops what that anchor rooted',
    lookupTrust(afterRetire, member.pubKeyId).tier === TrustTier.Observer,
    'exactly why it is never automatic',
  )

  // A rotation moves the axiom, and old vouches no longer root from it.
  const afterRotate = computeTrustGraph(
    vouchers,
    applyRotation([masjid.pubKeyId], { from: masjid.pubKeyId, to: parish.pubKeyId }),
  )
  check(
    'after rotation the old key no longer roots the graph',
    lookupTrust(afterRotate, member.pubKeyId).tier === TrustTier.Observer,
    'the community re-vouches under the new key',
  )
}

/* ─────────────────── 5. sync ─────────────────── */

section('5. Sync — actions cross an untrusted relay')
{
  const action = act(masjid, AnchorActionKind.Endorse, parish.pubKeyId, 'St Peter')
  const relay = generateEphemeralKeyPair()

  const relayed = createSignedOp(relay, {
    hlc: action.hlc,
    entity: 'anchorAction',
    entityId: action.id,
    op: 'put',
    record: action,
  })
  check('a third party may relay an anchor action', verifySignedOp(relayed).ok, 'rotations must propagate')

  const manufactured = createSignedOp(relay, {
    hlc: action.hlc,
    entity: 'anchorAction',
    entityId: action.id,
    op: 'put',
    record: { ...action, targetPub: mallory.pubKeyId },
  })
  const verdict = verifySignedOp(manufactured)
  check(
    'a manufactured endorsement inside a valid relay op is caught',
    !verdict.ok && verdict.reason === OpRejectReason.InvalidAttestation,
    !verdict.ok ? verdict.reason : 'ACCEPTED — CRITICAL',
  )

  check('it survives a bundle round trip', verifyBundle(createBundle(relay, [relayed])).accepted.length === 1)
}

console.log(`\n${BOLD}${'─'.repeat(64)}${RESET}`)
if (failed === 0) {
  console.log(`${GREEN}${BOLD}  ${passed} checks passed.${RESET} Anchor governance holds.`)
} else {
  console.log(`${RED}${BOLD}  ${failed} failed${RESET}, ${passed} passed`)
  for (const f of failures) console.log(`   ${RED}·${RESET} ${f}`)
}
console.log(`${BOLD}${'─'.repeat(64)}${RESET}\n`)

process.exit(failed === 0 ? 0 : 1)
