/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The commons ships as static files so it can be served from any free CDN
  // (Vercel, GitHub Pages, or a USB stick handed round a market).
  output: 'export',
  images: { unoptimized: true },
  headers: undefined, // `output: export` serves headers via the host, not Next.
}

export default nextConfig
