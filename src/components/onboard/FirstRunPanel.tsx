'use client'

import Link from 'next/link'
import { useCallback, useState } from 'react'

import { FirstRun, promptFor, coHostedCommonsUrl, isCommonsManifest } from '@/lib/firstRun'
import { saveSyncSource } from '@/lib/db/repo'
import { runSync } from '@/lib/sync/service'
import { log } from '@/lib/telemetry'

interface Props {
  state: FirstRun
  onChanged: () => Promise<void> | void
}

/**
 * The one thing worth saying when a device has nothing.
 *
 * WHY IT MAY OFFER A COMMONS BUT NEVER AN ANCHOR
 * Adding a sync source is the project's own one-tap case: a source is untrusted
 * transport, every record it serves is checked against its author's signature,
 * and the worst a hostile one manages is to withhold. An anchor is an axiom of
 * the trust graph, so it is never offered here at all — not even the author's.
 * The Unrooted prompt sends the user to the anchor panel to type a fingerprint
 * they got from a person, which is the only honest way in and is exactly what
 * the README means by bootstrapping staying out of band.
 *
 * WHY THE COMMONS URL IS NOT COMPILED IN
 * It is derived from where the page is being served. A fork deployed anywhere
 * offers its own commons; a build with nothing beside it offers nothing and
 * says so. No author's address is in the bundle.
 */
export function FirstRunPanel({ state, onChanged }: Props) {
  const prompt = promptFor(state)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null)

  const addCoHosted = useCallback(async () => {
    setBusy(true)
    setNote(null)
    try {
      const base = process.env.NEXT_PUBLIC_BASE_PATH ?? ''
      const url = coHostedCommonsUrl(window.location.href, base)
      if (!url) {
        setNote({ kind: 'bad', text: 'Could not work out where this app is served from.' })
        return
      }

      // `response.ok` proves nothing on a static host: a missing path is
      // routinely answered with the app shell and a 200. Parse it and check it
      // is really a manifest, or we would add a source that never yields a record.
      const res = await fetch(new URL('manifest.json', url).toString(), { cache: 'no-store' })
      const body = res.ok ? await res.json().catch(() => null) : null
      if (!isCommonsManifest(body)) {
        setNote({
          kind: 'bad',
          text: 'No commons is published beside this app. Ask whoever runs yours for its address, and add it under Sync → Sources.',
        })
        return
      }

      await saveSyncSource({
        url,
        label: new URL(url).hostname,
        cursorHlc: null,
        seenBundleIds: [],
        manifestEtag: null,
        lastPulledAt: null,
        enabled: true,
      })
      const report = await runSync()
      log.info('sync', 'co-hosted commons added on first run', { applied: report.applied })
      setNote(
        report.errors.length
          ? { kind: 'ok', text: 'Added. Nothing could be fetched just now — it will fill in when you have data.' }
          : { kind: 'ok', text: `Added. ${report.applied} record${report.applied === 1 ? '' : 's'} arrived.` },
      )
      await onChanged()
    } catch (err) {
      setNote({ kind: 'bad', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }, [onChanged])

  if (!prompt) return null

  return (
    <section className="border border-paper/30 p-5 sm:p-7">
      <p className="eyebrow">{prompt.eyebrow}</p>
      <h2 className="mt-3 font-display text-3xl uppercase text-paper sm:text-4xl">
        {prompt.headline}
      </h2>
      <p className="mt-4 max-w-2xl font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
        {prompt.body}
      </p>

      {note ? (
        <p
          className={`mt-5 border px-3 py-2 font-mono text-[11px] leading-relaxed ${
            note.kind === 'ok'
              ? 'border-paper/40 bg-paper/5 text-paper'
              : 'border-alarm/60 bg-alarm/10 text-paper'
          }`}
        >
          {note.text}
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        {prompt.action?.kind === 'add-commons' ? (
          <button onClick={() => void addCoHosted()} disabled={busy} className="btn btn-solid">
            {busy ? 'Adding…' : prompt.action.label}
          </button>
        ) : prompt.action?.href ? (
          <Link href={prompt.action.href} className="btn btn-solid">
            {prompt.action.label} <span aria-hidden>→</span>
          </Link>
        ) : null}

        {prompt.secondary ? (
          <Link href={prompt.secondary.href} className="btn">
            {prompt.secondary.label}
          </Link>
        ) : null}
      </div>
    </section>
  )
}
