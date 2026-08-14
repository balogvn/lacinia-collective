'use client'

import { useState } from 'react'

import { Visibility, type VisibilityVerdict } from '@/lib/moderate/policy'
import { FLAG_REASON_LABELS } from '@/lib/db/schema'

interface Props {
  verdict: VisibilityVerdict
  children: React.ReactNode
}

/**
 * Wraps content whose visibility policy says to hide it.
 *
 * Every hidden item is ONE TAP from being read, and always carries the reason
 * it was hidden. Nothing is deleted — it cannot be, since the data is already
 * on other people's devices — so pretending otherwise would be a lie told to
 * the person who flagged it.
 *
 * A hidden item with no explanation and no way through is how a community
 * learns that a tool is being used against it.
 */
export function WithheldItem({ verdict, children }: Props) {
  const [revealed, setRevealed] = useState(false)

  if (verdict.visibility === Visibility.Visible) return <>{children}</>

  if (verdict.visibility === Visibility.Downranked) {
    return (
      <div className="opacity-60">
        <p className="mb-1.5 font-mono text-[9px] uppercase tracking-wider text-paper/40">
          {verdict.reason}
        </p>
        {children}
      </div>
    )
  }

  if (revealed) {
    return (
      <div className="border-l-2 border-signal/60 pl-4">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <p className="font-mono text-[9px] uppercase tracking-wider text-signal">
            {verdict.visibility === Visibility.Withheld ? 'Was withheld' : 'Was muted'}
            {verdict.flagReason ? ` · ${FLAG_REASON_LABELS[verdict.flagReason]}` : ''}
          </p>
          <button
            onClick={() => setRevealed(false)}
            className="font-mono text-[9px] uppercase tracking-wider text-paper/40 hover:text-paper"
          >
            Hide again
          </button>
        </div>
        {children}
      </div>
    )
  }

  return (
    <div className="border border-dashed border-paper/25 p-4">
      <p className="font-mono text-[10px] uppercase tracking-wider text-paper-dim">
        {verdict.visibility === Visibility.Withheld ? 'Withheld' : 'Muted'}
        {verdict.flagReason ? ` · ${FLAG_REASON_LABELS[verdict.flagReason]}` : ''}
      </p>
      <p className="mt-1.5 max-w-lg font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
        {verdict.reason}
      </p>
      <button onClick={() => setRevealed(true)} className="btn mt-3">
        Read it anyway
      </button>
    </div>
  )
}
