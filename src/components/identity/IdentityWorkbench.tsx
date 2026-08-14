'use client'

import Link from 'next/link'
import { useState } from 'react'

import { useCommons } from '@/hooks/useCommons'
import { CreateIdentity } from './CreateIdentity'
import { RecoveryPhrase } from './RecoveryPhrase'
import { IdentityCard } from './IdentityCard'
import { VouchBench } from './VouchBench'
import { VouchList } from './VouchList'
import { AnchorPanel } from './AnchorPanel'
import { SyncPanel } from '@/components/sync/SyncPanel'
import { TrustTier } from '@/lib/db/schema'
import { dumpTelemetry } from '@/lib/telemetry'
import { estimateStorage } from '@/lib/db/db'

export function IdentityWorkbench() {
  const commons = useCommons()
  const [storage, setStorage] = useState<string | null>(null)
  const [showPhrase, setShowPhrase] = useState(false)

  const showDiagnostics = async () => {
    const est = await estimateStorage()
    setStorage(
      est
        ? `${(est.usage / 1024).toFixed(1)} KB used of ${(est.quota / 1024 / 1024).toFixed(0)} MB granted`
        : 'Storage estimate unavailable in this browser',
    )
    // Full structured log to the console — this is the report a user pastes
    // into a message when something goes wrong offline.
    console.log(dumpTelemetry())
  }

  if (!commons.ready) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-wider text-paper-dim">
        Opening local database…
      </p>
    )
  }

  if (commons.error) {
    return (
      <div className="border border-alarm/60 bg-alarm/10 p-5">
        <p className="eyebrow text-alarm">Local storage unavailable</p>
        <p className="mt-3 max-w-lg font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper">
          {commons.error}
        </p>
        <p className="mt-3 max-w-lg font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
          Private browsing blocks IndexedDB in some browsers. Lacinia cannot hold an identity
          without it.
        </p>
      </div>
    )
  }

  if (!commons.identity || !commons.keyPair) {
    return (
      <CreateIdentity
        onCreate={commons.createIdentity}
        onRestore={commons.restoreIdentity}
      />
    )
  }

  // Gate everything behind the recovery phrase until it is acknowledged.
  // Survives a reload, because an identity whose phrase was never recorded is
  // one lost handset away from being gone permanently.
  if (!commons.phraseAcknowledged && commons.recoveryPhrase) {
    return (
      <RecoveryPhrase
        phrase={commons.recoveryPhrase}
        onAcknowledge={commons.acknowledgePhrase}
      />
    )
  }

  if (showPhrase && commons.recoveryPhrase) {
    return (
      <RecoveryPhrase
        phrase={commons.recoveryPhrase}
        onAcknowledge={() => setShowPhrase(false)}
        revisiting
      />
    )
  }

  const inbound = commons.vouchers.filter((v) => v.direction === 'INBOUND')

  return (
    <div className="space-y-8">
      <IdentityCard
        identity={commons.identity}
        trust={commons.trust}
        voucherCount={inbound.length}
      />

      <div id="how">
        <VouchBench
          identity={commons.identity}
          keyPair={commons.keyPair}
          onStore={commons.storeVoucher}
          grantableTier={commons.trust?.tier ?? TrustTier.Observer}
        />
      </div>

      <div id="sync">
        <SyncPanel keyPair={commons.keyPair} onMerged={commons.refresh} />
      </div>

      <AnchorPanel anchors={commons.anchors} onChange={commons.refresh} />

      <VouchList
        vouchers={commons.vouchers}
        peers={commons.peers}
        selfPub={commons.identity.pubKey}
        onRevoke={commons.revokeVoucher}
      />

      {/* ── docs / honesty section ──────────────────────────────────── */}
      <section id="docs" className="border border-paper/30 p-5 sm:p-7">
        <p className="eyebrow">What this build does and does not do</p>
        <h2 className="mt-3 font-display text-3xl uppercase text-paper sm:text-4xl">
          Task 1 — foundation
        </h2>

        <div className="mt-6 grid gap-8 lg:grid-cols-2">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-paper">Working now</p>
            <ul className="mt-3 space-y-2 font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
              <li>— Ed25519 identity generated and held on this device</li>
              <li>— Twelve-word recovery, no account and no password</li>
              <li>— Two-scan offline vouching with proof-of-possession</li>
              <li>— Replay-bound vouchers, re-verified on every load</li>
              <li>— Sybil-resistant trust scoring, computed locally</li>
              <li>— IndexedDB schema with an append-only CRDT oplog</li>
            </ul>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-paper">Not yet built</p>
            <ul className="mt-3 space-y-2 font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper/45">
              <li>— Sync bundles pushed and pulled as static JSON</li>
              <li>— Time-banked listings surfaced in a marketplace</li>
              <li>— Augmented deliberation and bridging-statement clustering</li>
              <li>— Revocation, and the governance around anchors</li>
              <li>— Optional PIN lock is implemented but not yet wired to the UI</li>
            </ul>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap gap-3 border-t border-paper/20 pt-5">
          <button onClick={showDiagnostics} className="btn">
            Print diagnostics to console
          </button>
          {commons.recoveryPhrase ? (
            <button onClick={() => setShowPhrase(true)} className="btn">
              Show my recovery phrase
            </button>
          ) : null}
        </div>
        {storage ? (
          <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-paper-dim">
            {storage} · telemetry written to the browser console
          </p>
        ) : null}
      </section>

      <p className="font-mono text-[10px] uppercase tracking-wider text-paper/35">
        <Link href="/" className="underline underline-offset-4 hover:text-paper">
          ← Back to the commons
        </Link>
      </p>
    </div>
  )
}
