'use client'

import { useMemo, useState } from 'react'

import { LANGUAGES, languageName } from '@/lib/lang/languages'
import { needsTranslation, translatableBy } from '@/lib/lang/translation'
import type { Statement, Translation } from '@/lib/db/schema'

interface Props {
  statements: Statement[]
  translations: Translation[]
  readerLangs: string[]
  selfPub: string
  onSetReads: (langs: string[]) => Promise<void>
  /** Jumps the queue to this statement so it can be rendered. */
  onOpen: (statementId: string) => void
}

/**
 * Two counts, and they are not the same count.
 *
 * The GAP is what you cannot read — the part of this conversation that is
 * closed to you. Naming it is the whole reason language is tagged at all: a
 * Yorùbá speaker scrolling past Hausa statements currently learns nothing
 * except that some text looked strange, and a divide you cannot see is one
 * nobody thinks to cross.
 *
 * The WORK is what you can read and have not yet rendered. Offering someone
 * work in a language they do not read would be absurd, which is exactly the
 * conflation this panel exists to avoid — see translatableBy.
 *
 * Neither list removes anything from the conversation. Every statement stays in
 * the queue for everyone, in whatever language it was written; this only says
 * which of them you are shut out of and which you could open for somebody else.
 */
export function TranslationQueue({
  statements,
  translations,
  readerLangs,
  selfPub,
  onSetReads,
  onOpen,
}: Props) {
  const [editing, setEditing] = useState(false)

  const gap = useMemo(
    () => needsTranslation(statements, translations, readerLangs),
    [statements, translations, readerLangs],
  )
  const work = useMemo(
    () => translatableBy(statements, translations, readerLangs, selfPub),
    [statements, translations, readerLangs, selfPub],
  )

  const toggle = async (code: string) => {
    const next = readerLangs.includes(code)
      ? readerLangs.filter((l) => l !== code)
      : [...readerLangs, code]
    // Never let the list empty out — with no languages, everything is a gap and
    // nothing is work, which is a broken-looking screen rather than a fact.
    if (next.length === 0) return
    await onSetReads(next)
  }

  const tagged = statements.filter((s) => s.lang).length

  return (
    <section className="border border-paper/30">
      <div className="flex flex-wrap items-center gap-3 border-b border-paper/25 p-5">
        <p className="eyebrow">Across languages</p>
        <button
          onClick={() => setEditing((v) => !v)}
          className="ml-auto font-mono text-[10px] uppercase tracking-wider text-paper-dim hover:text-paper"
        >
          {editing ? '− Done' : `I read: ${readerLangs.map((l) => languageName(l)?.split(' (')[0] ?? l).join(', ')}`}
        </button>
      </div>

      {editing ? (
        <div className="border-b border-paper/25 p-5">
          <p className="max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/50">
            Kept on this phone and never published. It changes which statements are counted below and
            nothing else — no statement is ever hidden from you because of the language it is in.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {LANGUAGES.map((l) => {
              const on = readerLangs.includes(l.code)
              return (
                <button
                  key={l.code}
                  onClick={() => void toggle(l.code)}
                  className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                    on
                      ? 'border-signal bg-signal/10 text-paper'
                      : 'border-paper/25 text-paper/45 hover:border-paper/50 hover:text-paper'
                  }`}
                >
                  {l.endonym}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      <div className="grid gap-5 p-5 sm:grid-cols-2">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-wider text-paper/40">
            Closed to you
          </p>
          <p className="mt-2 font-display text-3xl text-paper">{gap.length}</p>
          <p className="mt-2 max-w-sm font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper-dim">
            {gap.length === 0
              ? 'Nothing here is in a language you cannot read.'
              : 'Written in a language you do not read, and not yet rendered into one you do. They are still in the queue — you can vote on anything, read or not.'}
          </p>
        </div>

        <div>
          <p className="font-mono text-[10px] uppercase tracking-wider text-paper/40">
            You could open for someone
          </p>
          <p className="mt-2 font-display text-3xl text-paper">{work.length}</p>
          <p className="mt-2 max-w-sm font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper-dim">
            {work.length === 0
              ? tagged === 0
                ? 'Nobody has said what language they wrote in yet, so there is nothing to go on.'
                : 'You have rendered everything here that you can read.'
              : 'You can read these and have not rendered them. This is work — someone can settle it with you in time credits.'}
          </p>
          {work.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {work.slice(0, 5).map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => onOpen(s.id)}
                    className="text-left font-mono text-[11px] leading-relaxed text-paper-dim underline underline-offset-4 hover:text-paper"
                  >
                    {s.text.length > 70 ? `${s.text.slice(0, 70)}…` : s.text}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  )
}
