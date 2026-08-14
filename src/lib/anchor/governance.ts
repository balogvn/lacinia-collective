/**
 * ANCHOR GOVERNANCE — collective lifecycle for the axioms of the trust graph.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE CHANGES NOTHING BY ITSELF
 *
 * Anchors are the axioms. Every trust score in the system derives from them, so
 * any mechanism that let the network edit the anchor set would be using derived
 * trust to choose the thing trust derives from. That is circular, and it is
 * capturable in both directions:
 *
 *   · anchors voting each other in    → a cartel nothing can dislodge
 *   · a majority voting an anchor out → the factional attack the moderation
 *                                       layer already refuses, aimed at the
 *                                       root instead of at a statement
 *
 * Both would look like governance. So this module computes a VIEW — what the
 * anchors you already trust have signed about the anchor set — and returns it
 * as evidence. Applying any of it is the device owner's act, always.
 *
 * THE EXCEPTION I DELIBERATELY DID NOT MAKE
 * Auto-applying RETIRE is tempting: removing an axiom shrinks trust rather than
 * inflating it, which is the fail-safe direction everywhere else in this
 * codebase. It is still refused, because a stolen anchor key could then sign
 * one retirement and collapse the standing of everyone that anchor ever
 * vouched for. One signature, whole community, no recovery but re-establishing
 * an anchor from scratch. Surfacing it costs a tap; automating it costs the
 * commons.
 *
 * BOOTSTRAPPING IS OUT OF BAND, NECESSARILY. The first anchor cannot be
 * endorsed by an anchor you already trust — there is not one yet. It comes off
 * a poster, a radio slot, a person standing in front of you. All software can
 * do is show the human-checkable fingerprint and ask whether you checked it.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { attest, verifyAttestation } from '../crypto/attest'
import { fingerprintFromId, idToPubKey, type KeyPair } from '../crypto/keys'
import { AnchorActionKind, type AnchorAction, type PubKeyId } from '../db/schema'
import { log } from '../telemetry'

export const ANCHOR_DOMAIN = 'lacinia/anchor-action/v1'

export const MAX_NOTE_CHARS = 120

export class AnchorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnchorError'
  }
}

/* ─────────────────────────── creation ─────────────────────────── */

export function createAnchorAction(
  anchor: KeyPair,
  input: {
    kind: AnchorActionKind
    targetPub?: string
    note?: string
    now?: number
  },
): AnchorAction {
  const needsTarget =
    input.kind === AnchorActionKind.Endorse || input.kind === AnchorActionKind.Rotate

  if (needsTarget) {
    if (!input.targetPub) throw new AnchorError(`${input.kind} needs a target key.`)
    try {
      idToPubKey(input.targetPub)
    } catch {
      throw new AnchorError('That is not a valid Lacinia public key.')
    }
    if (input.targetPub === anchor.pubKeyId) {
      throw new AnchorError('An anchor cannot endorse or rotate to its own key.')
    }
  }

  const body = {
    kind: input.kind,
    anchorPub: anchor.pubKeyId,
    ...(needsTarget ? { targetPub: input.targetPub! } : {}),
    note: (input.note ?? '').slice(0, MAX_NOTE_CHARS),
    actedAt: input.now ?? Date.now(),
  }

  const attestation = attest(anchor, ANCHOR_DOMAIN, body)
  log.info('trust', 'anchor action signed', { kind: input.kind })

  return {
    ...body,
    id: attestation.id,
    signature: attestation.signature,
    signedBytes: attestation.signedBytes,
    hlc: '',
  }
}

/**
 * Verifies the action against the key that claims to have taken it.
 *
 * `anchorPub` is inside the signed document, so an action cannot be
 * re-attributed to a different anchor without breaking the signature.
 */
export function verifyAnchorAction(action: AnchorAction): boolean {
  return verifyAttestation(
    ANCHOR_DOMAIN,
    action as unknown as Record<string, unknown>,
    action.anchorPub,
  )
}

/* ─────────────────────────── the view ─────────────────────────── */

export interface PendingRetirement {
  action: AnchorAction
  anchorPub: PubKeyId
  fingerprint: string
}

export interface PendingRotation {
  action: AnchorAction
  from: PubKeyId
  to: PubKeyId
  fromFingerprint: string
  toFingerprint: string
}

export interface EndorsedCandidate {
  candidate: PubKeyId
  fingerprint: string
  /** Anchors you already trust that have signed for this key. */
  endorsedBy: PubKeyId[]
  notes: string[]
}

export interface AnchorGovernanceView {
  /** Retirements signed by anchors this device currently trusts. */
  retirements: PendingRetirement[]
  /** Rotations signed by anchors this device currently trusts. */
  rotations: PendingRotation[]
  /** Keys endorsed by trusted anchors and not already trusted here. */
  candidates: EndorsedCandidate[]
  /** Actions discarded because the signature failed. */
  rejected: number
}

/**
 * Builds the governance view for a device.
 *
 * ONLY ACTIONS SIGNED BY AN ALREADY-TRUSTED ANCHOR ARE SURFACED. Without that
 * filter anyone could mint an endorsement and fill this panel with candidates,
 * turning a governance surface into a spam surface — and one that specifically
 * invites people to add attacker-chosen axioms.
 */
export function buildGovernanceView(
  anchors: readonly PubKeyId[],
  actions: readonly AnchorAction[],
  opts: { now?: number } = {},
): AnchorGovernanceView {
  const trusted = new Set(anchors)
  const retirements: PendingRetirement[] = []
  const rotations: PendingRotation[] = []
  const byCandidate = new Map<PubKeyId, EndorsedCandidate>()
  let rejected = 0

  // Sorted for deterministic output across devices.
  const ordered = [...actions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  for (const action of ordered) {
    if (!verifyAnchorAction(action)) {
      rejected++
      continue
    }
    if (!trusted.has(action.anchorPub)) continue
    if (opts.now !== undefined && action.actedAt > opts.now + 5 * 60_000) continue

    switch (action.kind) {
      case AnchorActionKind.Retire:
        retirements.push({
          action,
          anchorPub: action.anchorPub,
          fingerprint: fingerprintFromId(action.anchorPub),
        })
        break

      case AnchorActionKind.Rotate: {
        if (!action.targetPub) break
        // Already followed — nothing to decide.
        if (trusted.has(action.targetPub)) break
        rotations.push({
          action,
          from: action.anchorPub,
          to: action.targetPub,
          fromFingerprint: fingerprintFromId(action.anchorPub),
          toFingerprint: fingerprintFromId(action.targetPub),
        })
        break
      }

      case AnchorActionKind.Endorse: {
        if (!action.targetPub) break
        if (trusted.has(action.targetPub)) break
        const existing = byCandidate.get(action.targetPub)
        if (existing) {
          if (!existing.endorsedBy.includes(action.anchorPub)) {
            existing.endorsedBy.push(action.anchorPub)
            if (action.note) existing.notes.push(action.note)
          }
        } else {
          byCandidate.set(action.targetPub, {
            candidate: action.targetPub,
            fingerprint: fingerprintFromId(action.targetPub),
            endorsedBy: [action.anchorPub],
            notes: action.note ? [action.note] : [],
          })
        }
        break
      }
    }
  }

  // Most-endorsed first: a key several anchors recognise is worth looking at
  // before one only a single anchor mentioned.
  const candidates = [...byCandidate.values()].sort(
    (a, b) => b.endorsedBy.length - a.endorsedBy.length || (a.candidate < b.candidate ? -1 : 1),
  )

  if (rejected > 0) {
    log.warn('trust', 'discarded anchor actions that failed verification', { rejected })
  }

  return { retirements, rotations, candidates, rejected }
}

/**
 * Applies a rotation to an anchor list — pure, so the caller decides when.
 *
 * Replaces rather than adds: following a rotation and keeping the old key would
 * leave a key the anchor has explicitly abandoned still rooting the graph,
 * which is the exact situation rotation exists to end.
 */
export function applyRotation(
  anchors: readonly PubKeyId[],
  rotation: { from: PubKeyId; to: PubKeyId },
): PubKeyId[] {
  const next = anchors.filter((a) => a !== rotation.from)
  if (!next.includes(rotation.to)) next.push(rotation.to)
  return next
}

export function applyRetirement(anchors: readonly PubKeyId[], anchorPub: PubKeyId): PubKeyId[] {
  return anchors.filter((a) => a !== anchorPub)
}
