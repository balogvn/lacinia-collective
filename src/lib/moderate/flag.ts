/**
 * Flags — signed, attributable objections.
 *
 * A flag is not a report to an authority, because there is no authority. It is
 * a signed statement of the form "I, this key, object to this item for this
 * reason", published like everything else. What any device does with it is
 * decided locally by policy.ts.
 *
 * ATTRIBUTABLE, NOT ANONYMOUS. Anonymous flagging is free, and anything free
 * gets farmed. A flag costs you something here: it is signed with your key,
 * it is visible in the graph, and — as with vouching — flagging everything
 * devalues every flag you have given.
 */

import { attest, verifyAttestation } from '../crypto/attest'
import { contentId, type KeyPair } from '../crypto/keys'
import {
  FlagReason,
  HARM_REASONS,
  TrustTier,
  type Flag,
  type FlagTarget,
  type PubKeyId,
} from '../db/schema'
import { log } from '../telemetry'

export const FLAG_DOMAIN = 'lacinia/flag/v1'

/**
 * How much a flag counts, by the flagger's standing.
 *
 * An Observer is a key someone made thirty seconds ago. Their flag is not
 * nothing — a newcomer may be the first to notice something — but it cannot be
 * enough on its own, or a key farm becomes a censorship button.
 */
export const FLAG_TIER_WEIGHT: Record<TrustTier, number> = {
  [TrustTier.Observer]: 0.15,
  [TrustTier.Neighbour]: 0.6,
  [TrustTier.Steward]: 1,
  [TrustTier.Anchor]: 1.5,
}

/** Flags a person may raise before dilution begins, by tier. */
const FLAG_QUOTA: Record<TrustTier, number> = {
  [TrustTier.Observer]: 2,
  [TrustTier.Neighbour]: 6,
  [TrustTier.Steward]: 15,
  [TrustTier.Anchor]: 40,
}

/**
 * A flag's id is derived from (flagger, target), NOT its content.
 *
 * So changing your mind about the reason updates the same row instead of
 * stacking a second flag — one person cannot become three by re-flagging under
 * different reasons.
 */
export function flagIdFor(flaggerPub: PubKeyId, targetId: string): string {
  return contentId(new TextEncoder().encode(`flag|${flaggerPub}|${targetId}`))
}

export function createFlag(
  flagger: KeyPair,
  input: {
    targetId: string
    targetEntity: FlagTarget
    reason: FlagReason
    conversationId?: string
    now?: number
  },
): Flag {
  const body = {
    targetId: input.targetId,
    targetEntity: input.targetEntity,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    authorPub: flagger.pubKeyId,
    reason: input.reason,
    createdAt: input.now ?? Date.now(),
  }

  const attestation = attest(flagger, FLAG_DOMAIN, body)

  log.info('trust', 'flag raised', {
    target: input.targetId.slice(0, 12),
    reason: input.reason,
  })

  return {
    ...body,
    id: attestation.id,
    signature: attestation.signature,
    signedBytes: attestation.signedBytes,
    hlc: '',
  }
}

export function verifyFlag(flag: Flag): boolean {
  return verifyAttestation(FLAG_DOMAIN, flag as unknown as Record<string, unknown>, flag.authorPub)
}

/**
 * One objection per person per target, keeping their most recent.
 *
 * THE ATTACK THIS CLOSES
 * A flag's id is the content address of its signed bytes, and those bytes
 * include `reason` and `createdAt` — so re-flagging the same item produces a
 * SECOND valid row rather than updating the first. Every downstream count then
 * treated one person as several.
 *
 * That was not merely untidy, it was an amplifier. `flagWeight` dilutes by
 * sqrt(outgoing/quota), so N duplicate flags on one target contribute
 * N · W/sqrt(N/quota) = W · sqrt(N · quota) — growing without bound while the
 * penalty grows only as its square root. A brand-new Observer key posting 50
 * duplicates on one statement reached the weight of a full Anchor; 200 reached
 * twice that. The dilution was designed to stop someone flagging MANY things,
 * and did nothing about someone flagging ONE thing many times.
 *
 * Deduplicating on read rather than on write is deliberate: duplicates also
 * arrive over sync, from devices whose behaviour we do not control, and the
 * signature on each is perfectly valid. The fix has to live where the counting
 * happens.
 */
export function dedupeFlags(flags: readonly Flag[]): Flag[] {
  const newest = new Map<string, Flag>()
  for (const flag of flags) {
    const key = `${flag.authorPub}|${flag.targetId}`
    const held = newest.get(key)
    if (
      !held ||
      flag.createdAt > held.createdAt ||
      // Deterministic tiebreak: two devices holding the same pair must agree
      // on which survives, or they withhold different things.
      (flag.createdAt === held.createdAt && flag.id > held.id)
    ) {
      newest.set(key, flag)
    }
  }
  return [...newest.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Weight of one flag, after the capacity constraint.
 *
 * Flagging everything you dislike dilutes every flag you have ever raised —
 * the same mechanism that stops a Steward vouching for sixty fake keys. It
 * makes flagging a scarce, considered act rather than a reflex.
 */
export function flagWeight(tier: TrustTier, outgoingFlags: number): number {
  const quota = FLAG_QUOTA[tier]
  const dilution = Math.sqrt(Math.max(1, outgoingFlags / quota))
  return FLAG_TIER_WEIGHT[tier] / dilution
}

export function isHarmFlag(flag: Flag): boolean {
  return HARM_REASONS.has(flag.reason)
}

/** Counts each person's outstanding flags, for the capacity constraint. */
export function countOutgoingFlags(flags: readonly Flag[]): Map<PubKeyId, number> {
  const counts = new Map<PubKeyId, number>()
  for (const flag of flags) {
    if (flag.deleted) continue
    counts.set(flag.authorPub, (counts.get(flag.authorPub) ?? 0) + 1)
  }
  return counts
}
