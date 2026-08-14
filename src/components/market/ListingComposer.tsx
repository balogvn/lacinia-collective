'use client'

import { useState } from 'react'

import { NIGERIAN_STATES } from '@/lib/data/nigeria'
import { formatCredits } from '@/lib/ledger/balance'
import {
  ResourceCategory,
  ResourceKind,
  TrustTier,
  TRUST_TIER_LABELS,
  MAX_ENTRY_CREDITS,
  type ResourceListing,
  type UserIdentity,
} from '@/lib/db/schema'

interface Props {
  identity: UserIdentity
  myTier: TrustTier
  onPublish: (
    input: Omit<ResourceListing, 'id' | 'hlc' | 'createdAt' | 'status'>,
  ) => Promise<string>
}

/** 90 days. A stale marketplace is worse than an empty one. */
const DEFAULT_TTL_MS = 90 * 24 * 60 * 60_000

const QUICK_DURATIONS = [
  { label: '30 min', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '2 hours', value: 120 },
  { label: 'Half day', value: 240 },
  { label: 'Gift', value: 0 },
]

export function ListingComposer({ identity, myTier, onPublish }: Props) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<ResourceKind>(ResourceKind.Offer)
  const [category, setCategory] = useState<ResourceCategory>(ResourceCategory.Food)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [credits, setCredits] = useState(60)
  const [quantity, setQuantity] = useState(1)
  const [state, setState] = useState(identity.locality?.state ?? '')
  const [lga, setLga] = useState(identity.locality?.lga ?? '')
  const [minTier, setMinTier] = useState<TrustTier>(TrustTier.Observer)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const publish = async () => {
    setBusy(true)
    setError(null)
    try {
      await onPublish({
        authorPub: identity.pubKey,
        kind,
        category,
        title: title.trim(),
        description: description.trim(),
        timeCredits: credits,
        quantity,
        locality: { state, lga },
        minTrustTier: minTier,
        expiresAt: Date.now() + DEFAULT_TTL_MS,
      })
      setTitle('')
      setDescription('')
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const valid =
    title.trim().length > 0 &&
    state.length > 0 &&
    lga.trim().length > 0 &&
    Number.isInteger(credits) &&
    credits >= 0 &&
    credits <= MAX_ENTRY_CREDITS

  return (
    <section className="border border-paper/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between p-5 text-left"
      >
        <span>
          <span className="eyebrow block">Share something</span>
          <span className="mt-1 block font-mono text-[11px] uppercase tracking-wider text-paper">
            Post what you can offer, or what you need
          </span>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-paper-dim">
          {open ? '− Close' : '+ New post'}
        </span>
      </button>

      {open ? (
        <div className="border-t border-paper/25 p-5">
          <div className="flex flex-wrap gap-2">
            {[ResourceKind.Offer, ResourceKind.Request].map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`border px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                  kind === k
                    ? 'border-paper bg-paper text-canvas'
                    : 'border-paper/30 text-paper-dim hover:border-paper/70'
                }`}
              >
                {k === ResourceKind.Offer ? 'I can offer' : 'I need'}
              </button>
            ))}
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="eyebrow">What is it</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={80}
                placeholder="e.g. Tailoring, or a bag of rice"
                className="field mt-2"
              />
            </label>

            <label className="block sm:col-span-2">
              <span className="eyebrow">Details (optional)</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                maxLength={300}
                placeholder="When, where, anything they should know"
                className="field mt-2 resize-none"
              />
            </label>

            <label className="block">
              <span className="eyebrow">Category</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as ResourceCategory)}
                className="field mt-2"
              >
                {Object.values(ResourceCategory).map((c) => (
                  <option key={c} value={c}>
                    {c.charAt(0) + c.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </label>


            <div className="sm:col-span-2">
              <span className="eyebrow">Worth in time</span>
              <div className="mt-2 flex flex-wrap gap-2">
                {QUICK_DURATIONS.map((d) => (
                  <button
                    key={d.label}
                    onClick={() => setCredits(d.value)}
                    className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                      credits === d.value
                        ? 'border-paper bg-paper text-canvas'
                        : 'border-paper/30 text-paper-dim hover:border-paper/70'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
                <input
                  type="number"
                  min={0}
                  max={MAX_ENTRY_CREDITS}
                  value={credits}
                  onChange={(e) => setCredits(Math.floor(Number(e.target.value) || 0))}
                  className="field w-28 py-2 text-[11px]"
                  aria-label="Minutes"
                />
              </div>
              <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-paper/45">
                {credits === 0
                  ? 'A gift — no credits change hands, nothing is recorded in the ledger.'
                  : `${formatCredits(credits)} of anyone's time. Goods are quoted at the time they would take to replace.`}
              </p>
            </div>

            <label className="block">
              <span className="eyebrow">State</span>
              <select value={state} onChange={(e) => setState(e.target.value)} className="field mt-2">
                <option value="">Choose…</option>
                {NIGERIAN_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="eyebrow">Local Government Area</span>
              <input
                value={lga}
                onChange={(e) => setLga(e.target.value)}
                placeholder="e.g. Ikorodu"
                className="field mt-2"
              />
            </label>

            <div className="sm:col-span-2">
              <span className="eyebrow">Who may take this up</span>
              <div className="mt-2 flex flex-wrap gap-2">
                {[TrustTier.Observer, TrustTier.Neighbour, TrustTier.Steward].map((t) => (
                  <button
                    key={t}
                    onClick={() => setMinTier(t)}
                    disabled={t > myTier}
                    className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                      minTier === t
                        ? 'border-paper bg-paper text-canvas'
                        : 'border-paper/30 text-paper-dim hover:border-paper/70'
                    }`}
                  >
                    {t === TrustTier.Observer ? 'Anyone' : `${TRUST_TIER_LABELS[t]}+`}
                  </button>
                ))}
              </div>
              {/*
                You cannot gate above your own standing — otherwise an unvouched
                key could post a listing only Anchors may see, which is a way of
                claiming authority you do not have.
              */}
              <p className="mt-2 max-w-xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
                Restricting a post is for things that could be stripped by a stranger — donated
                medicine, a shared tool. You cannot require more standing than you hold.
              </p>
            </div>
          </div>

          {error ? (
            <p className="mt-4 border border-alarm/60 bg-alarm/10 px-3 py-2 font-mono text-[11px] text-paper">
              {error}
            </p>
          ) : null}

          <button onClick={publish} disabled={!valid || busy} className="btn btn-solid mt-6">
            {busy ? 'Posting…' : 'Post to the commons'}
          </button>
        </div>
      ) : null}
    </section>
  )
}
