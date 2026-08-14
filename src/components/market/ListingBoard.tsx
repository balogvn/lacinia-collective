'use client'

import { useMemo, useState } from 'react'

import { formatCredits } from '@/lib/ledger/balance'
import { fingerprintFromId } from '@/lib/crypto/keys'
import {
  ResourceCategory,
  ResourceKind,
  TrustTier,
  TRUST_TIER_LABELS,
  type ResourceListing,
  type UserIdentity,
  type PubKeyId,
} from '@/lib/db/schema'

interface Props {
  listings: ResourceListing[]
  people: UserIdentity[]
  selfPub: PubKeyId
  myTier: TrustTier
  myLga?: string
  onSettle: (listing: ResourceListing) => void
  onWithdraw: (listing: ResourceListing) => void
}

const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  [ResourceCategory.Food]: 'Food',
  [ResourceCategory.Clothing]: 'Clothing',
  [ResourceCategory.Skill]: 'Skill',
  [ResourceCategory.Transport]: 'Transport',
  [ResourceCategory.Shelter]: 'Shelter',
  [ResourceCategory.Tools]: 'Tools',
  [ResourceCategory.Care]: 'Care',
  [ResourceCategory.Medicine]: 'Medicine',
  [ResourceCategory.Education]: 'Education',
  [ResourceCategory.Other]: 'Other',
}

export function ListingBoard({
  listings,
  people,
  selfPub,
  myTier,
  myLga,
  onSettle,
  onWithdraw,
}: Props) {
  const [kind, setKind] = useState<ResourceKind | 'ALL'>('ALL')
  const [category, setCategory] = useState<ResourceCategory | 'ALL'>('ALL')
  const [nearbyOnly, setNearbyOnly] = useState(false)

  const nameFor = (pubKey: PubKeyId): string =>
    people.find((p) => p.pubKey === pubKey)?.displayName ?? fingerprintFromId(pubKey)

  const visible = useMemo(() => {
    return listings
      .filter((l) => (kind === 'ALL' ? true : l.kind === kind))
      .filter((l) => (category === 'ALL' ? true : l.category === category))
      .filter((l) => (nearbyOnly && myLga ? l.locality.lga === myLga : true))
      .sort((a, b) => {
        // Aid is intensely local — a bag of rice in Ikorodu is useless in Kano,
        // so same-LGA listings sort first regardless of recency.
        if (myLga) {
          const aNear = a.locality.lga === myLga ? 0 : 1
          const bNear = b.locality.lga === myLga ? 0 : 1
          if (aNear !== bNear) return aNear - bNear
        }
        return b.createdAt - a.createdAt
      })
  }, [listings, kind, category, nearbyOnly, myLga])

  return (
    <section className="border border-paper/30">
      <div className="flex flex-wrap items-center gap-3 border-b border-paper/25 p-5">
        <p className="eyebrow">Offers and requests</p>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-paper/40">
          {visible.length} of {listings.length}
        </span>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-paper/25 p-5">
        {(['ALL', ResourceKind.Offer, ResourceKind.Request] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-wider transition-colors ${
              kind === k
                ? 'border-paper bg-paper text-canvas'
                : 'border-paper/30 text-paper-dim hover:border-paper/70'
            }`}
          >
            {k === 'ALL' ? 'Everything' : k === ResourceKind.Offer ? 'Offered' : 'Needed'}
          </button>
        ))}

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as ResourceCategory | 'ALL')}
          className="field w-auto py-2 text-[10px] uppercase tracking-wider"
        >
          <option value="ALL">All categories</option>
          {Object.values(ResourceCategory).map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>

        {myLga ? (
          <button
            onClick={() => setNearbyOnly((v) => !v)}
            aria-pressed={nearbyOnly}
            className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-wider transition-colors ${
              nearbyOnly
                ? 'border-paper bg-paper text-canvas'
                : 'border-paper/30 text-paper-dim hover:border-paper/70'
            }`}
          >
            {myLga} only
          </button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <p className="p-5 font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
          Nothing here yet. Post what you can offer, or sync with a commons to see what neighbours
          have shared.
        </p>
      ) : (
        <ul>
          {visible.map((listing) => {
            const mine = listing.authorPub === selfPub
            const locked = listing.minTrustTier > myTier
            const isGift = listing.timeCredits === 0

            return (
              <li key={listing.id} className="border-b border-paper/15 p-5 last:border-b-0">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="border border-paper/30 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-paper-dim">
                        {listing.kind === ResourceKind.Offer ? 'Offered' : 'Needed'}
                      </span>
                      <span className="font-mono text-[9px] uppercase tracking-wider text-paper/40">
                        {CATEGORY_LABELS[listing.category]}
                      </span>
                    </div>

                    <h3 className="mt-2 font-display text-2xl uppercase text-paper">
                      {listing.title}
                    </h3>

                    {listing.description ? (
                      <p className="mt-1.5 max-w-2xl font-mono text-[11px] leading-relaxed text-paper-dim">
                        {listing.description}
                      </p>
                    ) : null}

                    <p className="mt-2.5 font-mono text-[10px] uppercase tracking-wider text-paper/45">
                      {nameFor(listing.authorPub)} · {listing.locality.lga}, {listing.locality.state}
                      {listing.quantity > 1 ? ` · ${listing.quantity}${listing.unit ? ` ${listing.unit}` : ''}` : ''}
                    </p>
                  </div>

                  <div className="text-right">
                    <p className="font-mono text-2xl text-paper">
                      {isGift ? 'Gift' : formatCredits(listing.timeCredits)}
                    </p>
                    <p className="font-mono text-[9px] uppercase tracking-wider text-paper/40">
                      {isGift ? 'outside the ledger' : 'time credits'}
                    </p>

                    <div className="mt-3 flex justify-end gap-2">
                      {mine ? (
                        <button
                          onClick={() => onWithdraw(listing)}
                          className="border border-paper/30 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-paper-dim transition-colors hover:border-alarm hover:text-alarm"
                        >
                          Withdraw
                        </button>
                      ) : (
                        <button
                          onClick={() => onSettle(listing)}
                          disabled={locked}
                          className="btn disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          {isGift ? 'Arrange' : 'Settle'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/*
                  A trust gate with no explanation reads as arbitrary exclusion,
                  which is how you get a community that distrusts the tool.
                  Always say what is required and how to get there.
                */}
                {locked && !mine ? (
                  <p className="mt-3 border-l border-signal/60 pl-3 font-mono text-[10px] uppercase leading-relaxed tracking-wider text-signal">
                    Needs {TRUST_TIER_LABELS[listing.minTrustTier]} standing — you are{' '}
                    {TRUST_TIER_LABELS[myTier]}. Ask a neighbour who already belongs to vouch for
                    you in person.
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
