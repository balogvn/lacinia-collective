'use client'

import { useState } from 'react'

import { estimateStrength, MIN_PIN_LENGTH, type VaultStrength } from '@/lib/crypto/vault'

interface Props {
  hasPin: boolean
  phraseAcknowledged: boolean
  onSetPin: (pin: string) => Promise<void>
  onRemovePin: (pin: string) => Promise<void>
  onLockNow: () => Promise<void>
}

const STRENGTH_STYLE: Record<VaultStrength, string> = {
  weak: 'text-alarm',
  fair: 'text-signal',
  strong: 'text-paper',
}

/**
 * PIN management.
 *
 * Two things this screen refuses to do, both deliberate:
 *
 * It will not let you set a PIN before acknowledging the recovery phrase.
 * Setting one destroys the stored phrase, so doing it first would take an
 * identity that is one forgotten PIN from gone and give the user no way back.
 *
 * It does not show a reassuring green meter. The estimate assumes an attacker
 * who has the handset and derives offline, because that is the case this
 * feature exists for, and a six-digit PIN does not survive it for long.
 */
export function VaultPanel({
  hasPin,
  phraseAcknowledged,
  onSetPin,
  onRemovePin,
  onLockNow,
}: Props) {
  const [open, setOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const estimate = pin ? estimateStrength(pin) : null
  const matches = pin.length > 0 && pin === confirm
  const canSet = matches && pin.length >= MIN_PIN_LENGTH && phraseAcknowledged

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
      setPin('')
      setConfirm('')
      setNotice(ok)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="border border-paper/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between p-5 text-left"
      >
        <span>
          <span className="eyebrow block">Key protection</span>
          <span className="mt-1 block font-mono text-[11px] uppercase tracking-wider text-paper">
            {hasPin
              ? 'PIN set — the key is encrypted on this device'
              : 'No PIN — the key is readable by anyone holding this phone'}
          </span>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-paper-dim">
          {open ? '− Hide' : '+ Manage'}
        </span>
      </button>

      {open ? (
        <div className="border-t border-paper/25 p-5">
          <p className="max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/50">
            A PIN encrypts your key where it sits. It defends against someone picking up your phone.
            It does not defend against malicious code in this page, or against someone who copies
            the device and takes their time — for that you want a passphrase, not four digits.
          </p>

          {notice ? (
            <p className="mt-4 border border-paper/50 bg-paper/10 px-3 py-2 font-mono text-[11px] text-paper">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className="mt-4 border border-alarm/60 bg-alarm/10 px-3 py-2 font-mono text-[11px] text-paper">
              {error}
            </p>
          ) : null}

          {!phraseAcknowledged && !hasPin ? (
            <p className="mt-5 border border-signal/60 bg-signal/5 px-3 py-2.5 font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper">
              Write down your recovery phrase first. Setting a PIN erases it from this device, and
              it is the only way back if you forget the PIN.
            </p>
          ) : null}

          <div className="mt-5 grid max-w-lg gap-3">
            <label className="block">
              <span className="eyebrow">{hasPin ? 'Current PIN' : 'New PIN or passphrase'}</span>
              <input
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                autoComplete="new-password"
                placeholder={hasPin ? 'Enter to remove it' : 'Six or more characters'}
                className="field mt-2"
              />
            </label>

            {!hasPin ? (
              <label className="block">
                <span className="eyebrow">Type it again</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  className="field mt-2"
                />
              </label>
            ) : null}

            {estimate && !hasPin ? (
              <p
                className={`font-mono text-[10px] uppercase leading-relaxed tracking-wider ${STRENGTH_STYLE[estimate.strength]}`}
              >
                {estimate.strength} · {estimate.note}
              </p>
            ) : null}
            {!hasPin && confirm.length > 0 && !matches ? (
              <p className="font-mono text-[10px] uppercase tracking-wider text-alarm">
                The two do not match.
              </p>
            ) : null}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {hasPin ? (
              <>
                <button
                  onClick={() => void run(() => onRemovePin(pin), 'PIN removed.')}
                  disabled={busy || pin.length === 0}
                  className="btn"
                >
                  {busy ? 'Working…' : 'Remove PIN'}
                </button>
                <button onClick={() => void onLockNow()} className="btn btn-solid">
                  Lock now
                </button>
              </>
            ) : (
              <button
                onClick={() =>
                  void run(
                    () => onSetPin(pin),
                    'PIN set. Your key is now encrypted on this device, and the recovery phrase has been erased from it.',
                  )
                }
                disabled={busy || !canSet}
                className="btn btn-solid"
              >
                {busy ? 'Encrypting…' : 'Set PIN'}
              </button>
            )}
          </div>

          {hasPin ? (
            <p className="mt-4 max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
              Removing the PIN does not bring your recovery phrase back — it was erased when the PIN
              was set. Your twelve words exist only where you wrote them down.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
