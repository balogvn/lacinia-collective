'use client'

import { useEffect, useState } from 'react'
import { renderQRDataURI, estimateQRVersion } from '@/lib/qr/render'

interface Props {
  payload: string
  caption?: string
  /** Show byte/version diagnostics. On by default — payload size is a real constraint. */
  showDiagnostics?: boolean
}

export function QRPanel({ payload, caption, showDiagnostics = true }: Props) {
  const [src, setSrc] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    renderQRDataURI(payload)
      .then((uri) => {
        if (!cancelled) setSrc(uri)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [payload])

  const info = estimateQRVersion(payload.length)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(payload)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked — the payload is visible below regardless */
    }
  }

  return (
    <div className="terminal p-4">
      <div className="mx-auto aspect-square w-full max-w-[280px]">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={caption ?? 'Lacinia QR code'} className="h-full w-full" />
        ) : (
          <div className="flex h-full w-full items-center justify-center font-mono text-[10px] uppercase tracking-wider text-canvas/40">
            rendering…
          </div>
        )}
      </div>

      {caption ? (
        <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-wider text-canvas/60">
          {caption}
        </p>
      ) : null}

      {/*
        Size and version only. `info.note` ("needs a steadier hand") is written
        for whoever is tuning the payload, not for the person holding the phone
        — under your own code it reads as a warning you cannot act on.
      */}
      {showDiagnostics ? (
        <p
          className="mt-1 text-center font-mono text-[10px] uppercase tracking-wider text-canvas/40"
          title={info.note}
        >
          {payload.length} chars · QR v{info.version}
        </p>
      ) : null}

      {/*
        The paste fallback is not a developer convenience — it is the path that
        works when a camera is broken, permission is refused, or two people are
        on a WhatsApp call instead of standing together.
      */}
      <button
        onClick={copy}
        className="mt-3 w-full border border-canvas/30 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-canvas/70 transition-colors hover:bg-canvas hover:text-paper"
      >
        {copied ? 'Copied to clipboard' : 'Copy code as text'}
      </button>
    </div>
  )
}
