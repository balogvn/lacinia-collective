'use client'

import { useMemo, useState } from 'react'

import {
  rankBridging,
  rankDivisive,
  rankPopular,
  type OpinionMap,
  type StatementScore,
} from '@/lib/deliberate/cluster'
import type { PubKeyId, Statement } from '@/lib/db/schema'

interface Props {
  map: OpinionMap
  statements: Statement[]
  selfPub: PubKeyId
}

type Lens = 'bridging' | 'divisive' | 'popular'

const LENSES: Array<{ id: Lens; label: string; blurb: string }> = [
  {
    id: 'bridging',
    label: 'What we share',
    blurb:
      'Statements every group agrees with. Ranked by the WORST group’s agreement, so one group holding out is enough to sink a statement.',
  },
  {
    id: 'divisive',
    label: 'Where we differ',
    blurb:
      'Statements the groups read completely differently. Shown, never hidden — knowing where the fault line runs is the point.',
  },
  {
    id: 'popular',
    label: 'Most agreed',
    blurb:
      'Plain headcount, ignoring groups. Shown only so you can see how it differs — this is the ranking that lets the biggest bloc speak for everyone.',
  },
]

const GROUP_NAMES = ['Group A', 'Group B', 'Group C', 'Group D']

export function OpinionResults({ map, statements, selfPub }: Props) {
  const [lens, setLens] = useState<Lens>('bridging')

  const textOf = useMemo(() => {
    const byId = new Map(statements.map((s) => [s.id, s.text]))
    return (id: string) => byId.get(id) ?? id
  }, [statements])

  const ranked: StatementScore[] = useMemo(() => {
    if (lens === 'bridging') return rankBridging(map.statements)
    if (lens === 'divisive') return rankDivisive(map.statements)
    return rankPopular(map.statements)
  }, [lens, map.statements])

  if (map.status === 'insufficient') {
    return (
      <section className="border border-paper/30 p-5">
        <p className="eyebrow">Not enough yet</p>
        <h3 className="mt-2 font-display text-2xl uppercase text-paper sm:text-3xl">
          Groups appear once enough people have voted
        </h3>
        <p className="mt-3 max-w-lg font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
          {map.reason}
        </p>
        {/*
          Drawing clusters from four votes would be inventing a division and
          then asking people to see themselves in it. Better to say so.
        */}
        <p className="mt-3 max-w-lg font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
          Until then, statements are counted but not grouped — a map drawn from a handful of votes
          would show divisions that are not there.
        </p>
        <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            { label: 'People', value: `${map.have.participants} / ${map.need.participants}` },
            { label: 'Statements', value: `${map.have.statements} / ${map.need.statements}` },
          ].map((s) => (
            <div key={s.label}>
              <dt className="font-mono text-[9px] uppercase tracking-wider text-paper/40">
                {s.label}
              </dt>
              <dd className="font-mono text-lg text-paper">{s.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    )
  }

  const me = map.participants.find((p) => p.pubKey === selfPub)

  // Scale the scatter to the box. Guard against a degenerate axis when everyone
  // sits on one line, which would otherwise divide by zero.
  const xs = map.participants.map((p) => p.x)
  const ys = map.participants.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1
  const project = (p: { x: number; y: number }) => ({
    cx: 8 + ((p.x - minX) / spanX) * 84,
    cy: 8 + ((p.y - minY) / spanY) * 84,
  })

  return (
    <section className="border border-paper/30">
      <div className="grid gap-6 border-b border-paper/25 p-5 lg:grid-cols-[280px_1fr]">
        {/* ── opinion map ── */}
        <div>
          <p className="eyebrow">
            {map.k === 1 ? 'One group' : `${map.k} groups found`}
          </p>
          <svg
            viewBox="0 0 100 100"
            className="mt-3 aspect-square w-full border border-paper/20"
            role="img"
            aria-label={`Opinion map showing ${map.participants.length} people in ${map.k} groups`}
          >
            {/*
              Two inks only, so groups are distinguished by FORM rather than
              colour: filled, hollow, small, cross. Opacity alone was
              indistinguishable at this size, and colour-coding would not
              survive the palette or a colour-blind reader.
            */}
            {map.participants.map((p) => {
              const { cx, cy } = project(p)
              const isMe = p.pubKey === selfPub
              if (isMe) {
                return (
                  <g key={p.pubKey}>
                    <circle cx={cx} cy={cy} r={3.4} className="fill-signal" />
                    <circle cx={cx} cy={cy} r={5.4} className="fill-none stroke-signal" strokeWidth={0.7} />
                  </g>
                )
              }
              if (p.group % 2 === 0) {
                return (
                  <circle key={p.pubKey} cx={cx} cy={cy} r={2} className="fill-paper" opacity={0.85} />
                )
              }
              return (
                <circle
                  key={p.pubKey}
                  cx={cx}
                  cy={cy}
                  r={2.2}
                  className="fill-none stroke-paper"
                  strokeWidth={0.9}
                  opacity={0.85}
                />
              )
            })}
          </svg>
          <p className="mt-2 font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
            {map.participants.length} people placed by how they voted.
            {me ? ' The gold dot is you.' : ''}
          </p>
        </div>

        {/* ── group summaries ── */}
        <div>
          <p className="eyebrow">Who is here</p>
          <ul className="mt-3 space-y-3">
            {map.groups.map((group) => (
              <li key={group.id} className="border-l border-paper/25 pl-4">
                <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-paper">
                  {/* Matches the mark used on the map above. */}
                  <span
                    aria-hidden
                    className={`inline-block h-2 w-2 rounded-full ${
                      group.id % 2 === 0 ? 'bg-paper' : 'border border-paper'
                    }`}
                  />
                  {map.k === 1 ? 'Everyone' : GROUP_NAMES[group.id]} · {group.size}{' '}
                  {group.size === 1 ? 'person' : 'people'}
                  {me?.group === group.id && map.k > 1 ? ' · you' : ''}
                </p>
                {group.distinctive.length > 0 ? (
                  <p className="mt-1 font-mono text-[10px] leading-relaxed text-paper-dim">
                    Most distinctive: “{textOf(group.distinctive[0]!.statementId)}”
                  </p>
                ) : null}
              </li>
            ))}
          </ul>

          {map.k > 1 ? (
            <p className="mt-4 max-w-lg font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
              These groups are computed on your phone from voting patterns alone. Nobody assigned
              them, and they are not identities — the same people will fall differently on a
              different question.
            </p>
          ) : null}
        </div>
      </div>

      {/* ── lenses ── */}
      <div className="flex flex-wrap border-b border-paper/25">
        {LENSES.map((l) => (
          <button
            key={l.id}
            onClick={() => setLens(l.id)}
            className={`flex-1 border-r border-paper/25 px-4 py-3.5 text-left transition-colors last:border-r-0 ${
              lens === l.id ? 'bg-paper text-canvas' : 'text-paper-dim hover:text-paper'
            }`}
          >
            <span className="block font-mono text-[11px] uppercase tracking-wider">{l.label}</span>
          </button>
        ))}
      </div>

      <div className="p-5">
        <p className="max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/50">
          {LENSES.find((l) => l.id === lens)!.blurb}
        </p>

        {ranked.length === 0 ? (
          <p className="mt-5 font-mono text-[11px] uppercase tracking-wider text-paper-dim">
            No statement has enough votes yet.
          </p>
        ) : (
          <ol className="mt-5 space-y-4">
            {ranked.slice(0, 8).map((score, i) => (
              <li key={score.statementId} className="border-b border-paper/10 pb-4 last:border-b-0">
                <div className="flex items-start gap-3">
                  <span className="font-mono text-[10px] text-paper/35">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[13px] leading-relaxed text-paper">
                      {textOf(score.statementId)}
                    </p>

                    {/* Per-group bars: the whole argument in one row. A tribal
                        statement shows one full bar and one empty one. */}
                    <div className="mt-2.5 flex flex-wrap gap-3">
                      {score.byGroup.map((g) => (
                        <div key={g.group} className="min-w-[92px] flex-1">
                          <div className="flex items-baseline justify-between">
                            <span className="font-mono text-[9px] uppercase tracking-wider text-paper/40">
                              {map.k === 1 ? 'All' : GROUP_NAMES[g.group]}
                            </span>
                            <span className="font-mono text-[9px] text-paper/60">
                              {g.votes === 0 ? '—' : `${Math.round(g.agree * 100)}%`}
                            </span>
                          </div>
                          <div className="mt-1 h-1 w-full bg-paper/15">
                            <div
                              className="h-full bg-paper"
                              style={{ width: `${g.votes === 0 ? 0 : g.agree * 100}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>

                    <p className="mt-2 font-mono text-[9px] uppercase tracking-wider text-paper/35">
                      {score.agrees} agree · {score.disagrees} disagree · {score.passes} passed
                      {lens === 'bridging'
                        ? ` · worst group ${Math.round(score.consensus * 100)}%`
                        : lens === 'divisive'
                          ? ` · gap ${Math.round(score.divisiveness * 100)} points`
                          : ` · ${Math.round(score.overallAgree * 100)}% of those who decided`}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}
