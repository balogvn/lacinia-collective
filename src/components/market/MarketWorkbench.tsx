'use client'

import Link from 'next/link'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

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
  const benchRef = useRef<HTMLDivElement>(null)

  /*
    Bring the bench into view when it opens.

    It renders above the listing board, so tapping Settle on a listing far down
    the page opened it 1,300px off-screen. Nothing visibly happened, which reads
    as a dead button rather than as a scroll position, and the one thing nobody
    does in response is scroll up to look for what they just summoned.
  */
  useLayoutEffect(() => {
    if (!benchOpen && !settling) return
    /*
      Synchronous, and repeated on a timer rather than a frame.

      Two things defeated the obvious version. The browser's scroll anchoring
      adds the inserted bench's own height to scrollY to keep the content under
      your finger still, which silently undid the scroll (hence
      overflow-anchor:none on the wrapper). And a requestAnimationFrame
      scheduled from an effect never fired at all: the surrounding block
      re-renders while the marketplace refreshes, the wrapper unmounts, and
      cleanup cancels the frame before it runs. Measured: the effect ran once,
      the callback zero times.

      useLayoutEffect scrolls before paint with no frame to cancel, and the
      short timer re-asserts it after the panels above finish resizing, which
      was worth 118px, the height of the bench's own heading.
    */
    const align = () => benchRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' })
    align()
    const settle = setTimeout(align, 120)
    return () => clearTimeout(settle)
  }, [benchOpen, settling])

  /*
    Opened by /aid#settle, so a link can land someone straight on the bench
    rather than on the page with the bench somewhere below the fold.
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
    /*
      overflow-anchor:none is load-bearing, not a tweak.

      The bench is inserted ABOVE the listing board, and the browser's scroll
      anchoring "helpfully" adds the inserted height to scrollY so the content
      under your finger does not jump. Measured: our scrollIntoView landed the
      bench at top (scrollY 828), then anchoring added 539 straight back, giving
      1367 and a bench 539px above the fold. The scroll was working and being
      reverted a frame later, which is why tapping Settle looked like a dead
      button. Turning anchoring off in this subtree lets the scroll stand.
    */
    <div className="space-y-8 [overflow-anchor:none]">
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
            <div ref={benchRef} className="scroll-mt-4">
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
            </div>
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
