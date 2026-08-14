'use client'

import { useEffect, useMemo, useState } from 'react'
import { renderQRDataURI } from '@/lib/qr/render'
import { planTransfer, type TransferPlan } from '@/lib/sync/frames'

interface Props {
  payload: string
  onDone?: () => void
}

/** Frames per second. Below ~6 the transfer drags; above ~10 cheap cameras miss frames. */
const FPS = 6

/**
 * Animated multi-frame QR sender.
 *
 * Loops forever by design: there is no back-channel, so the sender cannot know
 * when the receiver has collected every frame. The receiver simply stops
 * watching — and because frames are self-identifying, it can join the loop at
 * any point rather than waiting for frame zero.
 *
 * All frames are pre-rendered before the animation starts. Rendering a QR
 * inside the animation tick would stall on a slow device exactly when timing
 * matters most, and a dropped frame costs the receiver a whole extra loop.
 */
export function FrameBroadcaster({ payload, onDone }: Props) {
  const [plan, setPlan] = useState<TransferPlan | null>(null)
  const [images, setImages] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setPlan(null)
    setImages([])
    setIndex(0)

    void (async () => {
      try {
        const next = await planTransfer(payload)
        if (cancelled) return
        setPlan(next)
        const rendered = await Promise.all(next.frames.map((f) => renderQRDataURI(f)))
        if (!cancelled) setImages(rendered)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [payload])

  useEffect(() => {
    if (paused || images.length === 0) return
    const timer = setInterval(() => setIndex((i) => (i + 1) % images.length), 1000 / FPS)
    return () => clearInterval(timer)
  }, [paused, images.length])

  const stats = useMemo(() => {
    if (!plan) return null
    const saved = plan.totalBytes
      ? Math.round((1 - plan.compressedBytes / plan.totalBytes) * 100)
      : 0
    return {
      frames: plan.frames.length,
      seconds: (plan.frames.length / FPS).toFixed(1),
      kb: (plan.compressedBytes / 1024).toFixed(1),
      saved,
    }
  }, [plan])

  if (error) {
    return (
      <p className="border border-alarm/60 bg-alarm/10 px-3 py-2 font-mono text-[11px] text-paper">
        {error}
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="terminal p-4">
        <div className="mx-auto aspect-square w-full max-w-[300px]">
          {images.length > 0 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={images[index]}
              alt={`Transfer frame ${index + 1} of ${images.length}`}
              className="h-full w-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center font-mono text-[10px] uppercase tracking-wider text-canvas/40">
              preparing frames…
            </div>
          )}
        </div>

        {/* Progress pips: the receiver's phone shows what it still needs, and
            the sender can see the loop is actually running. */}
        {images.length > 0 ? (
          <div className="mt-3 flex flex-wrap justify-center gap-1">
            {images.map((_, i) => (
              <span
                key={i}
                className={`h-1 w-4 ${i === index ? 'bg-canvas' : 'bg-canvas/25'}`}
                aria-hidden
              />
            ))}
          </div>
        ) : null}

        {stats ? (
          <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-wider text-canvas/45">
            frame {index + 1}/{stats.frames} · {stats.kb} KB · {stats.seconds}s per loop
            {stats.saved > 0 ? ` · ${stats.saved}% compressed` : ''}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => setPaused((p) => !p)} className="btn flex-1">
          {paused ? 'Resume' : 'Pause'}
        </button>
        {onDone ? (
          <button onClick={onDone} className="btn flex-1">
            Done
          </button>
        ) : null}
      </div>

      <p className="font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
        Hold the phones steady and let the code loop at least once. The other phone can start
        scanning at any point — frames are collected in any order.
      </p>
    </div>
  )
}
