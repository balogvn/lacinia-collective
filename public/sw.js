/**
 * Lacinia service worker — hand-written, ~2KB.
 *
 * A plugin (next-pwa/Workbox) would add ~40KB of runtime to solve caching
 * problems we do not have. On a metered 2G connection that is a real cost to
 * every user, forever, so we spend the 60 lines instead.
 *
 * STRATEGY
 *   Navigations  → network-first, falling back to the cached shell. Keeps the
 *                  app usable with zero signal, which is the default state.
 *   Static assets→ stale-while-revalidate. Instant paint, quiet refresh.
 *   Everything else → passthrough.
 *
 * Sync bundles are deliberately NOT cached here: they are IndexedDB's business,
 * and a stale bundle served from HTTP cache would silently resurrect data the
 * CRDT layer had already superseded.
 */

const VERSION = 'lacinia-v1'
const SHELL = `${VERSION}-shell`
const ASSETS = `${VERSION}-assets`

const PRECACHE = ['/', '/identity', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // Individually, so one 404 during development does not abort the whole
      // install and leave the app with no offline shell at all.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(SHELL).then((cache) => cache.put(request, copy))
          return response
        })
        .catch(async () => {
          const cached = await caches.match(request)
          return cached || (await caches.match('/')) || Response.error()
        }),
    )
    return
  }

  if (/\.(js|css|woff2?|png|svg|webmanifest|ico)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const cached = await cache.match(request)
        const network = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone())
            return response
          })
          .catch(() => cached)
        return cached || network
      }),
    )
  }
})
