'use client'

import { useMemo, useState } from 'react'

import { LANGUAGES, languageName } from '@/lib/lang/languages'
import { translationsFor, MAX_TRANSLATION_CHARS } from '@/lib/lang/translation'
import { fingerprintFromId } from '@/lib/crypto/keys'
import type { Translation, TranslationTarget } from '@/lib/db/schema'

interface Props {
  targetId: string
  targetEntity: TranslationTarget
  /** What the original was written in, if its author said. */
  sourceLang?: string | undefined
  translations: Translation[]
  readerLangs: string[]
  /** Absent when this device holds no key — reading translations still works. */
  canWrite: boolean
  /**
   * Show who translated it.
   *
   * FALSE INSIDE THE VOTE QUEUE, deliberately. That surface hides the author of
   * a statement so people judge the claim rather than the person — which is
   * precisely how ethno-religious divides reproduce themselves in a tool built
   * to bridge them. A translator's name is a name too, and printing it beside
   * the words at the moment of judgement would reintroduce exactly what the
   * queue removes. The attribution is not destroyed, only deferred: it is
   * signed, it syncs, and it is shown everywhere judgement is not happening.
   */
  attributed: boolean
  onTranslate: (input: { lang: string; text: string; sourceLang?: string }) => Promise<void>
  onWithdraw?: (translationId: string) => Promise<void>
  selfPub?: string
}

export function TranslationPanel({
  targetId,
  sourceLang,
  translations,
  readerLangs,
  canWrite,
  attributed,
  onTranslate,
  onWithdraw,
  selfPub,
}: Props) {
  const [open, setOpen] = useState(false)
  const [lang, setLang] = useState(() => readerLangs[0] ?? 'en')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const view = useMemo(
    () => translationsFor(targetId, translations, { readerLangs }),
    [targetId, translations, readerLangs],
  )

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onTranslate({ lang, text, ...(sourceLang ? { sourceLang } : {}) })
      setText('')
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (view.all.length === 0 && !canWrite) return null

  return (
    <div className="mt-4 border-t border-paper/15 pt-3">
      {view.all.length > 0 ? (
        <ul className="space-y-3">
          {view.all.map((t) => (
            <li key={t.id} className="border-l-2 border-signal/50 pl-3">
              <p className="font-mono text-[9px] uppercase tracking-wider text-signal">
                {languageName(t.lang) ?? t.lang}
                {/*
                  The reader is told this is somebody's rendering, not the
                  words themselves. A translation presented as the original
                  would make the translator the author of another person's
                  meaning — in a language the author may not read well enough
                  to notice.
                */}
                <span className="text-paper/35"> · a neighbour&rsquo;s rendering</span>
              </p>
              <p className="mt-1 text-[15px] leading-relaxed text-paper/85">{t.text}</p>

              {attributed ? (
                <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-paper/35">
                  {fingerprintFromId(t.translatorPub)}
                  {selfPub && t.translatorPub === selfPub && onWithdraw ? (
                    <button
                      onClick={() => void onWithdraw(t.id)}
                      className="ml-3 underline underline-offset-2 hover:text-alarm"
                    >
                      Withdraw
                    </button>
                  ) : null}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {canWrite ? (
        open ? (
          <div className="mt-3 space-y-2">
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              className="field text-[11px]"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.endonym === l.name ? l.name : `${l.endonym} — ${l.name}`}
                </option>
              ))}
            </select>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              maxLength={MAX_TRANSLATION_CHARS}
              placeholder="Put it in your own words, as closely as you can."
              className="field resize-none text-[13px]"
            />
            {error ? (
              <p className="border border-alarm/60 bg-alarm/10 px-2 py-1 font-mono text-[10px] text-paper">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button onClick={() => void submit()} disabled={busy || !text.trim()} className="btn">
                {busy ? 'Signing…' : 'Publish this translation'}
              </button>
              <button onClick={() => setOpen(false)} className="btn">
                Cancel
              </button>
            </div>
            <p className="font-mono text-[9px] uppercase leading-relaxed tracking-wider text-paper/35">
              Signed by you and published beside the original, which is never replaced. If someone
              asked you for it, it is an hour like any other and can be settled under Mutual aid —
              they have to agree to it, the same as any exchange here.
            </p>
          </div>
        ) : (
          <button
            onClick={() => setOpen(true)}
            className="mt-2 font-mono text-[10px] uppercase tracking-wider text-paper-dim transition-colors hover:text-paper"
          >
            + Translate this
          </button>
        )
      ) : null}
    </div>
  )
}
