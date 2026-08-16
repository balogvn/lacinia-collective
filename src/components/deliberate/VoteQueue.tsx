'use client'

import { useMemo, useState } from 'react'

import { VoteValue, MAX_STATEMENT_CHARS, type FlagReason, type Statement } from '@/lib/db/schema'
import { FlagControl } from '@/components/moderate/FlagControl'
import { WithheldItem } from '@/components/moderate/WithheldItem'
import { Visibility, type VisibilityVerdict } from '@/lib/moderate/policy'

interface Props {
  statements: Statement[]
  myVotes: Map<string, VoteValue>
  selfPub: string
  onVote: (statementId: string, value: VoteValue) => Promise<void>
  onAdd: (text: string) => Promise<void>
  evaluate: (targetId: string, authorPub: string) => VisibilityVerdict
  onFlag: (statementId: string, reason: FlagReason) => Promise<void>
  onUnflag: (statementId: string) => Promise<void>
}

/**
 * The voting surface.
 *
 * NOTE WHAT IS NOT HERE: no reply box, no quote, no thread, no author name on
 * the card. Each statement stands alone and you respond only to the claim.
 *
 * Hiding the author is deliberate and does real work. Once a name is attached,
 * people vote on the person — which is precisely how ethno-religious divides
 * reproduce themselves in a tool meant to bridge them. The author is still
 * recorded and signed; it is simply not shown at the moment of judgement.
 */
export function VoteQueue({
  statements,
  myVotes,
  selfPub,
  onVote,
  onAdd,
  evaluate,
  onFlag,
  onUnflag,
}: Props) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [composing, setComposing] = useState(false)

  // Unvoted statements first, oldest first within that — so the queue drains
  // predictably rather than reshuffling under the reader after every vote.
  //
  // Withheld statements are skipped rather than shown-and-collapsed: asking
  // someone to vote on something the whole room flagged as abusive is the
  // opposite of protecting them. They remain readable from the withheld panel.
  const queue = useMemo(
    () =>
      statements
        .filter((s) => !myVotes.has(s.id))
        .filter((s) => evaluate(s.id, s.authorPub).visibility !== Visibility.Withheld)
        .sort((a, b) => a.createdAt - b.createdAt),
    [statements, myVotes, evaluate],
  )

  const withheld = useMemo(
    () => statements.filter((s) => evaluate(s.id, s.authorPub).visibility === Visibility.Withheld),
    [statements, evaluate],
  )

  const current = queue[0] ?? null
  const done = statements.length - queue.length

  const submit = async () => {
    setBusy(true)
    try {
      await onAdd(draft)
      setDraft('')
      setComposing(false)
    } finally {
      setBusy(false)
    }
  }

  const cast = async (value: VoteValue) => {
    if (!current) return
    setBusy(true)
    try {
      await onVote(current.id, value)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="border border-paper/30">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-paper/25 p-5">
        <p className="eyebrow">One at a time</p>
        <p className="font-mono text-[10px] uppercase tracking-wider text-paper/40">
          {done} of {statements.length} voted
        </p>
      </div>

      {statements.length > 0 ? (
        <div className="h-1 w-full bg-paper/15">
          <div
            className="h-full bg-paper transition-all"
            style={{ width: `${statements.length ? (done / statements.length) * 100 : 0}%` }}
          />
        </div>
      ) : null}

      <div className="p-5">
        {current ? (
          <>
            <WithheldItem verdict={evaluate(current.id, current.authorPub)}>
              <blockquote className="min-h-[7rem] border-l-2 border-paper/40 pl-5">
                <p className="font-display text-2xl leading-snug text-paper sm:text-3xl">
                  {current.text}
                </p>
              </blockquote>
            </WithheldItem>

            <div className="mt-4">
              <FlagControl
                targetId={current.id}
                targetEntity="statement"
                alreadyFlagged={evaluate(current.id, current.authorPub).flaggedByYou}
                onFlag={(reason) => onFlag(current.id, reason)}
                onWithdraw={() => onUnflag(current.id)}
              />
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              {/*
                Deliberately NOT btn-solid. These are three peer choices, and a
                filled Agree beside an outlined Disagree is a thumb on the
                scale — in the one screen whose entire job is measuring what
                people actually think. It also read as a selection state, so
                Agree looked chosen no matter which one you pressed.
              */}
              <button onClick={() => void cast(VoteValue.Agree)} disabled={busy} className="btn flex-1">
                Agree
              </button>
              <button onClick={() => void cast(VoteValue.Disagree)} disabled={busy} className="btn flex-1">
                Disagree
              </button>
              <button onClick={() => void cast(VoteValue.Pass)} disabled={busy} className="btn flex-1">
                Pass
              </button>
            </div>

            <p className="mt-4 max-w-lg font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
              There is no reply button. You can agree, disagree, pass — or write your own statement.
              Nothing here can be argued with, only responded to.
            </p>
          </>
        ) : (
          <div className="min-h-[7rem]">
            <p className="font-display text-2xl uppercase text-paper sm:text-3xl">
              {statements.length === 0
                ? 'Nothing to vote on yet'
                : 'You have voted on everything here'}
            </p>
            <p className="mt-3 max-w-lg font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
              {statements.length === 0
                ? 'Write the first statement, or sync to see what neighbours have added.'
                : 'Add a statement of your own, or come back after syncing.'}
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-paper/25 p-5">
        {composing ? (
          <>
            <label className="block">
              <span className="eyebrow">Your own statement</span>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value.slice(0, MAX_STATEMENT_CHARS))}
                rows={3}
                placeholder="One clear claim someone could agree or disagree with"
                className="field mt-2 resize-none"
              />
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <span className="font-mono text-[10px] uppercase tracking-wider text-paper/40">
                {draft.length}/{MAX_STATEMENT_CHARS}
              </span>
              <button
                onClick={submit}
                disabled={busy || draft.trim().length < 8}
                className="btn btn-solid ml-auto"
              >
                {busy ? 'Adding…' : 'Add statement'}
              </button>
              <button onClick={() => setComposing(false)} className="btn">
                Cancel
              </button>
            </div>
            <p className="mt-3 max-w-xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
              Write one claim, not a paragraph. Nuance that would go in a reply has to become its own
              statement — harder to write, impossible to brigade.
            </p>
          </>
        ) : (
          <button onClick={() => setComposing(true)} className="btn">
            + Add your own statement
          </button>
        )}
      </div>

      {/*
        The withheld panel. Nothing here is deleted — it cannot be, the data is
        already on other devices — so it is listed openly with its reason and
        stays one tap from being read. A hidden item with no way through is how
        a community learns a tool is being used against it.
      */}
      {withheld.length > 0 ? (
        <div className="border-t border-paper/25 p-5">
          <p className="eyebrow">
            Withheld here · {withheld.length}
          </p>
          <p className="mt-2 max-w-lg font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
            Every group in this conversation flagged these. Nothing is deleted, and you can read any
            of them.
          </p>
          <ul className="mt-3 space-y-3">
            {withheld.map((s) => (
              <li key={s.id}>
                <WithheldItem verdict={evaluate(s.id, s.authorPub)}>
                  <p className="font-mono text-[12px] leading-relaxed text-paper">{s.text}</p>
                </WithheldItem>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Statements you wrote, so you can see what you have contributed. */}
      {statements.some((s) => s.authorPub === selfPub) ? (
        <div className="border-t border-paper/25 p-5">
          <p className="eyebrow">Yours</p>
          <ul className="mt-3 space-y-2">
            {statements
              .filter((s) => s.authorPub === selfPub)
              .map((s) => (
                <li
                  key={s.id}
                  className="border-l border-paper/25 pl-3 font-mono text-[11px] leading-relaxed text-paper-dim"
                >
                  {s.text}
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
