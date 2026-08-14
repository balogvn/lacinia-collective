'use client'

import { useState } from 'react'

import { idToPubKey, fingerprintFromId } from '@/lib/crypto/keys'
import { setAnchors } from '@/lib/db/repo'
import type { PubKeyId } from '@/lib/db/schema'

interface Props {
  anchors: PubKeyId[]
  onChange: () => Promise<void> | void
}

/**
 * Anchor management.
 *
 * Anchors are the axioms of the trust graph — the only scores not derived from
 * something else. Everything in trust.ts propagates outward from this list, so
 * with an empty list every score in the system is exactly zero and nobody can
 * ever leave Observer. That makes this panel load-bearing, not administrative.
 *
 * Crucially, the anchor set is chosen BY THE DEVICE OWNER, not shipped by us.
 * A hardcoded anchor list would make this a platform with a central authority
 * wearing a decentralised costume. A community body — a mosque, a parish, a
 * market association, a co-op — publishes its public key on a poster or a radio
 * slot, and each person decides whose word roots their own graph. Two people in
 * the same town can legitimately hold different anchor sets and compute
 * different, equally valid scores.
 */
export function AnchorPanel({ anchors, onChange }: Props) {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const add = async () => {
    const candidate = input.trim()
    setError(null)
    try {
      // Validates length and encoding — a mistyped key would otherwise sit in
      // the list forever, silently rooting nothing.
      idToPubKey(candidate)
    } catch {
      setError('That is not a valid Lacinia public key.')
      return
    }
    if (anchors.includes(candidate)) {
      setError('That anchor is already trusted.')
      return
    }
    await setAnchors([...anchors, candidate])
    setInput('')
    await onChange()
  }

  const remove = async (key: PubKeyId) => {
    await setAnchors(anchors.filter((a) => a !== key))
    await onChange()
  }

  return (
    <section className="border border-paper/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between p-5 text-left"
      >
        <span>
          <span className="eyebrow block">Anchors — the root of your trust graph</span>
          <span className="mt-1 block font-mono text-[11px] uppercase tracking-wider text-paper">
            {anchors.length === 0
              ? 'None trusted yet — every score stays at zero'
              : `${anchors.length} anchor${anchors.length === 1 ? '' : 's'} trusted`}
          </span>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-paper-dim">
          {open ? '− Hide' : '+ Manage'}
        </span>
      </button>

      {open ? (
        <div className="border-t border-paper/25 p-5">
          <p className="max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/50">
            An anchor is a community body whose word you accept as a starting point — a mosque, a
            parish, a market association, a co-operative. They publish their public key where you
            can verify it in person. Nothing is trusted by default, and we do not choose for you:
            standing is only ever as good as the anchors you personally accept.
          </p>

          {anchors.length > 0 ? (
            <ul className="mt-5 space-y-2">
              {anchors.map((a) => (
                <li
                  key={a}
                  className="flex flex-wrap items-center gap-3 border border-paper/20 px-4 py-3"
                >
                  <span className="font-mono text-sm tracking-wider text-paper">
                    {fingerprintFromId(a)}
                  </span>
                  <span className="truncate font-mono text-[9px] text-paper/30">{a}</span>
                  <button
                    onClick={() => void remove(a)}
                    className="ml-auto font-mono text-[10px] uppercase tracking-wider text-paper-dim hover:text-alarm"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              placeholder="Paste the anchor's public key"
              className="field flex-1 text-[11px]"
            />
            <button onClick={add} disabled={!input.trim()} className="btn">
              Trust this anchor
            </button>
          </div>

          {error ? (
            <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-alarm">{error}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
