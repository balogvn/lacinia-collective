/**
 * Sync bundles — a batch of signed ops, published as a static JSON file.
 *
 * WHY JSON AND NOT THE BINARY CODEC
 * QR payloads use a packed binary format because every byte costs scan
 * reliability. A bundle has the opposite constraints: it is fetched over HTTP
 * where the CDN applies gzip for free, and it must be readable by a CI job that
 * may be written in Python by someone who has never seen this codebase. JSON is
 * the correct container here; the compression happens at the transport layer.
 *
 * THE PUBLISHER SIGNATURE MEANS ONE THING ONLY
 * "I relayed these bytes." It is NOT an attestation that the ops are true, and
 * nothing downstream may treat it as one. Op authorship is verified per-op in
 * ops.ts. Consequently any device can rebroadcast any bundle it received —
 * gossip is safe by construction, and a compromised relay can censor but never
 * forge.
 *
 * DENIAL OF SERVICE IS A REAL THREAT HERE, unlike anywhere in Task 1.
 * Ed25519 verification costs ~1ms. A 100,000-op bundle is a 100-second frozen
 * main thread on a low-end phone — a denial of service delivered as a
 * legitimate-looking file from a URL the user trusts. The caps below are
 * enforced BEFORE parsing and BEFORE any signature work, and they are not
 * advisory.
 */

import { canonicalize, canonicalBytes } from './canonical'
import { toBase64Url, fromBase64Url } from '../codec'
import { contentId, sign, verify, idToPubKey, type KeyPair } from '../crypto/keys'
import { verifySignedOp, type SignedOp, type OpVerdict } from './ops'
import { compareHLC } from '../hlc'
import { log } from '../telemetry'

export const BUNDLE_VERSION = 1

/** Refuse before parsing. 2 MB of gzipped JSON is already a huge sync payload. */
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024
/** Refuse before verifying. 2,000 ops ≈ 2s of signature work — the ceiling. */
export const MAX_OPS_PER_BUNDLE = 2_000

export interface SyncBundle {
  v: number
  id: string
  publisher: string
  createdAt: number
  opCount: number
  hlcMin: string
  hlcMax: string
  ops: SignedOp[]
  sig: string
}

export interface BundleVerification {
  bundle: SyncBundle
  /** Ops that verified AND passed policy. */
  accepted: Array<{ op: SignedOp; record: unknown }>
  rejected: Array<{ op: Partial<SignedOp>; verdict: OpVerdict }>
  /** Publisher signature validity. Informational only — never gates op acceptance. */
  publisherValid: boolean
  bytes: number
}

export class BundleError extends Error {
  constructor(message: string, readonly kind: 'too-large' | 'too-many-ops' | 'malformed' | 'version') {
    super(message)
    this.name = 'BundleError'
  }
}

/** The document the publisher signs: bundle metadata plus the op id list. */
function publisherDocument(b: Omit<SyncBundle, 'sig' | 'id'>): string {
  return canonicalize({
    createdAt: b.createdAt,
    hlcMax: b.hlcMax,
    hlcMin: b.hlcMin,
    opCount: b.opCount,
    opIds: b.ops.map((o) => o.id),
    publisher: b.publisher,
    v: b.v,
  })
}

/**
 * The bundle id is a CONTENT ADDRESS over the op set alone — deliberately
 * excluding `publisher` and `createdAt`.
 *
 * Deriving it from the signed document instead (the obvious first move) makes
 * the id depend on the wall clock, so a relay that republishes the same ops
 * every hour mints a fresh id every hour. `seenBundleIds` in transport.ts then
 * never matches, and every device re-downloads byte-identical content forever.
 * On a metered data bundle that is the exact cost this architecture exists to
 * avoid.
 *
 * Excluding the publisher additionally means two relays carrying the same ops
 * produce one id, so a device that already merged it from one source skips it
 * at the other.
 */
function bundleContentId(ops: readonly SignedOp[]): string {
  return contentId(new TextEncoder().encode(canonicalize(ops.map((o) => o.id))))
}

export function createBundle(publisher: KeyPair, ops: readonly SignedOp[]): SyncBundle {
  if (ops.length > MAX_OPS_PER_BUNDLE) {
    throw new BundleError(
      `bundle would hold ${ops.length} ops, limit is ${MAX_OPS_PER_BUNDLE}`,
      'too-many-ops',
    )
  }

  // Sorted by HLC so bundles are deterministic: the same op set always produces
  // the same bytes and the same id, which makes them cacheable and dedupable.
  const sorted = [...ops].sort((a, b) => compareHLC(a.hlc, b.hlc) || (a.id < b.id ? -1 : 1))

  const partial = {
    v: BUNDLE_VERSION,
    publisher: publisher.pubKeyId,
    createdAt: Date.now(),
    opCount: sorted.length,
    hlcMin: sorted[0]?.hlc ?? '',
    hlcMax: sorted[sorted.length - 1]?.hlc ?? '',
    ops: sorted,
  }

  const doc = publisherDocument(partial)
  const docBytes = new TextEncoder().encode(doc)

  const bundle: SyncBundle = {
    ...partial,
    id: bundleContentId(sorted),
    sig: toBase64Url(sign(docBytes, publisher.secretKey)),
  }

  log.info('sync', 'bundle created', {
    id: bundle.id.slice(0, 12),
    ops: bundle.opCount,
    bytes: canonicalBytes(bundle).length,
  })
  return bundle
}

export interface VerifyBundleOptions {
  now?: number
  /**
   * Policy hook applied AFTER cryptographic verification. Returning false drops
   * the op silently. This is where trust-gating lives — e.g. "ignore listings
   * from authors with no path to an anchor" — so spam can be discarded without
   * ever reaching the materialised tables.
   */
  accept?: (op: SignedOp, record: unknown) => boolean
  /** Stop verifying after this many ops. Defaults to MAX_OPS_PER_BUNDLE. */
  budget?: number
}

/**
 * Parses and verifies a bundle from raw text.
 *
 * Takes text rather than a parsed object so the byte cap can be enforced before
 * `JSON.parse` — parsing a 200 MB string to discover it is too large is the
 * exact denial of service the cap exists to prevent.
 */
export function verifyBundleText(
  text: string,
  opts: VerifyBundleOptions = {},
): BundleVerification {
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_BUNDLE_BYTES) {
    throw new BundleError(
      `bundle is ${(bytes / 1024 / 1024).toFixed(1)} MB, limit is ${MAX_BUNDLE_BYTES / 1024 / 1024} MB`,
      'too-large',
    )
  }

  let parsed: SyncBundle
  try {
    parsed = JSON.parse(text) as SyncBundle
  } catch (err) {
    throw new BundleError(`bundle is not valid JSON: ${String(err)}`, 'malformed')
  }

  return verifyBundle(parsed, { ...opts, knownBytes: bytes })
}

export function verifyBundle(
  bundle: SyncBundle,
  opts: VerifyBundleOptions & { knownBytes?: number } = {},
): BundleVerification {
  const now = opts.now ?? Date.now()

  if (!bundle || typeof bundle !== 'object') {
    throw new BundleError('bundle is not an object', 'malformed')
  }
  if (bundle.v !== BUNDLE_VERSION) {
    throw new BundleError(
      `bundle speaks version ${bundle.v}, this device speaks ${BUNDLE_VERSION}`,
      'version',
    )
  }
  if (!Array.isArray(bundle.ops)) {
    throw new BundleError('bundle.ops is not an array', 'malformed')
  }
  if (bundle.ops.length > MAX_OPS_PER_BUNDLE) {
    throw new BundleError(
      `bundle holds ${bundle.ops.length} ops, limit is ${MAX_OPS_PER_BUNDLE}`,
      'too-many-ops',
    )
  }

  // CENSORSHIP DEFENCE. A device records merged bundle ids in `seenBundleIds`
  // and never fetches them again. An attacker who could publish a junk bundle
  // carrying the id of a real one it had not yet fetched would make that device
  // skip the genuine bundle permanently — silently censoring specific vouches
  // or listings without forging anything. Recomputing the content address
  // closes it: a bundle whose id does not match its ops never reaches the
  // seen-set, because this throws before transport records it.
  const expectedId = bundleContentId(bundle.ops)
  if (bundle.id !== expectedId) {
    throw new BundleError(
      `bundle id does not match its contents (claimed ${String(bundle.id).slice(0, 12)}…, computed ${expectedId.slice(0, 12)}…)`,
      'malformed',
    )
  }

  // Publisher signature is informational. We compute it for provenance display
  // and logging, and then deliberately ignore it when deciding what to accept.
  let publisherValid = false
  try {
    const doc = publisherDocument({
      v: bundle.v,
      publisher: bundle.publisher,
      createdAt: bundle.createdAt,
      opCount: bundle.opCount,
      hlcMin: bundle.hlcMin,
      hlcMax: bundle.hlcMax,
      ops: bundle.ops,
    })
    publisherValid = verify(
      fromBase64Url(bundle.sig),
      new TextEncoder().encode(doc),
      idToPubKey(bundle.publisher),
    )
  } catch {
    publisherValid = false
  }

  const budget = Math.min(opts.budget ?? MAX_OPS_PER_BUNDLE, bundle.ops.length)
  const accepted: BundleVerification['accepted'] = []
  const rejected: BundleVerification['rejected'] = []

  for (let i = 0; i < budget; i++) {
    const op = bundle.ops[i]!
    const verdict = verifySignedOp(op, now)
    if (!verdict.ok) {
      rejected.push({ op, verdict })
      continue
    }
    if (opts.accept && !opts.accept(op, verdict.record)) continue
    accepted.push({ op, record: verdict.record })
  }

  if (budget < bundle.ops.length) {
    // Never silently truncate — a partially-verified bundle that looks complete
    // is how you get a device that believes it is in sync and is not.
    log.warn('sync', 'verification budget exhausted, bundle only partly processed', {
      verified: budget,
      total: bundle.ops.length,
    })
  }

  log.info('sync', 'bundle verified', {
    id: String(bundle.id).slice(0, 12),
    accepted: accepted.length,
    rejected: rejected.length,
    publisherValid,
  })

  return {
    bundle,
    accepted,
    rejected,
    publisherValid,
    bytes: opts.knownBytes ?? canonicalBytes(bundle).length,
  }
}

export function serializeBundle(bundle: SyncBundle): string {
  return canonicalize(bundle)
}

/* ──────────────────────────── manifest ──────────────────────────── */

/**
 * The index a device fetches first. Small, cacheable, and the only file that
 * must be re-fetched often — everything else is content-addressed and therefore
 * immutable, so it can be cached forever.
 */
export interface BundleManifest {
  v: number
  updatedAt: number
  entries: Array<{
    /** Path relative to the manifest. */
    path: string
    id: string
    hlcMax: string
    opCount: number
    bytes: number
  }>
}

export function selectNewEntries(
  manifest: BundleManifest,
  cursorHlc: string | null,
  seenIds: ReadonlySet<string>,
): BundleManifest['entries'] {
  return manifest.entries
    .filter((e) => !seenIds.has(e.id))
    // An entry whose newest op predates our cursor holds nothing we lack.
    .filter((e) => !cursorHlc || compareHLC(e.hlcMax, cursorHlc) > 0)
    .sort((a, b) => compareHLC(a.hlcMax, b.hlcMax))
}
