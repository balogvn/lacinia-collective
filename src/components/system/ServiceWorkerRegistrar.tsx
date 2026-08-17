'use client'

import { useEffect } from 'react'
import { log } from '@/lib/telemetry'
import { requestPersistentStorage } from '@/lib/db/db'

/**
 * Registers the service worker and asks for durable storage.
 *
 * The storage request is the important half. Without it, the browser may evict
 * IndexedDB under pressure — and here that means deleting an identity plus
 * every vouch attached to it, with no server copy to restore from. Chrome
 * grants persistence silently once the app is installed or sufficiently used,
 * so we ask on every load until it sticks.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === 'undefined') return

    if ('serviceWorker' in navigator) {
      // Must match the deployed basePath. A worker registered at "/sw.js" on a
      // subpath deployment 404s, and one registered with scope "/" is rejected
      // outright — a worker may not claim a scope above its own directory. The
      // app would then appear to work and silently have no offline mode.
      const base = process.env.NEXT_PUBLIC_BASE_PATH ?? ''
      navigator.serviceWorker
        // updateViaCache:'none' stops the browser serving sw.js itself from
        // its HTTP cache, which is how a worker keeps re-installing the same
        // stale generation for hours after a deploy.
        .register(`${base}/sw.js`, { scope: `${base}/`, updateViaCache: 'none' })
        .then((reg) => {
          log.info('sync', 'service worker registered', { scope: reg.scope })
          // Ask on every load. Without it the browser checks on its own
          // schedule, and a device can sit on a shell whose scripts no longer
          // exist on the host with no way for the app to notice or recover.
          void reg.update()
          return reg
        })
        .catch((err) => log.warn('sync', 'service worker registration failed', { error: String(err) }))
    }

    requestPersistentStorage().catch(() => undefined)
  }, [])

  return null
}
