/**
 * Headless adversarial verification of invite links.
 *
 * An invite link is the one artefact in this system that is designed to be
 * forwarded by strangers into group chats. Every check below is therefore a
 * HOSTILE LINK or a field failure, and asserts the parser refuses it or
 * declaws it. The threat that matters most is an invite that quietly changes
 * what a device believes — see ANCHOR ASYMMETRY in src/lib/invite.ts.
 *
 *   npm run verify:invite
 */

import {
  buildInviteFragment,
  buildInviteLink,
  parseInvite,
  inviteSourceLabel,
  InviteReject,
  INVITE_REJECT_MESSAGES,
  INVITE_VERSION,
  MAX_INVITE_ANCHORS,
  type Invite,
} from '../src/lib/invite'
import { generateEphemeralKeyPair, fingerprintFromId } from '../src/lib/crypto/keys'
import { configureTelemetry } from '../src/lib/telemetry'

configureTelemetry({ mirrorToConsole: false })

/* ─────────────────────────── tiny harness ─────────────────────────── */

let passed = 0
let failed = 0
const failures: string[] = []

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ${GREEN}✓${RESET} ${name}${detail ? ` ${DIM}${detail}${RESET}` : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ${RED}✗ ${name}${RESET}${detail ? ` ${DIM}${detail}${RESET}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${BOLD}${title}${RESET}`)
}

/** The page an invite is opened at, in the shipped deployment. */
const JOIN = 'https://balogvn.github.io/lacinia-collective/join/'
const COMMONS = 'https://balogvn.github.io/lacinia-collective/commons/'

const anchorA = generateEphemeralKeyPair()
const anchorB = generateEphemeralKeyPair()
const anchorC = generateEphemeralKeyPair()

function ok(result: ReturnType<typeof parseInvite>): Invite | null {
  return result.ok ? result.value : null
}

/* ─────────────────── 1. the round trip ─────────────────── */

section('1. Round trip — what is shared is what arrives')
{
  const link = buildInviteLink(
    { commonsUrl: COMMONS, label: 'Ikorodu market', anchors: [anchorA.pubKeyId] },
    JOIN,
  )
  const parsed = ok(parseInvite(link, JOIN))

  check('an invite parses', !!parsed)
  check('the commons address survives', parsed?.commonsUrl === COMMONS, parsed?.commonsUrl)
  check('the label survives', parsed?.label === 'Ikorodu market')
  check('the anchor survives', parsed?.anchors[0]?.pubKey === anchorA.pubKeyId)
  check(
    'the fingerprint is derived, never carried',
    parsed?.anchors[0]?.fingerprint === fingerprintFromId(anchorA.pubKeyId),
    parsed?.anchors[0]?.fingerprint,
  )
  check('a same-origin commons is not flagged as cross-origin', parsed?.crossOrigin === false)
  check('the host is exposed for the reader', parsed?.host === 'balogvn.github.io')

  // The whole point of storing a relative path: the printed code has to keep
  // working when the commons moves hosts. This is the check that proves it.
  const onLan = ok(parseInvite(link, 'http://192.168.1.14:3000/join/'))
  check(
    'an invite printed for github.io still works when opened on a LAN host',
    onLan?.commonsUrl === 'http://192.168.1.14:3000/commons/',
    onLan?.commonsUrl,
  )

  check(
    'the fragment stores a path relative to the join page, not an absolute one',
    buildInviteFragment({ commonsUrl: COMMONS }, JOIN) === 'v=1&c=..%2Fcommons%2F',
    buildInviteFragment({ commonsUrl: COMMONS }, JOIN),
  )

  check(
    'building twice gives the same link',
    buildInviteFragment({ commonsUrl: COMMONS, label: 'x', anchors: [anchorA.pubKeyId] }, JOIN) ===
      buildInviteFragment({ commonsUrl: COMMONS, label: 'x', anchors: [anchorA.pubKeyId] }, JOIN),
  )
}

/* ─────────────────── 2. hostile schemes ─────────────────── */

section('2. Hostile schemes — an invite may only point at a web address')
{
  for (const scheme of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'blob:https://balogvn.github.io/abc',
    'ftp://example.com/commons/',
    'vbscript:msgbox(1)',
  ]) {
    const r = parseInvite(`#v=1&c=${encodeURIComponent(scheme)}`, JOIN)
    check(`${scheme.split(':')[0]}: is refused`, !r.ok && r.reason === InviteReject.BadScheme)
  }

  // Resolution has to happen BEFORE judgement. This string looks relative and
  // is not — a parser that pattern-matched the raw value would call it
  // same-origin and hand a stranger's host the trust of the inviter's page.
  const sneaky = ok(parseInvite('#v=1&c=%2F%2Fevil.example%2Fcommons%2F', JOIN))
  check('a protocol-relative URL is resolved, not treated as a path', sneaky?.host === 'evil.example')
  check('…and is flagged cross-origin', sneaky?.crossOrigin === true)

  // Traversal is not an attack here — the commons may legitimately sit above
  // the app — but it must resolve honestly rather than escape the origin.
  const up = ok(parseInvite('#v=1&c=..%2F..%2Fother%2F', JOIN))
  check('path traversal cannot leave the origin', up?.host === 'balogvn.github.io', up?.commonsUrl)
}

/* ─────────────────── 3. downgrade ─────────────────── */

section('3. Downgrade — https pages may not be pointed at plaintext')
{
  const bad = parseInvite('#v=1&c=http%3A%2F%2Fexample.com%2Fcommons%2F', JOIN)
  check(
    'an http commons from an https page is refused',
    !bad.ok && bad.reason === InviteReject.Insecure,
  )

  // …but the same link is fine on a laptop serving the app over http on market
  // wifi, or from a USB stick. Refusing this would break the offline case the
  // whole project exists for.
  const lanLink = buildInviteLink(
    { commonsUrl: 'http://192.168.1.14:3000/commons/' },
    'http://192.168.1.14:3000/join/',
  )
  const lan = ok(parseInvite(lanLink, 'http://192.168.1.14:3000/join/'))
  check('an http commons from an http page is allowed', lan?.commonsUrl === 'http://192.168.1.14:3000/commons/')

  const dev = ok(parseInvite('#v=1&c=..%2Fcommons%2F', 'http://localhost:3000/join/'))
  check('localhost over http still works', dev?.commonsUrl === 'http://localhost:3000/commons/')

  const upgrade = ok(parseInvite('#v=1&c=https%3A%2F%2Fexample.com%2Fc%2F', 'http://localhost:3000/join/'))
  check('an https commons from an http page is fine', upgrade?.host === 'example.com')
}

/* ─────────────────── 4. malformed and oversized ─────────────────── */

section('4. Malformed input — never throws, always explains')
{
  const noVersion = parseInvite('#c=commons%2F', JOIN)
  check('a link with no version is refused', !noVersion.ok && noVersion.reason === InviteReject.Malformed)

  const future = parseInvite('#v=9&c=commons%2F', JOIN)
  check('a future version is refused by name', !future.ok && future.reason === InviteReject.WrongVersion)
  check(
    '…and the message tells the user what to do',
    !future.ok && INVITE_REJECT_MESSAGES[future.reason].includes('Update the app'),
  )

  const noCommons = parseInvite('#v=1', JOIN)
  check('a link naming no commons is refused', !noCommons.ok && noCommons.reason === InviteReject.NoCommons)

  const emptyCommons = parseInvite('#v=1&c=%20%20', JOIN)
  check('a blank commons is refused', !emptyCommons.ok && emptyCommons.reason === InviteReject.NoCommons)

  const empty = parseInvite('#', JOIN)
  check('an empty fragment is refused', !empty.ok && empty.reason === InviteReject.Malformed)

  const huge = parseInvite(`#v=1&c=commons%2F&n=${'x'.repeat(5000)}`, JOIN)
  check('an absurdly large fragment is refused before parsing', !huge.ok && huge.reason === InviteReject.TooLarge)

  const longUrl = parseInvite(`#v=1&c=https%3A%2F%2Fe.com%2F${'a'.repeat(600)}`, JOIN)
  check('an absurdly long commons url is refused', !longUrl.ok && longUrl.reason === InviteReject.TooLarge)

  // Fuzz: whatever arrives, the join screen must render a message rather than
  // a stack trace. A link is opened by people who were sent it, not by us.
  let threw = false
  const alphabet = '#&=%?/\\:.avc19-_[]{}<>"\'‮ ü '
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < 3000; i++) {
    let s = ''
    for (let j = 0; j < Math.floor(rnd() * 60); j++) {
      s += alphabet[Math.floor(rnd() * alphabet.length)]
    }
    try {
      parseInvite(s, JOIN)
    } catch {
      threw = true
      console.log(`    threw on ${JSON.stringify(s)}`)
      break
    }
  }
  check('3,000 fuzzed links, none throws', !threw)

  let threwOnBase = false
  try {
    parseInvite('#v=1&c=commons/', 'not a url at all')
  } catch {
    threwOnBase = true
  }
  check('an unparseable page url does not throw either', !threwOnBase)
}

/* ─────────────────── 5. anchors ─────────────────── */

section('5. Anchors — carried, counted, never applied')
{
  const junk = ok(parseInvite('#v=1&c=commons%2F&a=not-a-key,,%20,????', JOIN))
  check('garbage anchor keys are dropped', junk?.anchors.length === 0)

  const dupLink = buildInviteFragment(
    { commonsUrl: COMMONS, anchors: [anchorA.pubKeyId, anchorA.pubKeyId, anchorB.pubKeyId] },
    JOIN,
  )
  const dup = ok(parseInvite(`#${dupLink}`, JOIN))
  check('duplicate anchors are collapsed', dup?.anchors.length === 2)

  const many = Array.from({ length: 12 }, () => generateEphemeralKeyPair().pubKeyId)
  const capped = ok(parseInvite(`#v=1&c=commons%2F&a=${many.join(',')}`, JOIN))
  check(
    `an invite cannot carry more than ${MAX_INVITE_ANCHORS} anchors`,
    capped?.anchors.length === MAX_INVITE_ANCHORS,
    `${capped?.anchors.length} kept of ${many.length}`,
  )

  const none = ok(parseInvite('#v=1&c=commons%2F', JOIN))
  check('no anchors means an empty list, not undefined', Array.isArray(none?.anchors) && none?.anchors.length === 0)

  // The property the whole design rests on: parsing an invite produces DATA.
  // There is no code path from here into setAnchors — the join screen has to
  // ask a human, holding the fingerprint up next to the question.
  const withAnchors = ok(parseInvite(`#v=1&c=commons%2F&a=${anchorC.pubKeyId}`, JOIN))
  check(
    'every carried anchor arrives with the fingerprint a human can check',
    withAnchors?.anchors.every((a) => /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(a.fingerprint)) === true,
    withAnchors?.anchors[0]?.fingerprint,
  )
}

/* ─────────────────── 6. the label lies ─────────────────── */

section('6. Labels — attacker-controlled text, treated as such')
{
  const bidi = ok(parseInvite(`#v=1&c=commons%2F&n=${encodeURIComponent('Ikorodu‮market')}`, JOIN))
  check('a bidi override is stripped from the label', bidi?.label === 'Ikorodumarket', bidi?.label)

  const zero = ok(parseInvite(`#v=1&c=commons%2F&n=${encodeURIComponent('good​evil')}`, JOIN))
  check('zero-width characters are stripped', zero?.label === 'goodevil')

  const ctrl = ok(parseInvite(`#v=1&c=commons%2F&n=${encodeURIComponent('one\ntwo ')}`, JOIN))
  check('control characters are stripped', ctrl?.label === 'onetwo', ctrl?.label)

  const long = ok(parseInvite(`#v=1&c=commons%2F&n=${'m'.repeat(300)}`, JOIN))
  check('an over-long label is truncated, not refused', long?.label?.length === 60)

  const blank = ok(parseInvite('#v=1&c=commons%2F&n=%20%20%20', JOIN))
  check('a whitespace-only label becomes no label', blank?.label === undefined)

  // Names contain ampersands and equals signs; a hand-rolled encoder would
  // split the fragment on them and lose half the link.
  const awkward = 'Ọ̀ṣun & Èkó = 1'
  const round = ok(parseInvite(`#${buildInviteFragment({ commonsUrl: COMMONS, label: awkward }, JOIN)}`, JOIN))
  check('a label with & and = survives intact', round?.label === awkward, round?.label)

  const unicode = 'Ìkọrọdù ᐧ 市場'
  const uni = ok(parseInvite(`#${buildInviteFragment({ commonsUrl: COMMONS, label: unicode }, JOIN)}`, JOIN))
  check('a non-ASCII label survives intact', uni?.label === unicode, uni?.label)

  check(
    'a commons that named itself is listed under that name',
    inviteSourceLabel({ commonsUrl: COMMONS, host: 'h', label: 'Ikorodu', anchors: [], crossOrigin: false }) ===
      'Ikorodu',
  )
  check(
    'a commons that did not is listed under its host, which cannot be dressed up',
    inviteSourceLabel({ commonsUrl: COMMONS, host: 'balogvn.github.io', label: undefined, anchors: [], crossOrigin: false }) ===
      'balogvn.github.io',
  )
}

/* ─────────────────── 7. living with the format ─────────────────── */

section('7. The format has to survive being on a poster')
{
  const forward = ok(parseInvite('#v=1&c=commons%2F&n=Market&zz=something-from-2027&a=', JOIN))
  check('unknown keys from a later build are ignored, not fatal', forward?.label === 'Market')

  check('the version is declared, so it can change', INVITE_VERSION === '1')

  // QR budget. Byte-mode capacity at ECC level M: v8 = 152 chars, and anything
  // past v12 stops scanning on the cheap cameras this is built for.
  const realistic = buildInviteLink(
    { commonsUrl: COMMONS, label: 'Ikorodu market', anchors: [anchorA.pubKeyId] },
    JOIN,
  )
  check(
    'a real invite with one anchor fits a QR that scans in bad light',
    realistic.length <= 152,
    `${realistic.length} chars, budget 152`,
  )

  const bare = buildInviteLink({ commonsUrl: COMMONS, label: 'Ikorodu market' }, JOIN)
  check('an invite with no anchor is comfortably smaller', bare.length <= 106, `${bare.length} chars`)

  // Absolute URLs are what the relative form saves us from; measured so the
  // saving is a number rather than a claim. No joinUrl means no relative form.
  const draft = { commonsUrl: COMMONS, label: 'Ikorodu market', anchors: [anchorA.pubKeyId] }
  const saved = buildInviteFragment(draft).length - buildInviteFragment(draft, JOIN).length
  check('storing the commons relative is what buys the QR budget', saved > 30, `saves ${saved} chars`)
}

/* ─────────────────────────── report ─────────────────────────── */

console.log(`\n${BOLD}${'─'.repeat(64)}${RESET}`)
if (failed === 0) {
  console.log(`${GREEN}${BOLD}  ${passed} checks passed.${RESET} Invite links hold.`)
} else {
  console.log(`${RED}${BOLD}  ${failed} failed${RESET}, ${passed} passed`)
  for (const f of failures) console.log(`   ${RED}·${RESET} ${f}`)
}
console.log(`${BOLD}${'─'.repeat(64)}${RESET}\n`)

process.exit(failed === 0 ? 0 : 1)
