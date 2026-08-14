'use client'

import { useCallback, useEffect, useState } from 'react'

import {
  listFlags,
  saveFlag,
  withdrawFlag,
  myFlagFor,
  listVouchers,
  listRevocations,
  getAnchors,
} from '@/lib/db/repo'
import { createFlag } from '@/lib/moderate/flag'
import { applyRevocations } from '@/lib/moderate/revoke'
import { buildPolicy, type PolicyPreset, type VisibilityVerdict } from '@/lib/moderate/policy'
import { computeTrustGraph, lookupTrust } from '@/lib/vouch/trust'
import type { ParticipantPoint } from '@/lib/deliberate/cluster'
import {
  TrustTier,
  type Flag,
  type FlagReason,
  type FlagTarget,
  type PubKeyId,
} from '@/lib/db/schema'
import type { KeyPair } from '@/lib/crypto/keys'
import { log } from '@/lib/telemetry'

const PRESET_KEY = 'lacinia.moderationPreset'

function loadPreset(): PolicyPreset {
  if (typeof localStorage === 'undefined') return 'standard'
  const stored = localStorage.getItem(PRESET_KEY)
  return stored === 'open' || stored === 'cautious' ? stored : 'standard'
}

/**
 * Moderation view.
 *
 * The policy is rebuilt whenever flags or trust change, because a flag's weight
 * depends on its author's standing — a newly-merged vouch can change what is
 * hidden. Computing them separately would let the two drift within a render.
 */
export function useModeration(selfPub: PubKeyId | null, participants?: ParticipantPoint[]) {
  const [flags, setFlags] = useState<Flag[]>([])
  const [preset, setPresetState] = useState<PolicyPreset>('standard')
  const [evaluate, setEvaluate] = useState<
    (targetId: string, authorPub: PubKeyId) => VisibilityVerdict
  >(() => () => ({
    visibility: 'VISIBLE' as never,
    reason: '',
    flagReason: null,
    flagCount: 0,
    corroboration: 0,
    evidencedGroups: 0,
    flaggedByYou: false,
  }))
  const [ready, setReady] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [allFlags, rawVouchers, revocations, anchors] = await Promise.all([
        listFlags(),
        listVouchers(),
        listRevocations(),
        getAnchors(),
      ])

      // Revocations first: a revoked voucher must not still be lending weight
      // to its subject's flags.
      const vouchers = applyRevocations(rawVouchers, revocations)
      const graph = computeTrustGraph(vouchers, anchors)
      const tierOf = (pubKey: PubKeyId): TrustTier => lookupTrust(graph, pubKey).tier

      const policy = buildPolicy({
        selfPub: selfPub ?? '',
        flags: allFlags,
        tierOf,
        ...(participants ? { participants } : {}),
        preset: loadPreset(),
      })

      setFlags(allFlags)
      setPresetState(loadPreset())
      // Wrapped in a thunk — React would otherwise call the function as an updater.
      setEvaluate(() => policy)
      setReady(true)
    } catch (err) {
      log.error('trust', 'moderation refresh failed', { error: String(err) })
      setReady(true)
    }
  }, [selfPub, participants])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const raiseFlag = useCallback(
    async (
      keyPair: KeyPair,
      input: { targetId: string; targetEntity: FlagTarget; reason: FlagReason; conversationId?: string },
    ) => {
      await saveFlag(createFlag(keyPair, input))
      await refresh()
    },
    [refresh],
  )

  const dropFlag = useCallback(
    async (targetId: string) => {
      if (!selfPub) return
      const existing = await myFlagFor(targetId, selfPub)
      if (existing) await withdrawFlag(existing.id)
      await refresh()
    },
    [selfPub, refresh],
  )

  const setPreset = useCallback(
    async (next: PolicyPreset) => {
      localStorage.setItem(PRESET_KEY, next)
      await refresh()
    },
    [refresh],
  )

  const flaggedByMe = useCallback(
    (targetId: string) =>
      flags.some((f) => !f.deleted && f.targetId === targetId && f.authorPub === selfPub),
    [flags, selfPub],
  )

  return { ready, flags, preset, setPreset, evaluate, raiseFlag, dropFlag, flaggedByMe, refresh }
}
