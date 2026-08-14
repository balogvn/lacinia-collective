/**
 * OFFLINE PEER VOUCHING — the two-scan handshake.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE PROTOCOL
 *
 *   Adaeze (has trust)                        Bilkisu (new)
 *   ─────────────────                         ─────────────
 *                                       (1) builds VouchRequest:
 *                                           { subjectPub, nonce, name }
 *                                           signs it with her OWN key
 *                                           → shows QR
 *   (2) scans QR
 *       verifies Bilkisu's self-signature
 *       ── this is proof-of-possession: it
 *          proves the person holding the
 *          phone controls the secret key
 *          for the pubkey being claimed.
 *          Without it, Bilkisu could show
 *          a QR containing someone else's
 *          public key and collect vouches
 *          into an identity she cannot use
 *          — or worse, that someone else
 *          is being impersonated into.
 *       sees "Vouch for Bilkisu? [tier]"
 *   (3) signs TrustVoucher:
 *       { issuerPub, subjectPub, nonce,
 *         tier, issuedAt, expiresAt }
 *       → shows QR
 *                                       (4) scans QR
 *                                           verifies Adaeze's signature
 *                                           checks subjectPub === her own
 *                                           checks nonce === the one she minted
 *                                           persists to IndexedDB
 *
 * WHY THE NONCE
 * It binds the voucher to one specific in-person meeting. Without it, a
 * voucher is a standing bearer token: anyone who photographs Adaeze's QR
 * screen replays it forever, and Adaeze cannot tell a fresh vouch from a
 * three-month-old screenshot. With it, Bilkisu's device rejects any voucher
 * whose nonce it did not just mint.
 *
 * WHAT THIS DOES *NOT* DEFEND AGAINST — stated plainly:
 * A determined Adaeze can vouch for 50 keys she controls. No cryptography
 * stops that; it is a social attack, and it is answered in `trust.ts` by
 * capacity-constrained propagation, not here.
 * ───────────────────────────────────────────────────────────────────────────
 */

import {
  ByteReader,
  ByteWriter,
  PayloadType,
  readHeader,
  writeHeader,
  toBase64Url,
  fromBase64Url,
  wrapForQR,
  unwrapFromQR,
  CodecError,
} from '../codec'
import {
  type KeyPair,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  contentId,
  fingerprint,
  pubKeyToId,
  randomBytes,
  sign,
  verify,
} from '../crypto/keys'
import { log } from '../telemetry'
import { TrustTier, VoucherStatus, type TrustVoucher } from '../db/schema'

export const NONCE_BYTES = 8
export const MAX_NAME_BYTES = 40

/** Wall clocks disagree. Accept up to 5 min of future-dating before calling foul. */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000

/** Default voucher lifetime: 1 year. Trust should require renewal, not be permanent. */
export const DEFAULT_VOUCHER_TTL_MS = 365 * 24 * 60 * 60_000

/** A request is a live handshake, not a document. It goes stale fast. */
export const REQUEST_FRESHNESS_MS = 30 * 60_000

/* ─────────────────────────── result types ─────────────────────────── */

export enum RejectReason {
  Malformed = 'MALFORMED',
  WrongPayloadType = 'WRONG_PAYLOAD_TYPE',
  BadSignature = 'BAD_SIGNATURE',
  Expired = 'EXPIRED',
  NotYetValid = 'NOT_YET_VALID',
  StaleRequest = 'STALE_REQUEST',
  SelfVouch = 'SELF_VOUCH',
  SubjectMismatch = 'SUBJECT_MISMATCH',
  NonceMismatch = 'NONCE_MISMATCH',
  InvalidTier = 'INVALID_TIER',
}

export const REJECT_MESSAGES: Record<RejectReason, string> = {
  [RejectReason.Malformed]: 'This code is damaged or is not a Lacinia code.',
  [RejectReason.WrongPayloadType]: 'This is a Lacinia code, but not the kind expected here.',
  [RejectReason.BadSignature]: 'Signature does not match. Do not trust this code.',
  [RejectReason.Expired]: 'This vouch has expired. Ask for a fresh one.',
  [RejectReason.NotYetValid]: 'Dated in the future — check the clock on the other phone.',
  [RejectReason.StaleRequest]: 'This request is old. Ask them to show a fresh code.',
  [RejectReason.SelfVouch]: 'You cannot vouch for yourself.',
  [RejectReason.SubjectMismatch]: 'This vouch was issued to a different person.',
  [RejectReason.NonceMismatch]: 'This vouch does not match your request — possible replay.',
  [RejectReason.InvalidTier]: 'Unknown trust tier in this code.',
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: RejectReason; detail: string }

function reject<T>(reason: RejectReason, detail: string): ParseResult<T> {
  log.warn('vouch', `rejected: ${reason}`, { detail })
  return { ok: false, reason, detail }
}

/* ──────────────────────────── step 1 & 2 ──────────────────────────── */

export interface VouchRequest {
  subjectPub: string
  subjectFingerprint: string
  displayName: string
  /** base64url of NONCE_BYTES random bytes. */
  nonce: string
  issuedAt: number
}

export interface EncodedPayload {
  bytes: Uint8Array
  /** `LCN1:<base64url>` — the exact string to render into a QR. */
  qr: string
}

/**
 * Bilkisu's device builds this. The self-signature over the canonical prefix is
 * the proof-of-possession described at the top of this file.
 */
export function createVouchRequest(
  self: KeyPair,
  displayName: string,
  opts: { now?: number; nonce?: Uint8Array } = {},
): { request: VouchRequest; encoded: EncodedPayload } {
  const now = opts.now ?? Date.now()
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES)
  if (nonce.length !== NONCE_BYTES) {
    throw new CodecError(`nonce must be ${NONCE_BYTES} bytes`)
  }

  const writer = new ByteWriter(160)
  writeHeader(writer, PayloadType.VouchRequest)
  writer.fixed(self.publicKey, PUBLIC_KEY_BYTES)
  writer.fixed(nonce, NONCE_BYTES)
  writer.u48(now)
  writer.shortString(displayName, MAX_NAME_BYTES)

  // Everything written so far is the signed prefix. Signing the literal bytes
  // means there is no canonical-form step that could disagree across devices.
  const signedPrefix = writer.snapshot()
  writer.fixed(sign(signedPrefix, self.secretKey), SIGNATURE_BYTES)
  const bytes = writer.finish()

  const request: VouchRequest = {
    subjectPub: self.pubKeyId,
    subjectFingerprint: fingerprint(self.publicKey),
    // Round-trip the name through the codec so what we display is exactly what
    // the far side will decode, truncation included.
    displayName: decodeName(bytes),
    nonce: toBase64Url(nonce),
    issuedAt: now,
  }

  log.info('vouch', 'vouch request created', {
    bytes: bytes.length,
    qrChars: bytes.length && wrapForQR(bytes).length,
    fingerprint: request.subjectFingerprint,
  })

  return { request, encoded: { bytes, qr: wrapForQR(bytes) } }
}

function decodeName(bytes: Uint8Array): string {
  const r = new ByteReader(bytes)
  readHeader(r)
  r.bytes(PUBLIC_KEY_BYTES)
  r.bytes(NONCE_BYTES)
  r.u48()
  return r.shortString()
}

/** Adaeze's device runs this on the scanned string. Never throws. */
export function parseVouchRequest(
  input: string | Uint8Array,
  opts: { now?: number; requireFresh?: boolean } = {},
): ParseResult<VouchRequest> {
  const now = opts.now ?? Date.now()

  let reader: ByteReader
  let subjectPubBytes: Uint8Array
  let nonceBytes: Uint8Array
  let issuedAt: number
  let displayName: string
  let signedPrefix: Uint8Array
  let signature: Uint8Array

  try {
    const bytes = typeof input === 'string' ? unwrapFromQR(input) : input
    reader = new ByteReader(bytes)
    const header = readHeader(reader)
    if (header.type !== PayloadType.VouchRequest) {
      return reject(
        RejectReason.WrongPayloadType,
        `expected VouchRequest(${PayloadType.VouchRequest}), got ${header.type}`,
      )
    }
    subjectPubBytes = reader.bytes(PUBLIC_KEY_BYTES)
    nonceBytes = reader.bytes(NONCE_BYTES)
    issuedAt = reader.u48()
    displayName = reader.shortString()
    signedPrefix = reader.consumed()
    signature = reader.bytes(SIGNATURE_BYTES)
  } catch (err) {
    return reject(RejectReason.Malformed, err instanceof Error ? err.message : String(err))
  }

  if (!verify(signature, signedPrefix, subjectPubBytes)) {
    // Whoever produced this does not hold the secret key for the pubkey inside
    // it. This is the impersonation case — refuse loudly.
    return reject(RejectReason.BadSignature, 'self-signature failed proof-of-possession')
  }

  if (issuedAt - now > CLOCK_SKEW_TOLERANCE_MS) {
    return reject(RejectReason.NotYetValid, `issued ${issuedAt - now}ms in the future`)
  }

  if (opts.requireFresh !== false && now - issuedAt > REQUEST_FRESHNESS_MS) {
    return reject(RejectReason.StaleRequest, `request is ${Math.round((now - issuedAt) / 60_000)} min old`)
  }

  return {
    ok: true,
    value: {
      subjectPub: pubKeyToId(subjectPubBytes),
      subjectFingerprint: fingerprint(subjectPubBytes),
      displayName,
      nonce: toBase64Url(nonceBytes),
      issuedAt,
    },
  }
}

/* ──────────────────────────── step 3 & 4 ──────────────────────────── */

export interface ParsedVoucher {
  id: string
  issuerPub: string
  issuerFingerprint: string
  subjectPub: string
  tier: TrustTier
  nonce: string
  issuedAt: number
  expiresAt: number
  signature: string
  signedBytes: string
}

const VALID_TIERS = new Set<number>([
  TrustTier.Observer,
  TrustTier.Neighbour,
  TrustTier.Steward,
  TrustTier.Anchor,
])

/**
 * Adaeze signs. Note we refuse a self-vouch here as well as in the trust graph:
 * defence at the point of creation AND at the point of scoring, because a
 * hand-crafted payload can skip this function entirely.
 */
export function issueVoucher(
  issuer: KeyPair,
  request: VouchRequest,
  tier: TrustTier,
  opts: { now?: number; ttlMs?: number } = {},
): { voucher: ParsedVoucher; encoded: EncodedPayload } {
  const now = opts.now ?? Date.now()
  const expiresAt = now + (opts.ttlMs ?? DEFAULT_VOUCHER_TTL_MS)

  if (request.subjectPub === issuer.pubKeyId) {
    throw new Error('Refusing to self-vouch: issuer and subject are the same key.')
  }
  if (!VALID_TIERS.has(tier)) {
    throw new Error(`Unknown trust tier: ${tier}`)
  }

  const subjectPubBytes = fromBase64Url(request.subjectPub)
  const nonceBytes = fromBase64Url(request.nonce)
  if (subjectPubBytes.length !== PUBLIC_KEY_BYTES) throw new CodecError('bad subject key length')
  if (nonceBytes.length !== NONCE_BYTES) throw new CodecError('bad nonce length')

  const writer = new ByteWriter(192)
  writeHeader(writer, PayloadType.TrustVoucher)
  writer.fixed(issuer.publicKey, PUBLIC_KEY_BYTES)
  writer.fixed(subjectPubBytes, PUBLIC_KEY_BYTES)
  writer.fixed(nonceBytes, NONCE_BYTES)
  writer.u48(now)
  writer.u48(expiresAt)
  writer.u8(tier)

  const signedPrefix = writer.snapshot()
  const signature = sign(signedPrefix, issuer.secretKey)
  writer.fixed(signature, SIGNATURE_BYTES)
  const bytes = writer.finish()

  const voucher: ParsedVoucher = {
    // Content-addressed by the SIGNED bytes: deterministic, so the same voucher
    // reaching a device by two routes collapses to one row with no merge logic.
    id: contentId(signedPrefix),
    issuerPub: issuer.pubKeyId,
    issuerFingerprint: fingerprint(issuer.publicKey),
    subjectPub: request.subjectPub,
    tier,
    nonce: request.nonce,
    issuedAt: now,
    expiresAt,
    signature: toBase64Url(signature),
    signedBytes: toBase64Url(signedPrefix),
  }

  log.info('vouch', 'voucher issued', {
    bytes: bytes.length,
    qrChars: wrapForQR(bytes).length,
    tier: TrustTier[tier],
    subject: request.subjectFingerprint,
  })

  return { voucher, encoded: { bytes, qr: wrapForQR(bytes) } }
}

/** Bilkisu's device runs this on the scanned voucher string. Never throws. */
export function parseVoucher(
  input: string | Uint8Array,
  opts: { now?: number } = {},
): ParseResult<ParsedVoucher> {
  const now = opts.now ?? Date.now()

  let issuerPubBytes: Uint8Array
  let subjectPubBytes: Uint8Array
  let nonceBytes: Uint8Array
  let issuedAt: number
  let expiresAt: number
  let tier: number
  let signedPrefix: Uint8Array
  let signature: Uint8Array

  try {
    const bytes = typeof input === 'string' ? unwrapFromQR(input) : input
    const reader = new ByteReader(bytes)
    const header = readHeader(reader)
    if (header.type !== PayloadType.TrustVoucher) {
      return reject(
        RejectReason.WrongPayloadType,
        `expected TrustVoucher(${PayloadType.TrustVoucher}), got ${header.type}`,
      )
    }
    issuerPubBytes = reader.bytes(PUBLIC_KEY_BYTES)
    subjectPubBytes = reader.bytes(PUBLIC_KEY_BYTES)
    nonceBytes = reader.bytes(NONCE_BYTES)
    issuedAt = reader.u48()
    expiresAt = reader.u48()
    tier = reader.u8()
    signedPrefix = reader.consumed()
    signature = reader.bytes(SIGNATURE_BYTES)
  } catch (err) {
    return reject(RejectReason.Malformed, err instanceof Error ? err.message : String(err))
  }

  if (!verify(signature, signedPrefix, issuerPubBytes)) {
    return reject(RejectReason.BadSignature, 'issuer signature failed verification')
  }
  if (!VALID_TIERS.has(tier)) {
    return reject(RejectReason.InvalidTier, `tier ${tier} is not a known tier`)
  }

  const issuerPub = pubKeyToId(issuerPubBytes)
  const subjectPub = pubKeyToId(subjectPubBytes)
  if (issuerPub === subjectPub) {
    return reject(RejectReason.SelfVouch, 'issuer and subject are the same key')
  }
  if (issuedAt - now > CLOCK_SKEW_TOLERANCE_MS) {
    return reject(RejectReason.NotYetValid, `issued ${issuedAt - now}ms in the future`)
  }
  if (expiresAt <= now) {
    return reject(RejectReason.Expired, `expired ${Math.round((now - expiresAt) / 86_400_000)} days ago`)
  }

  return {
    ok: true,
    value: {
      id: contentId(signedPrefix),
      issuerPub,
      issuerFingerprint: fingerprint(issuerPubBytes),
      subjectPub,
      tier: tier as TrustTier,
      nonce: toBase64Url(nonceBytes),
      issuedAt,
      expiresAt,
      signature: toBase64Url(signature),
      signedBytes: toBase64Url(signedPrefix),
    },
  }
}

/**
 * Final gate before persistence. Signature validity alone is not enough — a
 * cryptographically perfect voucher issued to someone else, or answering a
 * request we never made, must still be refused.
 */
export function acceptVoucher(
  parsed: ParsedVoucher,
  self: { pubKeyId: string },
  expectedNonce: string | null,
  opts: { now?: number; deviceHlc: string } = { deviceHlc: '' },
): ParseResult<TrustVoucher> {
  const now = opts.now ?? Date.now()

  if (parsed.subjectPub !== self.pubKeyId) {
    return reject(
      RejectReason.SubjectMismatch,
      `voucher subject ${parsed.subjectPub.slice(0, 12)}… is not this device's key`,
    )
  }
  if (expectedNonce !== null && parsed.nonce !== expectedNonce) {
    return reject(
      RejectReason.NonceMismatch,
      'nonce does not match the pending request — replayed or misdirected voucher',
    )
  }

  return {
    ok: true,
    value: {
      id: parsed.id,
      issuerPub: parsed.issuerPub,
      subjectPub: parsed.subjectPub,
      tier: parsed.tier,
      nonce: parsed.nonce,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
      signature: parsed.signature,
      signedBytes: parsed.signedBytes,
      status: VoucherStatus.Valid,
      receivedAt: now,
      direction: 'INBOUND',
      hlc: opts.deviceHlc,
    },
  }
}

/** Decodes the signed prefix of a voucher — the authoritative field values. */
function decodeVoucherPrefix(prefix: Uint8Array): {
  issuerPub: string
  subjectPub: string
  nonce: string
  issuedAt: number
  expiresAt: number
  tier: number
} {
  const reader = new ByteReader(prefix)
  const header = readHeader(reader)
  if (header.type !== PayloadType.TrustVoucher) throw new CodecError('not a voucher prefix')
  const issuerPub = pubKeyToId(reader.bytes(PUBLIC_KEY_BYTES))
  const subjectPub = pubKeyToId(reader.bytes(PUBLIC_KEY_BYTES))
  const nonce = toBase64Url(reader.bytes(NONCE_BYTES))
  const issuedAt = reader.u48()
  const expiresAt = reader.u48()
  const tier = reader.u8()
  return { issuerPub, subjectPub, nonce, issuedAt, expiresAt, tier }
}

/**
 * Re-verify a stored voucher from its retained bytes.
 *
 * Run on load, not just on scan: rows can be edited by anything with access to
 * IndexedDB, so "it's in our database" is not evidence of anything.
 *
 * CRITICAL — the signature check alone is NOT sufficient here. The row's
 * `tier`, `expiresAt` etc. are denormalised copies of values that live inside
 * `signedBytes`, kept as columns so Dexie can index them. An attacker with
 * IndexedDB access can rewrite the column and leave `signedBytes` untouched:
 * the signature still verifies perfectly, and the UI reads the column. So we
 * decode the signed bytes and require every denormalised field to agree with
 * the value that was actually signed. The bytes are the truth; the columns are
 * a cache.
 */
export function reverifyStoredVoucher(v: TrustVoucher, now = Date.now()): VoucherStatus {
  if (v.status === VoucherStatus.Revoked) return VoucherStatus.Revoked
  try {
    const signedBytes = fromBase64Url(v.signedBytes)
    const signature = fromBase64Url(v.signature)
    const issuerKey = fromBase64Url(v.issuerPub)

    if (!verify(signature, signedBytes, issuerKey)) return VoucherStatus.Invalid

    const signed = decodeVoucherPrefix(signedBytes)
    const agrees =
      signed.issuerPub === v.issuerPub &&
      signed.subjectPub === v.subjectPub &&
      signed.nonce === v.nonce &&
      signed.issuedAt === v.issuedAt &&
      signed.expiresAt === v.expiresAt &&
      signed.tier === v.tier

    if (!agrees) {
      log.error('vouch', 'stored row disagrees with its own signed bytes — tampered', {
        id: v.id,
        rowTier: v.tier,
        signedTier: signed.tier,
      })
      return VoucherStatus.Invalid
    }

    if (v.issuerPub === v.subjectPub) return VoucherStatus.Invalid
    if (contentId(signedBytes) !== v.id) return VoucherStatus.Invalid

    return signed.expiresAt <= now ? VoucherStatus.Expired : VoucherStatus.Valid
  } catch {
    return VoucherStatus.Invalid
  }
}

/** Detects which kind of Lacinia code a scanner just saw, so one scanner handles both. */
export function sniffPayloadType(input: string | Uint8Array): PayloadType | null {
  try {
    const bytes = typeof input === 'string' ? unwrapFromQR(input) : input
    return readHeader(new ByteReader(bytes)).type
  } catch {
    return null
  }
}
