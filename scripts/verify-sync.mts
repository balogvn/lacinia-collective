/**
 * Headless adversarial verification of the sync layer (Task 2).
 *
 * Same rules as verify-protocol.ts: every case is an attack, a convergence
 * property, or a field failure mode. If this passes, bundles can cross an
 * untrusted relay safely and devices converge regardless of delivery order.
 *
 *   npm run verify:sync
 */

import { canonicalize, CanonicalError, pruneUndefined } from '../src/lib/sync/canonical'
import {
  createSignedOp,
  verifySignedOp,
  OpRejectReason,
  type SignedOp,
} from '../src/lib/sync/ops'
import {
  createBundle,
  verifyBundleText,
  verifyBundle,
  serializeBundle,
  selectNewEntries,
  BundleError,
  MAX_OPS_PER_BUNDLE,
  type SyncBundle,
} from '../src/lib/sync/bundle'
import { mergeOps, InMemoryMergeStore } from '../src/lib/sync/merge'
import { planTransfer, FrameCollector, parseFrame } from '../src/lib/sync/frames'
import { pullFromSource, emptyPullState } from '../src/lib/sync/transport'
import {
  generateEphemeralKeyPair,
  contentId,
  type KeyPair,
} from '../src/lib/crypto/keys'
import { createVouchRequest, parseVouchRequest, issueVoucher } from '../src/lib/vouch/protocol'
import { TrustTier, VoucherStatus, type TrustVoucher, type UserIdentity } from '../src/lib/db/schema'
import { pickSelf, peersOf } from '../src/lib/db/self'
import { createClock, now as hlcNow } from '../src/lib/hlc'
import { configureTelemetry } from '../src/lib/telemetry'

configureTelemetry({ mirrorToConsole: false })

/* ─────────────────────────── harness ─────────────────────────── */

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

/* ─────────────────────────── fixtures ─────────────────────────── */

const clock = createClock('testnode')
const tick = (): string => hlcNow(clock)

const adaeze = generateEphemeralKeyPair()
const bilkisu = generateEphemeralKeyPair()
const mallory = generateEphemeralKeyPair()
const relay = generateEphemeralKeyPair()

function makeListing(author: KeyPair, id: string, title: string, hlc: string) {
  return {
    id,
    authorPub: author.pubKeyId,
    kind: 'OFFER',
    category: 'FOOD',
    title,
    description: 'A bag of rice, spare.',
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

/** A genuinely signed voucher, produced through the real Task 1 handshake. */
function realVoucher(issuer: KeyPair, subject: KeyPair, hlc: string): TrustVoucher {
  const request = createVouchRequest(subject, 'Subject')
  const parsed = parseVouchRequest(request.encoded.qr)
  if (!parsed.ok) throw new Error('fixture request failed to parse')
  const { voucher } = issueVoucher(issuer, parsed.value, TrustTier.Neighbour)
  return {
    ...voucher,
    status: VoucherStatus.Valid,
    receivedAt: Date.now(),
    direction: 'INBOUND',
    hlc,
  }
}

/* ─────────────────── 1. canonical JSON ─────────────────── */

section('1. Canonical JSON — the signing substrate')
{
  check(
    'key order is normalised',
    canonicalize({ b: 1, a: 2 }) === canonicalize({ a: 2, b: 1 }),
    canonicalize({ b: 1, a: 2 }),
  )
  check('nested objects normalise', canonicalize({ x: { z: 1, y: 2 } }) === '{"x":{"y":2,"z":1}}')
  check('array order is preserved', canonicalize([3, 1, 2]) === '[3,1,2]')
  check('unicode strings survive', canonicalize({ n: 'Ngọzi' }) === '{"n":"Ngọzi"}')
  check('null is allowed', canonicalize({ a: null }) === '{"a":null}')
  check('-0 normalises to 0', canonicalize({ a: -0 }) === '{"a":0}')

  // The guard rails — each of these would otherwise be a signature that
  // verifies on one device and fails on another.
  const throws = (fn: () => unknown): boolean => {
    try {
      fn()
      return false
    } catch (e) {
      return e instanceof CanonicalError
    }
  }
  check('float is refused', throws(() => canonicalize({ a: 0.1 })))
  check('NaN is refused', throws(() => canonicalize({ a: NaN })))
  check('Infinity is refused', throws(() => canonicalize({ a: Infinity })))
  check('present-but-undefined is refused', throws(() => canonicalize({ a: undefined })))
  check(
    'pruneUndefined makes optional fields safe',
    canonicalize(pruneUndefined({ a: 1, b: undefined })) === '{"a":1}',
  )
}

/* ─────────────────── 2. op authorization ─────────────────── */

section('2. Op authorization — who may write what')
{
  const listing = makeListing(adaeze, 'listing-1', 'Rice', tick())
  const op = createSignedOp(adaeze, {
    hlc: listing.hlc,
    entity: 'listing',
    entityId: listing.id,
    op: 'put',
    record: listing,
  })
  check('honest listing op verifies', verifySignedOp(op).ok)

  // ATTACK: Mallory signs a listing claiming Adaeze as author.
  const forged = createSignedOp(mallory, {
    hlc: tick(),
    entity: 'listing',
    entityId: 'listing-2',
    op: 'put',
    record: makeListing(adaeze, 'listing-2', 'Free rice (scam)', tick()),
  })
  const forgedVerdict = verifySignedOp(forged)
  check(
    'listing authored by someone else is rejected',
    !forgedVerdict.ok && forgedVerdict.reason === OpRejectReason.Unauthorized,
    !forgedVerdict.ok ? forgedVerdict.detail : 'ACCEPTED — CRITICAL',
  )

  // ATTACK: relabel a valid op onto a different entityId.
  const relabelled: SignedOp = { ...op, entityId: 'listing-999' }
  const relabelVerdict = verifySignedOp(relabelled)
  check(
    'relabelling entityId breaks the signature',
    !relabelVerdict.ok && relabelVerdict.reason === OpRejectReason.BadSignature,
    !relabelVerdict.ok ? relabelVerdict.reason : 'ACCEPTED — CRITICAL',
  )

  // ATTACK: move a valid body onto a different hlc to win a merge race.
  const restamped: SignedOp = { ...op, hlc: 'ffffffffffff0000-evil' }
  check(
    'restamping the HLC breaks the signature',
    !verifySignedOp(restamped).ok,
    'merge-race defence',
  )

  // ATTACK: tamper with the body, leaving id/sig intact.
  const tamperedBody: SignedOp = {
    ...op,
    body: op.body.replace('"timeCredits":30', '"timeCredits":1'),
  }
  check('editing the body breaks the signature', !verifySignedOp(tamperedBody).ok)

  // ATTACK: non-canonical body that parses to the same record.
  const noncanonical: SignedOp = { ...op, body: `{"z":1,${op.body.slice(1)}` }
  check('non-canonical body is rejected', !verifySignedOp(noncanonical).ok)

  // ATTACK: identity op renaming somebody else.
  const identityForge = createSignedOp(mallory, {
    hlc: tick(),
    entity: 'identity',
    entityId: adaeze.pubKeyId,
    op: 'put',
    record: { pubKey: adaeze.pubKeyId, displayName: 'Mallory', hlc: tick() },
  })
  const identityVerdict = verifySignedOp(identityForge)
  check(
    'renaming another identity is rejected',
    !identityVerdict.ok && identityVerdict.reason === OpRejectReason.Unauthorized,
    !identityVerdict.ok ? identityVerdict.detail : 'ACCEPTED — CRITICAL',
  )

  check(
    'unknown entity is rejected',
    !verifySignedOp({ ...op, entity: 'wallet' as never }).ok,
  )
}

/* ─────────────────── 3. voucher relay ─────────────────── */

section('3. Voucher relay — the deliberate asymmetry')
{
  const voucher = realVoucher(adaeze, bilkisu, tick())

  // A RELAY signs the op. This must be allowed, or vouches could never travel
  // beyond devices the issuer personally synced with.
  const relayed = createSignedOp(relay, {
    hlc: voucher.hlc,
    entity: 'voucher',
    entityId: voucher.id,
    op: 'put',
    record: voucher,
  })
  const verdict = verifySignedOp(relayed)
  check('a third party may relay someone else\'s voucher', verdict.ok, 'relay ≠ authority')

  // …but the voucher's OWN signature is still checked, so a forged voucher
  // cannot ride in inside a validly-signed relay op.
  const forgedVoucher: TrustVoucher = { ...voucher, tier: TrustTier.Anchor }
  const relayedForgery = createSignedOp(relay, {
    hlc: forgedVoucher.hlc,
    entity: 'voucher',
    entityId: forgedVoucher.id,
    op: 'put',
    record: forgedVoucher,
  })
  const forgeryVerdict = verifySignedOp(relayedForgery)
  check(
    'a forged voucher inside a valid relay op is caught',
    !forgeryVerdict.ok && forgeryVerdict.reason === OpRejectReason.InvalidVoucher,
    !forgeryVerdict.ok ? forgeryVerdict.reason : 'ACCEPTED — CRITICAL',
  )
}

/* ─────────────────── 4. bundles ─────────────────── */

section('4. Bundles — untrusted transport')

let goodBundle: SyncBundle
{
  const ops = [
    createSignedOp(adaeze, {
      hlc: tick(),
      entity: 'listing',
      entityId: 'L1',
      op: 'put',
      record: makeListing(adaeze, 'L1', 'Rice', tick()),
    }),
    createSignedOp(bilkisu, {
      hlc: tick(),
      entity: 'listing',
      entityId: 'L2',
      op: 'put',
      record: makeListing(bilkisu, 'L2', 'Tailoring, 1 hour', tick()),
    }),
  ]
  goodBundle = createBundle(relay, ops)
  const text = serializeBundle(goodBundle)

  const verified = verifyBundleText(text)
  check('honest bundle verifies', verified.accepted.length === 2, `${verified.bytes} bytes`)
  check('publisher signature validates', verified.publisherValid)

  // THE CENTRAL PROPERTY: a bad publisher signature must not invalidate ops
  // that are individually authentic. Otherwise a relay could censor by
  // corrupting its own signature, and gossip would be unsafe.
  /*
    Flip to a character the signature does not already start with.
    `replace(/^./, 'A')` looks like corruption and is a coin toss: the keypair
    is fresh every run, so roughly one run in 64 produced a signature already
    beginning with 'A', left the bytes untouched, and failed a check that was
    testing nothing. It cost a CI run to find, which is the cheap version of
    what a nondeterministic security check costs later.
  */
  const flipped = (goodBundle.sig[0] === 'A' ? 'B' : 'A') + goodBundle.sig.slice(1)
  const badPublisher = verifyBundle({ ...goodBundle, sig: flipped })
  check(
    'ops survive an invalid publisher signature',
    badPublisher.accepted.length === 2 && !badPublisher.publisherValid,
    'relay signature is provenance, not authority',
  )

  // ATTACK: a relay bundles a forged op alongside honest ones. Built through
  // createBundle so the bundle itself is well-formed — the point is that ONE
  // bad op must not discard the rest, not that the container is malformed.
  const poisoned: SyncBundle = createBundle(relay, [
    ...goodBundle.ops,
    createSignedOp(mallory, {
      hlc: tick(),
      entity: 'listing',
      entityId: 'L3',
      op: 'put',
      record: makeListing(adaeze, 'L3', 'Impersonated', tick()),
    }),
  ])
  const poisonResult = verifyBundle(poisoned)
  check(
    'one poisoned op does not discard the honest ones',
    poisonResult.accepted.length === 2 && poisonResult.rejected.length === 1,
    `${poisonResult.accepted.length} kept, ${poisonResult.rejected.length} rejected`,
  )

  // Policy hook.
  const filtered = verifyBundle(goodBundle, { accept: (op) => op.author === adaeze.pubKeyId })
  check('accept policy filters post-verification', filtered.accepted.length === 1)

  // Content-addressed: same ops → same id, regardless of when or by whom it was
  // published. This is what makes `seenBundleIds` actually prevent re-downloads.
  check('bundle id is deterministic across publishes', createBundle(relay, ops).id === goodBundle.id)
  check(
    'bundle id is identical across different publishers',
    createBundle(mallory, ops).id === goodBundle.id,
    'two relays carrying the same ops dedupe to one fetch',
  )

  // CENSORSHIP ATTACK: publish junk under a real bundle's id so devices record
  // it as seen and skip the genuine one forever.
  let censorshipCaught = false
  try {
    verifyBundle({ ...createBundle(mallory, [goodBundle.ops[0]!]), id: goodBundle.id })
  } catch (e) {
    censorshipCaught = e instanceof BundleError && e.kind === 'malformed'
  }
  check(
    'a bundle lying about its id is rejected',
    censorshipCaught,
    'stops seen-set poisoning / silent censorship',
  )
}

/* ─────────────────── 5. DoS caps ─────────────────── */

section('5. Denial of service — caps enforced before work')
{
  const threw = (fn: () => unknown, kind: string): boolean => {
    try {
      fn()
      return false
    } catch (e) {
      return e instanceof BundleError && e.kind === kind
    }
  }

  const huge = 'x'.repeat(3 * 1024 * 1024)
  check(
    'oversized bundle is refused before JSON.parse',
    threw(() => verifyBundleText(huge), 'too-large'),
    '3 MB rejected',
  )

  const manyOps = {
    ...goodBundle,
    ops: Array.from({ length: MAX_OPS_PER_BUNDLE + 1 }, () => goodBundle.ops[0]!),
  }
  check(
    'op-count cap is enforced before verification',
    threw(() => verifyBundle(manyOps), 'too-many-ops'),
    `> ${MAX_OPS_PER_BUNDLE} ops rejected`,
  )

  const budgeted = verifyBundle(goodBundle, { budget: 1 })
  check('verification budget is honoured', budgeted.accepted.length === 1)

  check(
    'wrong bundle version is refused',
    threw(() => verifyBundle({ ...goodBundle, v: 99 }), 'version'),
  )
  check(
    'non-JSON text is refused',
    threw(() => verifyBundleText('not json at all'), 'malformed'),
  )
}

/* ─────────────────── 6. merge convergence ─────────────────── */

section('6. Merge — convergence under any delivery order')
{
  const hlc1 = hlcNow(clock)
  const hlc2 = hlcNow(clock)
  const hlc3 = hlcNow(clock)

  const v1 = createSignedOp(adaeze, {
    hlc: hlc1,
    entity: 'listing',
    entityId: 'L9',
    op: 'put',
    record: makeListing(adaeze, 'L9', 'First title', hlc1),
  })
  const v2 = createSignedOp(adaeze, {
    hlc: hlc2,
    entity: 'listing',
    entityId: 'L9',
    op: 'put',
    record: makeListing(adaeze, 'L9', 'Second title', hlc2),
  })
  const v3 = createSignedOp(adaeze, {
    hlc: hlc3,
    entity: 'listing',
    entityId: 'L9',
    op: 'put',
    record: makeListing(adaeze, 'L9', 'Third title', hlc3),
  })

  const asRecords = (ops: SignedOp[]) =>
    ops.map((op) => ({ op, record: JSON.parse(op.body) as unknown }))

  const titleAfter = async (order: SignedOp[]): Promise<string> => {
    const store = new InMemoryMergeStore()
    await mergeOps(asRecords(order), store)
    const live = store.live<{ title: string }>('listing')
    return live[0]?.title ?? '<none>'
  }

  const forward = await titleAfter([v1, v2, v3])
  const reverse = await titleAfter([v3, v2, v1])
  const shuffled = await titleAfter([v2, v3, v1])

  check(
    'in-order delivery keeps the newest',
    forward === 'Third title',
    forward,
  )
  check('reverse delivery converges identically', reverse === forward, reverse)
  check('shuffled delivery converges identically', shuffled === forward, shuffled)

  // Idempotency.
  const store = new InMemoryMergeStore()
  const first = await mergeOps(asRecords([v1, v2, v3]), store)
  const second = await mergeOps(asRecords([v1, v2, v3]), store)
  check(
    're-merging the same ops is a no-op',
    second.applied === 0 && second.duplicates === 3,
    `applied ${first.applied} then ${second.applied}`,
  )

  // Tombstone races an edit by HLC, like any other write.
  const deleteEarly = createSignedOp(adaeze, {
    hlc: hlc2,
    entity: 'listing',
    entityId: 'L9',
    op: 'tombstone',
    record: { id: 'L9', authorPub: adaeze.pubKeyId },
  })
  const tombStore = new InMemoryMergeStore()
  await mergeOps(asRecords([deleteEarly, v3]), tombStore)
  check(
    'a later edit beats an earlier delete',
    tombStore.live<{ title: string }>('listing')[0]?.title === 'Third title',
    'tombstones are ordinary ops',
  )

  const tombStore2 = new InMemoryMergeStore()
  const deleteLate = createSignedOp(adaeze, {
    hlc: hlcNow(clock),
    entity: 'listing',
    entityId: 'L9',
    op: 'tombstone',
    record: { id: 'L9', authorPub: adaeze.pubKeyId },
  })
  await mergeOps(asRecords([v3, deleteLate]), tombStore2)
  check(
    'a later delete beats an earlier edit',
    tombStore2.live('listing').length === 0,
  )

  // A tombstone arriving before the record it deletes must not be resurrected
  // by the later-arriving put.
  const tombStore3 = new InMemoryMergeStore()
  await mergeOps(asRecords([deleteLate, v3]), tombStore3)
  check(
    'an out-of-order delete is not undone by a late put',
    tombStore3.live('listing').length === 0,
    'the classic resurrection bug',
  )

  const clockStore = new InMemoryMergeStore()
  await mergeOps(asRecords([v3]), clockStore)
  check('remote HLCs are observed into the local clock', clockStore.observed === hlc3)
}

/* ─────────────────── 7. multi-frame QR ─────────────────── */

section('7. Multi-frame QR — offline device-to-device')
{
  const payload = serializeBundle(goodBundle)
  const plan = await planTransfer(payload)

  check(
    'bundle splits into scannable frames',
    plan.frames.length > 1,
    `${plan.totalBytes} B → ${plan.compressedBytes} B → ${plan.frames.length} frames`,
  )
  check(
    'compression reduces the frame count',
    !plan.compressed || plan.compressedBytes < plan.totalBytes,
    plan.compressed
      ? `${((1 - plan.compressedBytes / plan.totalBytes) * 100).toFixed(0)}% smaller`
      : 'CompressionStream unavailable',
  )
  check(
    'every frame stays inside QR range',
    plan.frames.every((f) => f.length < 270),
    `longest ${Math.max(...plan.frames.map((f) => f.length))} chars`,
  )
  check('frames are self-identifying', parseFrame(plan.frames[0]!)?.header.total === plan.frames.length)

  // In-order assembly.
  const inOrder = new FrameCollector()
  let assembled: string | null = null
  for (const frame of plan.frames) {
    const result = await inOrder.accept(frame)
    if (result.done) assembled = result.payload
  }
  check('in-order scan reassembles exactly', assembled === payload)

  // Out-of-order — the realistic case, since the sender loops and the receiver
  // joins partway through.
  const shuffled = [...plan.frames.slice(3), ...plan.frames.slice(0, 3)]
  const outOfOrder = new FrameCollector()
  let assembled2: string | null = null
  for (const frame of shuffled) {
    const result = await outOfOrder.accept(frame)
    if (result.done) assembled2 = result.payload
  }
  check('out-of-order scan reassembles exactly', assembled2 === payload, 'receiver may join mid-loop')

  // Duplicates are the norm at 8fps against a looping animation.
  const withDupes = new FrameCollector()
  let assembled3: string | null = null
  for (const frame of [...plan.frames, ...plan.frames]) {
    const result = await withDupes.accept(frame)
    if (result.done && !assembled3) assembled3 = result.payload
  }
  check('repeated frames are harmless', assembled3 === payload)

  // Mixing two transfers must reset rather than assemble garbage.
  const otherPlan = await planTransfer(payload + ' ')
  const mixer = new FrameCollector()
  await mixer.accept(plan.frames[0]!)
  await mixer.accept(otherPlan.frames[0]!)
  check(
    'frames from a different transfer reset the buffer',
    mixer.progress.transferId === otherPlan.transferId,
    'two people showing codes nearby',
  )

  check('garbage input is ignored', parseFrame('hello') === null)
  const partial = new FrameCollector()
  await partial.accept(plan.frames[0]!)
  check(
    'incomplete transfer reports what is missing',
    partial.missing.length === plan.frames.length - 1,
    `${partial.progress.received}/${partial.progress.total}`,
  )
}

/* ─────────────────── 8. transport ─────────────────── */

section('8. Transport — cursors, 304s and failure')
{
  const bundleText = serializeBundle(goodBundle)
  const manifest = {
    v: 1,
    updatedAt: Date.now(),
    entries: [
      {
        path: 'b1.json',
        id: goodBundle.id,
        hlcMax: goodBundle.hlcMax,
        opCount: goodBundle.opCount,
        bytes: bundleText.length,
      },
    ],
  }

  let manifestHits = 0
  let bundleHits = 0
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('manifest.json')) {
      manifestHits++
      const inm = (init?.headers as Record<string, string> | undefined)?.['If-None-Match']
      if (inm === '"v1"') {
        return new Response(null, { status: 304 })
      }
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { etag: '"v1"' },
      })
    }
    bundleHits++
    return new Response(bundleText, { status: 200 })
  }) as typeof fetch

  const source = { url: 'https://example.test/commons/', label: 'Test commons' }
  const first = await pullFromSource(source, emptyPullState(), { fetchImpl: fakeFetch })
  check('first pull fetches the bundle', first.fetched === 1, `${first.bytesDownloaded} bytes`)
  check('cursor advances', first.nextState.cursorHlc === goodBundle.hlcMax)
  check('bundle id is remembered', first.nextState.seenBundleIds.includes(goodBundle.id))

  const second = await pullFromSource(source, first.nextState, { fetchImpl: fakeFetch })
  check(
    'unchanged manifest costs one 304 and no bundle fetch',
    second.fetched === 0 && bundleHits === 1,
    `${manifestHits} manifest requests, ${bundleHits} bundle request`,
  )

  const offlineFetch = (async () => {
    throw new TypeError('Failed to fetch')
  }) as typeof fetch
  const offline = await pullFromSource(source, emptyPullState(), { fetchImpl: offlineFetch })
  check(
    'network failure is reported, never thrown',
    offline.errors.length === 1 && offline.fetched === 0,
    'being offline is normal, not an error',
  )

  // Reported from the field: someone pasted the address they open the app at
  // instead of the commons address. The two differ by one path segment, so the
  // fetch lands on <app>/manifest.json and 404s. A bare status code sent them
  // to check their network, which was the one thing working.
  const notFound = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
  const missing = await pullFromSource(source, emptyPullState(), { fetchImpl: notFound })
  check('a 404 manifest is reported, not thrown', missing.errors.length === 1 && missing.fetched === 0)
  check(
    'a 404 says what to do about it, not just its number',
    /commons/i.test(missing.errors[0]!) && !/HTTP 404/.test(missing.errors[0]!),
    missing.errors[0]?.slice(0, 72),
  )

  // A URL with no trailing slash still resolves, so the message never blames
  // the wrong thing: `.../commons` and `.../commons/` behave identically.
  let asked = ''
  const recordUrl = (async (u: string) => {
    asked = String(u)
    return new Response('{"v":1,"updatedAt":0,"entries":[]}', { status: 200 })
  }) as unknown as typeof fetch
  await pullFromSource({ url: 'https://h.example/a/commons', label: 'no slash' }, emptyPullState(), {
    fetchImpl: recordUrl,
  })
  check(
    'a missing trailing slash is not the problem — it is normalised',
    asked === 'https://h.example/a/commons/manifest.json',
    asked,
  )

  const badManifest = (async () => new Response('{{{', { status: 200 })) as unknown as typeof fetch
  const malformed = await pullFromSource(source, emptyPullState(), { fetchImpl: badManifest })
  check('malformed manifest is handled', malformed.errors.length === 1)

  check(
    'entries at or below the cursor are skipped',
    selectNewEntries(manifest, goodBundle.hlcMax, new Set()).length === 0,
  )
  check(
    'already-seen bundles are skipped even if newer',
    selectNewEntries(manifest, null, new Set([goodBundle.id])).length === 0,
  )
}

/* ─────────────────── 8b. local facts inside synced records ─────────────────── */

section('8b. Local facts must not be read from synced records')
{
  // `isSelf` means "this row is my device's owner", but it sits inside the
  // signed record and so travels. After a sync a device holds several rows all
  // asserting isSelf:true about themselves.
  const me = generateEphemeralKeyPair()
  const founder = generateEphemeralKeyPair()

  const row = (k: KeyPair, name: string): UserIdentity => ({
    pubKey: k.pubKeyId,
    fingerprint: 'XXXX-XXXX-XXXX',
    displayName: name,
    isSelf: true, // as published — every identity claims this about itself
    deviceId: 'd',
    createdAt: 1,
    hlc: '0',
  })

  // Dexie returns rows in primary-key order, and base64url sorts lowercase
  // last — so a founder key can genuinely precede a user's own.
  const asStored = [row(founder, 'Founder'), row(me, 'Me')].sort((a, b) =>
    a.pubKey < b.pubKey ? -1 : 1,
  )

  const naive = asStored.find((i) => i.isSelf && !i.deleted)
  const resolved = pickSelf(asStored, me.pubKeyId)

  check(
    'the naive isSelf lookup can return the WRONG identity',
    naive!.pubKey !== me.pubKeyId || asStored[0]!.pubKey === me.pubKeyId,
    naive!.pubKey === me.pubKeyId ? 'ordering favoured us this time' : 'it returned the founder',
  )
  check(
    'resolving from the vault key always returns this device',
    resolved?.pubKey === me.pubKeyId && resolved?.displayName === 'Me',
  )
  check(
    'a synced row claiming isSelf never shadows the vault key',
    pickSelf(asStored, me.pubKeyId)?.pubKey === me.pubKeyId,
  )
  check(
    'peers exclude this device and include everyone else',
    peersOf(asStored, me.pubKeyId).length === 1 &&
      peersOf(asStored, me.pubKeyId)[0]!.pubKey === founder.pubKeyId,
  )
  check('with no vault there is no self', pickSelf(asStored, null) === undefined)
}

/* ─────────────────── 9. data cost ─────────────────── */

section('9. Data cost — the whole point of the architecture')
{
  const ops: SignedOp[] = []
  for (let i = 0; i < 50; i++) {
    ops.push(
      createSignedOp(adaeze, {
        hlc: hlcNow(clock),
        entity: 'listing',
        entityId: `bulk-${i}`,
        op: 'put',
        record: makeListing(adaeze, `bulk-${i}`, `Offer ${i}`, hlcNow(clock)),
      }),
    )
  }
  const bulk = createBundle(adaeze, ops)
  const json = serializeBundle(bulk)
  const raw = new TextEncoder().encode(json).length

  const gz = await new Response(
    new Blob([json]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer()

  const perOpRaw = Math.round(raw / 50)
  const perOpGz = Math.round(gz.byteLength / 50)

  check(
    '50 listings fit in a small payload',
    gz.byteLength < 20 * 1024,
    `${(raw / 1024).toFixed(1)} KB raw → ${(gz.byteLength / 1024).toFixed(1)} KB gzipped`,
  )
  check(
    'per-op wire cost stays modest',
    perOpGz < 400,
    `${perOpRaw} B raw → ${perOpGz} B gzipped per listing`,
  )
  check('gzip roughly halves the payload', gz.byteLength < raw * 0.6)
}

/* ─────────────────────────── report ─────────────────────────── */

console.log(`\n${BOLD}${'─'.repeat(64)}${RESET}`)
if (failed === 0) {
  console.log(`${GREEN}${BOLD}  ${passed} checks passed.${RESET} Sync layer holds.`)
} else {
  console.log(`${RED}${BOLD}  ${failed} failed${RESET}, ${passed} passed`)
  for (const f of failures) console.log(`   ${RED}·${RESET} ${f}`)
}
console.log(`${BOLD}${'─'.repeat(64)}${RESET}\n`)

process.exit(failed === 0 ? 0 : 1)
