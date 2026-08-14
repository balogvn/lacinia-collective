'use client'

import { formatCredits } from '@/lib/ledger/balance'
import { fingerprintFromId } from '@/lib/crypto/keys'
import type { LedgerEntry, PubKeyId, UserIdentity } from '@/lib/db/schema'

interface Props {
  entries: LedgerEntry[]
  people: UserIdentity[]
  selfPub: PubKeyId
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

export function LedgerHistory({ entries, people, selfPub }: Props) {
  const mine = entries
    .filter((e) => e.fromPub === selfPub || e.toPub === selfPub)
    .sort((a, b) => b.agreedAt - a.agreedAt)

  if (mine.length === 0) {
    return (
      <section className="border border-paper/30 p-5">
        <p className="eyebrow">Your exchanges</p>
        <p className="mt-3 max-w-lg font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
          Nothing yet. Every exchange here needs both people to sign it in person — there is no way
          to record one on your own.
        </p>
      </section>
    )
  }

  const nameFor = (pubKey: PubKeyId): string =>
    people.find((p) => p.pubKey === pubKey)?.displayName ?? fingerprintFromId(pubKey)

  return (
    <section className="border border-paper/30">
      <div className="flex items-baseline justify-between border-b border-paper/25 p-5">
        <p className="eyebrow">Your exchanges</p>
        <p className="font-mono text-[10px] uppercase tracking-wider text-paper/40">
          {mine.length} recorded
        </p>
      </div>

      <ul>
        {mine.map((entry) => {
          const earned = entry.toPub === selfPub
          const counterparty = earned ? entry.fromPub : entry.toPub
          return (
            <li
              key={entry.id}
              className="flex flex-wrap items-center gap-4 border-b border-paper/10 p-5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[12px] text-paper">
                  {earned ? 'Helped' : 'Helped by'} {nameFor(counterparty)}
                </p>
                <p className="font-mono text-[9px] tracking-wider text-paper/35">
                  {fingerprintFromId(counterparty)} · {shortDate(entry.agreedAt)}
                </p>
              </div>

              <p
                className={`font-mono text-lg ${earned ? 'text-paper' : 'text-signal'}`}
              >
                {earned ? '+' : '−'}
                {formatCredits(entry.amount).replace('−', '')}
              </p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
