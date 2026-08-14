'use client'

import Link from 'next/link'
import { useState } from 'react'

import { useCommons } from '@/hooks/useCommons'
import { useMarketplace } from '@/hooks/useMarketplace'
import { BalanceCard } from './BalanceCard'
import { ListingBoard } from './ListingBoard'
import { ListingComposer } from './ListingComposer'
import { SettlementBench } from './SettlementBench'
import { LedgerHistory } from './LedgerHistory'
import type { ResourceListing } from '@/lib/db/schema'

export function MarketWorkbench() {
  const commons = useCommons()
  const market = useMarketplace(commons.identity?.pubKey ?? null)
  const [settling, setSettling] = useState<ResourceListing | null>(null)
  const [benchOpen, setBenchOpen] = useState(false)

  if (!commons.ready || !market.ready) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-wider text-paper-dim">
        Opening local database…
      </p>
    )
  }

  if (!commons.identity || !commons.keyPair) {
    return (
      <section className="border border-paper/30 p-5 sm:p-7">
        <p className="eyebrow">An identity is needed first</p>
        <h2 className="mt-3 font-display text-3xl uppercase text-paper sm:text-4xl">
          Nothing here works anonymously
        </h2>
        <p className="mt-3 max-w-xl font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
          Every exchange is signed by both people. Create a keypair, then come back — it takes a few
          seconds and needs no email or password.
        </p>
        <Link href="/identity" className="btn btn-solid mt-6">
          Create an identity →
        </Link>
      </section>
    )
  }

  const error = market.error ?? commons.error
  if (error) {
    return (
      <div className="border border-alarm/60 bg-alarm/10 p-5">
        <p className="eyebrow text-alarm">Local storage unavailable</p>
        <p className="mt-3 max-w-lg font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper">
          {error}
        </p>
      </div>
    )
  }

  const myEntries = market.entries.filter(
    (e) => e.fromPub === commons.identity!.pubKey || e.toPub === commons.identity!.pubKey,
  )

  return (
    <div className="space-y-8">
      {market.balance ? (
        <BalanceCard
          balance={market.balance}
          tier={market.myTier}
          entryCount={myEntries.length}
          zeroSum={market.zeroSum}
        />
      ) : null}

      {benchOpen || settling ? (
        <SettlementBench
          keyPair={commons.keyPair}
          balances={market.balances}
          tierOf={market.tierOf}
          listing={settling}
          onRecord={market.recordSettlement}
          onClose={() => {
            setSettling(null)
            setBenchOpen(false)
          }}
        />
      ) : (
        <button onClick={() => setBenchOpen(true)} className="btn btn-solid">
          Settle an exchange
        </button>
      )}

      <ListingComposer
        identity={commons.identity}
        myTier={market.myTier}
        onPublish={market.publishListing}
      />

      <ListingBoard
        listings={market.listings}
        people={market.people}
        selfPub={commons.identity.pubKey}
        myTier={market.myTier}
        {...(commons.identity.locality?.lga ? { myLga: commons.identity.locality.lga } : {})}
        onSettle={(listing) => {
          setSettling(listing)
          setBenchOpen(true)
        }}
        onWithdraw={(listing) =>
          void market.withdrawListing(listing.id, listing.authorPub)
        }
      />

      <LedgerHistory
        entries={market.entries}
        people={market.people}
        selfPub={commons.identity.pubKey}
      />

      <p className="font-mono text-[10px] uppercase tracking-wider text-paper/35">
        <Link href="/identity" className="underline underline-offset-4 hover:text-paper">
          ← Identity and standing
        </Link>
      </p>
    </div>
  )
}
