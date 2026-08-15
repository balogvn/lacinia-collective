'use client'

import { useMemo, useState } from 'react'

import { QRPanel } from '@/components/qr/QRPanel'
import { buildInviteLink, MAX_INVITE_ANCHORS } from '@/lib/invite'
import { fingerprintFromId } from '@/lib/crypto/keys'
import type { PubKeyId, SyncSourceRecord } from '@/lib/db/schema'

interface Props {
  sources: SyncSourceRecord[]
  anchors: PubKeyId[]
}

/**
 * Turning a commons into something you can send someone.
 *
 * WHY THE ANCHORS RIDE ALONG BY DEFAULT
 * A link carrying only an address produces a commons that syncs perfectly and
 * reads as entirely empty of trust — every score zero, every tier Observer —
 * because standing is derived from anchors and a fresh device has none. That
 * failure looks like the app being broken rather than like a missing step, so
 * an invite that omits them is not a smaller invite; it is one that usually
 * fails. They ride along as a PROPOSAL: the recipient still has to check each
 * fingerprint and tick its own box, exactly as if they had typed the key in.
 *
 * WHERE THE LINK POINTS
 * At this deployment's own /join/ page, because that is the build the sender
 * knows exists. The commons address inside is stored relative to it, so the
 * same link keeps working if the whole app is later served from somewhere else.
 */
export function InvitePanel({ sources, anchors }: Props) {
  const [selected, setSelected] = useState(0)
  const [label, setLabel] = useState('')
  const [includeAnchors, setIncludeAnchors] = useState(true)
  const [copied, setCopied] = useState(false)
  const [shareNote, setShareNote] = useState<string | null>(null)

  const source = sources[Math.min(selected, sources.length - 1)]

  const joinUrl = useMemo(() => {
    if (typeof window === 'undefined') return ''
    // basePath is build-time only and unreadable from client code, so it comes
    // through the environment — the same route ServiceWorkerRegistrar takes.
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? ''
    return `${window.location.origin}${base}/join/`
  }, [])

  const carried = includeAnchors ? anchors.slice(0, MAX_INVITE_ANCHORS) : []

  const link = useMemo(() => {
    if (!source || !joinUrl) return ''
    return buildInviteLink(
      {
        commonsUrl: source.url,
        label: label.trim() || source.label,
        anchors: carried,
      },
      joinUrl,
    )
  }, [source, joinUrl, label, carried])

  if (sources.length === 0) {
    return (
      <div className="mt-8 border-t border-paper/20 pt-6">
        <p className="eyebrow">Invite someone</p>
        <p className="mt-3 max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/50">
          Add a commons above first. An invite is a link to one — there is nothing to share until
          this phone follows something.
        </p>
      </div>
    )
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setShareNote('Clipboard blocked — select the address below and copy it by hand.')
    }
  }

  /*
    Web Share hands the link straight to WhatsApp, Signal or SMS — the apps
    people actually pass things through here. It only exists on mobile browsers
    and only over https, so every path below it has to work on its own.
  */
  const share = async () => {
    setShareNote(null)
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
      await copy()
      return
    }
    try {
      await navigator.share({
        title: label.trim() || source!.label,
        text: `Join ${label.trim() || source!.label} on Lacinia`,
        url: link,
      })
    } catch {
      /* dismissed, or refused by the browser — the copy button is right there */
    }
  }

  return (
    <div className="mt-8 border-t border-paper/20 pt-6">
      <p className="eyebrow">Invite someone</p>
      <p className="mt-3 max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/50">
        One link that adds the commons and offers the anchors, so nobody has to be walked through
        two settings panels over the phone. Send it, or hold the code up to their camera.
      </p>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_320px] lg:items-start">
        <div>
          {sources.length > 1 ? (
            <label className="block">
              <span className="eyebrow">Which commons</span>
              <select
                value={selected}
                onChange={(e) => setSelected(Number(e.target.value))}
                className="field mt-2 text-[11px]"
              >
                {sources.map((s, i) => (
                  <option key={s.url} value={i}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="mt-4 block">
            <span className="eyebrow">Call it something</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
              placeholder={source!.label}
              className="field mt-2 text-[11px]"
            />
          </label>

          {anchors.length > 0 ? (
            <label className="mt-4 flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={includeAnchors}
                onChange={(e) => setIncludeAnchors(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-signal"
              />
              <span className="font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper">
                Offer the {carried.length || anchors.length} anchor
                {(carried.length || anchors.length) === 1 ? '' : 's'} this phone trusts
                <span className="mt-1 block text-[10px] tracking-wider text-paper/45">
                  {carried.map((a) => fingerprintFromId(a)).join(' · ') ||
                    anchors.slice(0, MAX_INVITE_ANCHORS).map((a) => fingerprintFromId(a)).join(' · ')}
                </span>
                <span className="mt-1 block text-[10px] tracking-wider text-paper/45">
                  Without this their standing stays at zero. They still have to check each
                  fingerprint against you before it counts.
                </span>
              </span>
            </label>
          ) : (
            <p className="mt-4 max-w-lg font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
              This phone trusts no anchor, so the invite carries none. Whoever opens it will sync
              fine and see every score at zero — add an anchor below before inviting anyone.
            </p>
          )}

          <div className="mt-5 flex flex-wrap gap-3">
            <button onClick={() => void share()} className="btn btn-solid">
              Send the invite
            </button>
            <button onClick={() => void copy()} className="btn">
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>

          {shareNote ? (
            <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-paper-dim">
              {shareNote}
            </p>
          ) : null}

          {/*
            The link is shown in full and selectable. Someone reading it down a
            phone line, writing it on a chalkboard, or checking what they are
            about to forward needs to see the whole thing, not a summary of it.
          */}
          <p className="mt-4 break-all font-mono text-[10px] leading-relaxed text-paper/40">
            {link}
          </p>
        </div>

        {/*
          The QR is not a nicety. It is the path with no network at all: two
          phones held together in a market, one screen and one camera.
        */}
        {link ? <QRPanel payload={link} caption="Point their camera here" showDiagnostics={false} /> : null}
      </div>
    </div>
  )
}
