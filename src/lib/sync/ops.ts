/**
 * Signed operations — the unit of sync.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE MODEL: BUNDLES ARE UNTRUSTED TRANSPORT
 *
 * Every op carries its own author signature. A bundle's signature attests only
 * "I relayed these bytes" — never "these claims are true". A relay can
 * republish anybody's ops and cannot forge a single one, which is what makes
 * open gossip safe: any device may rebroadcast any bundle it received, from
 * anyone, without becoming an authority over the contents.
 *
 * AUTHORIZATION IS PER-ENTITY. This is the part that is easy to get backwards.
 *
 *   identity, listing  → op.author MUST be the record's owner.
 *                        Only I may write my own listing or rename myself.
 *
 *   voucher            → op.author may be ANYONE.
 *                        A voucher is self-authenticating: it carries the
 *                        issuer's signature over its own bytes, verified
 *                        independently. Relaying other people's vouchers is
 *                        precisely how the trust graph propagates through the
 *                        network. Requiring op.author == issuer here would mean
 *                        a vouch could only ever reach devices the issuer
 *                        personally synced with, which defeats sync entirely.
 *
 * Uniform-strict authorization breaks trust propagation. Uniform-loose lets
 * anyone author anything. Neither is recoverable after deployment, so the
 * policy is explicit and table-driven below.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { canonicalize, canonicalBytes, pruneUndefined } from './canonical'
import { voteIdFor } from '../deliberate/ids'
import { toBase64Url, fromBase64Url } from '../codec'
import { contentId, sign, verify, idToPubKey, type KeyPair } from '../crypto/keys'
import { reverifyStoredVoucher } from '../vouch/protocol'
import { reverifyEntry } from '../ledger/entry'
import { verifyFlag } from '../moderate/flag'
import { verifyRevocation } from '../moderate/revoke'
import { verifyAnchorAction } from '../anchor/governance'
import {
  VoucherStatus,
  type OpEntity,
  type PubKeyId,
  type TrustVoucher,
  type ResourceListing,
  type UserIdentity,
  type LedgerEntry,
  type Flag,
  type VoucherRevocation,
  type AnchorAction,
} from '../db/schema'
import type { HLC } from '../hlc'
import { log } from '../telemetry'

export interface SignedOp {
  /** Content hash of the signed document. Deterministic → free dedupe. */
  id: string
  hlc: HLC
  entity: OpEntity
  entityId: string
  op: 'put' | 'tombstone'
  /** Whoever signed THIS op. Not necessarily the subject — see the header. */
  author: PubKeyId
  /** Canonical JSON of the record. Stored verbatim; never re-derived to verify. */
  body: string
  /** base64url Ed25519 over the canonical signed document. */
  sig: string
}

export enum OpRejectReason {
  Malformed = 'MALFORMED',
  BadSignature = 'BAD_SIGNATURE',
  IdMismatch = 'ID_MISMATCH',
  Unauthorized = 'UNAUTHORIZED',
  EntityIdMismatch = 'ENTITY_ID_MISMATCH',
  UnknownEntity = 'UNKNOWN_ENTITY',
  InvalidVoucher = 'INVALID_VOUCHER',
  InvalidEntry = 'INVALID_ENTRY',
  InvalidAttestation = 'INVALID_ATTESTATION',
  NotCanonical = 'NOT_CANONICAL',
}

export type OpVerdict =
  | { ok: true; record: unknown }
  | { ok: false; reason: OpRejectReason; detail: string }

/**
 * The exact document that gets signed.
 *
 * `id` and `sig` are excluded (they are derived from it). Everything else is
 * included, so an attacker cannot relabel a valid op — moving a signed body
 * onto a different `entity`, `entityId`, `hlc` or `op` changes the signed
 * bytes and invalidates the signature.
 */
function signedDocument(op: Omit<SignedOp, 'id' | 'sig'>): string {
  return canonicalize({
    author: op.author,
    body: op.body,
    entity: op.entity,
    entityId: op.entityId,
    hlc: op.hlc,
    op: op.op,
  })
}

export function createSignedOp(
  signer: KeyPair,
  input: {
    hlc: HLC
    entity: OpEntity
    entityId: string
    op: 'put' | 'tombstone'
    record: unknown
  },
): SignedOp {
  const body = canonicalize(pruneUndefined(input.record))
  const unsigned = {
    hlc: input.hlc,
    entity: input.entity,
    entityId: input.entityId,
    op: input.op,
    author: signer.pubKeyId,
    body,
  }
  const doc = signedDocument(unsigned)
  const docBytes = new TextEncoder().encode(doc)

  return {
    ...unsigned,
    id: contentId(docBytes),
    sig: toBase64Url(sign(docBytes, signer.secretKey)),
  }
}

/* ─────────────────────────── authorization ─────────────────────────── */

/**
 * Per-entity rules. Returning `null` means authorized; a string is the reason.
 *
 * Each rule also asserts that `entityId` matches the record's own primary key,
 * because otherwise a validly-signed listing could be filed under a different
 * id and overwrite someone else's row.
 */
const AUTHORIZERS: Record<
  OpEntity,
  (record: Record<string, unknown>, op: SignedOp) => string | null
> = {
  identity: (record, op) => {
    const pubKey = record.pubKey
    if (typeof pubKey !== 'string') return 'identity record has no pubKey'
    if (pubKey !== op.entityId) return 'entityId does not match record.pubKey'
    if (pubKey !== op.author) return 'only the key holder may write their own identity'
    return null
  },

  listing: (record, op) => {
    const id = record.id
    const authorPub = record.authorPub
    if (typeof id !== 'string' || typeof authorPub !== 'string') return 'listing record is malformed'
    if (id !== op.entityId) return 'entityId does not match record.id'
    if (authorPub !== op.author) return 'only the author may write their own listing'
    return null
  },

  // Self-authenticating. Anyone may relay; validity comes from the voucher's
  // own signature, checked separately in verifySignedOp.
  voucher: (record, op) => {
    const id = record.id
    if (typeof id !== 'string') return 'voucher record has no id'
    if (id !== op.entityId) return 'entityId does not match record.id'
    return null
  },

  // Also self-authenticating, and for the same reason: a ledger entry carries
  // BOTH parties' signatures over identical bytes, so it proves itself. Open
  // relay matters more here than for vouchers — a balance is only meaningful
  // if third parties can see the entries that produced it, and restricting
  // relay to the two participants would mean nobody could ever assess a
  // stranger's standing before extending them credit.
  ledger: (record, op) => {
    const id = record.id
    if (typeof id !== 'string') return 'ledger entry has no id'
    if (id !== op.entityId) return 'entityId does not match record.id'
    return null
  },

  // Self-authenticating, so anyone may relay — a flag only the flagger's own
  // phone knows about protects nobody. Its embedded signature is verified
  // separately below.
  flag: (record, op) => {
    const id = record.id
    if (typeof id !== 'string') return 'flag has no id'
    if (id !== op.entityId) return 'entityId does not match record.id'
    return null
  },

  // Also self-authenticating and relayable, and here that matters most: a
  // revocation must outrun the trust it cancels. Restricting relay to the
  // issuer would leave a compromised key trusted on every device the issuer
  // never synced with.
  revocation: (record, op) => {
    const id = record.id
    if (typeof id !== 'string') return 'revocation has no id'
    if (id !== op.entityId) return 'entityId does not match record.id'
    return null
  },

  // Self-authenticating and relayable, like vouchers and revocations: a
  // rotation is useless if it only reaches devices the anchor personally
  // synced with.
  anchorAction: (record, op) => {
    const id = record.id
    if (typeof id !== 'string') return 'anchor action has no id'
    if (id !== op.entityId) return 'entityId does not match record.id'
    return null
  },

  conversation: (record, op) => {
    const id = record.id
    const authorPub = record.authorPub
    if (typeof id !== 'string' || typeof authorPub !== 'string') return 'conversation is malformed'
    if (id !== op.entityId) return 'entityId does not match record.id'
    if (authorPub !== op.author) return 'only the author may write their own conversation'
    return null
  },

  statement: (record, op) => {
    const id = record.id
    const authorPub = record.authorPub
    if (typeof id !== 'string' || typeof authorPub !== 'string') return 'statement is malformed'
    if (id !== op.entityId) return 'entityId does not match record.id'
    if (authorPub !== op.author) return 'only the author may write their own statement'
    return null
  },

  // A vote's id is derived from (voter, statement), so changing your mind is an
  // LWW update of the same row. Checking that derivation here is what stops
  // someone filing a vote under an id that would overwrite SOMEONE ELSE'S vote:
  // the authorPub check alone would not, because the id is a separate field.
  vote: (record, op) => {
    const id = record.id
    const authorPub = record.authorPub
    const statementId = record.statementId
    if (typeof id !== 'string' || typeof authorPub !== 'string' || typeof statementId !== 'string') {
      return 'vote is malformed'
    }
    if (id !== op.entityId) return 'entityId does not match record.id'
    if (authorPub !== op.author) return 'only the voter may write their own vote'
    if (id !== voteIdFor(authorPub, statementId)) {
      return 'vote id is not derived from this voter and statement'
    }
    if (record.value !== 1 && record.value !== 0 && record.value !== -1) {
      return 'vote value must be 1, 0 or -1'
    }
    return null
  },
}

/* ─────────────────────────── verification ─────────────────────────── */

function reject(reason: OpRejectReason, detail: string): OpVerdict {
  return { ok: false, reason, detail }
}

/**
 * Full verification of one op. Never throws — malformed input arriving from a
 * public CDN is expected traffic, not an exceptional condition.
 */
export function verifySignedOp(op: SignedOp, now = Date.now()): OpVerdict {
  if (
    !op ||
    typeof op.id !== 'string' ||
    typeof op.hlc !== 'string' ||
    typeof op.entity !== 'string' ||
    typeof op.entityId !== 'string' ||
    typeof op.body !== 'string' ||
    typeof op.author !== 'string' ||
    typeof op.sig !== 'string' ||
    (op.op !== 'put' && op.op !== 'tombstone')
  ) {
    return reject(OpRejectReason.Malformed, 'op is missing required fields')
  }

  if (!(op.entity in AUTHORIZERS)) {
    return reject(OpRejectReason.UnknownEntity, `unknown entity "${op.entity}"`)
  }

  let authorKey: Uint8Array
  let signature: Uint8Array
  try {
    authorKey = idToPubKey(op.author)
    signature = fromBase64Url(op.sig)
  } catch (err) {
    return reject(OpRejectReason.Malformed, err instanceof Error ? err.message : String(err))
  }

  // Verify over the STORED document, exactly as in the Task 1 voucher fix: the
  // bytes are the truth. We then separately assert that re-canonicalizing the
  // parsed body reproduces `op.body`, which catches a body that is valid JSON
  // but not in canonical form — otherwise two encodings of the same record
  // would yield two different, both-verifying op ids.
  const doc = signedDocument(op)
  const docBytes = new TextEncoder().encode(doc)

  if (!verify(signature, docBytes, authorKey)) {
    return reject(OpRejectReason.BadSignature, 'author signature failed verification')
  }

  if (contentId(docBytes) !== op.id) {
    return reject(OpRejectReason.IdMismatch, 'op id is not the hash of its signed document')
  }

  let record: Record<string, unknown>
  try {
    record = JSON.parse(op.body) as Record<string, unknown>
  } catch {
    return reject(OpRejectReason.Malformed, 'body is not valid JSON')
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return reject(OpRejectReason.Malformed, 'body is not an object')
  }

  try {
    if (canonicalize(record) !== op.body) {
      return reject(OpRejectReason.NotCanonical, 'body is not in canonical form')
    }
  } catch (err) {
    return reject(OpRejectReason.NotCanonical, err instanceof Error ? err.message : String(err))
  }

  const authError = AUTHORIZERS[op.entity as OpEntity](record, op)
  if (authError) {
    return reject(OpRejectReason.Unauthorized, authError)
  }

  // A voucher's authority comes from the issuer's own signature, not from
  // whoever relayed it. Verify it here so a forged voucher cannot ride into the
  // trust graph inside a validly-signed relay op.
  if (op.entity === 'voucher' && op.op === 'put') {
    const voucher = record as unknown as TrustVoucher
    const status = reverifyStoredVoucher(voucher, now)
    if (status === VoucherStatus.Invalid) {
      return reject(OpRejectReason.InvalidVoucher, 'relayed voucher failed its own signature check')
    }
  }

  // Same principle for money. Both parties' signatures are checked here, so a
  // relay cannot invent an exchange that never happened — which, unchecked,
  // would let anyone mint credits for themselves by publishing a bundle.
  if (op.entity === 'ledger' && op.op === 'put') {
    if (!reverifyEntry(record as unknown as LedgerEntry)) {
      return reject(
        OpRejectReason.InvalidEntry,
        'relayed ledger entry failed its two-signature check',
      )
    }
  }

  // A flag carries the flagger's own signature. Without checking it, a relay
  // could manufacture flags attributed to people who never raised them — and
  // since flags drive what gets withheld, that is a censorship primitive.
  if (op.entity === 'flag' && op.op === 'put') {
    if (!verifyFlag(record as unknown as Flag)) {
      return reject(OpRejectReason.InvalidAttestation, 'flag failed its own signature check')
    }
  }

  // Same for revocations, where the stakes run the other way: a forged
  // revocation strips standing from someone who earned it.
  if (op.entity === 'revocation' && op.op === 'put') {
    if (!verifyRevocation(record as unknown as VoucherRevocation)) {
      return reject(
        OpRejectReason.InvalidAttestation,
        'revocation failed its own signature check — only the issuer may revoke',
      )
    }
  }

  // Signed by the anchor itself. Without this check a relay could manufacture
  // endorsements and rotations, which is a route to installing an
  // attacker-chosen axiom at the root of everyone's trust graph.
  if (op.entity === 'anchorAction' && op.op === 'put') {
    if (!verifyAnchorAction(record as unknown as AnchorAction)) {
      return reject(
        OpRejectReason.InvalidAttestation,
        'anchor action failed its own signature check',
      )
    }
  }

  return { ok: true, record }
}

/* ─────────────────────────── helpers ─────────────────────────── */

export function opForIdentity(signer: KeyPair, identity: UserIdentity): SignedOp {
  return createSignedOp(signer, {
    hlc: identity.hlc,
    entity: 'identity',
    entityId: identity.pubKey,
    op: identity.deleted ? 'tombstone' : 'put',
    record: identity,
  })
}

export function opForVoucher(signer: KeyPair, voucher: TrustVoucher): SignedOp {
  return createSignedOp(signer, {
    hlc: voucher.hlc,
    entity: 'voucher',
    entityId: voucher.id,
    op: voucher.deleted ? 'tombstone' : 'put',
    record: voucher,
  })
}

export function opForListing(signer: KeyPair, listing: ResourceListing): SignedOp {
  return createSignedOp(signer, {
    hlc: listing.hlc,
    entity: 'listing',
    entityId: listing.id,
    op: listing.deleted ? 'tombstone' : 'put',
    record: listing,
  })
}

/** Byte size of an op on the wire, for the data-cost reporting the UI shows. */
export function opWireSize(op: SignedOp): number {
  return canonicalBytes(op).length
}

export function logOpRejection(op: Partial<SignedOp>, verdict: OpVerdict): void {
  if (verdict.ok) return
  log.warn('sync', `op rejected: ${verdict.reason}`, {
    id: op.id?.slice(0, 12),
    entity: op.entity,
    author: op.author?.slice(0, 12),
    detail: verdict.detail,
  })
}
