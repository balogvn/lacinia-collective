'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { useCommons } from '@/hooks/useCommons'
import { useFirstRun } from '@/hooks/useFirstRun'
import { FirstRunPanel } from '@/components/onboard/FirstRunPanel'
import { UnlockGate } from '@/components/identity/UnlockGate'
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
  const firstRun = useFirstRun(!!commons.identity)

  /*
    Opened by /aid#settle, which is where the translation queue sends someone
    who wants to be paid for a rendering. A link that landed on this page and
    left them to find the bench themselves would be the same broken promise the
    copy over there used to make.
  */
  useEffect(() => {
    if (typeof window === 'undefined') return
    const open = () => {
      if (window.location.hash === '#settle') setBenchOpen(true)
    }
    open()
    window.addEventListener('hashchange', open)
    return () => window.removeEventListener('hashchange', open)
  }, [])

  if (!commons.ready || !market.ready) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-wider text-paper-dim">
        Opening local database…
      </p>
    )
  }

  // Locked: signing is impossible, so every action here would fail. Gate
  // before the "create an identity" branch, which would otherwise invite
  // overwriting a key that merely needs unlocking.
  if (commons.locked) {
    return <UnlockGate onUnlock={commons.unlock} />
  }

  /*
    NO GATE ON READING. This used to return a "nothing here works anonymously"
    wall for any device without a keypair — which was false, and expensively so:
    `runSync()` takes no key, so a guest device can already be holding a whole
    commons, and the wall hid records it had just downloaded and verified. Only
    the actions that carry a signature need a key, and each gates itself below.
  */
  const guest = !commons.identity || !commons.keyPair

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

  const selfPub = commons.identity?.pubKey ?? ''
  const myEntries = market.entries.filter(
    (e) => e.fromPub === selfPub || e.toPub === selfPub,
  )

  return (
    <div className="space-y-8">
      <FirstRunPanel
        state={firstRun.state}
        onChanged={async () => {
          await market.refresh()
          await commons.refresh()
          await firstRun.refresh()
        }}
      />

      {/* Signed surfaces, all of which need a key. A guest sees the board. */}
      {!guest && commons.identity && commons.keyPair ? (
        <>
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
        </>
      ) : null}

      <ListingBoard
        listings={market.listings}
        people={market.people}
        selfPub={selfPub}
        myTier={market.myTier}
        canAct={!guest}
        {...(commons.identity?.locality ? { myLocality: commons.identity.locality } : {})}
        onSettle={(listing) => {
          setSettling(listing)
          setBenchOpen(true)
        }}
        onWithdraw={(listing) =>
          void market.withdrawListing(listing.id, listing.authorPub)
        }
      />

      {!guest ? (
        <LedgerHistory entries={market.entries} people={market.people} selfPub={selfPub} />
      ) : null}

      <p className="font-mono text-[10px] uppercase tracking-wider text-paper/35">
        <Link href="/identity" className="underline underline-offset-4 hover:text-paper">
          ← Identity and standing
        </Link>
      </p>
    </div>
  )
}
