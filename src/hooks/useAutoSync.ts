'use client'

import { useEffect, useRef } from 'react'

import { getSyncSources, getPullState } from '@/lib/db/repo'
import { runSync } from '@/lib/sync/service'
import { log } from '@/lib/telemetry'

/**
 * Pull quietly when the app opens, so nobody has to press Sync to see the
 * commons.
 *
 * WHY THIS WAS NOT ALWAYS THE BEHAVIOUR
 * Every automatic fetch spends somebody's data, and this app is built for a
 * metered bundle. What makes it affordable is the ETag: an unchanged commons
 * answers 304 in a few hundred bytes, so the cost of checking is roughly the
 * cost of a single text message, and only a commons that actually changed
 * downloads anything.
 *
 * Three guards keep it honest.
 *   1. Never when the device reports itself offline. A doomed fetch on a bus
 *      is pure battery.
 *   2. Never more than once per QUIET_PERIOD. Moving between pages must not
 *      re-fetch, or a browsing session becomes a dozen requests.
 *   3. Never blocking. Failure is silent here — the Sync panel is where errors
 *      belong, because that is where somebody asked for an answer. A red
 *      banner on arrival for a network that was always going to be flaky is
 *      how people learn to ignore banners.
 */
const QUIET_PERIOD_MS = 5 * 60_000

export function useAutoSync(onMerged: () => Promise<void> | void): void {
  // Ref, not state: this must not re-run when the callback identity changes,
  // and it must survive re-renders without re-fetching.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    void (async () => {
      try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return

        const sources = (await getSyncSources()).filter((s) => s.enabled)
        if (sources.length === 0) return

        // Newest successful pull across all sources decides whether it is worth
        // asking again. One recently-pulled source is enough: they are fetched
        // together, so they are never far apart.
        let newest = 0
        for (const source of sources) {
          const state = await getPullState(source.url)
          if (state.lastPulledAt && state.lastPulledAt > newest) newest = state.lastPulledAt
        }
        if (newest && Date.now() - newest < QUIET_PERIOD_MS) return

        const report = await runSync()
        log.info('sync', 'automatic pull on open', {
          applied: report.applied,
          kb: +(report.bytesDownloaded / 1024).toFixed(1),
        })
        if (report.applied > 0) await onMerged()
      } catch (err) {
        // Deliberately swallowed. See the third guard above.
        log.info('sync', 'automatic pull did not complete', { error: String(err) })
      }
    })()
  }, [onMerged])
}
