'use client'

import { useState } from 'react'
import { NIGERIAN_STATES } from '@/lib/data/nigeria'
import { isValidRecoveryPhrase } from '@/lib/crypto/keys'

interface Props {
  onCreate: (input: {
    displayName: string
    locality?: { state: string; lga: string }
  }) => Promise<{ phrase: string }>
  onRestore: (phrase: string, displayName: string) => Promise<unknown>
}

type Mode = 'create' | 'restore'

export function CreateIdentity({ onCreate, onRestore }: Props) {
  const [mode, setMode] = useState<Mode>('create')
  const [displayName, setDisplayName] = useState('')
  const [state, setState] = useState('')
  const [lga, setLga] = useState('')
  const [restorePhrase, setRestorePhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)


  const submitCreate = async () => {
    setBusy(true)
    setError(null)
    try {
      // The recovery phrase is surfaced by the PARENT, which gates the whole
      // workbench on it. Showing it from here would be destroyed by the
      // re-render that follows identity creation. See RecoveryPhrase.tsx.
      await onCreate({
        displayName,
        ...(state && lga ? { locality: { state, lga } } : {}),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const submitRestore = async () => {
    setBusy(true)
    setError(null)
    try {
      await onRestore(restorePhrase, displayName || 'Restored identity')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /* ── form ───────────────────────────────────────────────────────── */
  return (
    <section className="border border-paper/30 p-5 sm:p-7">
      <div className="flex gap-5">
        {(['create', 'restore'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`font-mono text-[11px] uppercase tracking-wider transition-colors ${
              mode === m ? 'text-paper underline underline-offset-8' : 'text-paper-dim hover:text-paper'
            }`}
          >
            {m === 'create' ? 'New identity' : 'Restore from phrase'}
          </button>
        ))}
      </div>

      <h2 className="mt-5 font-display text-3xl uppercase text-paper sm:text-4xl">
        {mode === 'create' ? 'Join the commons' : 'Bring back your identity'}
      </h2>
      <p className="mt-2 max-w-xl font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
        No email. No password. No phone number. A keypair is generated on this device and never
        leaves it.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="eyebrow">Name others will see</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Bilkisu A."
            maxLength={40}
            className="field mt-2"
          />
        </label>

        {mode === 'create' ? (
          <>
            <label className="block">
              <span className="eyebrow">State</span>
              <select value={state} onChange={(e) => setState(e.target.value)} className="field mt-2">
                <option value="">Prefer not to say</option>
                {NIGERIAN_STATES.map((s) => (
                  <option key={s} value={s} className="bg-canvas-deep">
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="eyebrow">Local Government Area</span>
              <input
                value={lga}
                onChange={(e) => setLga(e.target.value)}
                placeholder="e.g. Ikorodu"
                className="field mt-2"
              />
            </label>

          </>
        ) : (
          <label className="block sm:col-span-2">
            <span className="eyebrow">Your twelve words</span>
            <textarea
              value={restorePhrase}
              onChange={(e) => setRestorePhrase(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder="word word word …"
              className="field mt-2 resize-none"
            />
            {restorePhrase.trim().split(/\s+/).length >= 12 ? (
              <span
                className={`mt-2 block font-mono text-[10px] uppercase tracking-wider ${
                  isValidRecoveryPhrase(restorePhrase) ? 'text-paper-dim' : 'text-alarm'
                }`}
              >
                {isValidRecoveryPhrase(restorePhrase)
                  ? 'Phrase is valid'
                  : 'Not a valid phrase — check spelling and order'}
              </span>
            ) : null}
          </label>
        )}
      </div>

      {error ? (
        <p className="mt-4 border border-alarm/60 bg-alarm/10 px-3 py-2 font-mono text-[11px] text-paper">
          {error}
        </p>
      ) : null}

      <button
        onClick={mode === 'create' ? submitCreate : submitRestore}
        disabled={
          busy ||
          !displayName.trim() ||
          (mode === 'restore' && !isValidRecoveryPhrase(restorePhrase))
        }
        className="btn btn-solid mt-6"
      >
        {busy ? 'Generating…' : mode === 'create' ? 'Generate my keypair' : 'Restore identity'}
      </button>
    </section>
  )
}
