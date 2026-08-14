/**
 * Cross-implementation verification: TypeScript app ⇄ plain-JS CI aggregator.
 *
 * WHY THIS EXISTS
 * scripts/aggregate-bundles.mjs reimplements canonicalization, base64url and
 * signature verification in dependency-free Node, so the compute layer can be
 * read and reimplemented (in Python, say) by someone who has never opened the
 * Next.js toolchain. That duplication is deliberate — and it is exactly the
 * kind of duplication that silently drifts.
 *
 * If the two canonicalizers ever disagree by a single byte, snapshots published
 * by CI stop verifying on every device in the network, and the failure appears
 * as "sync mysteriously stopped working" weeks later. This test runs the real
 * aggregator as a subprocess against real signed ops and re-verifies its output
 * with the app's own verifier.
 *
 *   npm run verify:aggregator
 */

import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { createSignedOp, verifySignedOp, type SignedOp } from '../src/lib/sync/ops'
import { createBundle, verifyBundle } from '../src/lib/sync/bundle'
import { canonicalize } from '../src/lib/sync/canonical'
import { generateEphemeralKeyPair } from '../src/lib/crypto/keys'
import { createClock, now as hlcNow } from '../src/lib/hlc'
import { TrustTier } from '../src/lib/db/schema'
import { configureTelemetry } from '../src/lib/telemetry'

configureTelemetry({ mirrorToConsole: false })

let passed = 0
let failed = 0
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
    console.log(`  ${RED}✗ ${name}${RESET}${detail ? ` ${DIM}${detail}${RESET}` : ''}`)
  }
}

const ROOT = process.cwd()
const INBOX = join(ROOT, 'commons', 'inbox')
const OUT = join(ROOT, 'public', 'commons')
const MANIFEST = join(OUT, 'manifest.json')

/** Snapshot filenames are content-addressed; the manifest is the only index. */
async function snapshotPath(): Promise<string | null> {
  if (!existsSync(MANIFEST)) return null
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const rel = manifest.entries?.[0]?.path
  if (!rel) return null
  const full = join(OUT, rel)
  return existsSync(full) ? full : null
}

const clock = createClock('aggtest')
const author = generateEphemeralKeyPair()
const other = generateEphemeralKeyPair()
const mallory = generateEphemeralKeyPair()

function listing(id: string, title: string, hlc: string, owner = author) {
  return {
    id,
    authorPub: owner.pubKeyId,
    kind: 'OFFER',
    category: 'FOOD',
    title,
    description: 'Shared from the market.',
    timeCredits: 30,
    quantity: 1,
    locality: { state: 'Lagos', lga: 'Ikorodu' },
    minTrustTier: TrustTier.Observer,
    status: 'OPEN',
    createdAt: 1_700_000_000_000,
    expiresAt: 1_900_000_000_000,
    hlc,
  }
}

function op(id: string, title: string, owner = author, signer = owner): SignedOp {
  const hlc = hlcNow(clock)
  return createSignedOp(signer, {
    hlc,
    entity: 'listing',
    entityId: id,
    op: 'put',
    record: listing(id, title, hlc, owner),
  })
}

console.log(`\n${BOLD}Cross-implementation: TypeScript app ⇄ plain-JS aggregator${RESET}`)

// Preserve anything already on disk so running the suite is non-destructive.
const priorPath = await snapshotPath()
const savedSnapshot = priorPath ? await readFile(priorPath, 'utf8') : null
const savedManifest = existsSync(MANIFEST) ? await readFile(MANIFEST, 'utf8') : null

await mkdir(INBOX, { recursive: true })
await mkdir(OUT, { recursive: true })
if (priorPath) await rm(priorPath)
if (existsSync(MANIFEST)) await rm(MANIFEST)

/* ── build two bundles, one carrying a forgery and a superseded edit ── */

const first = op('agg-1', 'Rice, 2kg')
const second = op('agg-2', 'Tailoring, 1 hour', other)
const supersededHlc = hlcNow(clock)
const superseded = createSignedOp(author, {
  hlc: supersededHlc,
  entity: 'listing',
  entityId: 'agg-1',
  op: 'put',
  record: listing('agg-1', 'Rice, 2kg — SUPERSEDED TITLE', supersededHlc),
})
// Mallory signs a listing that claims `author` as its owner.
const forged = op('agg-3', 'Impersonated offer', author, mallory)

const bundleA = createBundle(author, [first, second])
const bundleB = createBundle(other, [superseded, forged])

await writeFile(join(INBOX, 'test-a.json'), JSON.stringify(bundleA))
await writeFile(join(INBOX, 'test-b.json'), JSON.stringify(bundleB))

/* ── run the real aggregator as a subprocess ── */

let stdout = ''
try {
  stdout = execFileSync('node', ['scripts/aggregate-bundles.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
} catch (err) {
  console.error(String(err))
}

check('aggregator runs without error', stdout.includes('lacinia aggregate'), stdout.trim().split('\n')[0])
check('aggregator rejected the forged op', stdout.includes('only the owner may write a listing'))

const producedPath = (await snapshotPath())!
const snapshotText = await readFile(producedPath, 'utf8')
const snapshot = JSON.parse(snapshotText)

check(
  'snapshot filename is content-addressed',
  /snapshot-[0-9a-f]{16}\.json$/.test(producedPath),
  producedPath.split('/').pop() ?? '',
)

check(
  'snapshot holds one op per entity (compaction)',
  snapshot.opCount === 2,
  `${snapshot.opCount} ops from ${bundleA.opCount + bundleB.opCount} submitted`,
)

const titles = (snapshot.ops as SignedOp[])
  .map((o) => (JSON.parse(o.body) as { title: string }).title)
  .sort()
check(
  'compaction kept the newest edit, discarded the older',
  titles.includes('Rice, 2kg — SUPERSEDED TITLE') && !titles.includes('Rice, 2kg'),
  titles.join(' | '),
)
check('forged op is absent from the snapshot', !titles.includes('Impersonated offer'))

/* ── THE POINT: every CI-published op must verify with the app's verifier ── */

const verdicts = (snapshot.ops as SignedOp[]).map((o) => verifySignedOp(o))
check(
  'every op in the CI snapshot verifies with the app verifier',
  verdicts.every((v) => v.ok),
  verdicts.find((v) => !v.ok)?.ok === false
    ? (verdicts.find((v) => !v.ok) as { detail: string }).detail
    : `${verdicts.length}/${verdicts.length} ops`,
)

check(
  'aggregator canonicalization matches the app byte-for-byte',
  (snapshot.ops as SignedOp[]).every((o) => canonicalize(JSON.parse(o.body)) === o.body),
  'no drift between the two implementations',
)

check(
  'aggregator computes the same bundle content id as the app',
  snapshot.id === createBundle(author, snapshot.ops as SignedOp[]).id,
  snapshot.id.slice(0, 16),
)

/* ── the snapshot must be consumable as an ordinary bundle ── */

const asBundle = verifyBundle(snapshot)
check(
  'snapshot verifies as a normal bundle',
  asBundle.accepted.length === snapshot.opCount,
  `${asBundle.accepted.length} accepted, publisher unsigned by design`,
)
check(
  'unsigned CI publisher does not block acceptance',
  !asBundle.publisherValid && asBundle.accepted.length > 0,
  'relay signature is provenance, not authority',
)

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
check(
  'manifest points at the content-addressed snapshot',
  manifest.entries?.[0]?.path === producedPath.split('/').pop(),
  manifest.entries?.[0]?.path,
)
check('manifest id matches the snapshot', manifest.entries?.[0]?.id === snapshot.id)
check(
  'manifest records a byte size for cost display',
  typeof manifest.entries?.[0]?.bytes === 'number' && manifest.entries[0].bytes > 0,
  `${(manifest.entries[0].bytes / 1024).toFixed(1)} KB`,
)

/* ── carry-forward: a second run must not lose state ── */

const before = snapshot.opCount
execFileSync('node', ['scripts/aggregate-bundles.mjs'], { cwd: ROOT, encoding: 'utf8' })
const afterPath = (await snapshotPath())!
const after = JSON.parse(await readFile(afterPath, 'utf8'))
check(
  'an unchanged commons keeps the same content-addressed filename',
  afterPath === producedPath,
  'so caches stay valid',
)
check(
  'a run with an empty inbox preserves the snapshot',
  after.opCount === before,
  `${before} ops carried forward`,
)

/* ── restore ── */

await rm(join(INBOX, 'test-a.json'), { force: true })
await rm(join(INBOX, 'test-b.json'), { force: true })
for (const file of (await readdir(OUT)).filter((f) => /^snapshot-[0-9a-f]+\.json$/.test(f))) {
  await rm(join(OUT, file), { force: true })
}
if (savedSnapshot !== null && priorPath !== null) await writeFile(priorPath, savedSnapshot)
if (savedManifest !== null) await writeFile(MANIFEST, savedManifest)
else await rm(MANIFEST, { force: true })

console.log(`\n${BOLD}${'─'.repeat(64)}${RESET}`)
if (failed === 0) {
  console.log(`${GREEN}${BOLD}  ${passed} checks passed.${RESET} Aggregator agrees with the app.`)
} else {
  console.log(`${RED}${BOLD}  ${failed} failed${RESET}, ${passed} passed`)
}
console.log(`${BOLD}${'─'.repeat(64)}${RESET}\n`)

process.exit(failed === 0 ? 0 : 1)
