'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

import {
  parseInvite,
  inviteSourceLabel,
  INVITE_REJECT_MESSAGES,
  InviteReject,
  type Invite,
  type InviteAnchor,
} from '@/lib/invite'
import { getAnchors, setAnchors, getSyncSources, saveSyncSource } from '@/lib/db/repo'
import { runSync } from '@/lib/sync/service'
import { log } from '@/lib/telemetry'

/**
 * What happens when someone opens an invite.
 *
 * THE ONE-TAP HALF AND THE DELIBERATE HALF
 * Adding the commons is one tap, because a source is untrusted transport: every
 * op it serves is checked against its author's signature, so the worst a
 * hostile source achieves is showing you a selective view — which a second
 * source cures. Adding an anchor is not one tap and never will be, because an
 * anchor is an axiom of the trust graph and a hostile one rewrites what this
 * device believes about everyone. That asymmetry is the whole design; see
 * ANCHOR ASYMMETRY in src/lib/invite.ts.
 *
 * NO IDENTITY REQUIRED
 * Reading a commons needs no key — merging signed records verifies them against
 * their authors, not against you. So the invite works for someone who has never
 * opened this app, and the offer to create an identity comes after they have
 * seen what they are joining, not before.
 */
export function JoinFlow() {
  const [invite, setInvite] = useState<Invite | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const [added, setAdded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null)

  const [trustedAnchors, setTrustedAnchors] = useState<string[]>([])
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({})

  /*
    Read the link on mount AND on every fragment change.

    `location.href` rather than a router hook: the fragment is deliberately
    never sent to the server, so there is nothing for a server-rendered router
    to have seen, and this page is statically exported.

    The hashchange half is not housekeeping. Opening a second invite while this
    page is already up changes only the fragment, which remounts nothing — so
    without this the screen would keep describing the FIRST invite while the
    address bar showed the second, and the Add button would quietly act on the
    one nobody was reading. Every per-invite answer is cleared with it, or a
    fresh commons would inherit the last one's "added" and its ticked boxes.
  */
  useEffect(() => {
    if (typeof window === 'undefined') return

    const read = () => {
      setNotice(null)
      setConfirmed({})
      setAdded(false)
      setError(null)
      setInvite(null)

      const result = parseInvite(window.location.href, window.location.href)
      if (result.ok) {
        setInvite(result.value)
        void getSyncSources().then((list) => {
          if (list.some((s) => s.url === result.value.commonsUrl)) setAdded(true)
        })
      } else {
        setError(INVITE_REJECT_MESSAGES[result.reason])
      }
      void getAnchors().then(setTrustedAnchors)
      setReady(true)
    }

    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [])

  const addCommons = useCallback(async () => {
    if (!invite) return
    setBusy(true)
    setNotice(null)
    try {
      await saveSyncSource({
        url: invite.commonsUrl,
        label: inviteSourceLabel(invite),
        cursorHlc: null,
        seenBundleIds: [],
        manifestEtag: null,
        lastPulledAt: null,
        enabled: true,
      })
      setAdded(true)
      log.info('sync', 'commons added from invite', { host: invite.host })

      // Pull immediately, but treat failure as ordinary. Someone opening an
      // invite on a bus with no signal has still successfully joined — the
      // source is saved and the next sync will fill it in.
      const report = await runSync()
      setNotice(
        report.errors.length
          ? {
              kind: 'ok',
              text: 'Commons saved. Nothing could be fetched just now — it will fill in the next time you have data.',
            }
          : {
              kind: 'ok',
              text: `Commons saved. ${report.applied} record${report.applied === 1 ? '' : 's'} arrived.`,
            },
      )
    } catch (err) {
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }, [invite])

  const trustAnchor = useCallback(
    async (anchor: InviteAnchor) => {
      const next = [...trustedAnchors, anchor.pubKey]
      await setAnchors(next)
      setTrustedAnchors(next)
      log.info('sync', 'anchor trusted from invite', { fingerprint: anchor.fingerprint })
    },
    [trustedAnchors],
  )

  if (!ready) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-wider text-paper-dim">
        Reading the invite…
      </p>
    )
  }

  /* ── a link that is not an invite, or is a hostile one ── */
  if (error || !invite) {
    return (
      <section className="border border-paper/30 p-5 sm:p-7">
        <p className="eyebrow text-alarm">This link cannot be used</p>
        <h1 className="mt-3 font-display text-3xl uppercase text-paper sm:text-4xl">
          Nothing was added
        </h1>
        <p className="mt-4 max-w-xl font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
          {error ?? INVITE_REJECT_MESSAGES[InviteReject.Malformed]}
        </p>
        <p className="mt-4 max-w-xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
          Ask whoever sent it for the commons address on its own. You can paste it under Sync →
          Sources, which does exactly what this page would have done.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/identity" className="btn btn-solid">
            Go to sync settings
          </Link>
          <Link href="/guide" className="btn">
            What is this?
          </Link>
        </div>
      </section>
    )
  }

  const untrusted = invite.anchors.filter((a) => !trustedAnchors.includes(a.pubKey))

  return (
    <div className="space-y-8">
      {/* ── what you were sent ─────────────────────────────────────── */}
      <section className="border border-paper/30 p-5 sm:p-7">
        <p className="eyebrow">You were invited to a commons</p>
        <h1 className="mt-3 font-display text-[clamp(2rem,7vw,3.5rem)] uppercase leading-[0.95] text-paper">
          {invite.label ?? 'A commons'}
        </h1>

        {/*
          The host is the only part of an invite that cannot be dressed up — the
          name above is text a stranger typed. So the address gets its own line,
          in a size you cannot skim past, and it is described as the fact.
        */}
        <p className="mt-4 font-mono text-[10px] uppercase tracking-wider text-paper/40">
          Served from
        </p>
        <p className="mt-1 break-all font-mono text-base text-paper">{invite.host}</p>
        <p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-paper/30">
          {invite.commonsUrl}
        </p>

        {invite.crossOrigin ? (
          <p className="mt-4 border border-signal/60 bg-signal/5 px-3 py-2 font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper">
            This commons is on a different site than the link you opened. That is allowed, and it is
            also what a lookalike address looks like — check the name above is one you expected.
          </p>
        ) : null}

        <p className="mt-5 max-w-xl font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
          Adding a commons only decides where this phone looks for updates. It cannot put words in
          anyone&rsquo;s mouth: every record is checked against the signature of whoever wrote it,
          and one that fails is refused whoever handed it over.
        </p>

        {notice ? (
          <p
            className={`mt-5 border px-3 py-2 font-mono text-[11px] leading-relaxed ${
              notice.kind === 'ok'
                ? 'border-paper/40 bg-paper/5 text-paper'
                : 'border-alarm/60 bg-alarm/10 text-paper'
            }`}
          >
            {notice.text}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-3">
          <button onClick={() => void addCommons()} disabled={busy || added} className="btn btn-solid">
            {added ? 'Added to this phone' : busy ? 'Adding…' : 'Add this commons'}
          </button>
          <Link href="/guide" className="btn">
            What is this?
          </Link>
        </div>
      </section>

      {/* ── anchors: shown, never applied ───────────────────────────── */}
      {invite.anchors.length > 0 ? (
        <section className="border border-paper/30 p-5 sm:p-7">
          <p className="eyebrow">This invite also names {invite.anchors.length === 1 ? 'an anchor' : 'anchors'}</p>
          <h2 className="mt-3 font-display text-2xl uppercase text-paper sm:text-3xl">
            Nothing here is added by the link
          </h2>
          <p className="mt-3 max-w-xl font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
            An anchor is a community body whose word this phone accepts as a starting point — a
            market association, a co-operative, a union. Everyone&rsquo;s standing is worked out from
            there, so trusting the wrong one quietly changes what you are told about everybody.
            Without one, every score reads zero.
          </p>
          <p className="mt-3 max-w-xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
            A link cannot do this step for you. Check the twelve characters below against a poster,
            a broadcast, or the person themselves — that check is the only thing standing between
            you and a substituted key, because nothing in this system has met this body before.
          </p>

          <ul className="mt-6 space-y-4">
            {invite.anchors.map((anchor) => {
              const already = trustedAnchors.includes(anchor.pubKey)
              return (
                <li key={anchor.pubKey} className="border border-paper/20 p-4">
                  <p className="font-mono text-lg tracking-wider text-paper">{anchor.fingerprint}</p>
                  <p className="mt-1 break-all font-mono text-[9px] leading-relaxed text-paper/25">
                    {anchor.pubKey}
                  </p>

                  {already ? (
                    <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-signal">
                      Already trusted on this phone
                    </p>
                  ) : (
                    <>
                      {/*
                        Deliberately per-anchor, never pre-ticked, and with no
                        "trust all" button. A single control covering several
                        keys is how a confirmation becomes a reflex, and a
                        reflex launders a dangerous action as a considered one.
                      */}
                      <label className="mt-3 flex cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          checked={confirmed[anchor.pubKey] ?? false}
                          onChange={(e) =>
                            setConfirmed((c) => ({ ...c, [anchor.pubKey]: e.target.checked }))
                          }
                          className="mt-0.5 h-4 w-4 shrink-0 accent-signal"
                        />
                        <span className="font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper">
                          I checked <span className="tracking-widest">{anchor.fingerprint}</span>{' '}
                          against the poster, the broadcast, or the person themselves.
                        </span>
                      </label>
                      <button
                        onClick={() => void trustAnchor(anchor)}
                        disabled={!confirmed[anchor.pubKey]}
                        className="btn mt-3"
                      >
                        Trust this anchor
                      </button>
                    </>
                  )}
                </li>
              )
            })}
          </ul>

          {untrusted.length > 0 ? (
            <p className="mt-5 max-w-xl font-mono text-[10px] uppercase leading-relaxed tracking-wider text-paper/45">
              You can skip this entirely. The commons still syncs and you can still read it —
              standing simply stays at zero until you root it in someone.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* ── where to go next ────────────────────────────────────────── */}
      {added ? (
        <section className="border border-paper/30 p-5 sm:p-7">
          <p className="eyebrow">Next</p>
          <h2 className="mt-3 font-display text-2xl uppercase text-paper sm:text-3xl">
            Make a stamp so people can vouch for you
          </h2>
          <p className="mt-3 max-w-xl font-mono text-[11px] uppercase leading-relaxed tracking-wider text-paper-dim">
            You can read the commons without one. Posting, vouching and settling an exchange all
            need a key, because they are signed. It takes no email and no password.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/identity" className="btn btn-solid">
              Make my stamp →
            </Link>
            <Link href="/aid" className="btn">
              See what is offered
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  )
}
