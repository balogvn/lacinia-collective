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
        .register(`${base}/sw.js`, { scope: `${base}/` })
        .then((reg) => log.info('sync', 'service worker registered', { scope: reg.scope }))
        .catch((err) => log.warn('sync', 'service worker registration failed', { error: String(err) }))
    }

    requestPersistentStorage().catch(() => undefined)
  }, [])

  return null
}
