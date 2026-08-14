'use client'

import { useCallback, useEffect, useState } from 'react'

import { QRPanel } from '@/components/qr/QRPanel'
import { ScannerPanel } from '@/components/qr/ScannerPanel'
import {
  createVouchRequest,
  parseVouchRequest,
  issueVoucher,
  parseVoucher,
  acceptVoucher,
  REJECT_MESSAGES,
  type VouchRequest,
  type ParsedVoucher,
} from '@/lib/vouch/protocol'
import { type KeyPair, generateEphemeralKeyPair } from '@/lib/crypto/keys'
import { savePendingNonce, getPendingNonce, clearPendingNonce, stamp } from '@/lib/db/repo'
import { TrustTier, TRUST_TIER_LABELS, type TrustVoucher, type UserIdentity } from '@/lib/db/schema'
import { log } from '@/lib/telemetry'

interface Props {
  identity: UserIdentity
  keyPair: KeyPair
  onStore: (voucher: TrustVoucher, peerName?: string) => Promise<unknown>
  grantableTier: TrustTier
}

type Mode = 'show' | 'give' | 'receive'

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: 'show', label: 'Show my code', hint: 'Ask a neighbour to vouch for you' },
  { id: 'give', label: 'Vouch for someone', hint: 'Scan their code and sign' },
  { id: 'receive', label: 'Receive a vouch', hint: 'Scan the code they show back' },
]

export function VouchBench({ identity, keyPair, onStore, grantableTier }: Props) {
  const [mode, setMode] = useState<Mode>('show')
  const [myRequest, setMyRequest] = useState<{ request: VouchRequest; qr: string } | null>(null)
  const [scannedRequest, setScannedRequest] = useState<VouchRequest | null>(null)
  const [issuedQR, setIssuedQR] = useState<string | null>(null)
  const [tierToGrant, setTierToGrant] = useState<TrustTier>(TrustTier.Neighbour)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null)

  /* ── step 1: mint my request ─────────────────────────────────────── */
  const mintRequest = useCallback(async () => {
    const { request, encoded } = createVouchRequest(keyPair, identity.displayName)
    // The nonce must outlive a page reload: the neighbour may take a minute to
    // sign, and without it we cannot bind their voucher to this exchange.
    await savePendingNonce(request.nonce)
    setMyRequest({ request, qr: encoded.qr })
  }, [keyPair, identity.displayName])

  useEffect(() => {
    if (mode === 'show' && !myRequest) void mintRequest()
  }, [mode, myRequest, mintRequest])

  /* ── step 2: scan someone's request ──────────────────────────────── */
  const onScanRequest = (text: string) => {
    const result = parseVouchRequest(text)
    if (!result.ok) {
      setNotice({ kind: 'bad', text: `${REJECT_MESSAGES[result.reason]} (${result.detail})` })
      return
    }
    if (result.value.subjectPub === identity.pubKey) {
      setNotice({ kind: 'bad', text: 'That is your own code — you cannot vouch for yourself.' })
      return
    }
    setNotice(null)
    setScannedRequest(result.value)
    setIssuedQR(null)
  }

  /* ── step 3: sign it ─────────────────────────────────────────────── */
  const signVoucher = async () => {
    if (!scannedRequest) return
    try {
      const { voucher, encoded } = issueVoucher(keyPair, scannedRequest, tierToGrant)
      setIssuedQR(encoded.qr)

      // Keep our own copy: outbound vouches are what the capacity constraint
      // measures, so they must be recorded even though they help someone else.
      const hlc = await stamp()
      await onStore(
        {
          ...voucher,
          status: 'VALID' as TrustVoucher['status'],
          receivedAt: Date.now(),
          direction: 'OUTBOUND',
          hlc,
        },
        scannedRequest.displayName,
      )
      setNotice({ kind: 'ok', text: `Signed. Show this code to ${scannedRequest.displayName}.` })
    } catch (err) {
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : String(err) })
    }
  }

  /* ── step 4: receive the signed voucher ──────────────────────────── */
  const onScanVoucher = async (text: string) => {
    const parsed = parseVoucher(text)
    if (!parsed.ok) {
      setNotice({ kind: 'bad', text: `${REJECT_MESSAGES[parsed.reason]} (${parsed.detail})` })
      return
    }

    const expectedNonce = await getPendingNonce()
    const accepted = acceptVoucher(
      parsed.value,
      { pubKeyId: identity.pubKey },
      expectedNonce,
      { deviceHlc: await stamp() },
    )
    if (!accepted.ok) {
      setNotice({ kind: 'bad', text: `${REJECT_MESSAGES[accepted.reason]} (${accepted.detail})` })
      return
    }

    const { isNew } = (await onStore(accepted.value)) as { isNew: boolean }
    await clearPendingNonce()
    setMyRequest(null)
    setNotice({
      kind: 'ok',
      text: isNew
        ? `Vouch accepted from ${parsed.value.issuerFingerprint} at ${TRUST_TIER_LABELS[parsed.value.tier]}.`
        : 'You already hold this vouch — nothing changed.',
    })
  }

  /* ── single-device rehearsal ─────────────────────────────────────── */
  /**
   * Runs the counterpart role locally with a throwaway keypair, so one person
   * can see the whole handshake without a second phone. Explicitly labelled:
   * the peer is simulated, and the resulting vouch is real but from a key
   * nobody controls, so it confers no anchor-derived standing.
   */
  const rehearse = async () => {
    if (!myRequest) return
    const simulated = generateEphemeralKeyPair()
    const parsed = parseVouchRequest(myRequest.qr)
    if (!parsed.ok) return

    const { encoded } = issueVoucher(simulated, parsed.value, TrustTier.Neighbour)
    log.info('vouch', 'rehearsal handshake executed with simulated peer')
    await onScanVoucher(encoded.qr)
  }

  return (
    <section className="border border-paper/30">
      <div className="flex flex-wrap border-b border-paper/25">
        {MODES.map((m) => (
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
      </div>

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

        {/* ── show ──────────────────────────────────────────────────── */}
        {mode === 'show' ? (
          <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
            {myRequest ? (
              <QRPanel payload={myRequest.qr} caption="Your vouch request" />
            ) : (
              <div className="terminal flex aspect-square items-center justify-center p-4 font-mono text-[10px] uppercase tracking-wider text-canvas/40">
                minting…
              </div>
            )}

            <div>
              <p className="eyebrow">Step 1 of 2</p>
              <h3 className="mt-2 font-display text-2xl uppercase text-paper sm:text-3xl">
                Show this to someone who already belongs
              </h3>
              <ol className="mt-4 space-y-2.5 font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
                <li>01 — They scan this code with their Lacinia app.</li>
                <li>02 — Their phone checks you actually hold this key.</li>
                <li>03 — They choose a level and sign.</li>
                <li>04 — Switch to “Receive a vouch” and scan what they show back.</li>
              </ol>

              <p className="mt-5 max-w-lg border-l border-paper/25 pl-4 font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
                This code carries only your public key, your name and a one-time number. Your secret
                key never leaves this phone.
              </p>

              <div className="mt-6 border border-paper/25 p-4">
                <p className="eyebrow">Trying it alone?</p>
                <p className="mt-2 max-w-lg font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
                  Run the handshake against a simulated neighbour to see it work end to end. The
                  vouch is cryptographically real but comes from a throwaway key, so it grants no
                  standing.
                </p>
                <button onClick={rehearse} disabled={!myRequest} className="btn mt-3">
                  Rehearse with a simulated neighbour
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── give ──────────────────────────────────────────────────── */}
        {mode === 'give' ? (
          <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
            {issuedQR ? (
              <QRPanel payload={issuedQR} caption="Signed vouch — let them scan it" />
            ) : (
              <ScannerPanel onScan={onScanRequest} label="Scan their vouch request" />
            )}

            <div>
              {scannedRequest ? (
                <>
                  <p className="eyebrow">Verified — they hold this key</p>
                  <h3 className="mt-2 font-display text-2xl uppercase text-paper sm:text-3xl">
                    {scannedRequest.displayName}
                  </h3>
                  <p className="mt-2 font-mono text-lg tracking-wider text-paper">
                    {scannedRequest.subjectFingerprint}
                  </p>
                  <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-paper/45">
                    Read this fingerprint aloud together before you sign.
                  </p>

                  {!issuedQR ? (
                    <>
                      <div className="mt-6">
                        <p className="eyebrow">How well do you know them?</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {[TrustTier.Observer, TrustTier.Neighbour, TrustTier.Steward].map((t) => (
                            <button
                              key={t}
                              onClick={() => setTierToGrant(t)}
                              disabled={t > grantableTier}
                              className={`border px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                                tierToGrant === t
                                  ? 'border-paper bg-paper text-canvas'
                                  : 'border-paper/30 text-paper-dim hover:border-paper/70'
                              }`}
                            >
                              {TRUST_TIER_LABELS[t]}
                            </button>
                          ))}
                        </div>
                        <p className="mt-3 max-w-lg font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
                          You cannot grant above your own standing. Vouching for many people
                          weakens every vouch you give — including the ones you already gave.
                        </p>
                      </div>

                      <button onClick={signVoucher} className="btn btn-solid mt-6">
                        Sign this vouch
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        setScannedRequest(null)
                        setIssuedQR(null)
                        setNotice(null)
                      }}
                      className="btn mt-6"
                    >
                      Vouch for someone else
                    </button>
                  )}
                </>
              ) : (
                <>
                  <p className="eyebrow">Step 2 of 2 — their side</p>
                  <h3 className="mt-2 font-display text-2xl uppercase text-paper sm:text-3xl">
                    Only vouch for people you actually know
                  </h3>
                  <p className="mt-4 max-w-lg font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
                    A vouch is a claim about a real person, in your own name, that stays attached to
                    you. If they turn out to be a fake account, your own standing carries the cost.
                  </p>
                </>
              )}
            </div>
          </div>
        ) : null}

        {/* ── receive ───────────────────────────────────────────────── */}
        {mode === 'receive' ? (
          <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
            <ScannerPanel onScan={(t) => void onScanVoucher(t)} label="Scan the signed vouch" />
            <div>
              <p className="eyebrow">Step 2 of 2 — your side</p>
              <h3 className="mt-2 font-display text-2xl uppercase text-paper sm:text-3xl">
                Scan what they show back
              </h3>
              <p className="mt-4 max-w-lg font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
                Your phone checks the signature, checks the vouch was issued to your key, and checks
                it answers the exact request you just showed. Anything else is refused.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
