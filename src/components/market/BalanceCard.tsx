'use client'

import { formatCredits, CONFIDENCE_NOTE, type BalanceView } from '@/lib/ledger/balance'
import { TRUST_TIER_LABELS, type TrustTier } from '@/lib/db/schema'

interface Props {
  balance: BalanceView
  tier: TrustTier
  entryCount: number
  zeroSum: boolean
}

export function BalanceCard({ balance, tier, entryCount, zeroSum }: Props) {
  const inDebt = balance.balance < 0
  // How much of the credit line is used — the number that actually matters when
  // deciding whether you can accept more help.
  const usedPct = inDebt
    ? Math.min(100, Math.round((Math.abs(balance.balance) / balance.creditLimit) * 100))
    : 0

  return (
    <section className="border border-paper/30">
      <div className="grid gap-5 p-5 sm:grid-cols-[1fr_auto] sm:items-start">
        <div>
          <p className="eyebrow">Your time balance</p>
          <p className="mt-2 font-display text-5xl uppercase text-paper sm:text-6xl">
            {formatCredits(balance.balance)}
          </p>
          <p className="mt-2 max-w-md font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
            {balance.balance === 0
              ? 'Even with the commons. Nobody owes anybody.'
              : inDebt
                ? `You have received ${formatCredits(Math.abs(balance.balance))} more help than you have given.`
                : `You have given ${formatCredits(balance.balance)} more help than you have received.`}
          </p>

          {/*
            One hour of anyone's labour is 60 credits regardless of whose hour
            it is. Saying so on the balance screen is the point — it is a
            political commitment, not an implementation detail.
          */}
          <p className="mt-4 border-l border-paper/25 pl-4 font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
            One hour is sixty credits, whoever works it. This is a time bank, not a market.
          </p>
        </div>

        <dl className="grid grid-cols-3 gap-4 sm:grid-cols-1 sm:gap-3 sm:border-l sm:border-paper/25 sm:pl-6">
          {[
            { label: 'Given', value: formatCredits(balance.earned) },
            { label: 'Received', value: formatCredits(balance.spent) },
            { label: 'Exchanges', value: String(entryCount) },
          ].map((stat) => (
            <div key={stat.label}>
              <dt className="font-mono text-[9px] uppercase tracking-wider text-paper/40">
                {stat.label}
              </dt>
              <dd className="font-mono text-lg text-paper">{stat.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="border-t border-paper/25 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="eyebrow">
            Credit line · {TRUST_TIER_LABELS[tier]}
          </span>
          <span className="font-mono text-[11px] text-paper">
            {formatCredits(balance.available)} still available of{' '}
            {formatCredits(balance.creditLimit)}
          </span>
        </div>

        <div className="mt-2.5 h-1.5 w-full bg-paper/20">
          <div
            className={`h-full transition-all ${usedPct > 85 ? 'bg-alarm' : 'bg-paper'}`}
            style={{ width: `${usedPct}%` }}
          />
        </div>

        <p className="mt-3 max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
          How far you may go into debt depends on your standing. Earning a vouch raises it. Nobody
          can extend you more than this, which is what stops someone taking help from the whole
          street and disappearing.
        </p>

        <p className="mt-2 font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/35">
          {CONFIDENCE_NOTE[balance.confidence]}
        </p>

        {/*
          Mutual credit means every credit is someone else's debit, so the total
          across all balances must be exactly zero. If it is not, credits have
          been created from nothing — surfaced rather than swallowed, because a
          currency cannot recover from silent inflation.
        */}
        {!zeroSum ? (
          <p className="mt-3 border border-alarm/60 bg-alarm/10 px-3 py-2 font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper">
            Ledger inconsistency detected — balances do not cancel to zero. Report this from the
            diagnostics panel.
          </p>
        ) : null}
      </div>
    </section>
  )
}
