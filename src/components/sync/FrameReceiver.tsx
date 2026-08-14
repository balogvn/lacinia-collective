'use client'

import { useRef, useState } from 'react'
import { ScannerPanel } from '@/components/qr/ScannerPanel'
import { FrameCollector } from '@/lib/sync/frames'

interface Props {
  onComplete: (payload: string) => void | Promise<void>
}

/**
 * Multi-frame receiver.
 *
 * The collector is held in a ref rather than state: it must survive re-renders
 * without resetting, and putting a mutable accumulator in state would either
 * lose frames on every render or force a full copy per frame.
 */
export function FrameReceiver({ onComplete }: Props) {
  const collector = useRef(new FrameCollector())
  const [progress, setProgress] = useState({ received: 0, total: 0 })
  const [missing, setMissing] = useState<number[]>([])
  const [busy, setBusy] = useState(false)

  const handle = async (text: string) => {
    const result = await collector.current.accept(text)
    setProgress({
      received: collector.current.progress.received,
      total: collector.current.progress.total,
    })
    setMissing(collector.current.missing)

    if (result.done) {
      setBusy(true)
      try {
        await onComplete(result.payload)
      } finally {
        setBusy(false)
        setProgress({ received: 0, total: 0 })
        setMissing([])
      }
    }
  }

  const pct = progress.total ? Math.round((progress.received / progress.total) * 100) : 0

  return (
    <div className="space-y-3">
      <ScannerPanel onScan={(t) => void handle(t)} label="Scan the other phone's animated code" />

      {progress.total > 0 ? (
        <div className="border border-paper/25 p-4">
          <div className="flex items-baseline justify-between">
            <span className="eyebrow">Collecting</span>
            <span className="font-mono text-[11px] text-paper">
              {progress.received}/{progress.total}
            </span>
          </div>

          <div className="mt-2 h-1.5 w-full bg-paper/20">
            <div className="h-full bg-paper transition-all" style={{ width: `${pct}%` }} />
          </div>

          {/* Naming the missing frames turns "it isn't working" into "keep it
              pointed for one more loop", which is actionable. */}
          {missing.length > 0 && missing.length <= 12 ? (
            <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-paper/45">
              still need frame{missing.length === 1 ? '' : 's'} {missing.map((m) => m + 1).join(', ')}
            </p>
          ) : null}

          {busy ? (
            <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-paper">
              Verifying and merging…
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
