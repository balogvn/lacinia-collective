'use client'

import Link from 'next/link'
import { useState } from 'react'

import { useCommons } from '@/hooks/useCommons'
import { useDeliberation } from '@/hooks/useDeliberation'
import { useModeration } from '@/hooks/useModeration'
import { VoteQueue } from './VoteQueue'
import { OpinionResults } from './OpinionResults'
import { PolicyPanel } from '@/components/moderate/PolicyPanel'
import { NIGERIAN_STATES } from '@/lib/data/nigeria'

export function DeliberationWorkbench() {
  const commons = useCommons()
  const [activeId, setActiveId] = useState<string | null>(null)
  const delib = useDeliberation(activeId, commons.identity?.pubKey ?? null)
  // Group membership feeds the cross-group corroboration rule — without it the
  // policy falls back to the weaker ungrouped path.
  const moderation = useModeration(
    commons.identity?.pubKey ?? null,
    delib.map?.status === 'ok' ? delib.map.participants : undefined,
  )
  const [opening, setOpening] = useState(false)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [lga, setLga] = useState('')
  const [state, setState] = useState('')

  if (!commons.ready || !delib.ready) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-wider text-paper-dim">
        Opening local database…
      </p>
    )
  }

  if (!commons.identity) {
    return (
      <section className="border border-paper/30 p-5 sm:p-7">
        <p className="eyebrow">An identity is needed first</p>
        <h2 className="mt-3 font-display text-3xl uppercase text-paper sm:text-4xl">
          Votes are signed, so they need a key
        </h2>
        <p className="mt-3 max-w-xl font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
          One person, one vote per statement — which only means anything if a vote can be tied to a
          keypair. Creating one needs no email or password.
        </p>
        <Link href="/identity" className="btn btn-solid mt-6">
          Create an identity →
        </Link>
      </section>
    )
  }

  const active = delib.conversations.find((c) => c.id === (activeId ?? delib.conversations[0]?.id))

  const open = async () => {
    const id = await delib.openConversation({
      authorPub: commons.identity!.pubKey,
      title,
      prompt,
      ...(state && lga ? { locality: { state, lga } } : {}),
    })
    setActiveId(id)
    setTitle('')
    setPrompt('')
    setOpening(false)
  }

  return (
    <div className="space-y-8">
      {/* ── conversation picker ── */}
      <section className="border border-paper/30">
        <div className="flex flex-wrap items-center gap-3 border-b border-paper/25 p-5">
          <p className="eyebrow">Conversations</p>
          <button
            onClick={() => setOpening((v) => !v)}
            className="ml-auto font-mono text-[10px] uppercase tracking-wider text-paper-dim hover:text-paper"
          >
            {opening ? '− Close' : '+ Open one'}
          </button>
        </div>

        {opening ? (
          <div className="grid gap-4 border-b border-paper/25 p-5 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="eyebrow">Title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={80}
                placeholder="e.g. The market levy"
                className="field mt-2"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="eyebrow">The question</span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={2}
                maxLength={240}
                placeholder="What should change about how the levy is collected and spent?"
                className="field mt-2 resize-none"
              />
            </label>
            <label className="block">
              <span className="eyebrow">State</span>
              <select value={state} onChange={(e) => setState(e.target.value)} className="field mt-2">
                <option value="">Anywhere</option>
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
              <button
                onClick={open}
                disabled={title.trim().length < 3 || prompt.trim().length < 8}
                className="btn btn-solid"
              >
                Open the conversation
              </button>
            </div>
          </div>
        ) : null}

        {delib.conversations.length === 0 ? (
          <p className="p-5 font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
            None yet. Open one about something your community is actually arguing about, or sync to
            find conversations neighbours have started.
          </p>
        ) : (
          <ul>
            {delib.conversations.map((c) => (
              <li key={c.id} className="border-b border-paper/15 last:border-b-0">
                <button
                  onClick={() => setActiveId(c.id)}
                  className={`w-full p-5 text-left transition-colors ${
                    active?.id === c.id ? 'bg-paper/10' : 'hover:bg-paper/5'
                  }`}
                >
                  <span className="block font-display text-xl uppercase text-paper">{c.title}</span>
                  <span className="mt-1 block font-mono text-[11px] leading-relaxed text-paper-dim">
                    {c.prompt}
                  </span>
                  <span className="mt-1.5 block font-mono text-[9px] uppercase tracking-wider text-paper/40">
                    {c.locality ? `${c.locality.lga}, ${c.locality.state}` : 'Anywhere'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {active ? (
        <>
          <VoteQueue
            statements={delib.statements}
            myVotes={delib.myVotes}
            selfPub={commons.identity.pubKey}
            evaluate={moderation.evaluate}
            onFlag={(statementId, reason) =>
              moderation.raiseFlag(commons.keyPair!, {
                targetId: statementId,
                targetEntity: 'statement',
                reason,
                conversationId: active.id,
              })
            }
            onUnflag={moderation.dropFlag}
            onVote={delib.vote}
            onAdd={async (text) => {
              await delib.addStatement({
                authorPub: commons.identity!.pubKey,
                conversationId: active.id,
                text,
              })
            }}
          />

          {delib.map ? (
            <OpinionResults
              map={delib.map}
              statements={delib.statements}
              selfPub={commons.identity.pubKey}
            />
          ) : null}
        </>
      ) : null}

      {commons.identity ? (
        <PolicyPanel
          preset={moderation.preset}
          flags={moderation.flags}
          selfPub={commons.identity.pubKey}
          onPreset={moderation.setPreset}
          onWithdraw={moderation.dropFlag}
        />
      ) : null}

      <p className="font-mono text-[10px] uppercase tracking-wider text-paper/35">
        <Link href="/aid" className="underline underline-offset-4 hover:text-paper">
          ← Mutual aid
        </Link>
      </p>
    </div>
  )
}
