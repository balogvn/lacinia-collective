/**
 * Headless adversarial verification of the moderation layer.
 *
 * The claim this file has to prove is that MODERATION CANNOT BE WEAPONISED
 * BETWEEN BLOCS. In a tool built to bridge ethno-religious divides, the failure
 * mode is not a troll — it is one group mass-flagging the other group's
 * statements, which is indistinguishable from legitimate use if you only count
 * flags. So the central test has a whole bloc flag a rival statement in
 * concert, and fails if that statement is hidden from anyone.
 *
 * It also proves the second half: cross-group corroboration must still hide
 * genuinely abusive content, or the system is merely permissive rather than
 * principled.
 *
 *   npm run verify:moderation
 */

import { createFlag, verifyFlag, flagIdFor, flagWeight, dedupeFlags, FLAG_TIER_WEIGHT } from '../src/lib/moderate/flag'
import { buildPolicy, Visibility, isHidden, type PolicyPreset } from '../src/lib/moderate/policy'
import {
  createRevocation,
  verifyRevocation,
  applyRevocations,
  revocableVouchers,
  RevocationError,
} from '../src/lib/moderate/revoke'
import { createSignedOp, verifySignedOp, OpRejectReason } from '../src/lib/sync/ops'
import { createBundle, verifyBundle } from '../src/lib/sync/bundle'
import { computeTrustGraph, lookupTrust, type ParticipantPoint } from '../src/lib/vouch/trust'
import { createVouchRequest, parseVouchRequest, issueVoucher } from '../src/lib/vouch/protocol'
import { generateEphemeralKeyPair, type KeyPair } from '../src/lib/crypto/keys'
import {
  FlagReason,
  RevocationReason,
  TrustTier,
  VoucherStatus,
  type Flag,
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

const clock = createClock('modtest')

/* ─────────────────── fixtures: two blocs ─────────────────── */

const blocA: KeyPair[] = Array.from({ length: 12 }, () => generateEphemeralKeyPair())
const blocB: KeyPair[] = Array.from({ length: 8 }, () => generateEphemeralKeyPair())
const reader = blocA[0]!
const outsider = generateEphemeralKeyPair()

const participants: ParticipantPoint[] = [
  ...blocA.map((k, i) => ({ pubKey: k.pubKeyId, x: -1, y: i / 10, group: 0, votesCast: 6 })),
  ...blocB.map((k, i) => ({ pubKey: k.pubKeyId, x: 1, y: i / 10, group: 1, votesCast: 6 })),
]

/** Everyone is a Neighbour unless a test says otherwise. */
const flatTier = () => TrustTier.Neighbour

const TARGET_A = 'stmt-from-bloc-a'
const TARGET_B = 'stmt-from-bloc-b'
const AUTHOR_A = blocA[1]!.pubKeyId
const AUTHOR_B = blocB[1]!.pubKeyId

function flag(from: KeyPair, targetId: string, reason: FlagReason): Flag {
  return {
    ...createFlag(from, { targetId, targetEntity: 'statement', reason, conversationId: 'conv-1' }),
    hlc: hlcNow(clock),
  }
}

/* ─────────────────── 1. signatures ─────────────────── */

section('1. Flags are signed claims, not anonymous reports')
{
  const f = flag(blocA[2]!, TARGET_B, FlagReason.Abuse)
  check('an honest flag verifies', verifyFlag(f))
  check('the flag records who raised it', f.authorPub === blocA[2]!.pubKeyId)

  check('reason rewritten in IndexedDB is caught', !verifyFlag({ ...f, reason: FlagReason.Danger }))
  check('target rewritten in IndexedDB is caught', !verifyFlag({ ...f, targetId: 'something-else' }))
  check('flagger rewritten in IndexedDB is caught', !verifyFlag({ ...f, authorPub: outsider.pubKeyId }))
  check('id rewritten in IndexedDB is caught', !verifyFlag({ ...f, id: 'deadbeef' }))

  // One person cannot become three by re-flagging under different reasons.
  const again = flag(blocA[2]!, TARGET_B, FlagReason.Danger)
  check(
    're-flagging replaces rather than stacks',
    flagIdFor(blocA[2]!.pubKeyId, TARGET_B) === flagIdFor(blocA[2]!.pubKeyId, TARGET_B) &&
      again.targetId === f.targetId,
    'id derives from (flagger, target)',
  )

  // DOMAIN SEPARATION: a flag signature must not be replayable as a revocation.
  const voucher = realVoucher(blocA[3]!, blocB[3]!)
  const revocation = createRevocation(blocA[3]!, voucher, RevocationReason.Mistaken)
  check(
    'a flag signature cannot be replayed as a revocation',
    !verifyRevocation({ ...revocation, signature: f.signature, signedBytes: f.signedBytes }),
    'domain is inside the signed document',
  )
}

/* ─────────────────── 1b. THE DUPLICATE-FLAG AMPLIFIER ─────────────────── */

section('1b. One person cannot become a crowd by flagging twice')
{
  // A flag's id is the content address of its signed bytes, and those bytes
  // include `reason` and `createdAt`. So re-flagging the same item does NOT
  // update the first flag — it mints a second, equally valid one. Every count
  // downstream then reads one person as several.
  const attacker = blocA[0]!
  // Explicit timestamps: created back to back, both land in the same
  // millisecond and "most recent" stops being well defined — which the suite
  // caught by failing intermittently.
  const at = (reason: FlagReason, now: number): Flag => ({
    ...createFlag(attacker, { targetId: TARGET_B, targetEntity: 'statement', reason, conversationId: 'conv-1', now }),
    hlc: hlcNow(clock),
  })
  const once = at(FlagReason.Abuse, 1_000)
  const again = at(FlagReason.Spam, 2_000)

  check(
    'changing your mind mints a second valid flag, it does not update the first',
    once.id !== again.id && verifyFlag(once) && verifyFlag(again),
  )

  check(
    'both are the same person objecting to the same thing',
    once.authorPub === again.authorPub && once.targetId === again.targetId,
  )

  check('deduplication keeps exactly one', dedupeFlags([once, again]).length === 1)
  check(
    '…and it is the most recent objection',
    dedupeFlags([once, again])[0]!.reason === FlagReason.Spam,
  )
  check(
    'two devices holding the same pair agree on which survives',
    dedupeFlags([once, again])[0]!.id === dedupeFlags([again, once])[0]!.id,
  )
  check(
    'different people are never collapsed',
    dedupeFlags([once, flag(blocA[1]!, TARGET_B, FlagReason.Abuse)]).length === 2,
  )
  check(
    'the same person flagging DIFFERENT things is not collapsed',
    dedupeFlags([once, flag(attacker, 'some-other-target', FlagReason.Abuse)]).length === 2,
  )

  // The amplification itself. flagWeight dilutes by sqrt(outgoing/quota), so N
  // duplicates contribute W·sqrt(N·quota) — linear count against a square-root
  // penalty. Undeduplicated, a single Observer key reached an Anchor's weight.
  const spam = Array.from({ length: 60 }, (_, i) =>
    at(i % 2 ? FlagReason.Abuse : FlagReason.Spam, 10_000 + i),
  )
  check(
    'sixty duplicate flags from one key collapse to one objection',
    dedupeFlags(spam).length === 1,
    `${spam.length} rows → ${dedupeFlags(spam).length}`,
  )

  // And end to end: the whole campaign must not be able to withhold anything,
  // because it is one person and corroboration needs more than one group.
  const verdict = buildPolicy({
    selfPub: blocB[4]!.pubKeyId,
    flags: spam,
    tierOf: flatTier,
    participants,
  })(TARGET_B, AUTHOR_B)

  check(
    'a sixty-flag campaign by one person hides nothing',
    verdict.visibility === Visibility.Visible,
    `${spam.length} flags → ${verdict.visibility}`,
  )
  check(
    'and it is counted as the single objection it is',
    verdict.flagCount === 1,
    `flagCount ${verdict.flagCount}`,
  )
}

/* ─────────────────── 2. THE FACTIONAL ATTACK ─────────────────── */

section('2. One bloc cannot bury another bloc — the test that matters')
{
  // Every single member of bloc A flags bloc B's statement as abuse.
  // Bloc B flags nothing. This is a coordinated factional campaign.
  const factional = blocA.map((k) => flag(k, TARGET_B, FlagReason.Abuse))

  const evaluate = buildPolicy({
    selfPub: blocB[4]!.pubKeyId, // a bloc B member reading
    flags: factional,
    tierOf: flatTier,
    participants,
  })
  const verdict = evaluate(TARGET_B, AUTHOR_B)

  check(
    'a unanimous bloc-A campaign does NOT hide a bloc-B statement',
    verdict.visibility === Visibility.Visible,
    `${factional.length} flags from one group → ${verdict.visibility}`,
  )
  check(
    'and the reader is told why it stayed visible',
    verdict.reason.toLowerCase().includes('disagreement'),
    `“${verdict.reason}”`,
  )
  check(
    'corroboration across groups is zero',
    verdict.corroboration === 0,
    'bloc B raised nothing',
  )

  // Even a bloc A member reading it sees it — their own group's campaign does
  // not get to decide what they are shown.
  const asBlocA = buildPolicy({
    selfPub: blocA[5]!.pubKeyId,
    flags: factional.filter((f) => f.authorPub !== blocA[5]!.pubKeyId),
    tierOf: flatTier,
    participants,
  })
  check(
    'a bloc-A reader who did not flag it still sees it',
    asBlocA(TARGET_B, AUTHOR_B).visibility === Visibility.Visible,
  )

  // Mirror image: bloc B campaigning against bloc A must fail identically.
  const mirrored = buildPolicy({
    selfPub: blocA[6]!.pubKeyId,
    flags: blocB.map((k) => flag(k, TARGET_A, FlagReason.Abuse)),
    tierOf: flatTier,
    participants,
  })
  check(
    'the rule is symmetric — bloc B cannot bury bloc A either',
    mirrored(TARGET_A, AUTHOR_A).visibility === Visibility.Visible,
  )
}

/* ─────────────────── 3. genuine abuse still gets withheld ─────────────────── */

section('3. …but corroborated abuse is withheld')
{
  // Roughly a third of EACH bloc flags it. Nobody is campaigning; both groups
  // independently object.
  const corroborated = [
    ...blocA.slice(0, 4).map((k) => flag(k, TARGET_B, FlagReason.Abuse)),
    ...blocB.slice(0, 3).map((k) => flag(k, TARGET_B, FlagReason.Abuse)),
  ]

  const evaluate = buildPolicy({
    selfPub: outsider.pubKeyId,
    flags: corroborated,
    tierOf: flatTier,
    participants,
  })
  const verdict = evaluate(TARGET_B, AUTHOR_B)

  check(
    'a statement both groups flag is withheld',
    verdict.visibility === Visibility.Withheld,
    `corroboration ${verdict.corroboration} across ${verdict.evidencedGroups} groups`,
  )
  check(
    'the reader is told why, in plain language',
    verdict.reason.includes('Every group'),
    `“${verdict.reason}”`,
  )
  check('withheld is still recoverable, never deleted', isHidden(verdict.visibility))

  // DANGER clears a lower bar — the cost of delay is asymmetric.
  const lightDanger = [
    ...blocA.slice(0, 2).map((k) => flag(k, TARGET_B, FlagReason.Danger)),
    ...blocB.slice(0, 1).map((k) => flag(k, TARGET_B, FlagReason.Danger)),
  ]
  const dangerVerdict = buildPolicy({
    selfPub: outsider.pubKeyId,
    flags: lightDanger,
    tierOf: flatTier,
    participants,
  })(TARGET_B, AUTHOR_B)
  check(
    'DANGER is acted on at a lower threshold than ABUSE',
    isHidden(dangerVerdict.visibility),
    `${dangerVerdict.visibility} at corroboration ${dangerVerdict.corroboration}`,
  )

  const sameWeightAbuse = buildPolicy({
    selfPub: outsider.pubKeyId,
    flags: [
      ...blocA.slice(0, 2).map((k) => flag(k, TARGET_B, FlagReason.Abuse)),
      ...blocB.slice(0, 1).map((k) => flag(k, TARGET_B, FlagReason.Abuse)),
    ],
    tierOf: flatTier,
    participants,
  })(TARGET_B, AUTHOR_B)
  check(
    'the same weight of ABUSE flags does not reach withheld',
    sameWeightAbuse.visibility !== Visibility.Withheld,
    `${sameWeightAbuse.visibility} — asymmetry is deliberate`,
  )
}

/* ─────────────────── 4. noise reasons never hide ─────────────────── */

section('4. Spam and off-topic can never hide anything')
{
  const everyoneSaysSpam = [
    ...blocA.map((k) => flag(k, TARGET_B, FlagReason.Spam)),
    ...blocB.map((k) => flag(k, TARGET_B, FlagReason.Spam)),
  ]
  const verdict = buildPolicy({
    selfPub: outsider.pubKeyId,
    flags: everyoneSaysSpam,
    tierOf: flatTier,
    participants,
  })(TARGET_B, AUTHOR_B)

  check(
    'unanimous SPAM flags downrank but never hide',
    verdict.visibility === Visibility.Downranked,
    `${everyoneSaysSpam.length} flags from both groups → ${verdict.visibility}`,
  )
  check('the taxonomy is doing the work', !isHidden(verdict.visibility))

  const offTopic = buildPolicy({
    selfPub: outsider.pubKeyId,
    flags: [...blocA, ...blocB].map((k) => flag(k, TARGET_B, FlagReason.OffTopic)),
    tierOf: flatTier,
    participants,
  })(TARGET_B, AUTHOR_B)
  check('unanimous OFF_TOPIC likewise only downranks', offTopic.visibility === Visibility.Downranked)
}

/* ─────────────────── 5. Sybil resistance ─────────────────── */

section('5. Sybil and capacity')
{
  // 60 fresh keys — free to mint, no standing — all flag the same statement.
  const sybils = Array.from({ length: 60 }, () => generateEphemeralKeyPair())
  const sybilParticipants: ParticipantPoint[] = [
    ...participants,
    ...sybils.map((k, i) => ({ pubKey: k.pubKeyId, x: 0, y: i / 60, group: 1, votesCast: 3 })),
  ]

  const verdict = buildPolicy({
    selfPub: outsider.pubKeyId,
    flags: sybils.map((k) => flag(k, TARGET_B, FlagReason.Abuse)),
    tierOf: (pub) =>
      sybils.some((s) => s.pubKeyId === pub) ? TrustTier.Observer : TrustTier.Neighbour,
    participants: sybilParticipants,
  })(TARGET_B, AUTHOR_B)

  check(
    '60 fresh keys cannot hide a statement',
    verdict.visibility === Visibility.Visible,
    `${verdict.visibility} — no standing, no corroboration`,
  )

  check(
    'an Observer flag weighs far less than a Steward flag',
    FLAG_TIER_WEIGHT[TrustTier.Observer] < FLAG_TIER_WEIGHT[TrustTier.Steward] / 5,
    `${FLAG_TIER_WEIGHT[TrustTier.Observer]} vs ${FLAG_TIER_WEIGHT[TrustTier.Steward]}`,
  )

  // Capacity: flagging everything devalues every flag you have given.
  const modest = flagWeight(TrustTier.Neighbour, 3)
  const prolific = flagWeight(TrustTier.Neighbour, 60)
  check(
    'flagging everything dilutes each flag',
    prolific < modest / 2,
    `${modest.toFixed(3)} → ${prolific.toFixed(3)} after 60 flags`,
  )
}

/* ─────────────────── 6. due process ─────────────────── */

section('6. Due process — nothing disappears silently')
{
  // Note the author is excluded — people do not flag their own statements, and
  // including them would have the fixture testing something it does not claim.
  const heavy = [
    ...blocA.slice(0, 6).map((k) => flag(k, TARGET_B, FlagReason.Abuse)),
    ...blocB.filter((k) => k.pubKeyId !== AUTHOR_B).slice(0, 5).map((k) => flag(k, TARGET_B, FlagReason.Abuse)),
  ]

  // The author always sees their own work, and is told it is being withheld.
  const asAuthor = buildPolicy({
    selfPub: AUTHOR_B,
    flags: heavy,
    tierOf: flatTier,
    participants,
  })(TARGET_B, AUTHOR_B)
  check(
    'the author still sees their own statement',
    asAuthor.visibility === Visibility.Visible,
    'withheld without being readable is disappearance, not moderation',
  )
  check(
    'and is told others may not see it',
    asAuthor.reason.includes('flagged'),
    `“${asAuthor.reason}”`,
  )

  // Every hidden verdict carries an explanation.
  const asOther = buildPolicy({
    selfPub: outsider.pubKeyId,
    flags: heavy,
    tierOf: flatTier,
    participants,
  })(TARGET_B, AUTHOR_B)
  check('a hidden item always carries a reason', asOther.reason.length > 0, `“${asOther.reason}”`)

  // Your own flag mutes it for you alone, with no corroboration needed —
  // it censors nobody but yourself.
  const selfFlagged = buildPolicy({
    selfPub: blocA[7]!.pubKeyId,
    flags: [flag(blocA[7]!, TARGET_B, FlagReason.Abuse)],
    tierOf: flatTier,
    participants,
  })(TARGET_B, AUTHOR_B)
  check(
    'your own flag mutes it for you alone',
    selfFlagged.visibility === Visibility.Muted && selfFlagged.flaggedByYou,
  )

  // The reader is sovereign: "show everything" overrides all of it.
  const open = buildPolicy({
    selfPub: outsider.pubKeyId,
    flags: heavy,
    tierOf: flatTier,
    participants,
    preset: 'open' as PolicyPreset,
  })(TARGET_B, AUTHOR_B)
  check(
    'the reader can switch hiding off entirely',
    open.visibility === Visibility.Visible,
    'the device is sovereign',
  )
}

/* ─────────────────── 7. ungrouped targets ─────────────────── */

section('7. Listings and identities — no groups to corroborate across')
{
  const scam = 'listing-scam'
  const listingFlag = (from: KeyPair) => ({
    ...createFlag(from, { targetId: scam, targetEntity: 'listing' as const, reason: FlagReason.Deception }),
    hlc: hlcNow(clock),
  })

  const oneAnchor = buildPolicy({
    selfPub: outsider.pubKeyId,
    flags: [listingFlag(blocA[0]!)],
    tierOf: () => TrustTier.Anchor,
  })(scam, AUTHOR_A)
  check(
    'a single Anchor cannot withhold a listing alone',
    oneAnchor.visibility !== Visibility.Withheld,
    `${oneAnchor.visibility} — needs distinct flaggers`,
  )

  const several = buildPolicy({
    selfPub: outsider.pubKeyId,
    flags: [listingFlag(blocA[0]!), listingFlag(blocA[1]!), listingFlag(blocB[0]!)],
    tierOf: () => TrustTier.Steward,
  })(scam, AUTHOR_A)
  check(
    'three trusted people can withhold a scam listing',
    several.visibility === Visibility.Withheld,
    several.reason,
  )
}

/* ─────────────────── 8. revocation ─────────────────── */

section('8. Revocation — only the issuer may withdraw a vouch')

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

{
  const anchor = generateEphemeralKeyPair()
  const steward = generateEphemeralKeyPair()
  const voucher = realVoucher(anchor, steward)

  const before = computeTrustGraph([voucher], [anchor.pubKeyId])
  check(
    'the vouch confers standing before revocation',
    lookupTrust(before, steward.pubKeyId).tier >= TrustTier.Neighbour,
    `${TrustTier[lookupTrust(before, steward.pubKeyId).tier]}`,
  )

  const revocation = createRevocation(anchor, voucher, RevocationReason.Harmful)
  check('a revocation verifies', verifyRevocation(revocation))

  const after = computeTrustGraph(applyRevocations([voucher], [revocation]), [anchor.pubKeyId])
  check(
    'revoking removes the standing it conferred',
    lookupTrust(after, steward.pubKeyId).tier === TrustTier.Observer,
    `${TrustTier[lookupTrust(after, steward.pubKeyId).tier]} · score ${lookupTrust(after, steward.pubKeyId).score}`,
  )

  // ATTACK: a third party revokes someone else's vouch to strip their standing.
  let threw = false
  try {
    createRevocation(outsider, voucher, RevocationReason.Harmful)
  } catch (e) {
    threw = e instanceof RevocationError
  }
  check('a third party cannot mint a revocation', threw)

  // …and a hand-crafted one is refused at the door.
  const forged = { ...revocation, issuerPub: outsider.pubKeyId }
  check('a re-attributed revocation fails verification', !verifyRevocation(forged))

  const stillStanding = computeTrustGraph(applyRevocations([voucher], [forged]), [anchor.pubKeyId])
  check(
    'a forged revocation does not strip standing',
    lookupTrust(stillStanding, steward.pubKeyId).tier >= TrustTier.Neighbour,
    'stripping trust is as damaging as forging it',
  )

  // Revocation for a voucher issued by someone else must not bite even if it
  // somehow reached the local table.
  const otherVoucher = realVoucher(steward, generateEphemeralKeyPair())
  const mismatched = { ...revocation, voucherId: otherVoucher.id }
  check(
    'a revocation cannot cancel a vouch it has no authority over',
    applyRevocations([otherVoucher], [mismatched])[0]!.status === VoucherStatus.Valid,
  )

  check(
    'only your own outgoing vouches are revocable',
    revocableVouchers([voucher, otherVoucher], anchor.pubKeyId).length === 1,
  )
}

/* ─────────────────── 9. sync ─────────────────── */

section('9. Sync — flags and revocations cross an untrusted relay')
{
  const f = flag(blocA[0]!, TARGET_B, FlagReason.Abuse)
  const relay = generateEphemeralKeyPair()

  const relayed = createSignedOp(relay, {
    hlc: f.hlc,
    entity: 'flag',
    entityId: f.id,
    op: 'put',
    record: f,
  })
  check('a third party may relay a flag', verifySignedOp(relayed).ok, 'flags must propagate')

  // ATTACK: a relay manufactures a flag attributed to someone who never raised
  // one. Unchecked, this is a censorship primitive.
  const invented = createSignedOp(relay, {
    hlc: f.hlc,
    entity: 'flag',
    entityId: f.id,
    op: 'put',
    record: { ...f, reason: FlagReason.Danger },
  })
  const verdict = verifySignedOp(invented)
  check(
    'a manufactured flag inside a valid relay op is caught',
    !verdict.ok && verdict.reason === OpRejectReason.InvalidAttestation,
    !verdict.ok ? verdict.reason : 'ACCEPTED — CRITICAL',
  )

  const anchor = generateEphemeralKeyPair()
  const voucher = realVoucher(anchor, generateEphemeralKeyPair())
  const revocation = createRevocation(anchor, voucher, RevocationReason.Compromised)
  const relayedRevocation = createSignedOp(relay, {
    hlc: hlcNow(clock),
    entity: 'revocation',
    entityId: revocation.id,
    op: 'put',
    record: revocation,
  })
  check(
    'a third party may relay a revocation',
    verifySignedOp(relayedRevocation).ok,
    'it must outrun the trust it cancels',
  )

  const forgedRevocationOp = createSignedOp(relay, {
    hlc: hlcNow(clock),
    entity: 'revocation',
    entityId: revocation.id,
    op: 'put',
    record: { ...revocation, subjectPub: outsider.pubKeyId },
  })
  check(
    'a tampered revocation inside a valid relay op is caught',
    !verifySignedOp(forgedRevocationOp).ok,
  )

  const bundle = createBundle(relay, [relayed, relayedRevocation])
  check('both survive a bundle round trip', verifyBundle(bundle).accepted.length === 2)
}

console.log(`\n${BOLD}${'─'.repeat(64)}${RESET}`)
if (failed === 0) {
  console.log(`${GREEN}${BOLD}  ${passed} checks passed.${RESET} Moderation holds.`)
} else {
  console.log(`${RED}${BOLD}  ${failed} failed${RESET}, ${passed} passed`)
  for (const f of failures) console.log(`   ${RED}·${RESET} ${f}`)
}
console.log(`${BOLD}${'─'.repeat(64)}${RESET}\n`)

process.exit(failed === 0 ? 0 : 1)
