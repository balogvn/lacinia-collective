'use client'

import { useEffect, useRef, useState } from 'react'
import { startScanner, decodeImageFile, type ScannerHandle, type CameraUnavailableError } from '@/lib/qr/scan'

interface Props {
  onScan: (text: string) => void
  label: string
}

/**
 * Camera scanner with two fallbacks that are treated as first-class, not as
 * error states: paste-the-text, and decode-a-screenshot. In the field the
 * camera fails often — cracked lens, refused permission, an old WebView with no
 * getUserMedia — and a scanner that only scans is a scanner that blocks people
 * from joining.
 */
export function ScannerPanel({ onScan, label }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const handleRef = useRef<ScannerHandle | null>(null)
  const [cameraOn, setCameraOn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')

  useEffect(() => {
    // Stop the camera when the component unmounts, or the light stays on and
    // the battery drains while the user is elsewhere in the app.
    return () => {
      handleRef.current?.stop()
      handleRef.current = null
    }
  }, [])

  const begin = async () => {
    setError(null)
    if (!videoRef.current) return
    try {
      handleRef.current = await startScanner(
        videoRef.current,
        (text) => {
          handleRef.current?.stop()
          handleRef.current = null
          setCameraOn(false)
          onScan(text)
        },
        (err: CameraUnavailableError) => setError(err.message),
      )
      setCameraOn(true)
    } catch (err) {
      setCameraOn(false)
      if (err instanceof Error && !error) setError(err.message)
    }
  }

  const halt = () => {
    handleRef.current?.stop()
    handleRef.current = null
    setCameraOn(false)
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    const decoded = await decodeImageFile(file)
    if (decoded) onScan(decoded)
    else setError('No QR code found in that image.')
  }

  return (
    <div className="space-y-3">
      <p className="eyebrow">{label}</p>

      <div className="relative aspect-square w-full overflow-hidden border border-paper/30 bg-canvas-deep">
        <video
          ref={videoRef}
          className={`h-full w-full object-cover ${cameraOn ? '' : 'invisible'}`}
          muted
          playsInline
        />
        {!cameraOn ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="font-mono text-[10px] uppercase tracking-wider text-paper-dim">
              Camera is off
            </p>
            <button onClick={begin} className="btn">
              Start camera
            </button>
          </div>
        ) : (
          <>
            {/* Framing guide — people aim badly without one. */}
            <div className="pointer-events-none absolute inset-[18%] border-2 border-paper/70" />
            <button
              onClick={halt}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 border border-paper bg-canvas/80 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-paper"
            >
              Stop
            </button>
          </>
        )}
      </div>

      {error ? (
        <p className="border border-alarm/60 bg-alarm/10 px-3 py-2 font-mono text-[11px] leading-relaxed text-paper">
          {error}
        </p>
      ) : null}

      <details className="border border-paper/25">
        <summary className="cursor-pointer px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper-dim hover:text-paper">
          No camera? Paste the code instead
        </summary>
        <div className="space-y-2 border-t border-paper/25 p-3">
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="LCN1:…"
            className="field resize-none text-[11px]"
          />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => pasted.trim() && onScan(pasted.trim())}
              disabled={!pasted.trim()}
              className="btn flex-1"
            >
              Use this code
            </button>
            <label className="btn flex-1 cursor-pointer">
              Load screenshot
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
            </label>
          </div>
        </div>
      </details>
    </div>
  )
}
