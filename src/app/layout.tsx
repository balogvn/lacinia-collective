import type { Metadata, Viewport } from 'next'
import './globals.css'
import { ServiceWorkerRegistrar } from '@/components/system/ServiceWorkerRegistrar'

export const metadata: Metadata = {
  title: 'The Lacinia Collective — trust without signal',
  description:
    'An offline-first digital commons for Nigerian mutual aid: peer-vouched identity, time-banked resources, and civic deliberation that works with no network.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Lacinia',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Lacinia' },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  themeColor: '#0B4A33',
  width: 'device-width',
  initialScale: 1,
  // Never block pinch-zoom: users zoom to help a struggling camera read a QR,
  // and locking it out is an accessibility failure besides.
  maximumScale: 5,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ServiceWorkerRegistrar />
        {children}
      </body>
    </html>
  )
}
