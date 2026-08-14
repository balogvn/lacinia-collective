/**
 * Headless adversarial verification of the time-credit ledger (Task 3).
 *
 * The property that matters most is ZERO SUM. Under mutual credit every credit
 * is someone else's debit, so the total across all balances must be exactly
 * zero at all times. If that ever drifts, credits have been created from
 * nothing — the one failure a currency cannot recover from, and one that would
 * be invisible until the economy was already broken.
 *
 *   npm run verify:ledger
 */

import {
  proposeSettlement,
  parseProposal,
  confirmSettlement,
  parseConfirmation,
  completeSettlement,
  reverifyEntry,
  listingRefFor,
  isValidAmount,
  SettlementReject,
  PROPOSAL_FRESHNESS_MS,
  type SettlementProposal,
} from '../src/lib/ledger/entry'
import {
  computeBalances,
  lookupBalance,
  checkSolvency,
  auditZeroSum,
  formatCredits,
  emptyBalance,
} from '../src/lib/ledger/balance'
import { createSignedOp, verifySignedOp, OpRejectReason } from '../src/lib/sync/ops'
import { createBundle, verifyBundle } from '../src/lib/sync/bundle'
import { mergeOps, InMemoryMergeStore } from '../src/lib/sync/merge'
import { generateEphemeralKeyPair, type KeyPair } from '../src/lib/crypto/keys'
import { estimateQRVersion } from '../src/lib/qr/render'
import { unwrapFromQR, toBase64Url } from '../src/lib/codec'
import {
  TrustTier,
  CREDIT_LIMIT,
  MAX_ENTRY_CREDITS,
  type LedgerEntry,
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

const clock = createClock('ledgertest')
const adaeze = generateEphemeralKeyPair() // provider
const bilkisu = generateEphemeralKeyPair() // payer
const mallory = generateEphemeralKeyPair()
const chidi = generateEphemeralKeyPair()

/** Runs the full two-scan handshake and returns the completed entry. */
function settle(
  provider: KeyPair,
  payer: KeyPair,
  amount: number,
  opts: { listingId?: string; now?: number } = {},
): LedgerEntry {
  const { proposal, encoded } = proposeSettlement(provider, {
    payerPub: payer.pubKeyId,
    amount,
    listingId: opts.listingId ?? null,
    ...(opts.now ? { now: opts.now } : {}),
  })
  const parsed = parseProposal(encoded.qr, opts.now ? { now: opts.now } : {})
  if (!parsed.ok) throw new Error(`fixture proposal failed: ${parsed.reason}`)

  const { encoded: confirmEncoded } = confirmSettlement(payer, parsed.value)
  const confirmation = parseConfirmation(confirmEncoded.qr)
  if (!confirmation.ok) throw new Error('fixture confirmation failed')

  const completed = completeSettlement(confirmation.value, [proposal])
  if (!completed.ok) throw new Error(`fixture completion failed: ${completed.reason}`)
  return { ...completed.value, hlc: hlcNow(clock) }
}

const flatTier = () => TrustTier.Neighbour

/* ─────────────────── 1. the handshake ─────────────────── */

section('1. Settlement handshake — the honest path')

let sampleProposal: SettlementProposal
let sampleEntry: LedgerEntry

{
  const { proposal, encoded } = proposeSettlement(adaeze, {
    payerPub: bilkisu.pubKeyId,
    amount: 60,
    listingId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  })
  sampleProposal = proposal

  check('proposal encodes', encoded.bytes.length === 158, `${encoded.bytes.length} bytes`)
  const pv = estimateQRVersion(encoded.qr.length)
  check(
    'proposal QR stays scannable',
    encoded.qr.length < 270 && pv.version <= 12,
    `${encoded.qr.length} chars → QR v${pv.version}`,
  )

  const parsed = parseProposal(encoded.qr)
  check('payer parses the proposal', parsed.ok)
  if (!parsed.ok) throw new Error('handshake broken')
  check('amount survives the wire', parsed.value.amount === 60)
  check('listing reference survives', parsed.value.listingRef === 'a1b2c3d4e5f60718')

  const { entry, encoded: confirmEncoded } = confirmSettlement(bilkisu, parsed.value)
  const cv = estimateQRVersion(confirmEncoded.qr.length)
  check(
    'confirmation QR is much smaller than the proposal',
    confirmEncoded.bytes.length === 76 && cv.version <= 8,
    `${confirmEncoded.bytes.length} bytes → ${confirmEncoded.qr.length} chars → QR v${cv.version}`,
  )

  const confirmation = parseConfirmation(confirmEncoded.qr)
  check('provider parses the confirmation', confirmation.ok)
  if (!confirmation.ok) throw new Error('handshake broken')

  const completed = completeSettlement(confirmation.value, [proposal])
  check('provider completes the entry', completed.ok)
  if (!completed.ok) throw new Error('handshake broken')

  sampleEntry = { ...completed.value, hlc: hlcNow(clock) }
  check('both parties derive the same entry id', completed.value.id === entry.id, entry.id.slice(0, 16))
  check('completed entry re-verifies', reverifyEntry(sampleEntry))
  check(
    'entry carries two distinct signatures',
    sampleEntry.fromSig !== sampleEntry.toSig &&
      sampleEntry.fromSig.length > 0 &&
      sampleEntry.toSig.length > 0,
  )
}

/* ─────────────────── 2. attacks ─────────────────── */

section('2. Attacks — an entry with one signature is not an entry')
{
  // ATTACK: Mallory invents an exchange where Bilkisu pays her, forging the
  // payer's half. She controls only her own key.
  const { proposal } = proposeSettlement(mallory, { payerPub: bilkisu.pubKeyId, amount: 500 })
  const { encoded } = confirmSettlement(mallory, {
    ...proposal,
    fromPub: mallory.pubKeyId, // she can only sign as herself
  })
  const confirmation = parseConfirmation(encoded.qr)
  const completed = confirmation.ok
    ? completeSettlement(confirmation.value, [proposal])
    : { ok: false as const, reason: SettlementReject.Malformed }
  check(
    'a payer signature from the wrong key is refused',
    !completed.ok && completed.reason === SettlementReject.BadSignature,
    !completed.ok ? completed.reason : 'ACCEPTED — CRITICAL',
  )

  // ATTACK: replay a confirmation from one exchange into another.
  const otherExchange = proposeSettlement(adaeze, { payerPub: bilkisu.pubKeyId, amount: 30 })
  const parsedOther = parseProposal(otherExchange.encoded.qr)
  if (!parsedOther.ok) throw new Error('fixture failed')
  const otherConfirm = confirmSettlement(bilkisu, parsedOther.value)
  const otherParsed = parseConfirmation(otherConfirm.encoded.qr)
  if (!otherParsed.ok) throw new Error('fixture failed')

  const replayed = completeSettlement(otherParsed.value, [sampleProposal])
  check(
    'a confirmation cannot be replayed against another offer',
    !replayed.ok && replayed.reason === SettlementReject.NoPendingProposal,
    !replayed.ok ? replayed.reason : 'ACCEPTED — CRITICAL',
  )

  // ATTACK: tamper with the amount in a stored row, leaving signatures intact.
  check(
    'amount rewritten in IndexedDB is caught',
    !reverifyEntry({ ...sampleEntry, amount: 6000 }),
    'columns are a cache; the bytes are the truth',
  )
  check('payer swapped in IndexedDB is caught', !reverifyEntry({ ...sampleEntry, fromPub: mallory.pubKeyId }))
  check('provider swapped in IndexedDB is caught', !reverifyEntry({ ...sampleEntry, toPub: mallory.pubKeyId }))
  check('id rewritten in IndexedDB is caught', !reverifyEntry({ ...sampleEntry, id: 'deadbeef' }))
  check(
    'a single-signature entry is caught',
    !reverifyEntry({ ...sampleEntry, fromSig: sampleEntry.toSig }),
  )

  // Self-payment would let anyone mint their own credits.
  let selfThrew = false
  try {
    proposeSettlement(adaeze, { payerPub: adaeze.pubKeyId, amount: 60 })
  } catch {
    selfThrew = true
  }
  check('self-payment refused at proposal time', selfThrew)

  // Amount validation.
  check('zero is not a valid amount', !isValidAmount(0))
  check('negative is not a valid amount', !isValidAmount(-60))
  check('fractional is not a valid amount', !isValidAmount(1.5))
  check(`above ${MAX_ENTRY_CREDITS} is refused`, !isValidAmount(MAX_ENTRY_CREDITS + 1))
  check('a normal hour is valid', isValidAmount(60))

  // Field cases.
  const stale = proposeSettlement(adaeze, {
    payerPub: bilkisu.pubKeyId,
    amount: 60,
    now: Date.now() - PROPOSAL_FRESHNESS_MS - 60_000,
  })
  const staleParsed = parseProposal(stale.encoded.qr)
  check(
    'a stale proposal is refused',
    !staleParsed.ok && staleParsed.reason === SettlementReject.StaleProposal,
  )

  const future = proposeSettlement(adaeze, {
    payerPub: bilkisu.pubKeyId,
    amount: 60,
    now: Date.now() + 86_400_000,
  })
  check(
    'a future-dated proposal is refused',
    !parseProposal(future.encoded.qr).ok,
    'other phone has a bad clock',
  )

  check('garbage is refused cleanly', !parseProposal('hello world').ok)
  check(
    'a voucher QR is not mistaken for a settlement',
    (() => {
      const r = parseProposal(toBase64Url(unwrapFromQR(sampleProposal.signedBytes)))
      return !r.ok
    })(),
  )
}

/* ─────────────────── 3. zero sum ─────────────────── */

section('3. Zero sum — credits cannot be created from nothing')
{
  const entries = [
    settle(adaeze, bilkisu, 60),
    settle(bilkisu, chidi, 90),
    settle(chidi, adaeze, 30),
    settle(adaeze, chidi, 45),
  ]

  const balances = computeBalances(entries, flatTier, adaeze.pubKeyId)
  const audit = auditZeroSum(balances)
  check('all balances sum to exactly zero', audit.ok, `total ${audit.total}`)

  const a = lookupBalance(balances, adaeze.pubKeyId, TrustTier.Neighbour, true)
  const b = lookupBalance(balances, bilkisu.pubKeyId, TrustTier.Neighbour)
  const c = lookupBalance(balances, chidi.pubKeyId, TrustTier.Neighbour)

  // settle(provider, payer, amount): the provider is credited, the payer debited.
  //   1. adaeze ← bilkisu  60
  //   2. bilkisu ← chidi   90
  //   3. chidi   ← adaeze  30
  //   4. adaeze  ← chidi   45
  // adaeze:  +60 −30 +45 = +75
  check('provider balance is correct', a.balance === 75, `${a.balance}`)
  // bilkisu: −60 +90       = +30
  check('mixed balance is correct', b.balance === 30, `${b.balance}`)
  // chidi:   −90 +30 −45   = −105
  check('debtor balance is correct', c.balance === -105, `${c.balance}`)
  check('the three balances cancel', a.balance + b.balance + c.balance === 0)

  // The same entries arriving from both parties plus relays must count once.
  const duplicated = [...entries, ...entries, ...entries]
  const dedup = computeBalances(duplicated, flatTier, adaeze.pubKeyId)
  check(
    'duplicate entries are counted once',
    lookupBalance(dedup, adaeze.pubKeyId, TrustTier.Neighbour).balance === 75,
    'content-addressed dedupe',
  )
  check('zero sum holds after duplication', auditZeroSum(dedup).ok)

  // Order independence — two devices must agree without communicating.
  const shuffled = [entries[2]!, entries[0]!, entries[3]!, entries[1]!]
  const reordered = computeBalances(shuffled, flatTier, adaeze.pubKeyId)
  check(
    'balances are order-independent',
    lookupBalance(reordered, chidi.pubKeyId, TrustTier.Neighbour).balance === c.balance,
    'devices converge offline',
  )

  check(
    'confidence is reported honestly',
    a.confidence === 'own' && c.confidence === 'observed',
    `self=${a.confidence}, peer=${c.confidence}`,
  )
  const unknown = emptyBalance(mallory.pubKeyId, TrustTier.Observer)
  check('an unseen person reports no confidence', unknown.confidence === 'none')
}

/* ─────────────────── 4. credit limits ─────────────────── */

section('4. Credit limits — bounding the walk-away risk')
{
  const observer = emptyBalance(mallory.pubKeyId, TrustTier.Observer)
  check(
    'a new Observer may receive one hour of help',
    checkSolvency(observer, 60).ok,
    `limit ${CREDIT_LIMIT[TrustTier.Observer]} min`,
  )
  const over = checkSolvency(observer, 61)
  check('but not more than their limit', !over.ok, over.reason)
  const overYou = checkSolvency(observer, 61, 'you')
  check('the message addresses the right person', overYou.reason.includes('your') && over.reason.includes('their'), overYou.reason)
  check('the shortfall is stated precisely', over.shortfall === 1, `${over.shortfall} min short`)

  const neighbour = emptyBalance(bilkisu.pubKeyId, TrustTier.Neighbour)
  check(
    'a Neighbour may go a working day into debt',
    checkSolvency(neighbour, 480).ok,
    `limit ${CREDIT_LIMIT[TrustTier.Neighbour]} min`,
  )
  check('a Neighbour is still bounded', !checkSolvency(neighbour, 481).ok)

  // The limit follows trust, so earning a vouch raises the ceiling.
  check(
    'a stronger tier raises the ceiling',
    checkSolvency(emptyBalance(chidi.pubKeyId, TrustTier.Steward), 1920).ok &&
      !checkSolvency(emptyBalance(chidi.pubKeyId, TrustTier.Observer), 1920).ok,
    'standing is earned, not granted',
  )

  // Someone in credit can spend it plus their limit.
  const inCredit = { ...emptyBalance(adaeze.pubKeyId, TrustTier.Neighbour), balance: 200, available: 680 }
  check(
    'existing credit adds to spending room',
    checkSolvency(inCredit, 680).ok && !checkSolvency(inCredit, 681).ok,
    '200 earned + 480 limit',
  )

  // THE ATTACK the limit exists to bound: take help from many people and vanish.
  const victims = Array.from({ length: 20 }, () => generateEphemeralKeyPair())
  const spree: LedgerEntry[] = []
  let refused = 0
  for (const victim of victims) {
    const balances = computeBalances(spree, () => TrustTier.Observer, null)
    const malloryBalance = lookupBalance(balances, mallory.pubKeyId, TrustTier.Observer)
    if (!checkSolvency(malloryBalance, 60).ok) {
      refused++
      continue
    }
    spree.push(settle(victim, mallory, 60))
  }
  const final = lookupBalance(
    computeBalances(spree, () => TrustTier.Observer, null),
    mallory.pubKeyId,
    TrustTier.Observer,
  )
  check(
    'a walk-away spree is capped at the credit limit',
    final.balance >= -CREDIT_LIMIT[TrustTier.Observer] && refused === 19,
    `took ${spree.length} of 20 offers, ended at ${final.balance} min, ${refused} refused`,
  )
}

/* ─────────────────── 5. sync integration ─────────────────── */

section('5. Sync — entries cross an untrusted relay')
{
  const entry = settle(adaeze, bilkisu, 120)

  // A relay signs the op. Ledger entries are self-authenticating, so this must
  // be allowed — a balance is meaningless if third parties cannot see the
  // entries behind it.
  const relayed = createSignedOp(mallory, {
    hlc: entry.hlc,
    entity: 'ledger',
    entityId: entry.id,
    op: 'put',
    record: entry,
  })
  const verdict = verifySignedOp(relayed)
  check('a third party may relay a ledger entry', verdict.ok, 'relay ≠ authority')

  // …but an invented exchange inside a validly-signed relay op is caught.
  const invented = createSignedOp(mallory, {
    hlc: entry.hlc,
    entity: 'ledger',
    entityId: entry.id,
    op: 'put',
    record: { ...entry, amount: 9999 },
  })
  const inventedVerdict = verifySignedOp(invented)
  check(
    'an invented exchange in a relay op is caught',
    !inventedVerdict.ok && inventedVerdict.reason === OpRejectReason.InvalidEntry,
    !inventedVerdict.ok ? inventedVerdict.reason : 'ACCEPTED — CRITICAL',
  )

  // Bundle round trip.
  const bundle = createBundle(mallory, [relayed])
  const verified = verifyBundle(bundle)
  check('ledger entries survive a bundle round trip', verified.accepted.length === 1)

  // Merge is trivially convergent: entries are immutable, so re-merging in any
  // order must yield the identical set.
  const store = new InMemoryMergeStore()
  const asRecords = [{ op: relayed, record: JSON.parse(relayed.body) as unknown }]
  await mergeOps(asRecords, store)
  const again = await mergeOps(asRecords, store)
  check(
    're-merging a ledger entry is a no-op',
    again.applied === 0 && again.duplicates === 1,
    'immutable + content-addressed',
  )

  const merged = store.live<LedgerEntry>('ledger')
  check('merged entry still verifies', merged.length === 1 && reverifyEntry(merged[0]!))
}

/* ─────────────────── 6. presentation ─────────────────── */

section('6. Presentation — minutes people can read')
{
  check('minutes under an hour', formatCredits(45) === '45m', formatCredits(45))
  check('whole hours', formatCredits(120) === '2h', formatCredits(120))
  check('hours and minutes', formatCredits(90) === '1h 30m', formatCredits(90))
  check('debt uses a real minus sign', formatCredits(-90) === '−1h 30m', formatCredits(-90))
  check('zero', formatCredits(0) === '0')
  check(
    'a working day reads as a working day',
    formatCredits(CREDIT_LIMIT[TrustTier.Neighbour]) === '8h',
    formatCredits(CREDIT_LIMIT[TrustTier.Neighbour]),
  )
  check('a listing reference with no listing is all zeros', listingRefFor(null).every((b) => b === 0))
}

console.log(`\n${BOLD}${'─'.repeat(64)}${RESET}`)
if (failed === 0) {
  console.log(`${GREEN}${BOLD}  ${passed} checks passed.${RESET} Ledger holds.`)
} else {
  console.log(`${RED}${BOLD}  ${failed} failed${RESET}, ${passed} passed`)
  for (const f of failures) console.log(`   ${RED}·${RESET} ${f}`)
}
console.log(`${BOLD}${'─'.repeat(64)}${RESET}\n`)

process.exit(failed === 0 ? 0 : 1)
