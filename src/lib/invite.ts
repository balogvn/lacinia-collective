/**
 * Invite links — how a commons gets shared.
 *
 * THE PROBLEM THIS SOLVES
 * Joining someone's commons used to take eight steps across two panels that do
 * not know about each other: Sync → Sources for the URL, then Anchors → Manage
 * for a 43-character key. Getting seven of the eight right leaves every trust
 * score at zero and the app looking broken, because with no anchor there is no
 * axiom for the trust graph to stand on. So an invite that carries only a URL
 * is not an invite — it is a way to arrive at a commons that appears empty.
 *
 * THE FRAGMENT, NOT THE QUERY STRING
 * Everything rides after `#`. Fragments are never sent to the server, so no
 * host log, CDN, or Referer header ever records which commons a person was
 * invited to. Which commons you follow is social-graph metadata; on a query
 * string it would be readable by every hop, including hosts nobody chose.
 *
 * THE ENCODING IS URLSearchParams
 * Not base64-of-JSON, which inflates by a third and turns a debuggable link
 * into a blob nobody can read in a log. `v=1&c=…&n=…&a=…` is shorter, survives
 * being pasted through chat apps, and gives forward compatibility for free:
 * unknown keys are ignored, so a v1 device tolerates a link written by a later
 * build instead of refusing it.
 *
 * THE COMMONS URL IS USUALLY RELATIVE
 * A commons is nearly always served beside the app that reads it, so `c=commons/`
 * is stored rather than the full absolute URL. That saves ~44 characters — real
 * money in a QR symbol — and makes the invite portable: the same printed code
 * works whether the app is reached at github.io, a LAN address, or a folder on
 * a USB stick, because the URL resolves against wherever the link was opened.
 *
 * WHAT AN INVITE MAY NOT DO
 * It may carry anchor keys. It may never apply them. See ANCHOR ASYMMETRY below.
 */

import { idToPubKey, fingerprintFromId } from './crypto/keys'
import { log } from './telemetry'

/** Bumped only if the meaning of an existing key changes — new keys need no bump. */
export const INVITE_VERSION = '1'

/**
 * ANCHOR ASYMMETRY — why one tap is right for a source and wrong for an anchor.
 *
 * A sync source is untrusted transport. A hostile one can decide what to show
 * you and nothing else: every op is checked against its author's signature on
 * arrival, so it cannot forge, edit, or attribute a single record. The worst it
 * achieves is selective silence, and adding a second source cures that.
 *
 * An anchor is an axiom. It is the thing trust is derived FROM, so a hostile
 * one does not bend a score here and there — it rewrites what the device
 * believes about everyone, including who counts as a Steward and whose flags
 * withhold a statement. There is no second anchor that cures a bad first one.
 *
 * Hence: a source may be added with one tap. An anchor may not be added by a
 * link at all — the link can only put it in front of a human with its
 * fingerprint attached, which is the same bar the manual path already enforces.
 */
export const MAX_INVITE_ANCHORS = 4

/** Guards against a hostile fragment being expanded into the DOM. */
const MAX_FRAGMENT_CHARS = 4096
const MAX_LABEL_CHARS = 60
const MAX_URL_CHARS = 512

export enum InviteReject {
  Malformed = 'MALFORMED',
  WrongVersion = 'WRONG_VERSION',
  NoCommons = 'NO_COMMONS',
  BadScheme = 'BAD_SCHEME',
  Insecure = 'INSECURE',
  TooLarge = 'TOO_LARGE',
}

export const INVITE_REJECT_MESSAGES: Record<InviteReject, string> = {
  [InviteReject.Malformed]: 'This is not a Lacinia invite link.',
  [InviteReject.WrongVersion]:
    'This invite was written by a newer version of Lacinia. Update the app, or ask for the commons address on its own.',
  [InviteReject.NoCommons]: 'This invite does not name a commons.',
  [InviteReject.BadScheme]: 'An invite may only point at a web address. This one does not.',
  [InviteReject.Insecure]:
    'This invite points at an unencrypted address from a secure page. Anyone on the network could rewrite what you receive.',
  [InviteReject.TooLarge]: 'This invite is far larger than a real one. Refusing to read it.',
}

export type InviteResult =
  | { ok: true; value: Invite }
  | { ok: false; reason: InviteReject; detail: string }

export interface InviteAnchor {
  pubKey: string
  /** The 12 characters a human can actually check against a poster. */
  fingerprint: string
}

export interface Invite {
  /** Absolute, resolved against the page the link was opened on. */
  commonsUrl: string
  /** Hostname alone, for the one line a reader must actually look at. */
  host: string
  /** Attacker-controlled text. Never present it as a verified fact. */
  label: string | undefined
  anchors: InviteAnchor[]
  /**
   * The commons lives on a different host than the invite link. Not forbidden —
   * hosting the app and the data separately is legitimate — but it is the shape
   * a lookalike-domain attack takes, so the UI says so out loud.
   */
  crossOrigin: boolean
}

export interface InviteDraft {
  commonsUrl: string
  label?: string | undefined
  anchors?: readonly string[] | undefined
}

function reject(reason: InviteReject, detail: string): InviteResult {
  log.warn('sync', 'invite rejected', { reason, detail })
  return { ok: false, reason, detail }
}

/**
 * Strips characters that can make rendered text lie.
 *
 * Bidirectional overrides are the reason this exists: a label ending in a
 * U+202E can visually reverse everything after it, so "commons" can be made to
 * render as a different hostname than the one actually stored. The label sits
 * next to a URL on the join screen, which is precisely where that matters.
 */
function sanitiseLabel(raw: string): string | undefined {
  const cleaned = raw
    // C0/C1 controls, then the bidi overrides and invisible formatting ranges.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g, '')
    .trim()
    .slice(0, MAX_LABEL_CHARS)
  return cleaned.length > 0 ? cleaned : undefined
}

/**
 * Path of `to` expressed relative to the directory `from`.
 *
 * `../commons/` rather than `/lacinia-collective/commons/`: the second one
 * hard-codes the deployment's subpath, so a link printed for GitHub Pages would
 * resolve to a 404 on a laptop serving the same app from the web root. It is
 * also ~30 characters longer, which is the difference between a QR that scans
 * on a cheap camera and one that does not.
 */
function relativePath(from: string, to: string): string {
  const fromParts = from.split('/').filter(Boolean)
  const toParts = to.split('/').filter(Boolean)

  let shared = 0
  while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
    shared++
  }

  const hops = Array<string>(fromParts.length - shared).fill('..')
  const rest = toParts.slice(shared)
  let out = [...hops, ...rest].join('/') || '.'

  // A first segment containing a colon would be read as a scheme by the URL
  // parser — "mail:archive/" is not a relative path to anyone but a human.
  if (!out.startsWith('.') && out.split('/')[0]!.includes(':')) out = `./${out}`
  if (to.endsWith('/') && !out.endsWith('/')) out += '/'
  return out
}

/**
 * Builds the fragment body — everything that goes after `#`.
 *
 * `joinUrl` is where the link will be opened, and is used only to decide
 * whether the commons can be stored as a relative path. Omit it and the URL is
 * written absolute, which always works and is merely longer.
 */
export function buildInviteFragment(draft: InviteDraft, joinUrl?: string): string {
  const params = new URLSearchParams()
  params.set('v', INVITE_VERSION)

  let commons = draft.commonsUrl.trim()
  if (joinUrl) {
    try {
      const abs = new URL(commons, joinUrl)
      const base = new URL(joinUrl)
      if (abs.origin === base.origin) {
        // Relative to the DIRECTORY the join page sits in, so the link keeps
        // working when the whole app moves to another host or subpath. An
        // absolute PATH would not: /lacinia-collective/commons/ is meaningless
        // on a laptop serving the app from the web root.
        commons = relativePath(base.pathname.replace(/[^/]*$/, ''), abs.pathname) + abs.search + abs.hash
      } else {
        commons = abs.toString()
      }
    } catch {
      /* unparseable — fall through and store what we were given */
    }
  }
  params.set('c', commons)

  const label = draft.label ? sanitiseLabel(draft.label) : undefined
  if (label) params.set('n', label)

  const anchors = dedupeAnchors(draft.anchors ?? [])
  if (anchors.length > 0) params.set('a', anchors.join(','))

  return params.toString()
}

/** The whole link, ready to paste into a message. */
export function buildInviteLink(draft: InviteDraft, joinUrl: string): string {
  return `${joinUrl}#${buildInviteFragment(draft, joinUrl)}`
}

function dedupeAnchors(keys: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of keys) {
    const key = raw.trim()
    if (!key || out.includes(key)) continue
    try {
      idToPubKey(key)
    } catch {
      continue // not a key; silently dropped rather than shipped as garbage
    }
    out.push(key)
    if (out.length >= MAX_INVITE_ANCHORS) break
  }
  return out
}

/**
 * Reads a link someone was sent. Never throws.
 *
 * `pageUrl` is the address the link was actually opened at — the resolution
 * base for a relative commons, and the reference for deciding whether an
 * unencrypted address is acceptable.
 */
export function parseInvite(link: string, pageUrl: string): InviteResult {
  if (link.length > MAX_FRAGMENT_CHARS) {
    return reject(InviteReject.TooLarge, `${link.length} chars`)
  }

  const hash = link.indexOf('#')
  const body = hash >= 0 ? link.slice(hash + 1) : link
  if (!body.trim()) return reject(InviteReject.Malformed, 'no fragment')

  const params = new URLSearchParams(body)

  const version = params.get('v')
  if (version === null) return reject(InviteReject.Malformed, 'no version')
  if (version !== INVITE_VERSION) return reject(InviteReject.WrongVersion, `v=${version}`)

  const rawCommons = params.get('c')?.trim()
  if (!rawCommons) return reject(InviteReject.NoCommons, 'c missing or empty')
  if (rawCommons.length > MAX_URL_CHARS) return reject(InviteReject.TooLarge, 'commons url')

  let commons: URL
  let base: URL
  try {
    base = new URL(pageUrl)
    commons = new URL(rawCommons, pageUrl)
  } catch (err) {
    return reject(InviteReject.Malformed, err instanceof Error ? err.message : String(err))
  }

  // Resolve FIRST, then judge the result. Checking the raw string instead would
  // miss `//evil.example/x`, which looks relative and resolves cross-origin.
  if (commons.protocol !== 'https:' && commons.protocol !== 'http:') {
    return reject(InviteReject.BadScheme, commons.protocol)
  }

  // An http commons is fine when the app itself is served over http — a laptop
  // on market wifi, a USB stick, `npm run dev`. It is not fine from an https
  // page, where it would silently downgrade a link anyone on the path can edit.
  if (commons.protocol === 'http:' && base.protocol === 'https:') {
    return reject(InviteReject.Insecure, commons.origin)
  }

  const anchors: InviteAnchor[] = []
  for (const key of dedupeAnchors((params.get('a') ?? '').split(','))) {
    anchors.push({ pubKey: key, fingerprint: fingerprintFromId(key) })
  }

  const rawLabel = params.get('n')
  const value: Invite = {
    commonsUrl: commons.toString(),
    host: commons.host,
    label: rawLabel ? sanitiseLabel(rawLabel) : undefined,
    anchors,
    crossOrigin: commons.origin !== base.origin,
  }

  log.info('sync', 'invite parsed', {
    host: value.host,
    anchors: anchors.length,
    crossOrigin: value.crossOrigin,
  })
  return { ok: true, value }
}

/**
 * A label for the source record when the invite carried none.
 *
 * The host is the honest fallback: it is the one part of an invite that cannot
 * be dressed up, so a commons that declined to name itself is listed under the
 * address it actually came from.
 */
export function inviteSourceLabel(invite: Invite): string {
  return invite.label ?? invite.host
}
