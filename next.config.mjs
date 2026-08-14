/**
 * GitHub Pages serves a project repo from a subpath
 * (https://<user>.github.io/<repo>/), not from the origin root. Every
 * root-absolute reference — the service worker, the manifest, the PWA scope —
 * 404s there, and a broken scope silently kills offline mode, which is the one
 * thing this app is named for.
 *
 * `basePath` is therefore read from the environment rather than hardcoded, so
 * the same tree works in three places without edits:
 *   local dev / Vercel      NEXT_PUBLIC_BASE_PATH unset  → served at /
 *   GitHub Pages            NEXT_PUBLIC_BASE_PATH=/lacinia-collective
 *   a USB stick or LAN host set it to wherever it lands
 *
 * It is NEXT_PUBLIC_* because the service worker registration needs the same
 * value at runtime — `basePath` itself is build-time only and not readable from
 * client code.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The commons ships as static files so it can be served from any free CDN
  // (Vercel, GitHub Pages, or a USB stick handed round a market).
  output: 'export',
  images: { unoptimized: true },
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  // Pages serves directories, so emit /identity/index.html rather than
  // /identity.html — otherwise every route 404s on a static host.
  trailingSlash: true,
}

export default nextConfig
