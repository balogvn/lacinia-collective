'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { FrameBroadcaster } from './FrameBroadcaster'
import { InvitePanel } from './InvitePanel'
import { FrameReceiver } from './FrameReceiver'
import {
  buildOutboundBundle,
  confirmOutboundSent,
  importBundleText,
  runSync,
  type OutboundBundle,
  type SyncRunReport,
} from '@/lib/sync/service'
import { downloadBundle } from '@/lib/sync/transport'
import {
  getSyncSources,
  saveSyncSource,
  removeSyncSource,
  unsyncedOps,
  getPullState,
} from '@/lib/db/repo'
import type { PubKeyId, SyncSourceRecord } from '@/lib/db/schema'
import type { KeyPair } from '@/lib/crypto/keys'
import { log } from '@/lib/telemetry'

interface Props {
  keyPair: KeyPair
  /** Offered inside an invite, so the recipient does not land on an all-zero commons. */
  anchors: PubKeyId[]
  onMerged: () => Promise<void> | void
}

type Tab = 'pull' | 'publish' | 'receive' | 'sources'

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'pull', label: 'Pull', hint: 'Fetch updates from a commons' },
  { id: 'publish', label: 'Publish', hint: 'Share what this phone knows' },
  { id: 'receive', label: 'Receive', hint: 'Take updates from another phone' },
  { id: 'sources', label: 'Sources', hint: 'Where this device syncs from' },
]

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}

function formatWhen(ms: number | null): string {
  if (!ms) return 'never'
  const mins = Math.round((Date.now() - ms) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

export function SyncPanel({ keyPair, anchors, onMerged }: Props) {
  const [tab, setTab] = useState<Tab>('pull')
  // Only steer the opening tab once. After that the tab is the user's to
  // choose, and re-steering on every refresh would yank it away mid-task.
  const steered = useRef(false)
  const [sources, setSources] = useState<SyncSourceRecord[]>([])
  const [pending, setPending] = useState(0)
  const [lastPulled, setLastPulled] = useState<number | null>(null)
  const [outbound, setOutbound] = useState<OutboundBundle | null>(null)
  const [report, setReport] = useState<SyncRunReport | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [newUrl, setNewUrl] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [showFrames, setShowFrames] = useState(false)

  const refresh = useCallback(async () => {
    const list = await getSyncSources()
    setSources(list)
    setPending((await unsyncedOps(500)).length)
    let newest: number | null = null
    for (const source of list) {
      const state = await getPullState(source.url)
      if (state.lastPulledAt && (!newest || state.lastPulledAt > newest)) newest = state.lastPulledAt
    }
    setLastPulled(newest)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A fresh device has no sources, so Pull — the default — is the one tab where
  // nothing can be done, and its main button is greyed out on arrival. Open on
  // Sources instead, which is where the first action actually is.
  useEffect(() => {
    if (steered.current) return
    if (sources.length === 0) setTab('sources')
    steered.current = true
  }, [sources.length])

  /* ── pull ───────────────────────────────────────────────────────── */
  const doPull = async () => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await runSync()
      setReport(result)
      await onMerged()
      await refresh()
      setNotice({
        kind: result.errors.length ? 'bad' : 'ok',
        text: result.errors.length
          ? result.errors.join(' ')
          : `Applied ${result.applied} update${result.applied === 1 ? '' : 's'} for ${formatBytes(result.bytesDownloaded)}.`,
      })
    } catch (err) {
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  /* ── publish ────────────────────────────────────────────────────── */
  const prepare = async () => {
    setBusy(true)
    setNotice(null)
    try {
      const built = await buildOutboundBundle(keyPair)
      setOutbound(built)
      if (!built) setNotice({ kind: 'ok', text: 'Nothing new to publish — this phone is up to date.' })
    } catch (err) {
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const saveFile = async () => {
    if (!outbound) return
    downloadBundle(outbound.bundle)
    await confirmOutboundSent(outbound)
    await refresh()
    setNotice({ kind: 'ok', text: 'Bundle saved. Attach it to a pull request, or send it however you already talk.' })
  }

  const copyBundle = async () => {
    if (!outbound) return
    await navigator.clipboard.writeText(outbound.json)
    await confirmOutboundSent(outbound)
    await refresh()
    setNotice({ kind: 'ok', text: 'Bundle copied to clipboard.' })
  }

  /* ── receive ────────────────────────────────────────────────────── */
  const ingest = async (text: string) => {
    setBusy(true)
    try {
      const result = await importBundleText(text)
      await onMerged()
      await refresh()
      const { merge, verification } = result
      setNotice({
        kind: 'ok',
        text: `Applied ${merge.applied}, already had ${merge.duplicates}, older than mine ${merge.stale}${
          verification.rejected.length ? `, refused ${verification.rejected.length}` : ''
        }.`,
      })
    } catch (err) {
      log.warn('sync', 'import failed', { error: String(err) })
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    await ingest(await file.text())
  }

  /* ── sources ────────────────────────────────────────────────────── */
  const addSource = async () => {
    try {
      const url = new URL(newUrl.trim()).toString()
      await saveSyncSource({
        url,
        label: newLabel.trim() || new URL(url).hostname,
        cursorHlc: null,
        seenBundleIds: [],
        manifestEtag: null,
        lastPulledAt: null,
        enabled: true,
      })
      setNewUrl('')
      setNewLabel('')
      await refresh()
    } catch {
      setNotice({ kind: 'bad', text: 'That is not a valid web address.' })
    }
  }

  return (
    <section className="border border-paper/30">
      <div className="flex flex-wrap border-b border-paper/25">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTab(t.id)
              setNotice(null)
              setShowFrames(false)
            }}
            className={`flex-1 border-r border-paper/25 px-4 py-3.5 text-left transition-colors last:border-r-0 ${
              tab === t.id ? 'bg-paper text-canvas' : 'text-paper-dim hover:text-paper'
            }`}
          >
            <span className="block font-mono text-[11px] uppercase tracking-wider">{t.label}</span>
            <span
              className={`mt-1 block font-mono text-[9px] uppercase tracking-wider ${
                tab === t.id ? 'text-canvas/60' : 'text-paper/35'
              }`}
            >
              {t.hint}
            </span>
          </button>
        ))}
      </div>

      {/* Status strip — pending count is the honest answer to "am I synced?" */}
      <dl className="grid grid-cols-3 border-b border-paper/25">
        {[
          { label: 'Waiting to publish', value: `${pending} update${pending === 1 ? '' : 's'}` },
          { label: 'Last pull', value: formatWhen(lastPulled) },
          { label: 'Sources', value: `${sources.filter((s) => s.enabled).length}` },
        ].map((stat) => (
          <div key={stat.label} className="border-r border-paper/20 px-5 py-3 last:border-r-0">
            <dt className="font-mono text-[9px] uppercase tracking-wider text-paper/40">
              {stat.label}
            </dt>
            <dd className="mt-0.5 font-mono text-[13px] text-paper">{stat.value}</dd>
          </div>
        ))}
      </dl>

      <div className="p-5">
        {notice ? (
          <p
            className={`mb-5 border px-3 py-2.5 font-mono text-[11px] leading-relaxed ${
              notice.kind === 'ok'
                ? 'border-paper/50 bg-paper/10 text-paper'
                : 'border-alarm/60 bg-alarm/10 text-paper'
            }`}
          >
            {notice.text}
          </p>
        ) : null}

        {/* ── PULL ─────────────────────────────────────────────────── */}
        {tab === 'pull' ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <p className="eyebrow">Fetch</p>
              <h3 className="mt-2 font-display text-2xl uppercase text-paper sm:text-3xl">
                Pull from the commons
              </h3>
              <p className="mt-4 max-w-lg font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
                Only what changed since last time is downloaded. If nothing has changed, the whole
                check costs a few hundred bytes.
              </p>
              {/*
                With no sources there is nothing to sync, but a greyed-out
                button is a dead end — it states a problem and offers no way
                out. Send them where the fix is instead.
              */}
              {sources.filter((s) => s.enabled).length === 0 ? (
                <>
                  <button onClick={() => setTab('sources')} className="btn btn-solid mt-6">
                    Add a source first <span aria-hidden>→</span>
                  </button>
                  <p className="mt-3 max-w-lg font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
                    Nothing to pull from yet. A source is any web address serving a commons — you
                    can also receive updates straight from another phone under Receive.
                  </p>
                </>
              ) : (
                <button onClick={doPull} disabled={busy} className="btn btn-solid mt-6">
                  {busy ? 'Syncing…' : 'Sync now'}
                </button>
              )}
            </div>

            {report ? (
              <dl className="grid grid-cols-2 gap-px self-start border border-paper/20 bg-paper/10">
                {[
                  { label: 'Downloaded', value: formatBytes(report.bytesDownloaded) },
                  { label: 'Bundles', value: String(report.fetched) },
                  { label: 'Applied', value: String(report.applied) },
                  { label: 'Already had', value: String(report.duplicates) },
                  { label: 'Refused', value: String(report.rejected) },
                  { label: 'Sources', value: String(report.sources) },
                ].map((s) => (
                  <div key={s.label} className="bg-canvas px-4 py-3">
                    <dt className="font-mono text-[9px] uppercase tracking-wider text-paper/40">
                      {s.label}
                    </dt>
                    <dd className="mt-0.5 font-mono text-lg text-paper">{s.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ) : null}

        {/* ── PUBLISH ──────────────────────────────────────────────── */}
        {tab === 'publish' ? (
          <div className="grid gap-6 lg:grid-cols-[340px_1fr] lg:items-start">
            <div>
              {outbound && showFrames ? (
                <FrameBroadcaster
                  payload={outbound.json}
                  onDone={() => {
                    void confirmOutboundSent(outbound).then(refresh)
                    setShowFrames(false)
                    setNotice({ kind: 'ok', text: 'Marked as shared.' })
                  }}
                />
              ) : (
                <div className="border border-paper/25 p-5">
                  <p className="eyebrow">Outgoing bundle</p>
                  {outbound ? (
                    <>
                      <p className="mt-3 font-mono text-3xl text-paper">
                        {outbound.bundle.opCount}
                      </p>
                      <p className="font-mono text-[10px] uppercase tracking-wider text-paper-dim">
                        updates · {formatBytes(outbound.bytes)}
                      </p>
                      <p className="mt-3 font-mono text-[9px] tracking-wider text-paper/35">
                        {outbound.bundle.id.slice(0, 24)}…
                      </p>
                    </>
                  ) : (
                    <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-paper/45">
                      Nothing prepared yet.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div>
              <p className="eyebrow">Share</p>
              <h3 className="mt-2 font-display text-2xl uppercase text-paper sm:text-3xl">
                There is no server to upload to
              </h3>
              <p className="mt-4 max-w-lg font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
                That is the design, not a gap. Hand your updates to another phone, or save a file
                and send it however you already talk — WhatsApp, email, a pull request.
              </p>

              <div className="mt-6 flex flex-wrap gap-2">
                <button onClick={prepare} disabled={busy} className="btn">
                  {outbound ? 'Rebuild bundle' : 'Prepare bundle'}
                </button>
                <button
                  onClick={() => setShowFrames(true)}
                  disabled={!outbound || showFrames}
                  className="btn btn-solid"
                >
                  Show as animated code
                </button>
                <button onClick={saveFile} disabled={!outbound} className="btn">
                  Save bundle file
                </button>
                <button onClick={copyBundle} disabled={!outbound} className="btn">
                  Copy as text
                </button>
              </div>

              <p className="mt-5 max-w-lg border-l border-paper/25 pl-4 font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
                Your bundle carries other people’s updates too, signed by them. Relaying is how a
                vouch reaches someone who has never met either party — and it is safe because
                passing something on never lets you change it.
              </p>
            </div>
          </div>
        ) : null}

        {/* ── RECEIVE ──────────────────────────────────────────────── */}
        {tab === 'receive' ? (
          <div className="grid gap-6 lg:grid-cols-[340px_1fr] lg:items-start">
            <FrameReceiver onComplete={ingest} />
            <div>
              <p className="eyebrow">Merge</p>
              <h3 className="mt-2 font-display text-2xl uppercase text-paper sm:text-3xl">
                Take updates from another phone
              </h3>
              <p className="mt-4 max-w-lg font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
                Every update is checked against the signature of whoever wrote it. Anything that
                fails, or that tries to write on someone else’s behalf, is refused and counted.
              </p>

              <div className="mt-6">
                <label className="btn inline-flex cursor-pointer">
                  Load a bundle file
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => void onFile(e.target.files?.[0])}
                  />
                </label>
              </div>
            </div>
          </div>
        ) : null}

        {/* ── SOURCES ──────────────────────────────────────────────── */}
        {tab === 'sources' ? (
          <div>
            <p className="eyebrow">Where this device pulls from</p>
            <p className="mt-3 max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/50">
              A source is any web address serving a commons snapshot — a GitHub Pages site, a
              Vercel deployment, a neighbour’s laptop on the same wifi. Sources are not trusted:
              they can decide what to show you, but they cannot forge a single update.
            </p>

            {sources.length > 0 ? (
              <ul className="mt-5 space-y-2">
                {sources.map((s) => (
                  <li
                    key={s.url}
                    className="flex flex-wrap items-center gap-3 border border-paper/20 px-4 py-3"
                  >
                    <span className="font-mono text-[12px] text-paper">{s.label}</span>
                    <span className="truncate font-mono text-[9px] text-paper/30">{s.url}</span>
                    <button
                      onClick={() => void removeSyncSource(s.url).then(refresh)}
                      className="ml-auto font-mono text-[10px] uppercase tracking-wider text-paper-dim hover:text-alarm"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="mt-5 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Name, e.g. Ikorodu commons"
                className="field text-[11px]"
              />
              <input
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                spellCheck={false}
                placeholder="https://…/commons/"
                className="field text-[11px]"
              />
              <button onClick={addSource} disabled={!newUrl.trim()} className="btn">
                Add source
              </button>
            </div>

            <InvitePanel sources={sources} anchors={anchors} />
          </div>
        ) : null}
      </div>
    </section>
  )
}
