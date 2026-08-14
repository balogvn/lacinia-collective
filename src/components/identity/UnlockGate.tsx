'use client'

import { useState } from 'react'

interface Props {
  onUnlock: (pin: string) => Promise<void>
}

/**
 * Shown on every screen while the vault is sealed and this session has not
 * opened it.
 *
 * NO "FORGOT PIN?" LINK, because there is nothing behind it. There is no server
 * to reset against, and the recovery phrase was destroyed when the PIN was set
 * — it exists only wherever the user wrote it down. Offering a reset that
 * cannot reset would be worse than saying so.
 */
export function UnlockGate({ onUnlock }: Props) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempts, setAttempts] = useState(0)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onUnlock(pin)
      setPin('')
    } catch (err) {
      setAttempts((n) => n + 1)
      setError(err instanceof Error ? err.message : String(err))
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="border border-paper/30 p-5 sm:p-7">
      <p className="eyebrow">Locked</p>
      <h2 className="mt-3 font-display text-3xl uppercase text-paper sm:text-4xl">
        Enter your PIN
      </h2>
      <p className="mt-3 max-w-xl font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
        Your key is encrypted on this device. Nothing here works until it is unlocked, and it locks
        again when you close the app.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="mt-6 flex max-w-md flex-col gap-3 sm:flex-row"
      >
        <input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          autoFocus
          autoComplete="current-password"
          placeholder="PIN or passphrase"
          className="field flex-1"
        />
        <button type="submit" disabled={busy || pin.length === 0} className="btn btn-solid">
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>

      {error ? (
        <p className="mt-4 max-w-md border border-alarm/60 bg-alarm/10 px-3 py-2 font-mono text-[11px] text-paper">
          {error}
          {attempts >= 3
            ? ' — if you have lost it, restore from your twelve words on a fresh install.'
            : ''}
        </p>
      ) : null}

      {/*
        Unlocking is slow on purpose: ~310,000 PBKDF2 rounds. Saying so stops
        the delay reading as the app being broken.
      */}
      <p className="mt-4 max-w-xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/40">
        Unlocking takes a moment — the key is deliberately slow to derive, which is what makes
        guessing expensive.
      </p>
    </section>
  )
}
