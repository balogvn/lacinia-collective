/**
 * Headless verification of the first-run assessment.
 *
 * The failure this guards against is not a crash — it is the app telling a user
 * something untrue about their own device. Saying "you are rooted" to someone
 * whose root has vouched for nobody, or "nothing here yet" to someone holding a
 * whole commons, is worse than saying nothing, because the user acts on it.
 *
 *   npm run verify:firstrun
 */

import {
  FirstRun,
  assessDevice,
  promptFor,
  rootHasVouched,
  coHostedCommonsUrl,
  isCommonsManifest,
  type DeviceFacts,
} from '../src/lib/firstRun'
import { VoucherStatus, TrustTier, type TrustVoucher } from '../src/lib/db/schema'
import { configureTelemetry } from '../src/lib/telemetry'

configureTelemetry({ mirrorToConsole: false })

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

const base: DeviceFacts = {
  hasIdentity: false,
  sourceCount: 0,
  anchorCount: 0,
  recordCount: 0,
  rootHasVouched: false,
}
const facts = (over: Partial<DeviceFacts>): DeviceFacts => ({ ...base, ...over })

function voucher(issuerPub: string, status = VoucherStatus.Valid): TrustVoucher {
  return {
    id: `v-${issuerPub}-${status}`,
    issuerPub,
    subjectPub: 'someone-else',
    tier: TrustTier.Neighbour,
    nonce: 'n',
    issuedAt: 0,
    expiresAt: 0,
    signature: 's',
    signedBytes: 'b',
    status,
    receivedAt: 0,
    direction: 'INBOUND',
    hlc: '0',
  } as unknown as TrustVoucher
}

/* ─────────────────── 1. the states ─────────────────── */

section('1. Device states — what is actually true of this phone')
{
  check('a brand new device has nothing to read', assessDevice(base) === FirstRun.Empty)

  check(
    'a device holding records is not "empty", even with no source recorded',
    assessDevice(facts({ recordCount: 190 })) === FirstRun.Reading,
  )

  // The distinction that keeps the panel honest after a failed first sync: a
  // source was added, so the user HAS acted, and telling them "nothing here
  // yet" again would read as their tap having done nothing.
  check(
    'a source with nothing fetched yet is past Empty',
    assessDevice(facts({ sourceCount: 1 })) === FirstRun.Reading,
  )

  check(
    'reading without a key is a resting state, not an error',
    assessDevice(facts({ recordCount: 190, hasIdentity: false })) === FirstRun.Reading,
  )

  check(
    'a key with no anchor is Unrooted',
    assessDevice(facts({ recordCount: 190, hasIdentity: true })) === FirstRun.Unrooted,
  )

  // The state the deployed commons actually produces today.
  check(
    'an anchor that has vouched for nobody is called out, not treated as ready',
    assessDevice(facts({ recordCount: 190, hasIdentity: true, anchorCount: 1 })) ===
      FirstRun.InertRoot,
  )

  check(
    'a rooted device with a live root prompts nothing',
    assessDevice(
      facts({ recordCount: 190, hasIdentity: true, anchorCount: 1, rootHasVouched: true }),
    ) === FirstRun.Ready,
  )

  check('the ready state has no prompt to show', promptFor(FirstRun.Ready) === null)
}

/* ─────────────────── 2. what it says ─────────────────── */

section('2. Copy — one action each, and never a promise it cannot keep')
{
  const states = [FirstRun.Empty, FirstRun.Reading, FirstRun.Unrooted, FirstRun.InertRoot]
  for (const s of states) {
    const p = promptFor(s)!
    check(`${s} has a headline and a body`, p.headline.length > 0 && p.body.length > 40)
    check(`${s} offers exactly one primary action`, p.action !== null)
  }

  // Only the Empty state may add anything to the device. Every other prompt is
  // a signpost — if one of these ever grew an "add" action it would be adding
  // something on behalf of a user who was not asked.
  const adders = states.filter((s) => promptFor(s)!.action?.kind === 'add-commons')
  check('only the empty state can add anything', adders.length === 1 && adders[0] === FirstRun.Empty)

  const unrooted = promptFor(FirstRun.Unrooted)!
  check(
    'the unrooted prompt sends the user to a person, not to a link',
    /person|poster/i.test(unrooted.body) && !/we recommend|trust ours|our anchor/i.test(unrooted.body),
  )
  check(
    'the unrooted prompt names no key and no fingerprint',
    !/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/.test(unrooted.body + unrooted.headline),
  )

  const inert = promptFor(FirstRun.InertRoot)!
  check(
    'the inert-root prompt says plainly that the score is still zero',
    /zero/i.test(inert.body),
  )
  check(
    "…and does not blame the user's setup",
    /not a fault/i.test(inert.body),
  )

  const reading = promptFor(FirstRun.Reading)!
  check(
    'the reading prompt states that reading needs no key',
    /reading needs nothing/i.test(reading.body),
  )
}

/* ─────────────────── 3. is the root actually doing anything ─────────────────── */

section('3. Root liveness — the check the deployed commons currently fails')
{
  check('no anchors means no live root', !rootHasVouched([], [voucher('a')]))
  check('an anchor with no vouchers is not live', !rootHasVouched(['a'], []))
  check('an anchor that vouched for someone is live', rootHasVouched(['a'], [voucher('a')]))
  check(
    "someone else's vouches do not make your root live",
    !rootHasVouched(['a'], [voucher('b')]),
  )
  check(
    'a revoked vouch does not count',
    !rootHasVouched(['a'], [voucher('a', VoucherStatus.Revoked)]),
  )
  check(
    'an expired vouch does not count',
    !rootHasVouched(['a'], [voucher('a', VoucherStatus.Expired)]),
  )
  check(
    'a signature-failed vouch never counts',
    !rootHasVouched(['a'], [voucher('a', VoucherStatus.Invalid)]),
  )
}

/* ─────────────────── 4. finding the co-hosted commons ─────────────────── */

section('4. Discovery — derived from where the app is, never compiled in')
{
  check(
    'a root deployment resolves its own commons',
    coHostedCommonsUrl('https://example.org/aid/') === 'https://example.org/commons/',
  )
  check(
    'a subpath deployment resolves under its base path',
    coHostedCommonsUrl('https://balogvn.github.io/lacinia-collective/aid/', '/lacinia-collective') ===
      'https://balogvn.github.io/lacinia-collective/commons/',
  )
  check(
    'a fork on another host resolves ITS commons, not the author’s',
    coHostedCommonsUrl('https://someone-else.example/app/aid/', '/app') ===
      'https://someone-else.example/app/commons/',
  )
  check(
    'the fragment and query of the current page are discarded',
    coHostedCommonsUrl('https://example.org/join/?x=1#v=1&c=..') === 'https://example.org/commons/',
  )
  check('an unparseable page url yields nothing', coHostedCommonsUrl('not a url') === null)

  // A static host answers a missing path with the app shell and a 200, so
  // `response.ok` proves nothing. Adding a source on that basis would give the
  // user a commons that can never yield a record.
  check('an HTML page is not a manifest', !isCommonsManifest('<!doctype html><html></html>'))
  check('null is not a manifest', !isCommonsManifest(null))
  check('an empty object is not a manifest', !isCommonsManifest({}))
  check('a manifest missing entries is refused', !isCommonsManifest({ v: 1 }))
  check('a manifest with a string version is refused', !isCommonsManifest({ v: '1', entries: [] }))
  check('a real, empty manifest is accepted', isCommonsManifest({ v: 1, entries: [] }))
  check(
    'a real, populated manifest is accepted',
    isCommonsManifest({ v: 1, updatedAt: 0, entries: [{ id: 'x' }] }),
  )
}

/* ─────────────────────────── report ─────────────────────────── */

console.log(`\n${BOLD}${'─'.repeat(64)}${RESET}`)
if (failed === 0) {
  console.log(`${GREEN}${BOLD}  ${passed} checks passed.${RESET} First run tells the truth.`)
} else {
  console.log(`${RED}${BOLD}  ${failed} failed${RESET}, ${passed} passed`)
  for (const f of failures) console.log(`   ${RED}·${RESET} ${f}`)
}
console.log(`${BOLD}${'─'.repeat(64)}${RESET}\n`)

process.exit(failed === 0 ? 0 : 1)
