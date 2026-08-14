'use client'

import { useState } from 'react'

import {
  TRUST_TIER_LABELS,
  VoucherStatus,
  RevocationReason,
  REVOCATION_REASON_LABELS,
  type TrustVoucher,
  type UserIdentity,
} from '@/lib/db/schema'
import { fingerprintFromId } from '@/lib/crypto/keys'

interface Props {
  vouchers: TrustVoucher[]
  peers: UserIdentity[]
  selfPub: string
  onRevoke: (voucher: TrustVoucher, reason: RevocationReason) => Promise<void>
}

const STATUS_STYLE: Record<VoucherStatus, string> = {
  [VoucherStatus.Valid]: 'text-paper',
  [VoucherStatus.Expired]: 'text-paper/40',
  [VoucherStatus.Revoked]: 'text-alarm',
  [VoucherStatus.Invalid]: 'text-alarm',
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

export function VouchList({ vouchers, peers, selfPub, onRevoke }: Props) {
  const [revoking, setRevoking] = useState<TrustVoucher | null>(null)

  if (vouchers.filter((v) => v.issuerPub === selfPub || v.subjectPub === selfPub).length === 0) {
    return (
      <section className="border border-paper/30 p-5">
        <p className="eyebrow">Vouches</p>
        <p className="mt-3 max-w-lg font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
          Nothing yet. Standing here is built face to face — there is no way to buy it, and no
          button that grants it.
        </p>
      </section>
    )
  }

  // Returns null rather than falling back to the fingerprint, so the cell can
  // render the fingerprint once instead of twice.
  const nameFor = (pubKey: string): string | null =>
    peers.find((p) => p.pubKey === pubKey)?.displayName ?? null

  // Only vouches this device is actually party to. After a sync the table holds
  // every relayed voucher in the commons, and listing strangers' vouches under
  // "your vouches" is simply false. Membership is derived from the keys, never
  // from the synced `direction` field — see the note in schema.ts.
  const mine = vouchers.filter((v) => v.issuerPub === selfPub || v.subjectPub === selfPub)
  const sorted = [...mine].sort((a, b) => b.receivedAt - a.receivedAt)

  return (
    <section className="border border-paper/30">
      <div className="flex items-baseline justify-between border-b border-paper/25 p-5">
        <p className="eyebrow">Vouches</p>
        <p className="font-mono text-[10px] uppercase tracking-wider text-paper/40">
          {mine.filter((v) => v.status === VoucherStatus.Valid).length} valid ·{' '}
          {mine.length} total
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse">
          <thead>
            <tr className="border-b border-paper/20">
              {['Direction', 'Counterparty', 'Level', 'Received', 'Expires', 'Status'].map((h) => (
                <th
                  key={h}
                  className="px-5 py-2.5 text-left font-mono text-[9px] uppercase tracking-wider text-paper/40"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((v) => {
              const received = v.subjectPub === selfPub
              const counterparty = received ? v.issuerPub : v.subjectPub
              const name = nameFor(counterparty)
              return (
                <tr key={v.id} className="border-b border-paper/10 last:border-b-0">
                  <td className="px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-paper-dim">
                    {received ? '← received' : '→ given'}
                  </td>
                  <td className="px-5 py-3">
                    {name ? (
                      <>
                        <span className="block font-mono text-[12px] text-paper">{name}</span>
                        <span className="block font-mono text-[9px] tracking-wider text-paper/35">
                          {fingerprintFromId(counterparty)}
                        </span>
                      </>
                    ) : (
                      <span className="block font-mono text-[12px] tracking-wider text-paper">
                        {fingerprintFromId(counterparty)}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-paper-dim">
                    {TRUST_TIER_LABELS[v.tier]}
                  </td>
                  <td className="px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-paper/50">
                    {shortDate(v.receivedAt)}
                  </td>
                  <td className="px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-paper/50">
                    {shortDate(v.expiresAt)}
                  </td>
                  <td
                    className={`px-5 py-3 font-mono text-[10px] uppercase tracking-wider ${STATUS_STYLE[v.status]}`}
                  >
                    {v.status.toLowerCase()}
                    {/*
                      Only the issuer may withdraw a vouch, so this appears on
                      outbound rows alone. If anyone could revoke anyone's
                      vouch, the trust graph would be erasable by a single bad
                      actor — cheaper than forging trust, and more damaging.
                    */}
                    {!received && v.issuerPub === selfPub && v.status === VoucherStatus.Valid ? (
                      <button
                        onClick={() => setRevoking(v)}
                        className="mt-1 block font-mono text-[10px] uppercase tracking-wider text-paper/40 hover:text-alarm"
                      >
                        Withdraw
                      </button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {revoking ? (
        <div className="border-t border-alarm/40 bg-alarm/5 p-5">
          <p className="eyebrow text-alarm">Withdraw your vouch</p>
          <h3 className="mt-2 font-display text-2xl uppercase text-paper">
            {nameFor(revoking.subjectPub) ?? fingerprintFromId(revoking.subjectPub)}
          </h3>
          <p className="mt-2 max-w-lg font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
            This removes the standing your vouch gave them, on every device that receives it. There
            is no undo — if you change your mind you would vouch again, and both decisions stay on
            the record.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {(Object.keys(REVOCATION_REASON_LABELS) as RevocationReason[]).map((reason) => (
              <button
                key={reason}
                onClick={() => {
                  void onRevoke(revoking, reason)
                  setRevoking(null)
                }}
                className="border border-alarm/50 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-paper transition-colors hover:bg-alarm/15"
              >
                {REVOCATION_REASON_LABELS[reason]}
              </button>
            ))}
            <button onClick={() => setRevoking(null)} className="btn">
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
