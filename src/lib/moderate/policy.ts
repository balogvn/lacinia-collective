/**
 * VISIBILITY POLICY — what this device chooses to show.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NOTHING IS EVER DELETED, AND SAYING SO MATTERS
 *
 * Data gossips through signed bundles. Once published it exists on other
 * people's devices forever, and no amount of local policy changes that. Any
 * design promising removal would be lying to the person who flagged it.
 *
 * So this file does not remove anything. It decides what a device SHOWS,
 * every decision is reversible, and every withheld item stays one tap away
 * with the reason attached.
 *
 * THE CENTRAL MECHANISM: CROSS-GROUP CORROBORATION
 *
 * Task 4 ranks a statement by the MINIMUM agreement across opinion groups, so
 * one dissenting group is enough to sink it. Withholding uses the identical
 * shape, pointed the other way: a statement is withheld only when EVERY group
 * flags it.
 *
 *     bridging    = min over groups of agreement      → surfaces what unites
 *     withholding = min over groups of flag pressure  → hides only what all reject
 *
 * This is the answer to the attack that actually matters in a tool built to
 * bridge ethno-religious divides: one bloc mass-flagging the other bloc's
 * statements. Counting flags cannot distinguish that from genuine abuse.
 * Requiring corroboration across the groups the votes reveal makes a factional
 * campaign structurally useless — if only Group A objects, that is a
 * disagreement, and disagreement already has a button.
 *
 * FAIL OPEN. Where evidence is insufficient, show. In a system whose purpose
 * is bridging divides, wrongly hiding costs more than wrongly showing. The one
 * exception is DANGER, where the cost of delay is asymmetric — that exception
 * is a named constant and surfaced in the UI, not buried here.
 * ───────────────────────────────────────────────────────────────────────────
 */

import {
  FlagReason,
  HARM_REASONS,
  TrustTier,
  type Flag,
  type PubKeyId,
} from '../db/schema'
import { flagWeight, FLAG_TIER_WEIGHT, countOutgoingFlags, dedupeFlags, verifyFlag } from './flag'
import type { ParticipantPoint } from '../deliberate/cluster'
import { log } from '../telemetry'

export enum Visibility {
  /** Shown normally. */
  Visible = 'VISIBLE',
  /** Shown, but sorted below everything else. Noise reasons only. */
  Downranked = 'DOWNRANKED',
  /** Collapsed behind a tap. The reader decides. */
  Muted = 'MUTED',
  /** Hidden by default, listed in the withheld panel with its reason. */
  Withheld = 'WITHHELD',
}

export interface VisibilityVerdict {
  visibility: Visibility
  /** Plain-language explanation. Never show a hidden item without one. */
  reason: string
  /** Dominant harm reason, when there is one. */
  flagReason: FlagReason | null
  flagCount: number
  /** min over groups of weighted flag pressure, when groups exist. */
  corroboration: number
  /** Groups that had enough engagement for their pressure to count. */
  evidencedGroups: number
  /** True when the reader flagged it themselves. */
  flaggedByYou: boolean
}

/** How much of a group's weighted membership must object. */
const WITHHOLD_THRESHOLD = 0.25
const MUTE_THRESHOLD = 0.12

/**
 * DANGER is the one asymmetric case: the cost of showing incitement for
 * another day exceeds the cost of wrongly withholding something recoverable in
 * one tap. It still requires corroboration — it just needs less of it.
 */
const DANGER_WITHHOLD_THRESHOLD = 0.12

/** Absolute weighted threshold for targets with no opinion groups (listings, identities). */
const UNGROUPED_WITHHOLD_WEIGHT = 2.5
const UNGROUPED_MUTE_WEIGHT = 1.2
/** …and this many distinct people, so one Anchor cannot act alone. */
const UNGROUPED_MIN_FLAGGERS = 3

/** A group needs this many members present before its silence means anything. */
const MIN_GROUP_ENGAGEMENT = 2

export interface PolicyInput {
  /** Reader's own key — they always see their own content and their own flags. */
  selfPub: PubKeyId
  /** All flags this device holds. */
  flags: readonly Flag[]
  /** Trust tier lookup, for weighting. */
  tierOf: (pubKey: PubKeyId) => TrustTier
  /**
   * Opinion-group membership from Task 4, when the target sits in a clustered
   * conversation. Absent means fall back to the ungrouped rule.
   */
  participants?: readonly ParticipantPoint[]
  /** How strict this device is. The reader is sovereign. */
  preset?: PolicyPreset
}

export type PolicyPreset = 'open' | 'standard' | 'cautious'

export const PRESET_LABELS: Record<PolicyPreset, { label: string; blurb: string }> = {
  open: {
    label: 'Show everything',
    blurb: 'Nothing is hidden. Flags are still shown as labels so you know what others objected to.',
  },
  standard: {
    label: 'Community standard',
    blurb:
      'Withhold only what every group objected to. One group flagging alone is treated as disagreement, not abuse.',
  },
  cautious: {
    label: 'Cautious',
    blurb: 'Lower thresholds, and mute anything a single group objects to strongly.',
  },
}

const PRESET_SCALE: Record<PolicyPreset, number> = {
  open: Infinity,
  standard: 1,
  cautious: 0.6,
}

/**
 * Builds a reusable evaluator. Flag weights and group sizes are computed once,
 * because this is called for every item in a list.
 */
export function buildPolicy(input: PolicyInput) {
  const preset = input.preset ?? 'standard'
  const scale = PRESET_SCALE[preset]

  // Only verified flags count. An unverified flag in our own table is either
  // corrupt or planted, and either way must not influence what we hide.
  // Deduplicated BEFORE anything counts, because re-flagging produces a second
  // valid row and every count below would otherwise read one person as several.
  // See dedupeFlags — unchecked, this is a censorship amplifier, not a nit.
  const valid = dedupeFlags(input.flags.filter((f) => !f.deleted && verifyFlag(f)))
  if (valid.length !== input.flags.filter((f) => !f.deleted).length) {
    log.warn('trust', 'discarded flags that failed verification', {
      discarded: input.flags.filter((f) => !f.deleted).length - valid.length,
    })
  }

  const outgoing = countOutgoingFlags(valid)
  const groupOf = new Map<PubKeyId, number>()
  const groupWeight = new Map<number, number>()
  const groupSize = new Map<number, number>()

  for (const participant of input.participants ?? []) {
    groupOf.set(participant.pubKey, participant.group)
    const tier = input.tierOf(participant.pubKey)
    groupWeight.set(
      participant.group,
      (groupWeight.get(participant.group) ?? 0) + FLAG_TIER_WEIGHT[tier],
    )
    groupSize.set(participant.group, (groupSize.get(participant.group) ?? 0) + 1)
  }

  const byTarget = new Map<string, Flag[]>()
  for (const flag of valid) {
    const bucket = byTarget.get(flag.targetId)
    if (bucket) bucket.push(flag)
    else byTarget.set(flag.targetId, [flag])
  }

  const weightOf = (flag: Flag): number =>
    flagWeight(input.tierOf(flag.authorPub), outgoing.get(flag.authorPub) ?? 1)

  return function evaluate(targetId: string, authorPub: PubKeyId): VisibilityVerdict {
    const flags = byTarget.get(targetId) ?? []
    const flaggedByYou = flags.some((f) => f.authorPub === input.selfPub)

    const base: VisibilityVerdict = {
      visibility: Visibility.Visible,
      reason: '',
      flagReason: null,
      flagCount: flags.length,
      corroboration: 0,
      evidencedGroups: 0,
      flaggedByYou,
    }

    if (flags.length === 0) return base

    // ORDER MATTERS HERE. The author guarantee is checked BEFORE the self-flag
    // preference, because it is a guarantee and the other is a preference.
    //
    // Authors always see their own work, whatever anyone else — including
    // themselves — has flagged. Being withheld without being able to read what
    // was withheld is not moderation, it is disappearance, and an author who
    // cannot see what is being objected to cannot answer it or withdraw it.
    // Regretting your own statement is served by withdrawing it, not by
    // flagging it into your own blind spot.
    if (authorPub === input.selfPub) {
      return {
        ...base,
        visibility: Visibility.Visible,
        reason:
          flags.length > 0
            ? `${flags.length} ${flags.length === 1 ? 'person has' : 'people have'} flagged this. Others may not see it.`
            : '',
      }
    }

    // Your own objection always applies to your own view, whatever anyone else
    // thinks. This needs no corroboration because it censors nobody but you.
    if (flaggedByYou && preset !== 'open') {
      return {
        ...base,
        visibility: Visibility.Muted,
        reason: 'You flagged this.',
        flagReason: flags.find((f) => f.authorPub === input.selfPub)?.reason ?? null,
      }
    }

    if (preset === 'open') {
      return { ...base, reason: `${flags.length} flagged, shown anyway by your settings.` }
    }

    const harmFlags = flags.filter((f) => HARM_REASONS.has(f.reason))

    // NOISE REASONS CAN NEVER HIDE. Spam and off-topic are real problems and
    // they are not censorship problems — the worst they earn is a lower place
    // in the list.
    if (harmFlags.length === 0) {
      return {
        ...base,
        visibility: Visibility.Downranked,
        reason: 'Flagged as spam or off-topic. Shown lower, never hidden.',
        flagReason: flags[0]?.reason ?? null,
      }
    }

    const dominant = dominantReason(harmFlags)
    const isDanger = dominant === FlagReason.Danger

    /* ── grouped path: cross-group corroboration ── */
    if (input.participants && input.participants.length > 0 && groupWeight.size > 1) {
      const pressures: number[] = []

      for (const [group, total] of [...groupWeight.entries()].sort((a, b) => a[0] - b[0])) {
        if ((groupSize.get(group) ?? 0) < MIN_GROUP_ENGAGEMENT) continue
        let objecting = 0
        for (const flag of harmFlags) {
          if (groupOf.get(flag.authorPub) === group) objecting += weightOf(flag)
        }
        pressures.push(total > 0 ? objecting / total : 0)
      }

      // Fail open: with fewer than two groups' worth of evidence there is no
      // corroboration to speak of, so show it.
      if (pressures.length < 2) {
        return {
          ...base,
          visibility: Visibility.Visible,
          flagReason: dominant,
          reason: 'Flagged, but not by enough of the room to act on yet.',
        }
      }

      const corroboration = Math.min(...pressures)
      const withholdAt = (isDanger ? DANGER_WITHHOLD_THRESHOLD : WITHHOLD_THRESHOLD) * scale
      const muteAt = MUTE_THRESHOLD * scale

      if (corroboration >= withholdAt) {
        return {
          ...base,
          visibility: Visibility.Withheld,
          flagReason: dominant,
          corroboration: +corroboration.toFixed(4),
          evidencedGroups: pressures.length,
          reason: `Every group here flagged this — ${flags.length} people across ${pressures.length} groups.`,
        }
      }
      if (corroboration >= muteAt) {
        return {
          ...base,
          visibility: Visibility.Muted,
          flagReason: dominant,
          corroboration: +corroboration.toFixed(4),
          evidencedGroups: pressures.length,
          reason: `Flagged in every group, though not strongly. Tap to read it.`,
        }
      }

      // THE FACTIONAL ATTACK, REFUSED. Heavy flagging inside one group with
      // none from another is a disagreement wearing a moderation costume.
      const maxPressure = Math.max(...pressures)
      if (maxPressure >= muteAt) {
        return {
          ...base,
          visibility: Visibility.Visible,
          flagReason: dominant,
          corroboration: +corroboration.toFixed(4),
          evidencedGroups: pressures.length,
          reason:
            'One group flagged this and another did not. That is a disagreement, so it stays visible.',
        }
      }

      return {
        ...base,
        visibility: Visibility.Visible,
        flagReason: dominant,
        corroboration: +corroboration.toFixed(4),
        evidencedGroups: pressures.length,
        reason: 'Flagged by a few people, not enough to act on.',
      }
    }

    /* ── ungrouped path: listings, identities, unclustered conversations ──
       No opinion groups exist, so corroboration is approximated by requiring
       several distinct flaggers and real combined weight. Weaker than the
       grouped rule, and deliberately harder to trigger to compensate. */
    const distinct = new Set(harmFlags.map((f) => f.authorPub)).size
    const weight = harmFlags.reduce((sum, f) => sum + weightOf(f), 0)
    const withholdWeight = UNGROUPED_WITHHOLD_WEIGHT * scale * (isDanger ? 0.6 : 1)

    if (distinct >= UNGROUPED_MIN_FLAGGERS && weight >= withholdWeight) {
      return {
        ...base,
        visibility: Visibility.Withheld,
        flagReason: dominant,
        reason: `${distinct} people you have reason to trust flagged this.`,
      }
    }
    if (weight >= UNGROUPED_MUTE_WEIGHT * scale) {
      return {
        ...base,
        visibility: Visibility.Muted,
        flagReason: dominant,
        reason: `${distinct} ${distinct === 1 ? 'person' : 'people'} flagged this. Tap to read it.`,
      }
    }

    return {
      ...base,
      visibility: Visibility.Visible,
      flagReason: dominant,
      reason: 'Flagged, not enough to act on.',
    }
  }
}

/** Most-weighted harm reason, ties broken deterministically by enum order. */
function dominantReason(flags: readonly Flag[]): FlagReason {
  const counts = new Map<FlagReason, number>()
  for (const flag of flags) counts.set(flag.reason, (counts.get(flag.reason) ?? 0) + 1)

  // Danger outranks the others on a tie: under-reacting to incitement costs
  // more than over-reacting to rudeness.
  const order = [FlagReason.Danger, FlagReason.Deception, FlagReason.Abuse]
  let best = FlagReason.Abuse
  let bestCount = -1
  for (const reason of order) {
    const count = counts.get(reason) ?? 0
    if (count > bestCount) {
      bestCount = count
      best = reason
    }
  }
  return best
}

export function isHidden(v: Visibility): boolean {
  return v === Visibility.Withheld || v === Visibility.Muted
}
