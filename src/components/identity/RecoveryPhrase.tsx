'use client'

import { useState } from 'react'

interface Props {
  phrase: string
  onAcknowledge: () => Promise<void> | void
  /** True when shown again later from the identity card rather than at creation. */
  revisiting?: boolean
}

/**
 * The recovery phrase gate.
 *
 * This component exists as a separate, PARENT-OWNED screen for a reason. The
 * first implementation rendered the phrase inside the creation form, and the
 * moment the identity was written to IndexedDB the parent swapped the form out
 * for the workbench — so the twelve words flashed out of existence before
 * anyone could read them. With no server and no password reset, that is not a
 * cosmetic bug: it silently produces identities that can never be recovered.
 *
 * So the phrase now blocks the whole workbench until it is explicitly
 * acknowledged, and it survives a reload.
 */
export function RecoveryPhrase({ phrase, onAcknowledge, revisiting = false }: Props) {
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)

  const words = phrase.split(' ')

  const accept = async () => {
    setBusy(true)
    try {
      await onAcknowledge()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="border border-signal/60 bg-signal/5 p-5 sm:p-7">
      <p className="eyebrow text-signal">
        {revisiting ? 'Keep this private' : 'Write this down before you continue'}
      </p>
      <h2 className="mt-3 font-display text-3xl uppercase text-paper sm:text-4xl">
        Your recovery phrase
      </h2>
      <p className="mt-3 max-w-2xl font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
        There is no server, no password reset, and nobody to call. These twelve words are the only
        way to bring this identity back if the phone is lost, sold or wiped. Write them on paper.
        Not a screenshot — a photo in your gallery is the first thing an attacker reads.
      </p>

      <ol className="mt-6 grid grid-cols-2 gap-x-5 gap-y-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {words.map((word, i) => (
          <li
            key={`${word}-${i}`}
            className="flex items-baseline gap-2.5 border-b border-paper/20 pb-1.5"
          >
            <span className="font-mono text-[10px] text-paper/35">
              {String(i + 1).padStart(2, '0')}
            </span>
            <span className="font-mono text-sm text-paper">{word}</span>
          </li>
        ))}
      </ol>

      {revisiting ? (
        <button onClick={accept} className="btn mt-7">
          Hide it again
        </button>
      ) : (
        <>
          <label className="mt-7 flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-signal"
            />
            <span className="font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper">
              I have written these twelve words on paper and stored them somewhere safe.
            </span>
          </label>

          <button onClick={accept} disabled={!confirmed || busy} className="btn btn-solid mt-5">
            {busy ? 'Saving…' : 'Continue to the commons'}
          </button>
        </>
      )}
    </section>
  )
}
