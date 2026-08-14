#!/usr/bin/env node
/**
 * Serves the static export the way GitHub Pages does — under /<repo>/ rather
 * than at the origin root.
 *
 * WHY THIS EXISTS
 * `next dev` serves at the root, so it cannot catch the one class of bug a
 * Pages deployment actually introduces: root-absolute references that 404 under
 * a subpath. The worst of those is the service worker, because a worker that
 * fails to register leaves the app looking completely fine and silently
 * without offline mode — discovered later, on a bus, with no signal.
 *
 * Dependency-free on purpose; it is a verification tool, not a dependency.
 *
 *   npm run build:pages && npm run preview:pages
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, resolve, normalize } from 'node:path'

const ROOT = resolve(process.cwd(), 'out')
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || '/lacinia-collective'
const PORT = Number(process.env.PORT || 4311)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  if (!url.pathname.startsWith(BASE)) {
    // Mirrors Pages: anything outside the project subpath simply is not there.
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end(`Not found. This build is served under ${BASE}/`)
    return
  }

  const rel = url.pathname.slice(BASE.length) || '/'
  // normalize + prefix check keeps `..` from escaping the export directory.
  let filePath = resolve(join(ROOT, normalize(rel)))
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  try {
    const info = await stat(filePath).catch(() => null)
    if (!info || info.isDirectory()) filePath = join(filePath, 'index.html')

    const body = await readFile(filePath)
    res.writeHead(200, {
      'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream',
      // Pages sets this, and the sync layer's same-origin pull depends on the
      // commons being reachable without preflight.
      'access-control-allow-origin': '*',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(await readFile(join(ROOT, '404.html')).catch(() => 'Not found'))
  }
})

server.listen(PORT, () => {
  console.log(`Pages preview: http://localhost:${PORT}${BASE}/`)
})
