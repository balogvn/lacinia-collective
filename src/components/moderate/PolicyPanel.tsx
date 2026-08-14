'use client'

import { useState } from 'react'

import { PRESET_LABELS, type PolicyPreset } from '@/lib/moderate/policy'
import type { Flag } from '@/lib/db/schema'
import { FLAG_REASON_LABELS } from '@/lib/db/schema'

interface Props {
  preset: PolicyPreset
  flags: Flag[]
  selfPub: string
  onPreset: (preset: PolicyPreset) => Promise<void>
  onWithdraw: (targetId: string) => Promise<void>
}

/**
 * Where the reader sets their own moderation policy.
 *
 * This panel exists because the alternative is a platform deciding for
 * everyone, which is the thing this project is built to avoid. There is no
 * server to appeal to, so the compensating guarantee is that the device is
 * sovereign: you can turn hiding off entirely, and you can always see what your
 * own flags are doing.
 */
export function PolicyPanel({ preset, flags, selfPub, onPreset, onWithdraw }: Props) {
  const [open, setOpen] = useState(false)
  const mine = flags.filter((f) => !f.deleted && f.authorPub === selfPub)

  return (
    <section className="border border-paper/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between p-5 text-left"
      >
        <span>
          <span className="eyebrow block">What this phone hides</span>
          <span className="mt-1 block font-mono text-[11px] uppercase tracking-wider text-paper">
            {PRESET_LABELS[preset].label}
            {mine.length > 0 ? ` · ${mine.length} flag${mine.length === 1 ? '' : 's'} raised by you` : ''}
          </span>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-paper-dim">
          {open ? '− Hide' : '+ Manage'}
        </span>
      </button>

      {open ? (
        <div className="border-t border-paper/25 p-5">
          <p className="max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/50">
            There is no moderator and no appeals desk — so this decision is yours. Nothing is ever
            deleted; the data already exists on other people’s devices. These settings only change
            what this phone shows you by default.
          </p>

          <ul className="mt-5 space-y-2">
            {(Object.keys(PRESET_LABELS) as PolicyPreset[]).map((p) => (
              <li key={p}>
                <button
                  onClick={() => void onPreset(p)}
                  className={`w-full border p-4 text-left transition-colors ${
                    preset === p
                      ? 'border-paper bg-paper/10'
                      : 'border-paper/25 hover:border-paper/60'
                  }`}
                >
                  <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-paper">
                    <span
                      aria-hidden
                      className={`inline-block h-2 w-2 rounded-full ${
                        preset === p ? 'bg-paper' : 'border border-paper/40'
                      }`}
                    />
                    {PRESET_LABELS[p].label}
                  </span>
                  <span className="mt-1.5 block font-mono text-[10px] leading-relaxed text-paper-dim">
                    {PRESET_LABELS[p].blurb}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {mine.length > 0 ? (
            <div className="mt-6 border-t border-paper/20 pt-5">
              <p className="eyebrow">Flags you have raised</p>
              <p className="mt-2 max-w-lg font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
                Signed with your key and visible to others. Flagging many things weakens every flag
                you give.
              </p>
              <ul className="mt-3 space-y-2">
                {mine.map((flag) => (
                  <li
                    key={flag.id}
                    className="flex flex-wrap items-center gap-3 border border-paper/20 px-4 py-2.5"
                  >
                    <span className="font-mono text-[10px] uppercase tracking-wider text-paper">
                      {FLAG_REASON_LABELS[flag.reason]}
                    </span>
                    <span className="truncate font-mono text-[9px] text-paper/30">
                      {flag.targetEntity} · {flag.targetId.slice(0, 16)}…
                    </span>
                    <button
                      onClick={() => void onWithdraw(flag.targetId)}
                      className="ml-auto font-mono text-[10px] uppercase tracking-wider text-paper-dim hover:text-paper"
                    >
                      Withdraw
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
