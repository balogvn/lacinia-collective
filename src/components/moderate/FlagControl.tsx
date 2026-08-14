'use client'

import { useState } from 'react'

import {
  FlagReason,
  FLAG_REASON_LABELS,
  HARM_REASONS,
  type FlagTarget,
} from '@/lib/db/schema'

interface Props {
  targetId: string
  targetEntity: FlagTarget
  alreadyFlagged: boolean
  onFlag: (reason: FlagReason) => Promise<void>
  onWithdraw: () => Promise<void>
}

/**
 * The flag control.
 *
 * Note there is no generic "Report" button. The reader must choose a reason,
 * and the reasons are deliberately narrow — none of them means "I disagree",
 * because disagreement already has a button and conflating the two is how a
 * moderation queue becomes a voting booth.
 *
 * The consequences are stated up front rather than discovered later: a flag is
 * signed with your key and visible to others, and one group flagging alone
 * changes nothing.
 */
export function FlagControl({ targetId, targetEntity, alreadyFlagged, onFlag, onWithdraw }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const raise = async (reason: FlagReason) => {
    setBusy(true)
    try {
      await onFlag(reason)
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  if (alreadyFlagged) {
    return (
      <button
        onClick={() => void onWithdraw()}
        className="font-mono text-[10px] uppercase tracking-wider text-signal hover:text-paper"
      >
        You flagged this · Undo
      </button>
    )
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="font-mono text-[10px] uppercase tracking-wider text-paper/35 hover:text-paper"
      >
        Flag
      </button>
    )
  }

  return (
    <div className="mt-2 w-full border border-paper/25 p-3">
      <p className="eyebrow">Why are you flagging this?</p>

      <div className="mt-2.5 flex flex-wrap gap-2">
        {(Object.keys(FLAG_REASON_LABELS) as FlagReason[]).map((reason) => (
          <button
            key={reason}
            onClick={() => void raise(reason)}
            disabled={busy}
            className={`border px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider transition-colors ${
              HARM_REASONS.has(reason)
                ? 'border-alarm/50 text-paper hover:border-alarm hover:bg-alarm/10'
                : 'border-paper/30 text-paper-dim hover:border-paper/70'
            }`}
          >
            {FLAG_REASON_LABELS[reason]}
          </button>
        ))}
      </div>

      <p className="mt-3 max-w-md font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
        Your flag is signed with your key and others can see you raised it. Spam and off-topic only
        move things down the list. Nothing is hidden unless every group here objects.
      </p>

      <button
        onClick={() => setOpen(false)}
        className="mt-2 font-mono text-[10px] uppercase tracking-wider text-paper-dim hover:text-paper"
      >
        Cancel
      </button>

      <span className="sr-only">
        Flagging {targetEntity} {targetId}
      </span>
    </div>
  )
}
