#!/usr/bin/env node
/**
 * The free compute layer — bundle aggregation, run by GitHub Actions on a cron.
 *
 * WHAT IT DOES
 *   commons/inbox/*.json   → submitted bundles (via pull request, or a relay)
 *   public/commons/        → merged, compacted snapshots + manifest.json
 *
 * WHY COMPACTION MATTERS MORE THAN IT LOOKS
 * Without it, a device joining in year two must download every bundle ever
 * published to reconstruct current state. Because ops are last-writer-wins per
 * entity, all but the newest op for each key is redundant — so the aggregator
 * keeps one op per (entity, entityId) and drops the rest. A commons with 10,000
 * lifetime edits across 800 records compacts to 800 ops. New joiners fetch one
 * small snapshot instead of the entire history, which is the difference between
 * this being usable on a metered connection and not.
 *
 * WHY IT VERIFIES EVERYTHING AGAIN
 * CI is a public inbox: anyone can open a pull request. Every op is verified
 * here so garbage never reaches the published snapshot — but note that this is
 * a courtesy, not a security boundary. Clients re-verify independently, because
 * the CI job is exactly as untrusted as any other relay (see ops.ts).
 *
 * Deliberately plain Node with no build step: this must be readable and
 * runnable by anyone with the repo, including someone reimplementing it in
 * Python, and it must not depend on the Next.js toolchain.
 */

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ed = require('@noble/ed25519')
const { sha512 } = require('@noble/hashes/sha512')
const { sha256 } = require('@noble/hashes/sha256')

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m))

const ROOT = resolve(process.cwd())
const INBOX = join(ROOT, 'commons', 'inbox')
const OUT = join(ROOT, 'public', 'commons')

/**
 * Snapshot filenames are CONTENT-ADDRESSED — `snapshot-<id>.json`.
 *
 * The transport layer caches bundle files with `force-cache` and never
 * re-fetches them, because the architecture promises they are immutable. An
 * earlier version of this script wrote to a fixed `snapshot.json` whose
 * contents changed every run, quietly breaking that promise: devices happily
 * re-downloaded the stale file from their HTTP cache forever and reported
 * "applied 0 updates" while the commons moved on without them.
 *
 * Putting the content hash in the filename restores the invariant, so the
 * cache directive is correct rather than merely optimistic.
 */
const snapshotName = (id) => `snapshot-${id.slice(0, 16)}.json`
/** Kept for clients mid-fetch when a new snapshot lands. */
const SNAPSHOTS_TO_KEEP = 3

/* ─────────────────────── minimal shared primitives ─────────────────────── */
/* Kept in sync with src/lib by the round-trip test in verify-sync; if these
   ever diverge, CI-published snapshots stop verifying on devices.            */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function fromBase64Url(text) {
  const clean = text.trim().replace(/=+$/, '')
  const lookup = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i
  lookup['+'.charCodeAt(0)] = 62
  lookup['/'.charCodeAt(0)] = 63

  const groups = Math.floor(clean.length / 4)
  const rem = clean.length % 4
  if (rem === 1) throw new Error('bad base64url')
  const out = new Uint8Array(groups * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0))
  const at = (i) => {
    const v = clean.charCodeAt(i) < 128 ? lookup[clean.charCodeAt(i)] : -1
    if (v < 0) throw new Error('bad base64url char')
    return v
  }
  let o = 0
  let i = 0
  for (let g = 0; g < groups; g++, i += 4) {
    const n = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6) | at(i + 3)
    out[o++] = (n >>> 16) & 255
    out[o++] = (n >>> 8) & 255
    out[o++] = n & 255
  }
  if (rem === 2) out[o++] = (((at(i) << 18) | (at(i + 1) << 12)) >>> 16) & 255
  else if (rem === 3) {
    const n = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6)
    out[o++] = (n >>> 16) & 255
    out[o++] = (n >>> 8) & 255
  }
  return out
}

function toHex(bytes) {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

const contentId = (bytes) => toHex(sha256(bytes)).slice(0, 32)

/** Must match src/lib/sync/canonical.ts exactly, integer guard included. */
function canonicalize(value) {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number cannot be signed')
    if (!Number.isInteger(value)) throw new Error('non-integer number cannot be signed')
    return Object.is(value, -0) ? '0' : String(value)
  }
  if (t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (t === 'object') {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const parts = []
    for (const k of keys) {
      if (value[k] === undefined) throw new Error(`key "${k}" is present but undefined`)
      parts.push(`${JSON.stringify(k)}:${canonicalize(value[k])}`)
    }
    return `{${parts.join(',')}}`
  }
  throw new Error(`${t} cannot be signed`)
}

function signedDocument(op) {
  return canonicalize({
    author: op.author,
    body: op.body,
    entity: op.entity,
    entityId: op.entityId,
    hlc: op.hlc,
    op: op.op,
  })
}

const OWNER_FIELD = {
  identity: 'pubKey',
  listing: 'authorPub',
  conversation: 'authorPub',
  statement: 'authorPub',
  vote: 'authorPub',
}

function verifyOp(op) {
  if (!op || typeof op.sig !== 'string' || typeof op.body !== 'string') return 'malformed'
  if (op.op !== 'put' && op.op !== 'tombstone') return 'bad op kind'

  let record
  try {
    record = JSON.parse(op.body)
  } catch {
    return 'body is not JSON'
  }
  if (canonicalize(record) !== op.body) return 'body is not canonical'

  const doc = new TextEncoder().encode(signedDocument(op))
  try {
    if (!ed.verify(fromBase64Url(op.sig), doc, fromBase64Url(op.author))) return 'bad signature'
  } catch {
    return 'signature could not be checked'
  }
  if (contentId(doc) !== op.id) return 'id mismatch'

  // Voucher and ledger relay are intentionally open — both artefacts carry
  // their own signatures and prove themselves. See the asymmetry documented in
  // src/lib/sync/ops.ts. Everything else must be self-authored.
  const ownerField = OWNER_FIELD[op.entity]
  if (ownerField) {
    if (record[ownerField] !== op.author) return `only the owner may write a ${op.entity}`
  } else if (!RELAYABLE.has(op.entity)) {
    return `unknown entity "${op.entity}"`
  }

  // Flags and revocations carry their own signatures, verified against the key
  // named inside the signed document. Without this a relay could manufacture
  // flags nobody raised (a censorship primitive) or revocations nobody issued
  // (a way to strip standing from people who earned it).
  if (op.entity === 'flag') {
    const problem = verifyAttested(record, 'lacinia/flag/v1', record.authorPub)
    if (problem) return `flag: ${problem}`
  }
  if (op.entity === 'revocation') {
    const problem = verifyAttested(record, 'lacinia/revocation/v1', record.issuerPub)
    if (problem) return `revocation: ${problem}`
  }
  if (op.entity === 'anchorAction') {
    const problem = verifyAttested(record, 'lacinia/anchor-action/v1', record.anchorPub)
    if (problem) return `anchor action: ${problem}`
  }
  if (op.entity === 'translation') {
    const problem = verifyAttested(record, 'lacinia/translation/v1', record.translatorPub)
    if (problem) return `translation: ${problem}`
  }

  // A ledger entry needs BOTH parties' signatures over identical bytes.
  // Without this check a relay could publish invented exchanges and mint
  // credits for itself — the one failure a currency cannot recover from.
  if (op.entity === 'ledger') {
    const problem = verifyLedgerEntry(record)
    if (problem) return problem
  }

  // A vote's id must be the derivation of (voter, statement). The authorPub
  // check above proves you signed it; this proves you filed it under YOUR row
  // rather than one that would overwrite somebody else's vote.
  if (op.entity === 'vote') {
    const expected = contentId(
      new TextEncoder().encode(`vote|${record.authorPub}|${record.statementId}`),
    )
    if (record.id !== expected) return 'vote id is not derived from this voter and statement'
    if (record.value !== 1 && record.value !== 0 && record.value !== -1) {
      return 'vote value must be 1, 0 or -1'
    }
  }
  return null
}

/**
 * Two-signature check over the fixed-width settlement document.
 *
 * Mirrors reverifyEntry() in src/lib/ledger/entry.ts. The layout is
 *   header(4) fromPub(32) toPub(32) amount(u32) agreedAt(u48) nonce(8) listingRef(8)
 * = 94 bytes, and both signatures cover exactly those bytes.
 */
function verifyLedgerEntry(entry) {
  try {
    const doc = fromBase64Url(entry.signedBytes)
    if (doc.length !== 94) return 'ledger document is the wrong length'
    if (!ed.verify(fromBase64Url(entry.toSig), doc, fromBase64Url(entry.toPub))) {
      return 'provider signature invalid'
    }
    if (!ed.verify(fromBase64Url(entry.fromSig), doc, fromBase64Url(entry.fromPub))) {
      return 'payer signature invalid'
    }
    if (contentId(doc) !== entry.id) return 'ledger id mismatch'

    // Cross-check the denormalised columns against the signed bytes — they are
    // a cache, and anything that can write a bundle can rewrite them.
    const view = new DataView(doc.buffer, doc.byteOffset, doc.byteLength)
    const b64 = (start, len) => toBase64UrlBytes(doc.subarray(start, start + len))
    if (b64(4, 32) !== entry.fromPub) return 'fromPub disagrees with signed bytes'
    if (b64(36, 32) !== entry.toPub) return 'toPub disagrees with signed bytes'
    if (view.getUint32(68) !== entry.amount) return 'amount disagrees with signed bytes'
    if (entry.fromPub === entry.toPub) return 'self-payment'
    if (!Number.isInteger(entry.amount) || entry.amount <= 0) return 'invalid amount'
    return null
  } catch (err) {
    return `ledger entry unreadable: ${err.message}`
  }
}

/** Entities whose authority travels inside the record, so anyone may relay. */
const RELAYABLE = new Set(['voucher', 'ledger', 'flag', 'revocation', 'anchorAction', 'translation'])

/**
 * Mirrors verifyAttestation() in src/lib/crypto/attest.ts.
 *
 * The domain string is inside the signed document, so a flag signature cannot
 * be replayed as a revocation. The recomputation check is the same rule applied
 * everywhere else in this codebase: the bytes are the truth, the columns are a
 * cache.
 */
const ATTEST_OMIT = new Set(['id', 'signature', 'signedBytes', 'hlc', 'deleted', 'recordedAt'])

function verifyAttested(record, domain, signerPub) {
  try {
    if (typeof record.signature !== 'string' || typeof record.signedBytes !== 'string') {
      return 'missing signature'
    }
    const bytes = new TextEncoder().encode(record.signedBytes)
    if (!ed.verify(fromBase64Url(record.signature), bytes, fromBase64Url(signerPub))) {
      return 'signature invalid'
    }
    if (contentId(bytes) !== record.id) return 'id mismatch'

    const body = {}
    for (const [key, value] of Object.entries(record)) {
      if (ATTEST_OMIT.has(key) || value === undefined) continue
      body[key] = value
    }
    if (canonicalize({ d: domain, r: body }) !== record.signedBytes) {
      return 'record disagrees with its own signed bytes'
    }
    return null
  } catch (err) {
    return `unreadable: ${err.message}`
  }
}

function toBase64UrlBytes(bytes) {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63] + B64[n & 63]
  }
  const rem = bytes.length - i
  if (rem === 1) {
    const n = bytes[i] << 16
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63]
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63]
  }
  return out
}

/* ─────────────────────────── HLC comparison ─────────────────────────── */
// Fixed-width encoding means plain string compare is causal compare.
const hlcNewer = (a, b) => String(a) > String(b)

/* ─────────────────────────── aggregation ─────────────────────────── */

async function main() {
  const started = Date.now()
  await mkdir(OUT, { recursive: true })

  // Seed from the existing snapshot so history is not lost when the inbox is
  // cleared — the snapshot IS the accumulated state. Located via the manifest,
  // since the filename now carries a content hash.
  const latest = new Map()
  const manifestPath = join(OUT, 'manifest.json')
  let carried = 0
  let previousName = null

  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      previousName = manifest.entries?.[0]?.path ?? null
      if (previousName && existsSync(join(OUT, previousName))) {
        const previous = JSON.parse(await readFile(join(OUT, previousName), 'utf8'))
        for (const op of previous.ops ?? []) {
          latest.set(`${op.entity}:${op.entityId}`, op)
          carried++
        }
      }
    } catch (err) {
      console.error(`! existing snapshot unreadable, starting fresh: ${err.message}`)
    }
  }

  const files = existsSync(INBOX)
    ? (await readdir(INBOX)).filter((f) => f.endsWith('.json')).sort()
    : []

  let seen = 0
  let accepted = 0
  const rejections = []

  for (const file of files) {
    const text = await readFile(join(INBOX, file), 'utf8')
    let bundle
    try {
      bundle = JSON.parse(text)
    } catch {
      rejections.push(`${file}: not valid JSON`)
      continue
    }
    if (!Array.isArray(bundle.ops)) {
      rejections.push(`${file}: no ops array`)
      continue
    }

    for (const op of bundle.ops) {
      seen++
      const problem = verifyOp(op)
      if (problem) {
        rejections.push(`${file} op ${String(op?.id).slice(0, 10)}: ${problem}`)
        continue
      }

      // Compaction: last writer wins per entity key, so only the newest op for
      // each key survives into the snapshot.
      const key = `${op.entity}:${op.entityId}`
      const held = latest.get(key)
      if (!held || hlcNewer(op.hlc, held.hlc)) {
        latest.set(key, op)
        accepted++
      }
    }
  }

  const ops = [...latest.values()].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0))
  const snapshot = {
    v: 1,
    id: contentId(new TextEncoder().encode(canonicalize(ops.map((o) => o.id)))),
    publisher: '',
    // DETERMINISTIC, NOT Date.now(). The filename is a content address, which
    // promises the file is immutable — and the transport layer caches it
    // forever on that promise. A wall clock inside the body breaks it: two runs
    // over identical ops would write DIFFERENT bytes to the SAME filename, so
    // every device would keep serving whichever version it cached first.
    //
    // It also made the daily cron commit a diff even when nothing changed,
    // filling main with noise forever. The snapshot is a compaction artifact,
    // not a published-at claim; its ops each carry their own HLC.
    createdAt: 0,
    opCount: ops.length,
    hlcMin: ops[0]?.hlc ?? '',
    hlcMax: ops[ops.length - 1]?.hlc ?? '',
    ops,
    // The aggregator holds no key, and deliberately should not: a CI secret
    // that signs on behalf of the commons would be a central authority with a
    // single point of compromise. Clients ignore the publisher signature for
    // authorization anyway — every op is verified individually.
    sig: '',
  }

  const snapshotText = JSON.stringify(snapshot)
  const outName = snapshotName(snapshot.id)
  await writeFile(join(OUT, outName), snapshotText)

  const manifest = {
    v: 1,
    // Also deterministic — see the note on snapshot.createdAt. Nothing reads
    // this; devices detect change via the ETag on the manifest and the content
    // address of the snapshot, both of which move only when content moves.
    updatedAt: 0,
    entries: [
      {
        path: outName,
        id: snapshot.id,
        hlcMax: snapshot.hlcMax,
        opCount: snapshot.opCount,
        bytes: Buffer.byteLength(snapshotText),
      },
    ],
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  // Prune superseded snapshots, keeping a few so a client that read the old
  // manifest seconds ago can still complete its fetch.
  const stale = (await readdir(OUT))
    .filter((f) => /^snapshot-[0-9a-f]+\.json$/.test(f) && f !== outName)
    .sort()
  for (const file of stale.slice(0, Math.max(0, stale.length - (SNAPSHOTS_TO_KEEP - 1)))) {
    await rm(join(OUT, file))
  }
  // Remove the pre-content-address file if an older run left one behind.
  if (existsSync(join(OUT, 'snapshot.json'))) await rm(join(OUT, 'snapshot.json'))

  // Clear the inbox only after a successful write, so a crash mid-run cannot
  // lose submissions.
  if (process.env.LACINIA_KEEP_INBOX !== '1') {
    for (const file of files) await rm(join(INBOX, file))
  }

  const kb = (Buffer.byteLength(snapshotText) / 1024).toFixed(1)
  console.log(`lacinia aggregate — ${Date.now() - started}ms`)
  console.log(`  inbox bundles   ${files.length}`)
  console.log(`  ops seen        ${seen}`)
  console.log(`  ops applied     ${accepted}`)
  console.log(`  carried forward ${carried}`)
  console.log(`  snapshot        ${snapshot.opCount} ops, ${kb} KB`)
  if (rejections.length) {
    console.log(`  rejected        ${rejections.length}`)
    for (const r of rejections.slice(0, 25)) console.log(`    · ${r}`)
    if (rejections.length > 25) console.log(`    · …and ${rejections.length - 25} more`)
  }

  // Never fail the job for rejected ops — a public inbox WILL receive junk, and
  // a red build every time someone submits a malformed bundle trains everyone
  // to ignore the build.
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
