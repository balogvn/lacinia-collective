'use client'

import { TRUST_TIER_LABELS, TrustTier, type UserIdentity } from '@/lib/db/schema'
import { explainTrust, type TrustNode } from '@/lib/vouch/trust'

interface Props {
  identity: UserIdentity
  trust: TrustNode | null
  voucherCount: number
}

const TIER_ORDER: TrustTier[] = [
  TrustTier.Observer,
  TrustTier.Neighbour,
  TrustTier.Steward,
  TrustTier.Anchor,
]

export function IdentityCard({ identity, trust, voucherCount }: Props) {
  const tier = trust?.tier ?? TrustTier.Observer
  const score = trust?.score ?? 0

  return (
    <section className="border border-paper/30">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-paper/25 p-5">
        <div>
          <p className="eyebrow">This device</p>
          <h2 className="mt-2 font-display text-3xl uppercase text-paper sm:text-4xl">
            {identity.displayName}
          </h2>
          <p className="mt-2 font-mono text-[11px] uppercase tracking-wider text-paper-dim">
            {identity.locality
              ? `${identity.locality.lga}, ${identity.locality.state}`
              : 'Location not shared'}
          </p>
        </div>

        <div className="text-right">
          <p className="eyebrow">Fingerprint</p>
          {/*
            Read this aloud to confirm you scanned the right person. 12
            characters from a Crockford-style alphabet — no I, L, O or U, so
            there is nothing to mishear across a noisy market.
          */}
          <p className="mt-2 font-mono text-lg tracking-wider text-paper">{identity.fingerprint}</p>
        </div>
      </div>

      <div className="grid gap-5 p-5 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <p className="eyebrow">Standing</p>

          <div className="mt-3 flex items-center gap-1">
            {TIER_ORDER.map((t) => (
              <div key={t} className="flex-1">
                <div
                  className={`h-1.5 ${t <= tier ? 'bg-paper' : 'bg-paper/20'}`}
                  aria-hidden
                />
                <span
                  className={`mt-1.5 block font-mono text-[9px] uppercase tracking-wider ${
                    t === tier ? 'text-paper' : 'text-paper/35'
                  }`}
                >
                  {TRUST_TIER_LABELS[t]}
                </span>
              </div>
            ))}
          </div>

          <p className="mt-4 max-w-md font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
            {trust ? explainTrust(trust, { heldVouches: voucherCount }) : 'No trust data yet.'}
          </p>
        </div>

        <dl className="grid grid-cols-3 gap-4 sm:grid-cols-1 sm:gap-3 sm:border-l sm:border-paper/25 sm:pl-6">
          {[
            { label: 'Score', value: score.toFixed(3) },
            { label: 'Vouches', value: String(voucherCount) },
            {
              label: 'From anchor',
              value:
                trust && Number.isFinite(trust.distanceFromAnchor)
                  ? `${trust.distanceFromAnchor} hop${trust.distanceFromAnchor === 1 ? '' : 's'}`
                  : '—',
            },
          ].map((stat) => (
            <div key={stat.label}>
              <dt className="font-mono text-[9px] uppercase tracking-wider text-paper/40">
                {stat.label}
              </dt>
              <dd className="font-mono text-xl text-paper">{stat.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
