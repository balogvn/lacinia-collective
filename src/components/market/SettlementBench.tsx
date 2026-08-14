'use client'

import { useCallback, useEffect, useState } from 'react'

import { QRPanel } from '@/components/qr/QRPanel'
import { ScannerPanel } from '@/components/qr/ScannerPanel'
import {
  proposeSettlement,
  parseProposal,
  confirmSettlement,
  parseConfirmation,
  completeSettlement,
  SETTLEMENT_MESSAGES,
  type SettlementProposal,
} from '@/lib/ledger/entry'
import { checkSolvency, formatCredits, lookupBalance, type BalanceView } from '@/lib/ledger/balance'
import {
  savePendingProposal,
  getPendingProposals,
  clearPendingProposal,
} from '@/lib/db/repo'
import { fingerprintFromId, type KeyPair } from '@/lib/crypto/keys'
import { TrustTier, type LedgerEntry, type PubKeyId, type ResourceListing } from '@/lib/db/schema'
import { log } from '@/lib/telemetry'

interface Props {
  keyPair: KeyPair
  balances: Map<PubKeyId, BalanceView>
  tierOf: (pubKey: PubKeyId) => TrustTier
  listing: ResourceListing | null
  onRecord: (entry: LedgerEntry) => Promise<{ isNew: boolean }>
  onClose: () => void
}

type Mode = 'provide' | 'pay'

/**
 * The two-scan settlement handshake.
 *
 * "I did the work" proposes; "I received it" confirms. The direction is not
 * cosmetic — nobody may be charged without consenting, so the payer's signature
 * is what makes the entry real.
 */
export function SettlementBench({
  keyPair,
  balances,
  tierOf,
  listing,
  onRecord,
  onClose,
}: Props) {
  const [mode, setMode] = useState<Mode>('provide')
  const [amount, setAmount] = useState(listing?.timeCredits || 60)
  const [payerPub, setPayerPub] = useState('')
  const [proposalQR, setProposalQR] = useState<string | null>(null)
  const [incoming, setIncoming] = useState<SettlementProposal | null>(null)
  const [confirmQR, setConfirmQR] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null)

  useEffect(() => {
    setAmount(listing?.timeCredits || 60)
  }, [listing])

  /* ── provider side ─────────────────────────────────────────────── */

  const propose = async () => {
    try {
      const { proposal, encoded } = proposeSettlement(keyPair, {
        payerPub: payerPub.trim(),
        amount,
        listingId: listing?.id ?? null,
      })
      // Persist: the provider may lock their phone while the other person gets
      // their camera working, and a lost proposal makes the confirmation
      // unmatchable.
      await savePendingProposal(proposal)
      setProposalQR(encoded.qr)
      setNotice(null)
    } catch (err) {
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const onScanConfirmation = useCallback(
    async (text: string) => {
      const parsed = parseConfirmation(text)
      if (!parsed.ok) {
        setNotice({ kind: 'bad', text: SETTLEMENT_MESSAGES[parsed.reason] })
        return
      }
      const pending = await getPendingProposals()
      const completed = completeSettlement(parsed.value, pending)
      if (!completed.ok) {
        setNotice({ kind: 'bad', text: SETTLEMENT_MESSAGES[completed.reason] })
        return
      }
      try {
        const { isNew } = await onRecord(completed.value)
        await clearPendingProposal(completed.value.nonce)
        setProposalQR(null)
        setNotice({
          kind: 'ok',
          text: isNew
            ? `Recorded. You earned ${formatCredits(completed.value.amount)}.`
            : 'You already had this exchange recorded.',
        })
      } catch (err) {
        setNotice({ kind: 'bad', text: err instanceof Error ? err.message : String(err) })
      }
    },
    [onRecord],
  )

  /* ── payer side ────────────────────────────────────────────────── */

  const onScanProposal = (text: string) => {
    const parsed = parseProposal(text)
    if (!parsed.ok) {
      setNotice({ kind: 'bad', text: `${SETTLEMENT_MESSAGES[parsed.reason]} (${parsed.detail})` })
      return
    }
    if (parsed.value.fromPub !== keyPair.pubKeyId) {
      setNotice({ kind: 'bad', text: 'This offer was addressed to a different person.' })
      return
    }
    setIncoming(parsed.value)
    setNotice(null)
  }

  const confirm = async () => {
    if (!incoming) return
    try {
      const { entry, encoded } = confirmSettlement(keyPair, incoming)
      await onRecord(entry)
      setConfirmQR(encoded.qr)
      setNotice({
        kind: 'ok',
        text: `Signed. Show this to ${incoming.toFingerprint} so they can record it too.`,
      })
      log.info('sync', 'payer confirmed settlement', { amount: incoming.amount })
    } catch (err) {
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : String(err) })
    }
  }

  /* ── solvency, computed for whichever side we are on ───────────── */

  const myBalance = lookupBalance(balances, keyPair.pubKeyId, tierOf(keyPair.pubKeyId), true)

  const payerKey = mode === 'provide' ? payerPub.trim() : keyPair.pubKeyId
  const payerBalance = payerKey
    ? lookupBalance(balances, payerKey, tierOf(payerKey), payerKey === keyPair.pubKeyId)
    : null
  const checkAmount = mode === 'provide' ? amount : (incoming?.amount ?? 0)
  const solvency = payerBalance
    ? checkSolvency(payerBalance, checkAmount, mode === 'pay' ? 'you' : 'them')
    : null

  return (
    <section className="border border-paper/30">
      <div className="flex flex-wrap border-b border-paper/25">
        {(
          [
            { id: 'provide' as const, label: 'I did the work', hint: 'Ask them to pay you' },
            { id: 'pay' as const, label: 'I received help', hint: 'Scan their code and confirm' },
          ]
        ).map((m) => (
          <button
            key={m.id}
            onClick={() => {
              setMode(m.id)
              setNotice(null)
            }}
            className={`flex-1 border-r border-paper/25 px-4 py-3.5 text-left transition-colors last:border-r-0 ${
              mode === m.id ? 'bg-paper text-canvas' : 'text-paper-dim hover:text-paper'
            }`}
          >
            <span className="block font-mono text-[11px] uppercase tracking-wider">{m.label}</span>
            <span
              className={`mt-1 block font-mono text-[9px] uppercase tracking-wider ${
                mode === m.id ? 'text-canvas/60' : 'text-paper/35'
              }`}
            >
              {m.hint}
            </span>
          </button>
        ))}
        <button
          onClick={onClose}
          className="border-l border-paper/25 px-4 font-mono text-[10px] uppercase tracking-wider text-paper-dim hover:text-paper"
        >
          Close
        </button>
      </div>

      {listing ? (
        <p className="border-b border-paper/20 px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-paper-dim">
          Settling · {listing.title}
        </p>
      ) : null}

      <div className="p-5">
        {notice ? (
          <p
            className={`mb-5 border px-3 py-2.5 font-mono text-[11px] leading-relaxed ${
              notice.kind === 'ok'
                ? 'border-paper/50 bg-paper/10 text-paper'
                : 'border-alarm/60 bg-alarm/10 text-paper'
            }`}
          >
            {notice.text}
          </p>
        ) : null}

        {/* ── PROVIDER ─────────────────────────────────────────────── */}
        {mode === 'provide' ? (
          <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
            {proposalQR ? (
              <div className="space-y-3">
                <QRPanel payload={proposalQR} caption="Let them scan this" />
                <ScannerPanel
                  onScan={(t) => void onScanConfirmation(t)}
                  label="Then scan their confirmation"
                />
              </div>
            ) : (
              <div className="border border-paper/25 p-5">
                <p className="eyebrow">Your balance</p>
                <p className="mt-2 font-display text-4xl uppercase text-paper">
                  {formatCredits(myBalance.balance)}
                </p>
              </div>
            )}

            <div>
              <p className="eyebrow">Step 1 of 2</p>
              <h3 className="mt-2 font-display text-2xl uppercase text-paper sm:text-3xl">
                Ask them to confirm
              </h3>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="block sm:col-span-2">
                  <span className="eyebrow">Their public key</span>
                  <input
                    value={payerPub}
                    onChange={(e) => setPayerPub(e.target.value)}
                    spellCheck={false}
                    placeholder="Paste, or scan their identity code"
                    className="field mt-2 text-[11px]"
                  />
                  {payerPub.trim() ? (
                    <span className="mt-1.5 block font-mono text-[10px] tracking-wider text-paper/45">
                      {(() => {
                        try {
                          return fingerprintFromId(payerPub.trim())
                        } catch {
                          return 'Not a valid key'
                        }
                      })()}
                    </span>
                  ) : null}
                </label>

                <label className="block">
                  <span className="eyebrow">Minutes</span>
                  <input
                    type="number"
                    min={1}
                    value={amount}
                    onChange={(e) => setAmount(Math.floor(Number(e.target.value) || 0))}
                    className="field mt-2"
                  />
                </label>

                <div className="self-end pb-1">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-paper-dim">
                    = {formatCredits(amount)}
                  </span>
                </div>
              </div>

              {/*
                Advisory here, authoritative on their device. Our view of their
                history may be incomplete, and saying so is the honest framing.
              */}
              {solvency && payerPub.trim() ? (
                <p
                  className={`mt-4 border-l pl-3 font-mono text-[10px] uppercase leading-relaxed tracking-wider ${
                    solvency.ok ? 'border-paper/25 text-paper/45' : 'border-alarm text-alarm'
                  }`}
                >
                  {solvency.reason}
                  {payerBalance && payerBalance.confidence !== 'own'
                    ? ' Based only on exchanges this phone has seen.'
                    : ''}
                </p>
              ) : null}

              <button
                onClick={propose}
                disabled={!payerPub.trim() || amount < 1 || !!proposalQR}
                className="btn btn-solid mt-6"
              >
                Create the offer
              </button>

              {proposalQR ? (
                <button
                  onClick={() => {
                    setProposalQR(null)
                    setNotice(null)
                  }}
                  className="btn ml-2 mt-6"
                >
                  Start over
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ── PAYER ────────────────────────────────────────────────── */}
        {mode === 'pay' ? (
          <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
            {confirmQR ? (
              <QRPanel payload={confirmQR} caption="Show this back to them" />
            ) : (
              <ScannerPanel onScan={onScanProposal} label="Scan their offer" />
            )}

            <div>
              {incoming ? (
                <>
                  <p className="eyebrow">They are asking you to confirm</p>
                  <h3 className="mt-2 font-display text-2xl uppercase text-paper sm:text-3xl">
                    Pay {formatCredits(incoming.amount)}?
                  </h3>
                  <p className="mt-2 font-mono text-lg tracking-wider text-paper">
                    {incoming.toFingerprint}
                  </p>
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-paper/45">
                    Check this fingerprint matches the person in front of you.
                  </p>

                  {solvency ? (
                    <p
                      className={`mt-4 border-l pl-3 font-mono text-[10px] uppercase leading-relaxed tracking-wider ${
                        solvency.ok ? 'border-paper/25 text-paper/45' : 'border-alarm text-alarm'
                      }`}
                    >
                      {solvency.reason}
                    </p>
                  ) : null}

                  {!confirmQR ? (
                    <button
                      onClick={confirm}
                      disabled={!solvency?.ok}
                      className="btn btn-solid mt-6"
                    >
                      Confirm and sign
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setIncoming(null)
                        setConfirmQR(null)
                        setNotice(null)
                      }}
                      className="btn mt-6"
                    >
                      Done
                    </button>
                  )}
                </>
              ) : (
                <>
                  <p className="eyebrow">Step 2 of 2 — your side</p>
                  <h3 className="mt-2 font-display text-2xl uppercase text-paper sm:text-3xl">
                    Nobody can charge you without your signature
                  </h3>
                  <p className="mt-4 max-w-lg font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
                    Scan what they show you. Your phone checks the amount against your own credit
                    line before it will let you sign, and the record only becomes real once both of
                    you have signed the same thing.
                  </p>
                </>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
