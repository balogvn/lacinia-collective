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
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((reg) => log.info('sync', 'service worker registered', { scope: reg.scope }))
        .catch((err) => log.warn('sync', 'service worker registration failed', { error: String(err) }))
    }

    requestPersistentStorage().catch(() => undefined)
  }, [])

  return null
}
