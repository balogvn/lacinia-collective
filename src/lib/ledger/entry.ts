/**
 * SETTLEMENT PROTOCOL — turning an hour of work into a signed ledger entry.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE HANDSHAKE
 *
 *   Adaeze (did the work)                    Bilkisu (received it)
 *   ─────────────────────                    ─────────────────────
 *   1. proposes a settlement:
 *      { from: Bilkisu, to: Adaeze,
 *        amount: 60, listingRef, nonce }
 *      signs it as the PROVIDER
 *      → shows QR
 *                                      2. scans it
 *                                         sees "Pay Adaeze 60 minutes
 *                                         for Tailoring?"
 *                                         her device checks HER OWN balance
 *                                         against HER credit limit
 *                                         signs as the PAYER
 *                                         → shows QR back
 *   3. scans the confirmation
 *      now holds a two-signature entry
 *      both devices store it
 *
 * WHY THE PROVIDER PROPOSES AND THE PAYER CONFIRMS
 * The provider knows what was actually done. The payer must consent, because
 * nobody may be charged without agreeing — a one-sided "I hereby charge you"
 * would make the ledger worthless. Two signatures over identical bytes is the
 * whole security model: an entry with one signature is not an entry.
 *
 * A DELIBERATE REVERSAL OF A TASK 1 DECISION
 * The confirmation QR is NOT self-describing: it carries only the nonce and the
 * payer's signature (76 bytes → QR v6), because the proposing device already
 * holds the proposal. In protocol.ts I explicitly refused this trick for
 * vouchers — a voucher is a durable credential that gets re-scanned and
 * relayed, so "signature invalid" would be a rejection nobody could act on.
 * A confirmation answers local state, so the device can say "this doesn't match
 * any pending offer on this phone", which is precise and actionable. Different
 * artefact, different tradeoff.
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
  fromHex,
  toHex,
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
import { MAX_ENTRY_CREDITS, type LedgerEntry, type TimeCredits } from '../db/schema'

export const NONCE_BYTES = 8
export const LISTING_REF_BYTES = 8

/** Wall clocks disagree; same tolerance as the vouching protocol. */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000
/** A proposal is a live handshake between two people standing together. */
export const PROPOSAL_FRESHNESS_MS = 30 * 60_000

export enum SettlementReject {
  Malformed = 'MALFORMED',
  WrongPayloadType = 'WRONG_PAYLOAD_TYPE',
  BadSignature = 'BAD_SIGNATURE',
  SelfPayment = 'SELF_PAYMENT',
  StaleProposal = 'STALE_PROPOSAL',
  NotYetValid = 'NOT_YET_VALID',
  InvalidAmount = 'INVALID_AMOUNT',
  NoPendingProposal = 'NO_PENDING_PROPOSAL',
  NonceMismatch = 'NONCE_MISMATCH',
}

export const SETTLEMENT_MESSAGES: Record<SettlementReject, string> = {
  [SettlementReject.Malformed]: 'This code is damaged or is not a Lacinia code.',
  [SettlementReject.WrongPayloadType]: 'This is a Lacinia code, but not a settlement.',
  [SettlementReject.BadSignature]: 'Signature does not match. Do not accept this.',
  [SettlementReject.SelfPayment]: 'You cannot pay yourself.',
  [SettlementReject.StaleProposal]: 'This offer is old. Ask them to show a fresh one.',
  [SettlementReject.NotYetValid]: 'Dated in the future — check the clock on the other phone.',
  [SettlementReject.InvalidAmount]: 'That amount is not allowed.',
  [SettlementReject.NoPendingProposal]:
    'No offer on this phone matches that confirmation. Show your code again.',
  [SettlementReject.NonceMismatch]: 'This confirmation answers a different offer.',
}

export type SettlementResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: SettlementReject; detail: string }

function reject<T>(reason: SettlementReject, detail: string): SettlementResult<T> {
  log.warn('sync', `settlement rejected: ${reason}`, { detail })
  return { ok: false, reason, detail }
}

/* ──────────────────────────── proposal ──────────────────────────── */

export interface SettlementProposal {
  fromPub: string
  fromFingerprint: string
  toPub: string
  toFingerprint: string
  amount: TimeCredits
  listingRef: string
  nonce: string
  agreedAt: number
  /** The provider's signature, base64url. */
  toSig: string
  /** The exact bytes both parties sign — 94 fixed-width bytes. */
  signedBytes: string
}

export interface EncodedPayload {
  bytes: Uint8Array
  qr: string
}

/** Normalises a listing id to the 8-byte on-wire reference. */
export function listingRefFor(listingId: string | null | undefined): Uint8Array {
  if (!listingId) return new Uint8Array(LISTING_REF_BYTES)
  const hex = listingId.replace(/[^0-9a-f]/gi, '').slice(0, LISTING_REF_BYTES * 2)
  const padded = hex.padEnd(LISTING_REF_BYTES * 2, '0')
  return fromHex(padded)
}

/**
 * Builds the document both parties sign.
 *
 * Fixed-width fields written in a declared order, exactly as in codec.ts: the
 * bytes ARE the canonical form, so there is no canonicalisation step that two
 * devices could disagree about.
 */
function settlementDocument(input: {
  fromPub: Uint8Array
  toPub: Uint8Array
  amount: number
  agreedAt: number
  nonce: Uint8Array
  listingRef: Uint8Array
}): Uint8Array {
  const writer = new ByteWriter(128)
  writeHeader(writer, PayloadType.SettlementProposal)
  writer.fixed(input.fromPub, PUBLIC_KEY_BYTES)
  writer.fixed(input.toPub, PUBLIC_KEY_BYTES)
  writer.u32(input.amount)
  writer.u48(input.agreedAt)
  writer.fixed(input.nonce, NONCE_BYTES)
  writer.fixed(input.listingRef, LISTING_REF_BYTES)
  return writer.finish()
}

export function isValidAmount(amount: number): boolean {
  return Number.isInteger(amount) && amount > 0 && amount <= MAX_ENTRY_CREDITS
}

/** Step 1 — the provider proposes. */
export function proposeSettlement(
  provider: KeyPair,
  input: {
    payerPub: string
    amount: TimeCredits
    listingId?: string | null
    now?: number
    nonce?: Uint8Array
  },
): { proposal: SettlementProposal; encoded: EncodedPayload } {
  const now = input.now ?? Date.now()
  const nonce = input.nonce ?? randomBytes(NONCE_BYTES)

  if (!isValidAmount(input.amount)) {
    throw new Error(
      `Amount must be a whole number of minutes between 1 and ${MAX_ENTRY_CREDITS}.`,
    )
  }
  if (input.payerPub === provider.pubKeyId) {
    throw new Error('Refusing to settle: payer and provider are the same key.')
  }

  const fromPub = fromBase64Url(input.payerPub)
  if (fromPub.length !== PUBLIC_KEY_BYTES) throw new CodecError('bad payer key length')

  const listingRef = listingRefFor(input.listingId)
  const doc = settlementDocument({
    fromPub,
    toPub: provider.publicKey,
    amount: input.amount,
    agreedAt: now,
    nonce,
    listingRef,
  })

  const toSig = sign(doc, provider.secretKey)

  const writer = new ByteWriter(192)
  writer.bytes(doc)
  writer.fixed(toSig, SIGNATURE_BYTES)
  const bytes = writer.finish()

  const proposal: SettlementProposal = {
    fromPub: input.payerPub,
    fromFingerprint: fingerprint(fromPub),
    toPub: provider.pubKeyId,
    toFingerprint: fingerprint(provider.publicKey),
    amount: input.amount,
    listingRef: toHex(listingRef),
    nonce: toBase64Url(nonce),
    agreedAt: now,
    toSig: toBase64Url(toSig),
    signedBytes: toBase64Url(doc),
  }

  log.info('sync', 'settlement proposed', {
    bytes: bytes.length,
    qrChars: wrapForQR(bytes).length,
    amount: input.amount,
  })

  return { proposal, encoded: { bytes, qr: wrapForQR(bytes) } }
}

/** Step 2 — the payer's device reads it. Never throws. */
export function parseProposal(
  input: string | Uint8Array,
  opts: { now?: number; requireFresh?: boolean } = {},
): SettlementResult<SettlementProposal> {
  const now = opts.now ?? Date.now()

  let fromPubBytes: Uint8Array
  let toPubBytes: Uint8Array
  let amount: number
  let agreedAt: number
  let nonceBytes: Uint8Array
  let listingRefBytes: Uint8Array
  let doc: Uint8Array
  let toSig: Uint8Array

  try {
    const bytes = typeof input === 'string' ? unwrapFromQR(input) : input
    const reader = new ByteReader(bytes)
    const header = readHeader(reader)
    if (header.type !== PayloadType.SettlementProposal) {
      return reject(
        SettlementReject.WrongPayloadType,
        `expected SettlementProposal(${PayloadType.SettlementProposal}), got ${header.type}`,
      )
    }
    fromPubBytes = reader.bytes(PUBLIC_KEY_BYTES)
    toPubBytes = reader.bytes(PUBLIC_KEY_BYTES)
    amount = reader.u32()
    agreedAt = reader.u48()
    nonceBytes = reader.bytes(NONCE_BYTES)
    listingRefBytes = reader.bytes(LISTING_REF_BYTES)
    doc = reader.consumed()
    toSig = reader.bytes(SIGNATURE_BYTES)
  } catch (err) {
    return reject(SettlementReject.Malformed, err instanceof Error ? err.message : String(err))
  }

  if (!verify(toSig, doc, toPubBytes)) {
    return reject(SettlementReject.BadSignature, 'provider signature failed verification')
  }
  if (!isValidAmount(amount)) {
    return reject(SettlementReject.InvalidAmount, `amount ${amount} is out of range`)
  }

  const fromPub = pubKeyToId(fromPubBytes)
  const toPub = pubKeyToId(toPubBytes)
  if (fromPub === toPub) {
    return reject(SettlementReject.SelfPayment, 'payer and provider are the same key')
  }
  if (agreedAt - now > CLOCK_SKEW_TOLERANCE_MS) {
    return reject(SettlementReject.NotYetValid, `dated ${agreedAt - now}ms in the future`)
  }
  if (opts.requireFresh !== false && now - agreedAt > PROPOSAL_FRESHNESS_MS) {
    return reject(
      SettlementReject.StaleProposal,
      `offer is ${Math.round((now - agreedAt) / 60_000)} min old`,
    )
  }

  return {
    ok: true,
    value: {
      fromPub,
      fromFingerprint: fingerprint(fromPubBytes),
      toPub,
      toFingerprint: fingerprint(toPubBytes),
      amount,
      listingRef: toHex(listingRefBytes),
      nonce: toBase64Url(nonceBytes),
      agreedAt,
      toSig: toBase64Url(toSig),
      signedBytes: toBase64Url(doc),
    },
  }
}

/* ──────────────────────────── confirmation ──────────────────────────── */

/**
 * Step 2b — the payer signs the SAME bytes and returns only the nonce and their
 * signature. 76 bytes → 102 base64url chars → QR v6, which scans instantly.
 */
export function confirmSettlement(
  payer: KeyPair,
  proposal: SettlementProposal,
): { entry: LedgerEntry; encoded: EncodedPayload } {
  if (proposal.fromPub !== payer.pubKeyId) {
    throw new Error('This offer was addressed to a different person.')
  }

  const doc = fromBase64Url(proposal.signedBytes)
  const fromSig = sign(doc, payer.secretKey)

  const writer = new ByteWriter(96)
  writeHeader(writer, PayloadType.SettlementConfirmation)
  writer.fixed(fromBase64Url(proposal.nonce), NONCE_BYTES)
  writer.fixed(fromSig, SIGNATURE_BYTES)
  const bytes = writer.finish()

  const entry: LedgerEntry = {
    id: contentId(doc),
    fromPub: proposal.fromPub,
    toPub: proposal.toPub,
    amount: proposal.amount,
    listingRef: proposal.listingRef,
    nonce: proposal.nonce,
    agreedAt: proposal.agreedAt,
    toSig: proposal.toSig,
    fromSig: toBase64Url(fromSig),
    signedBytes: proposal.signedBytes,
    recordedAt: Date.now(),
    hlc: '',
  }

  log.info('sync', 'settlement confirmed by payer', {
    bytes: bytes.length,
    qrChars: wrapForQR(bytes).length,
  })

  return { entry, encoded: { bytes, qr: wrapForQR(bytes) } }
}

export interface ParsedConfirmation {
  nonce: string
  fromSig: string
}

export function parseConfirmation(
  input: string | Uint8Array,
): SettlementResult<ParsedConfirmation> {
  try {
    const bytes = typeof input === 'string' ? unwrapFromQR(input) : input
    const reader = new ByteReader(bytes)
    const header = readHeader(reader)
    if (header.type !== PayloadType.SettlementConfirmation) {
      return reject(
        SettlementReject.WrongPayloadType,
        `expected SettlementConfirmation(${PayloadType.SettlementConfirmation}), got ${header.type}`,
      )
    }
    const nonce = toBase64Url(reader.bytes(NONCE_BYTES))
    const fromSig = toBase64Url(reader.bytes(SIGNATURE_BYTES))
    return { ok: true, value: { nonce, fromSig } }
  } catch (err) {
    return reject(SettlementReject.Malformed, err instanceof Error ? err.message : String(err))
  }
}

/**
 * Step 3 — the provider matches a confirmation to a pending proposal.
 *
 * The nonce is what makes this safe: a confirmation lifted from a different
 * exchange cannot be replayed here, because it answers a nonce this device
 * never minted.
 */
export function completeSettlement(
  confirmation: ParsedConfirmation,
  pending: readonly SettlementProposal[],
  opts: { now?: number } = {},
): SettlementResult<LedgerEntry> {
  const proposal = pending.find((p) => p.nonce === confirmation.nonce)
  if (!proposal) {
    return reject(
      SettlementReject.NoPendingProposal,
      `no pending proposal matches nonce ${confirmation.nonce}`,
    )
  }

  const doc = fromBase64Url(proposal.signedBytes)
  const fromSig = fromBase64Url(confirmation.fromSig)
  const payerKey = fromBase64Url(proposal.fromPub)

  if (!verify(fromSig, doc, payerKey)) {
    return reject(SettlementReject.BadSignature, 'payer signature failed verification')
  }

  return {
    ok: true,
    value: {
      id: contentId(doc),
      fromPub: proposal.fromPub,
      toPub: proposal.toPub,
      amount: proposal.amount,
      listingRef: proposal.listingRef,
      nonce: proposal.nonce,
      agreedAt: proposal.agreedAt,
      toSig: proposal.toSig,
      fromSig: confirmation.fromSig,
      signedBytes: proposal.signedBytes,
      recordedAt: opts.now ?? Date.now(),
      hlc: '',
    },
  }
}

/* ──────────────────────────── re-verification ──────────────────────────── */

/**
 * Re-verify a stored entry from its retained bytes.
 *
 * As with vouchers in Task 1, the denormalised columns (`amount`, `fromPub`, …)
 * are a cache that anything with IndexedDB access can rewrite while leaving
 * both signatures perfectly valid. The bytes are the truth, so every column is
 * cross-checked against what was actually signed.
 */
export function reverifyEntry(entry: LedgerEntry): boolean {
  try {
    const doc = fromBase64Url(entry.signedBytes)
    if (!verify(fromBase64Url(entry.toSig), doc, fromBase64Url(entry.toPub))) return false
    if (!verify(fromBase64Url(entry.fromSig), doc, fromBase64Url(entry.fromPub))) return false
    if (contentId(doc) !== entry.id) return false

    const reader = new ByteReader(doc)
    const header = readHeader(reader)
    if (header.type !== PayloadType.SettlementProposal) return false

    const fromPub = pubKeyToId(reader.bytes(PUBLIC_KEY_BYTES))
    const toPub = pubKeyToId(reader.bytes(PUBLIC_KEY_BYTES))
    const amount = reader.u32()
    const agreedAt = reader.u48()
    const nonce = toBase64Url(reader.bytes(NONCE_BYTES))
    const listingRef = toHex(reader.bytes(LISTING_REF_BYTES))

    return (
      fromPub === entry.fromPub &&
      toPub === entry.toPub &&
      amount === entry.amount &&
      agreedAt === entry.agreedAt &&
      nonce === entry.nonce &&
      listingRef === entry.listingRef &&
      fromPub !== toPub &&
      isValidAmount(amount)
    )
  } catch {
    return false
  }
}
