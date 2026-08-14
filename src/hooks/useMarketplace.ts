'use client'

import { useCallback, useEffect, useState } from 'react'

import {
  listOpenListings,
  listLedgerEntries,
  listIdentities,
  listVouchers,
  getAnchors,
  revalidateLedger,
  saveListing,
  tombstoneListing,
  saveLedgerEntry,
  stamp,
} from '@/lib/db/repo'
import { computeTrustGraph, lookupTrust } from '@/lib/vouch/trust'
import { computeBalances, lookupBalance, auditZeroSum, type BalanceView } from '@/lib/ledger/balance'
import { contentId } from '@/lib/crypto/keys'
import {
  TrustTier,
  ListingStatus,
  type ResourceListing,
  type LedgerEntry,
  type UserIdentity,
  type PubKeyId,
} from '@/lib/db/schema'
import { log } from '@/lib/telemetry'

export interface MarketplaceState {
  ready: boolean
  listings: ResourceListing[]
  entries: LedgerEntry[]
  people: UserIdentity[]
  balance: BalanceView | null
  balances: Map<PubKeyId, BalanceView>
  tierOf: (pubKey: PubKeyId) => TrustTier
  myTier: TrustTier
  zeroSum: boolean
  error: string | null
}

/**
 * Marketplace + ledger view.
 *
 * Trust and balances are recomputed together because they are coupled: a
 * person's credit limit comes from their tier, so a newly-merged vouch changes
 * what they may borrow. Computing them separately would let the two drift
 * within a single render.
 */
export function useMarketplace(selfPub: PubKeyId | null) {
  const [state, setState] = useState<MarketplaceState>({
    ready: false,
    listings: [],
    entries: [],
    people: [],
    balance: null,
    balances: new Map(),
    tierOf: () => TrustTier.Observer,
    myTier: TrustTier.Observer,
    zeroSum: true,
    error: null,
  })

  const refresh = useCallback(async () => {
    try {
      // Drop any entry that fails its two-signature check before it can poison
      // a balance. A forged entry does not merely misreport — it creates
      // credits from nothing.
      await revalidateLedger()

      const [listings, entries, people, vouchers, anchors] = await Promise.all([
        listOpenListings(),
        listLedgerEntries(),
        listIdentities(),
        listVouchers(),
        getAnchors(),
      ])

      const graph = computeTrustGraph(vouchers, anchors)
      const tierOf = (pubKey: PubKeyId): TrustTier => lookupTrust(graph, pubKey).tier

      const balances = computeBalances(entries, tierOf, selfPub)
      const audit = auditZeroSum(balances)

      const myTier = selfPub ? tierOf(selfPub) : TrustTier.Observer
      const balance = selfPub ? lookupBalance(balances, selfPub, myTier, true) : null

      setState({
        ready: true,
        listings,
        entries,
        people,
        balance,
        balances,
        tierOf,
        myTier,
        zeroSum: audit.ok,
        error: null,
      })
    } catch (err) {
      log.error('db', 'marketplace refresh failed', { error: String(err) })
      setState((s) => ({ ...s, ready: true, error: err instanceof Error ? err.message : String(err) }))
    }
  }, [selfPub])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const publishListing = useCallback(
    async (input: Omit<ResourceListing, 'id' | 'hlc' | 'createdAt' | 'status'>) => {
      const createdAt = Date.now()
      const hlc = await stamp()
      // Content-addressed so two devices cannot mint the same id, and a
      // re-published identical listing is the same row rather than a duplicate.
      const id = contentId(
        new TextEncoder().encode(`${input.authorPub}|${createdAt}|${input.title}`),
      )
      await saveListing({ ...input, id, createdAt, status: ListingStatus.Open, hlc })
      await refresh()
      return id
    },
    [refresh],
  )

  const withdrawListing = useCallback(
    async (id: string, authorPub: PubKeyId) => {
      await tombstoneListing(id, authorPub)
      await refresh()
    },
    [refresh],
  )

  const recordSettlement = useCallback(
    async (entry: LedgerEntry) => {
      const result = await saveLedgerEntry(entry)
      await refresh()
      return result
    },
    [refresh],
  )

  return { ...state, refresh, publishListing, withdrawListing, recordSettlement }
}
