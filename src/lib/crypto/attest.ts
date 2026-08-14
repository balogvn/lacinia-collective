/**
 * Self-signed records — the pattern that makes gossip safe.
 *
 * WHY THIS ABSTRACTION EXISTS
 * Vouchers, ledger entries, flags and revocations all share one requirement:
 * ANYONE MAY RELAY THEM. A voucher has to reach devices its issuer never met,
 * a revocation has to outrun the trust it cancels, and a flag is worthless if
 * only the flagger's own phone knows about it.
 *
 * Relaying means re-signing the enclosing op with the relay's key, so the op
 * signature proves only "this relay passed it on". Authority has to travel
 * INSIDE the record, as a signature by the party whose claim it is. Vouchers
 * and ledger entries each hand-rolled this; flags and revocations would have
 * been a third and fourth copy, so it lives here now.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE
 *
 * 1. DOMAIN SEPARATION. The domain string is inside the signed document. A
 *    signature over a flag must not be replayable as a revocation — without a
 *    domain, two record types with the same field names would produce
 *    interchangeable signatures, and "I flagged this listing" could be
 *    replayed as "I revoked this vouch".
 *
 * 2. THE BYTES ARE THE TRUTH. We store the exact signed string and verify
 *    against it, then separately assert that recomputing it from the record's
 *    fields reproduces it. This is the Task 1 voucher lesson: denormalised
 *    columns are a cache that anything with IndexedDB access can rewrite while
 *    leaving the signature perfectly valid.
 */

import { canonicalize, pruneUndefined } from '../sync/canonical'
import { toBase64Url, fromBase64Url } from '../codec'
import { contentId, sign, verify, idToPubKey, type KeyPair } from './keys'
import { log } from '../telemetry'

/** Fields excluded from the signed document on every attested record. */
const ALWAYS_OMIT = ['id', 'signature', 'signedBytes', 'hlc', 'deleted', 'recordedAt'] as const

export interface Attestation {
  id: string
  signature: string
  signedBytes: string
}

function documentFor(domain: string, record: Record<string, unknown>): string {
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if ((ALWAYS_OMIT as readonly string[]).includes(key)) continue
    if (value === undefined) continue
    body[key] = value
  }
  return canonicalize(pruneUndefined({ d: domain, r: body }))
}

/**
 * Signs a record, returning its content id and signature.
 *
 * The id is the hash of the signed document, so it is deterministic across
 * devices — the same claim arriving by six routes collapses to one row.
 */
export function attest<T extends Record<string, unknown>>(
  signer: KeyPair,
  domain: string,
  record: T,
): Attestation {
  const doc = documentFor(domain, record)
  const bytes = new TextEncoder().encode(doc)
  return {
    id: contentId(bytes),
    signature: toBase64Url(sign(bytes, signer.secretKey)),
    signedBytes: doc,
  }
}

/**
 * Verifies an attested record against the key that should have signed it.
 *
 * Never throws — these arrive from a public CDN, where malformed input is
 * expected traffic rather than an exceptional condition.
 */
export function verifyAttestation(
  domain: string,
  record: Record<string, unknown> & Partial<Attestation>,
  signerPubKey: string,
): boolean {
  try {
    if (
      typeof record.signature !== 'string' ||
      typeof record.signedBytes !== 'string' ||
      typeof record.id !== 'string'
    ) {
      return false
    }

    const bytes = new TextEncoder().encode(record.signedBytes)
    if (!verify(fromBase64Url(record.signature), bytes, idToPubKey(signerPubKey))) return false
    if (contentId(bytes) !== record.id) return false

    // The columns are a cache; the bytes are the truth. A row edited in
    // IndexedDB keeps a valid signature and must still be rejected.
    if (documentFor(domain, record) !== record.signedBytes) {
      log.error('sync', 'attested record disagrees with its own signed bytes', {
        domain,
        id: record.id.slice(0, 12),
      })
      return false
    }

    return true
  } catch {
    return false
  }
}
