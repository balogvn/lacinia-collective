/**
 * Sync orchestration — the layer the UI actually calls.
 *
 * Everything below this file is pure and headless; everything here touches
 * Dexie and the network. Keeping the split sharp is what lets the verification
 * suite exercise the real merge and verification code paths in Node.
 */

import {
  createBundle,
  verifyBundleText,
  type SyncBundle,
  type BundleVerification,
} from './bundle'
import { mergeOps, type MergeReport } from './merge'
import type { SignedOp } from './ops'
import { pullFromSource, type PullState, type SyncSource } from './transport'
import {
  DexieMergeStore,
  getPullState,
  savePullState,
  getSyncSources,
  markOpsSynced,
  relayableOps,
  unsyncedOps,
  getAnchors,
  listVouchers,
} from '../db/repo'
import { computeTrustGraph, lookupTrust } from '../vouch/trust'
import { TrustTier } from '../db/schema'
import type { KeyPair } from '../crypto/keys'
import { log } from '../telemetry'

/* ──────────────────────────── outbound ──────────────────────────── */

export interface OutboundBundle {
  bundle: SyncBundle
  /** Op ids authored locally, to mark synced once the bundle actually leaves. */
  localOpIds: string[]
  json: string
  bytes: number
}

/**
 * Builds a bundle from our own pending ops plus recent ops we are relaying.
 *
 * Relaying matters: a device that publishes only its own ops makes the network
 * a star around whoever syncs most often. Rebroadcasting what we received is
 * what lets a vouch reach someone who has never met either party — and it is
 * safe precisely because each op carries its own author signature, so relaying
 * confers no authority (see ops.ts).
 */
export async function buildOutboundBundle(
  signer: KeyPair,
  opts: { includeRelay?: boolean; maxOps?: number } = {},
): Promise<OutboundBundle | null> {
  const maxOps = opts.maxOps ?? 500
  const mine = await unsyncedOps(maxOps)
  const relayed = opts.includeRelay === false ? [] : await relayableOps(maxOps)

  // Dedupe by op id: a relayed op we also authored must appear once.
  const byId = new Map<string, SignedOp>()
  for (const op of [...mine, ...relayed]) {
    if (byId.size >= maxOps) break
    byId.set(op.id, {
      id: op.id,
      hlc: op.hlc,
      entity: op.entity,
      entityId: op.entityId,
      op: op.op,
      author: op.author,
      body: op.body,
      sig: op.sig,
    })
  }

  if (byId.size === 0) {
    log.info('sync', 'nothing to publish')
    return null
  }

  const bundle = createBundle(signer, [...byId.values()])
  const json = JSON.stringify(bundle)

  return {
    bundle,
    localOpIds: mine.map((o) => o.id),
    json,
    bytes: new TextEncoder().encode(json).length,
  }
}

export async function confirmOutboundSent(outbound: OutboundBundle): Promise<void> {
  await markOpsSynced(outbound.localOpIds)
}

/* ──────────────────────────── policy ──────────────────────────── */

/**
 * Trust-gated acceptance.
 *
 * Signature validity says an op is authentic, not that it is worth storing. A
 * spammer can sign a million perfectly valid listings. Vouchers and identities
 * are always accepted — they are how the trust graph grows, and refusing them
 * would make trust unbootstrappable — but listings from authors with no path to
 * an anchor are dropped before they reach the tables.
 *
 * The asymmetry is deliberate: cheap-to-verify structural data flows freely,
 * user-generated content requires standing.
 */
export async function buildAcceptPolicy(options: { minTierForListings?: TrustTier } = {}) {
  const minTier = options.minTierForListings ?? TrustTier.Observer
  const [vouchers, anchors] = await Promise.all([listVouchers(), getAnchors()])
  const graph = computeTrustGraph(vouchers, anchors)

  return (op: SignedOp): boolean => {
    if (op.entity === 'voucher' || op.entity === 'identity') return true
    if (minTier === TrustTier.Observer) return true

    const node = lookupTrust(graph, op.author)
    const allowed = node.tier >= minTier
    if (!allowed) {
      log.info('sync', 'listing dropped by trust policy', {
        author: op.author.slice(0, 12),
        tier: node.tier,
      })
    }
    return allowed
  }
}

/* ──────────────────────────── inbound ──────────────────────────── */

export interface ImportResult {
  verification: BundleVerification
  merge: MergeReport
}

export async function importBundleText(
  text: string,
  opts: { minTierForListings?: TrustTier } = {},
): Promise<ImportResult> {
  const accept = await buildAcceptPolicy(opts)
  const verification = verifyBundleText(text, { accept })
  const merge = await mergeOps(verification.accepted, new DexieMergeStore())
  return { verification, merge }
}

/* ──────────────────────────── pull ──────────────────────────── */

export interface SyncRunReport {
  sources: number
  fetched: number
  bytesDownloaded: number
  applied: number
  duplicates: number
  rejected: number
  errors: string[]
}

/**
 * Pulls every enabled source and merges what comes back.
 *
 * Cursor state is saved per source AFTER a successful merge, so a crash
 * mid-merge re-fetches rather than skipping — re-merging is free (ops are
 * idempotent) whereas skipping loses data permanently.
 */
export async function runSync(
  opts: { minTierForListings?: TrustTier; fetchImpl?: typeof fetch } = {},
): Promise<SyncRunReport> {
  const sources = (await getSyncSources()).filter((s) => s.enabled)
  const accept = await buildAcceptPolicy(opts)
  const store = new DexieMergeStore()

  const report: SyncRunReport = {
    sources: sources.length,
    fetched: 0,
    bytesDownloaded: 0,
    applied: 0,
    duplicates: 0,
    rejected: 0,
    errors: [],
  }

  for (const record of sources) {
    const source: SyncSource = { url: record.url, label: record.label }
    const state: PullState = await getPullState(record.url)

    const pull = await pullFromSource(source, state, {
      accept,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    })

    report.fetched += pull.fetched
    report.bytesDownloaded += pull.bytesDownloaded
    report.errors.push(...pull.errors)

    for (const verification of pull.verifications) {
      report.rejected += verification.rejected.length
      const merge = await mergeOps(verification.accepted, store)
      report.applied += merge.applied
      report.duplicates += merge.duplicates
    }

    await savePullState(record.url, pull.nextState)
  }

  log.info('sync', 'sync run complete', {
    sources: report.sources,
    applied: report.applied,
    kb: +(report.bytesDownloaded / 1024).toFixed(1),
  })

  return report
}
