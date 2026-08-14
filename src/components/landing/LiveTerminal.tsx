'use client'

import { useEffect, useState } from 'react'

import { generateEphemeralKeyPair, fingerprint, contentId } from '@/lib/crypto/keys'
import { createVouchRequest, parseVouchRequest, issueVoucher, parseVoucher } from '@/lib/vouch/protocol'
import { computeTrustGraph, lookupTrust } from '@/lib/vouch/trust'
import { TrustTier, VoucherStatus, TRUST_TIER_LABELS, type TrustVoucher } from '@/lib/db/schema'
import { fromBase64Url } from '@/lib/codec'
import { estimateQRVersion } from '@/lib/qr/render'

type Tab = 'ED25519' | 'TRUST GRAPH'

interface Row {
  value: string
  label: string
}

/**
 * The reference image shows a terminal streaming hashes. Rather than print
 * decorative hex, this runs an ACTUAL vouching handshake in the visitor's
 * browser on mount and prints the real digests — so the first thing anyone sees
 * on the marketing page is the engine working, on their own device, offline.
 */
export function LiveTerminal() {
  const [tab, setTab] = useState<Tab>('ED25519')
  const [ed25519Rows, setEd25519Rows] = useState<Row[]>([])
  const [trustRows, setTrustRows] = useState<Row[]>([])
  const [status, setStatus] = useState('initialising…')
  const [revealed, setRevealed] = useState(0)

  useEffect(() => {
    let cancelled = false

    // Deferred a frame so the first paint is not blocked by key generation on a
    // slow device — the panel should appear immediately, then fill in.
    const run = () => {
      const adaeze = generateEphemeralKeyPair()
      const bilkisu = generateEphemeralKeyPair()

      const { request, encoded: reqEncoded } = createVouchRequest(bilkisu, 'Bilkisu A.')
      const parsedRequest = parseVouchRequest(reqEncoded.qr)
      if (!parsedRequest.ok) return

      const { voucher, encoded: vouEncoded } = issueVoucher(
        adaeze,
        parsedRequest.value,
        TrustTier.Neighbour,
      )
      const verified = parseVoucher(vouEncoded.qr)
      const qrInfo = estimateQRVersion(vouEncoded.qr.length)

      if (cancelled) return

      setEd25519Rows([
        { value: contentId(fromBase64Url(bilkisu.pubKeyId)), label: 'SUBJECT' },
        { value: contentId(reqEncoded.bytes), label: 'REQUEST' },
        { value: contentId(fromBase64Url(voucher.signature)), label: 'SIGNATURE' },
        { value: voucher.id, label: verified.ok ? 'VERIFIED' : 'REJECTED' },
      ])
      setStatus(
        `${vouEncoded.bytes.length} B · ${vouEncoded.qr.length} chars · QR v${qrInfo.version}`,
      )

      // A miniature trust graph so the second tab is also real.
      const anchor = generateEphemeralKeyPair()
      const mk = (i: string, s: string, t: TrustTier): TrustVoucher => ({
        id: `${i}->${s}`,
        issuerPub: i,
        subjectPub: s,
        tier: t,
        nonce: 'n',
        issuedAt: Date.now() - 1000,
        expiresAt: Date.now() + 31_536_000_000,
        signature: 's',
        signedBytes: 's',
        status: VoucherStatus.Valid,
        receivedAt: Date.now(),
        direction: 'INBOUND',
        hlc: '0',
      })

      const graph = computeTrustGraph(
        [
          mk(anchor.pubKeyId, adaeze.pubKeyId, TrustTier.Steward),
          mk(adaeze.pubKeyId, bilkisu.pubKeyId, TrustTier.Neighbour),
        ],
        [anchor.pubKeyId],
      )

      const anchorNode = lookupTrust(graph, anchor.pubKeyId)
      const adaezeNode = lookupTrust(graph, adaeze.pubKeyId)
      const bilkisuNode = lookupTrust(graph, bilkisu.pubKeyId)

      setTrustRows([
        {
          value: `${fingerprint(anchor.publicKey)}   score ${anchorNode.score.toFixed(3)}`,
          label: TRUST_TIER_LABELS[anchorNode.tier].toUpperCase(),
        },
        {
          value: `${fingerprint(adaeze.publicKey)}   score ${adaezeNode.score.toFixed(3)}`,
          label: TRUST_TIER_LABELS[adaezeNode.tier].toUpperCase(),
        },
        {
          value: `${fingerprint(bilkisu.publicKey)}   score ${bilkisuNode.score.toFixed(3)}`,
          label: TRUST_TIER_LABELS[bilkisuNode.tier].toUpperCase(),
        },
        {
          value: `${graph.edgeCount} edges · ${graph.rounds} layers · exact`,
          label: 'CONVERGED',
        },
      ])
    }

    const handle = requestAnimationFrame(run)
    return () => {
      cancelled = true
      cancelAnimationFrame(handle)
    }
  }, [])

  const rows = tab === 'ED25519' ? ed25519Rows : trustRows

  // Reveal one line at a time — the streaming feel of the reference, without
  // faking any of the underlying values.
  useEffect(() => {
    setRevealed(0)
    if (rows.length === 0) return
    const timers = rows.map((_, i) => setTimeout(() => setRevealed(i + 1), 180 * (i + 1)))
    return () => timers.forEach(clearTimeout)
  }, [tab, rows.length])

  return (
    <div className="terminal w-full">
      <div
        className="flex items-stretch border-b border-canvas/25"
        role="tablist"
        aria-label="Live engine output"
      >
        {(['ED25519', 'TRUST GRAPH'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
              tab === t
                ? 'bg-canvas/10 text-canvas'
                : 'text-canvas/45 hover:text-canvas/80'
            }`}
          >
            {t}
          </button>
        ))}
        <div className="flex-1 border-l border-canvas/15" />
        <div className="flex items-center gap-1.5 border-l border-canvas/25 px-4">
          <span className="h-1.5 w-1.5 rounded-full bg-canvas/35" />
          <span className="h-1.5 w-1.5 rounded-full bg-canvas/35" />
          <span className="h-1.5 w-1.5 rounded-full bg-canvas/35" />
        </div>
      </div>

      <div className="min-h-[168px] px-4 py-3.5">
        <p className="font-mono text-[11px] text-canvas/70">
          &gt;{' '}
          {tab === 'ED25519'
            ? 'signing vouch handshake on this device…'
            : 'propagating trust from anchor…'}
        </p>

        <div className="mt-2 space-y-1 overflow-x-auto no-scrollbar">
          {rows.slice(0, revealed).map((row) => (
            <div key={row.label} className="flex items-baseline gap-3 whitespace-nowrap">
              <code className="font-mono text-[11px] text-canvas/90">{row.value}</code>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-canvas/45">
                {row.label}
              </span>
            </div>
          ))}
        </div>

        {revealed >= rows.length && rows.length > 0 ? (
          <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-canvas/45">
            {tab === 'ED25519' ? status : 'no server contacted'}
          </p>
        ) : null}

        <span className="mt-2 inline-block h-3 w-2 animate-blink bg-canvas align-middle" />
      </div>
    </div>
  )
}
