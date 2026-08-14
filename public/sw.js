/**
 * Lacinia service worker — hand-written, ~2KB.
 *
 * A plugin (next-pwa/Workbox) would add ~40KB of runtime to solve caching
 * problems we do not have. On a metered 2G connection that is a real cost to
 * every user, forever, so we spend the 60 lines instead.
 *
 * PATHS ARE RESOLVED FROM THE WORKER'S OWN LOCATION, never hardcoded to "/".
 * GitHub Pages serves this app from /<repo>/, so a root-absolute precache list
 * would 404 every entry and the offline shell would silently never exist — the
 * failure mode being "the offline-first app does not work offline", discovered
 * on a bus with no signal. `new URL('./', self.location)` gives the scope
 * wherever the app is deployed: origin root, a project subpath, or a LAN host.
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

const VERSION = 'lacinia-v2'
const SHELL = `${VERSION}-shell`
const ASSETS = `${VERSION}-assets`

/** Directory this worker was served from — the app's real base. */
const BASE = new URL('./', self.location).href

const PRECACHE = [BASE, `${BASE}identity/`, `${BASE}manifest.webmanifest`]

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
          return cached || (await caches.match(BASE)) || Response.error()
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
