/**
 * Transport — pulling bundles from a static host.
 *
 * PULL is a cursor plus conditional requests against a static manifest. Because
 * bundle files are content-addressed they are immutable, so they can be cached
 * forever and never re-fetched; only `manifest.json` is volatile, and it is
 * fetched with an ETag so an unchanged commons costs a single 304 — a few
 * hundred bytes. On a metered Nigerian data bundle that difference is the whole
 * argument for this architecture.
 *
 * PUSH has no server. That is not an omission, it is the design: a static host
 * serves files and accepts nothing. The three honest paths are
 *
 *   1. export a bundle file the user attaches wherever they already talk
 *      (WhatsApp, email, a GitHub pull request),
 *   2. hand it to another phone over multi-frame QR (see frames.ts),
 *   3. POST to an optional, user-configured relay.
 *
 * We implement all three rather than pretending a write API exists. Note that
 * (1) and (2) require no infrastructure at all and no trust in a relay, which
 * is why they are the primary paths and (3) is opt-in.
 */

import {
  verifyBundleText,
  type BundleManifest,
  type SyncBundle,
  type VerifyBundleOptions,
  type BundleVerification,
  MAX_BUNDLE_BYTES,
} from './bundle'
import { log } from '../telemetry'

export interface SyncSource {
  /** Base URL containing manifest.json, e.g. https://commons.example/commons/ */
  url: string
  label: string
}

export interface PullState {
  /** Highest HLC we have merged from this source. */
  cursorHlc: string | null
  /** Bundle ids already merged, so a re-listed bundle is never re-fetched. */
  seenBundleIds: string[]
  manifestEtag: string | null
  lastPulledAt: number | null
}

export interface PullResult {
  source: SyncSource
  manifestChanged: boolean
  fetched: number
  bytesDownloaded: number
  verifications: BundleVerification[]
  nextState: PullState
  errors: string[]
}

export class TransportError extends Error {
  constructor(message: string, readonly kind: 'offline' | 'http' | 'malformed') {
    super(message)
    this.name = 'TransportError'
  }
}

function joinUrl(base: string, path: string): string {
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString()
}

export function emptyPullState(): PullState {
  return { cursorHlc: null, seenBundleIds: [], manifestEtag: null, lastPulledAt: null }
}

/**
 * Fetches the manifest and any bundles newer than the cursor.
 *
 * Never throws for network conditions — being offline is the expected state,
 * not an error, and a thrown exception here would surface as a red banner every
 * time someone opened the app on a bus.
 */
export async function pullFromSource(
  source: SyncSource,
  state: PullState,
  opts: VerifyBundleOptions & { fetchImpl?: typeof fetch; maxBundles?: number } = {},
): Promise<PullResult> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  const errors: string[] = []
  const verifications: BundleVerification[] = []
  let bytesDownloaded = 0
  let fetched = 0

  const result = (nextState: PullState, manifestChanged: boolean): PullResult => ({
    source,
    manifestChanged,
    fetched,
    bytesDownloaded,
    verifications,
    nextState,
    errors,
  })

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    log.info('sync', 'skipping pull — device reports offline', { source: source.label })
    return result(state, false)
  }

  let manifestText: string
  let etag: string | null = state.manifestEtag

  try {
    const headers: Record<string, string> = {}
    if (state.manifestEtag) headers['If-None-Match'] = state.manifestEtag

    const response = await doFetch(joinUrl(source.url, 'manifest.json'), {
      headers,
      cache: 'no-cache',
    })

    if (response.status === 304) {
      log.info('sync', 'manifest unchanged (304)', { source: source.label })
      return result({ ...state, lastPulledAt: Date.now() }, false)
    }
    if (!response.ok) {
      throw new TransportError(`manifest returned HTTP ${response.status}`, 'http')
    }

    etag = response.headers.get('etag')
    manifestText = await response.text()
    bytesDownloaded += manifestText.length
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('sync', 'manifest fetch failed', { source: source.label, error: message })
    errors.push(`Could not reach ${source.label}: ${message}`)
    return result(state, false)
  }

  let manifest: BundleManifest
  try {
    manifest = JSON.parse(manifestText) as BundleManifest
    if (!Array.isArray(manifest.entries)) throw new Error('manifest.entries is not an array')
  } catch (err) {
    errors.push(`Manifest from ${source.label} is malformed: ${String(err)}`)
    return result(state, false)
  }

  const seen = new Set(state.seenBundleIds)
  const { selectNewEntries } = await import('./bundle')
  const pending = selectNewEntries(manifest, state.cursorHlc, seen)
  const limit = opts.maxBundles ?? 25

  if (pending.length > limit) {
    // Report rather than silently truncate: a device that believes it is in
    // sync when it is 200 bundles behind will make decisions on stale trust.
    log.warn('sync', 'more bundles pending than this pass will fetch', {
      pending: pending.length,
      limit,
    })
    errors.push(
      `${pending.length - limit} more bundles are waiting at ${source.label} — sync again to continue.`,
    )
  }

  let cursorHlc = state.cursorHlc

  for (const entry of pending.slice(0, limit)) {
    if (entry.bytes > MAX_BUNDLE_BYTES) {
      errors.push(`Skipped an oversized bundle (${(entry.bytes / 1024 / 1024).toFixed(1)} MB).`)
      continue
    }
    try {
      // Content-addressed → immutable → cacheable forever.
      const response = await doFetch(joinUrl(source.url, entry.path), { cache: 'force-cache' })
      if (!response.ok) {
        errors.push(`Bundle ${entry.path} returned HTTP ${response.status}.`)
        continue
      }
      const text = await response.text()
      bytesDownloaded += text.length
      fetched++

      const verification = verifyBundleText(text, opts)
      verifications.push(verification)

      seen.add(entry.id)
      if (!cursorHlc || entry.hlcMax > cursorHlc) cursorHlc = entry.hlcMax
    } catch (err) {
      errors.push(`Bundle ${entry.path} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  log.info('sync', 'pull complete', {
    source: source.label,
    fetched,
    kb: +(bytesDownloaded / 1024).toFixed(1),
    errors: errors.length,
  })

  return result(
    {
      cursorHlc,
      // Bounded so the state row cannot grow without limit on a long-lived
      // device; the cursor already prevents re-fetching anything older.
      seenBundleIds: [...seen].slice(-500),
      manifestEtag: etag,
      lastPulledAt: Date.now(),
    },
    true,
  )
}

/**
 * Optional relay push. Fails soft — a relay is a convenience, and the file and
 * QR paths remain the ones that always work.
 */
export async function pushToRelay(
  relayUrl: string,
  bundle: SyncBundle,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetchImpl(relayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle),
    })
    if (!response.ok) return { ok: false, detail: `Relay returned HTTP ${response.status}` }
    log.info('sync', 'bundle pushed to relay', { id: bundle.id.slice(0, 12) })
    return { ok: true, detail: `Sent ${bundle.opCount} updates.` }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

/** Triggers a file download — the zero-infrastructure push path. */
export function downloadBundle(bundle: SyncBundle, filename?: string): void {
  const text = JSON.stringify(bundle, null, 2)
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename ?? `lacinia-bundle-${bundle.id.slice(0, 12)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
  log.info('sync', 'bundle exported as file', { id: bundle.id.slice(0, 12), bytes: text.length })
}
