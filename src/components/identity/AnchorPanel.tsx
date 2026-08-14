'use client'

import { useCallback, useEffect, useState } from 'react'

import { idToPubKey, fingerprintFromId, type KeyPair } from '@/lib/crypto/keys'
import { setAnchors, listAnchorActions, saveAnchorAction } from '@/lib/db/repo'
import {
  buildGovernanceView,
  createAnchorAction,
  applyRotation,
  applyRetirement,
  MAX_NOTE_CHARS,
  type AnchorGovernanceView,
} from '@/lib/anchor/governance'
import { AnchorActionKind, type PubKeyId } from '@/lib/db/schema'

interface Props {
  anchors: PubKeyId[]
  selfPub: PubKeyId
  keyPair: KeyPair
  onChange: () => Promise<void> | void
}

/**
 * Anchors and their governance.
 *
 * Anchors are the axioms of the trust graph — with none, every score is zero.
 * Everything the network says about them arrives here as EVIDENCE, and nothing
 * is applied without a tap. That is not caution; a network process that edited
 * the axioms would be using derived trust to choose what trust derives from,
 * which is circular and capturable in both directions (a cartel voting itself
 * in, or a majority voting a rival out).
 *
 * The first anchor is unavoidably out of band: it cannot be endorsed by an
 * anchor you already trust, because there is not one yet. All this screen can
 * do is show the fingerprint and ask whether you checked it against the poster.
 */
export function AnchorPanel({ anchors, selfPub, keyPair, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [confirmedFingerprint, setConfirmedFingerprint] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<AnchorGovernanceView | null>(null)
  const [note, setNote] = useState('')

  const iAmAnchor = anchors.includes(selfPub)

  const refreshView = useCallback(async () => {
    setView(buildGovernanceView(anchors, await listAnchorActions()))
  }, [anchors])

  useEffect(() => {
    void refreshView()
  }, [refreshView])

  const candidateFingerprint = (() => {
    const key = input.trim()
    if (!key) return null
    try {
      idToPubKey(key)
      return fingerprintFromId(key)
    } catch {
      return null
    }
  })()

  const add = async (key: string) => {
    setError(null)
    try {
      idToPubKey(key)
    } catch {
      setError('That is not a valid Lacinia public key.')
      return
    }
    if (anchors.includes(key)) {
      setError('That anchor is already trusted.')
      return
    }
    await setAnchors([...anchors, key])
    setInput('')
    setConfirmedFingerprint(false)
    await onChange()
    await refreshView()
  }

  const remove = async (key: PubKeyId) => {
    await setAnchors(applyRetirement(anchors, key))
    await onChange()
    await refreshView()
  }

  const acceptRotation = async (from: PubKeyId, to: PubKeyId) => {
    await setAnchors(applyRotation(anchors, { from, to }))
    await onChange()
    await refreshView()
  }

  /** Only meaningful if this device's own key is itself an anchor. */
  const publish = async (kind: AnchorActionKind, targetPub?: string) => {
    setError(null)
    try {
      await saveAnchorAction(createAnchorAction(keyPair, { kind, ...(targetPub ? { targetPub } : {}), note }))
      setNote('')
      setInput('')
      await refreshView()
      await onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="border border-paper/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between p-5 text-left"
      >
        <span>
          <span className="eyebrow block">Anchors — the root of your trust graph</span>
          <span className="mt-1 block font-mono text-[11px] uppercase tracking-wider text-paper">
            {anchors.length === 0
              ? 'None trusted yet — every score stays at zero'
              : `${anchors.length} anchor${anchors.length === 1 ? '' : 's'} trusted`}
            {view && (view.retirements.length || view.rotations.length || view.candidates.length)
              ? ` · ${view.retirements.length + view.rotations.length + view.candidates.length} to review`
              : ''}
          </span>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-paper-dim">
          {open ? '− Hide' : '+ Manage'}
        </span>
      </button>

      {open ? (
        <div className="border-t border-paper/25 p-5">
          <p className="max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/50">
            An anchor is a community body whose word you accept as a starting point — a mosque, a
            parish, a market association, a co-operative. Nothing below is applied automatically:
            anchors are the axioms of your trust graph, and a network that could edit them would be
            deciding what everyone must believe.
          </p>

          {error ? (
            <p className="mt-4 border border-alarm/60 bg-alarm/10 px-3 py-2 font-mono text-[11px] text-paper">
              {error}
            </p>
          ) : null}

          {/* ── pending: retirements ── */}
          {view && view.retirements.length > 0 ? (
            <div className="mt-5 border border-signal/60 bg-signal/5 p-4">
              <p className="eyebrow text-signal">Standing down</p>
              <ul className="mt-3 space-y-3">
                {view.retirements.map((r) => (
                  <li key={r.action.id} className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-sm tracking-wider text-paper">{r.fingerprint}</span>
                    {r.action.note ? (
                      <span className="font-mono text-[10px] text-paper-dim">“{r.action.note}”</span>
                    ) : null}
                    <button onClick={() => void remove(r.anchorPub)} className="btn ml-auto">
                      Remove this anchor
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-3 max-w-xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/50">
                Removing this drops the standing of everyone it vouched for. That is why a signed
                retirement is shown rather than obeyed — a stolen key could otherwise unroot a whole
                community with one message.
              </p>
            </div>
          ) : null}

          {/* ── pending: rotations ── */}
          {view && view.rotations.length > 0 ? (
            <div className="mt-5 border border-signal/60 bg-signal/5 p-4">
              <p className="eyebrow text-signal">Changing key</p>
              <ul className="mt-3 space-y-3">
                {view.rotations.map((r) => (
                  <li key={r.action.id}>
                    <p className="font-mono text-[11px] tracking-wider text-paper">
                      {r.fromFingerprint} → {r.toFingerprint}
                    </p>
                    {r.action.note ? (
                      <p className="mt-1 font-mono text-[10px] text-paper-dim">“{r.action.note}”</p>
                    ) : null}
                    <button
                      onClick={() => void acceptRotation(r.from, r.to)}
                      className="btn mt-2"
                    >
                      Follow this change
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-3 max-w-xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/50">
                Signed by the old key, so only its holder could have written it — check with them in
                person before following it.
              </p>
            </div>
          ) : null}

          {/* ── candidates from endorsements ── */}
          {view && view.candidates.length > 0 ? (
            <div className="mt-5 border border-paper/25 p-4">
              <p className="eyebrow">Recognised by anchors you already trust</p>
              <ul className="mt-3 space-y-3">
                {view.candidates.slice(0, 8).map((c) => (
                  <li key={c.candidate} className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-sm tracking-wider text-paper">{c.fingerprint}</span>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-paper-dim">
                      {c.endorsedBy.length} anchor{c.endorsedBy.length === 1 ? '' : 's'}
                      {c.notes[0] ? ` · “${c.notes[0]}”` : ''}
                    </span>
                    <button onClick={() => void add(c.candidate)} className="btn ml-auto">
                      Trust this too
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* ── current set ── */}
          {anchors.length > 0 ? (
            <ul className="mt-5 space-y-2">
              {anchors.map((a) => (
                <li key={a} className="flex flex-wrap items-center gap-3 border border-paper/20 px-4 py-3">
                  <span className="font-mono text-sm tracking-wider text-paper">
                    {fingerprintFromId(a)}
                  </span>
                  {a === selfPub ? (
                    <span className="font-mono text-[9px] uppercase tracking-wider text-signal">you</span>
                  ) : null}
                  <span className="truncate font-mono text-[9px] text-paper/30">{a}</span>
                  <button
                    onClick={() => void remove(a)}
                    className="ml-auto font-mono text-[10px] uppercase tracking-wider text-paper-dim hover:text-alarm"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {/* ── add by key, with a fingerprint check ── */}
          <div className="mt-5">
            <span className="eyebrow">Add an anchor</span>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                value={input}
                onChange={(e) => {
                  setInput(e.target.value)
                  setConfirmedFingerprint(false)
                }}
                spellCheck={false}
                placeholder="Paste the anchor's public key"
                className="field flex-1 text-[11px]"
              />
            </div>

            {/*
              A 43-character key cannot be checked by eye against a poster. The
              fingerprint can — and it is the only defence against being handed
              a substituted key, since nothing else in the system has met this
              body before.
            */}
            {candidateFingerprint ? (
              <label className="mt-3 flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={confirmedFingerprint}
                  onChange={(e) => setConfirmedFingerprint(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-signal"
                />
                <span className="font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper">
                  I checked <span className="tracking-widest">{candidateFingerprint}</span> against
                  the poster, the broadcast, or the person themselves.
                </span>
              </label>
            ) : null}

            <button
              onClick={() => void add(input.trim())}
              disabled={!candidateFingerprint || !confirmedFingerprint}
              className="btn mt-3"
            >
              Trust this anchor
            </button>
          </div>

          {/* ── acting AS an anchor ── */}
          {iAmAnchor ? (
            <div className="mt-6 border-t border-paper/20 pt-5">
              <p className="eyebrow">You are an anchor here</p>
              <p className="mt-2 max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/50">
                What you sign below propagates to anyone who trusts you, as something for them to
                consider. It never changes their device on its own.
              </p>

              <input
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, MAX_NOTE_CHARS))}
                placeholder="A short note, e.g. Ikorodu Market Association, 2026 committee"
                className="field mt-3 text-[11px]"
              />

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => void publish(AnchorActionKind.Endorse, input.trim())}
                  disabled={!candidateFingerprint}
                  className="btn"
                >
                  Recognise the key above
                </button>
                <button
                  onClick={() => void publish(AnchorActionKind.Rotate, input.trim())}
                  disabled={!candidateFingerprint}
                  className="btn"
                >
                  Announce it as my new key
                </button>
                <button
                  onClick={() => void publish(AnchorActionKind.Retire)}
                  className="btn"
                >
                  Stand down as an anchor
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
