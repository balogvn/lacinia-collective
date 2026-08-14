'use client'

import { useCallback, useEffect, useState } from 'react'

import {
  type KeyPair,
  keyPairFromPhrase,
  keyPairFromSecret,
  generateRecoveryPhrase,
} from '@/lib/crypto/keys'
import { toBase64Url, fromBase64Url } from '@/lib/codec'
import {
  createSelfIdentity,
  getSelf,
  getVault,
  saveVault,
  listVouchers,
  saveVoucher,
  getAnchors,
  setAnchors,
  revalidateVouchers,
  stamp,
  upsertPeer,
  listIdentities,
  setActiveSigner,
  resignLegacyOps,
  listRevocations,
  saveRevocation,
} from '@/lib/db/repo'
import { applyRevocations, createRevocation } from '@/lib/moderate/revoke'
import { sealSecret, openSecret } from '@/lib/crypto/vault'
import { setSessionKey, getSessionKey } from '@/lib/crypto/session'
import type { RevocationReason } from '@/lib/db/schema'
import { computeTrustGraph, lookupTrust, type TrustGraph, type TrustNode } from '@/lib/vouch/trust'
import { TrustTier, type TrustVoucher, type UserIdentity, type Locality } from '@/lib/db/schema'
import { log } from '@/lib/telemetry'

export interface CommonsState {
  ready: boolean
  identity: UserIdentity | null
  keyPair: KeyPair | null
  vouchers: TrustVoucher[]
  peers: UserIdentity[]
  graph: TrustGraph | null
  trust: TrustNode | null
  anchors: string[]
  /** Twelve words, present until the user confirms they wrote them down. */
  recoveryPhrase: string | null
  phraseAcknowledged: boolean
  /** True when a PIN is set and this session has not unlocked it yet. */
  locked: boolean
  /** True when a PIN is set at all, unlocked or not. */
  hasPin: boolean
  error: string | null
}

/**
 * Single source of truth for the identity + trust view.
 *
 * Everything is loaded from IndexedDB, never from a network call — the hook has
 * no notion of "loading from server" because there is no server. `refresh()`
 * re-reads local state after any mutation.
 */
export function useCommons() {
  const [state, setState] = useState<CommonsState>({
    ready: false,
    identity: null,
    keyPair: null,
    vouchers: [],
    peers: [],
    graph: null,
    trust: null,
    anchors: [],
    recoveryPhrase: null,
    phraseAcknowledged: true,
    locked: false,
    hasPin: false,
    error: null,
  })

  const refresh = useCallback(async () => {
    try {
      const [identity, vault, anchors, peers] = await Promise.all([
        getSelf(),
        getVault(),
        getAnchors(),
        listIdentities(),
      ])

      // Re-verify every stored voucher before it influences anything. A row in
      // IndexedDB is not evidence — see reverifyStoredVoucher.
      await revalidateVouchers()
      const [rawVouchers, revocations] = await Promise.all([listVouchers(), listRevocations()])

      // Revocations are applied before the graph is built, never after. A
      // revoked vouch must stop conferring standing immediately — the whole
      // point of revocation is that it outruns the trust it cancels.
      const vouchers = applyRevocations(rawVouchers, revocations)

      let keyPair: KeyPair | null = null
      if (vault?.plainSecret) {
        try {
          keyPair = keyPairFromSecret(fromBase64Url(vault.plainSecret))
        } catch (err) {
          log.error('crypto', 'stored secret failed to load', { error: String(err) })
        }
      } else if (vault?.sealed) {
        // Sealed: the only usable key is whatever this session unlocked, held
        // in memory. Nothing on disk can produce it.
        keyPair = getSessionKey()
      }

      const hasPin = !!vault?.sealed
      const locked = hasPin && !keyPair

      // Every write now emits a signed op, so the repo needs a key before any
      // mutation. Installing it here — after the vault is read and on every
      // refresh — keeps crypto plumbing out of the UI callsites.
      setActiveSigner(keyPair)

      // Ops written before Task 2 have no signature and would never publish.
      // Cheap no-op once they have all been upgraded.
      if (keyPair) await resignLegacyOps(keyPair)

      const graph = computeTrustGraph(vouchers, anchors)
      const trust = identity ? lookupTrust(graph, identity.pubKey) : null

      setState({
        ready: true,
        identity: identity ?? null,
        keyPair,
        vouchers,
        peers: peers.filter((p) => !p.isSelf),
        graph,
        trust,
        anchors,
        recoveryPhrase: vault?.recoveryPhrase ?? null,
        locked,
        hasPin,
        // Default to true when there is no vault at all, so the gate only fires
        // for a real, un-acknowledged identity.
        phraseAcknowledged: vault ? vault.phraseAcknowledged : true,
        error: null,
      })
    } catch (err) {
      log.error('db', 'refresh failed', { error: String(err) })
      setState((s) => ({ ...s, ready: true, error: err instanceof Error ? err.message : String(err) }))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Creates the device identity and returns the recovery phrase exactly once. */
  const createIdentity = useCallback(
    async (input: {
      displayName: string
      locality?: Locality
    }): Promise<{ phrase: string; keyPair: KeyPair }> => {
      const phrase = generateRecoveryPhrase()
      const keyPair = keyPairFromPhrase(phrase)

      await createSelfIdentity(keyPair, input)
      await saveVault({
        id: 'self',
        pubKey: keyPair.pubKeyId,
        // Unencrypted by default; the PIN is opt-in. See the threat model in
        // crypto/vault.ts for why that is the honest default here.
        plainSecret: toBase64Url(keyPair.secretKey),
        recoveryPhrase: phrase,
        phraseAcknowledged: false,
        createdAt: Date.now(),
      })

      await refresh()
      return { phrase, keyPair }
    },
    [refresh],
  )

  /** Called only after the user ticks "I have written these down". */
  const acknowledgePhrase = useCallback(async () => {
    const vault = await getVault()
    if (!vault) return
    await saveVault({ ...vault, phraseAcknowledged: true })
    await refresh()
  }, [refresh])

  const restoreIdentity = useCallback(
    async (phrase: string, displayName: string): Promise<KeyPair> => {
      const keyPair = keyPairFromPhrase(phrase)
      await createSelfIdentity(keyPair, { displayName })
      await saveVault({
        id: 'self',
        pubKey: keyPair.pubKeyId,
        plainSecret: toBase64Url(keyPair.secretKey),
        phraseAcknowledged: true,
        createdAt: Date.now(),
      })
      await refresh()
      return keyPair
    },
    [refresh],
  )

  const storeVoucher = useCallback(
    async (voucher: TrustVoucher, peerName?: string) => {
      const hlc = await stamp()
      const result = await saveVoucher({ ...voucher, hlc })
      if (peerName) {
        // Whichever end is not us. Derived, for the reason in schema.ts.
        const self = state.identity?.pubKey
        const peerKey = voucher.subjectPub === self ? voucher.issuerPub : voucher.subjectPub
        await upsertPeer(peerKey, peerName)
      }
      await refresh()
      return result
    },
    [refresh],
  )

  /**
   * Seals the key under a PIN.
   *
   * CLEARING THE RECOVERY PHRASE IS THE WHOLE POINT, not tidying up. The phrase
   * derives the key on its own, so leaving it in plaintext in the same
   * IndexedDB row would mean an attacker never bothers with the ciphertext —
   * they read the twelve words and walk. Sealing the key while leaving the
   * phrase beside it protects nothing at all.
   *
   * The consequence is real and the UI states it: after this, the phrase exists
   * only wherever the user wrote it down.
   */
  const setPin = useCallback(
    async (pin: string) => {
      const vault = await getVault()
      if (!vault?.plainSecret) throw new Error('No unlocked key to protect.')

      const keyPair = keyPairFromSecret(fromBase64Url(vault.plainSecret))
      const sealed = await sealSecret(keyPair.secretKey, pin)

      await saveVault({
        id: 'self',
        pubKey: vault.pubKey,
        sealed,
        phraseAcknowledged: vault.phraseAcknowledged,
        createdAt: vault.createdAt,
        // plainSecret and recoveryPhrase deliberately omitted — see above.
      })

      // Keep the user working; they just set the PIN, they should not be
      // bounced to an unlock screen for it.
      setSessionKey(keyPair)
      await refresh()
    },
    [refresh],
  )

  const unlock = useCallback(
    async (pin: string) => {
      const vault = await getVault()
      if (!vault?.sealed) throw new Error('This device has no PIN set.')
      const secret = await openSecret(vault.sealed, pin)
      setSessionKey(keyPairFromSecret(secret))
      await refresh()
    },
    [refresh],
  )

  /**
   * Removes the PIN, returning the key to plaintext at rest.
   *
   * The recovery phrase does NOT come back — it was destroyed when the PIN was
   * set, and nothing on the device can reproduce it.
   */
  const removePin = useCallback(
    async (pin: string) => {
      const vault = await getVault()
      if (!vault?.sealed) throw new Error('This device has no PIN set.')
      // Re-derive from the PIN rather than trusting the session key, so this
      // cannot be triggered by someone who wandered up to an unlocked screen.
      const secret = await openSecret(vault.sealed, pin)
      const keyPair = keyPairFromSecret(secret)

      await saveVault({
        id: 'self',
        pubKey: vault.pubKey,
        plainSecret: toBase64Url(secret),
        phraseAcknowledged: vault.phraseAcknowledged,
        createdAt: vault.createdAt,
      })
      setSessionKey(keyPair)
      await refresh()
    },
    [refresh],
  )

  const lockNow = useCallback(async () => {
    setSessionKey(null)
    await refresh()
  }, [refresh])

  /** Withdraw a vouch you gave. Only the issuer can, enforced in createRevocation. */
  const revokeVoucher = useCallback(
    async (voucher: TrustVoucher, reason: RevocationReason) => {
      if (!state.keyPair) throw new Error('No identity loaded.')
      await saveRevocation(createRevocation(state.keyPair, voucher, reason))
      await refresh()
    },
    [state.keyPair, refresh],
  )

  const addAnchor = useCallback(
    async (pubKey: string) => {
      const current = await getAnchors()
      await setAnchors([...current, pubKey])
      await refresh()
    },
    [refresh],
  )

  return {
    ...state,
    refresh,
    createIdentity,
    restoreIdentity,
    storeVoucher,
    addAnchor,
    acknowledgePhrase,
    revokeVoucher,
    setPin,
    unlock,
    removePin,
    lockNow,
  }
}

export { TrustTier }
