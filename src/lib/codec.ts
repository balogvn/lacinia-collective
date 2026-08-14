/**
 * Byte-level codec for everything that crosses a QR code or a sync bundle.
 *
 * WHY NOT JSON
 * Signatures must be verified byte-identically on a device that never met the
 * signer. `JSON.stringify` gives no key-order guarantee across engines, and
 * numbers round-trip through float formatting. Any "canonical JSON" layer is
 * extra code that can disagree with itself across versions — a class of bug
 * that surfaces as "signature invalid" months later, in the field, unfixable
 * without a migration.
 *
 * Instead: fixed-width big-endian fields written in a declared order. The bytes
 * ARE the canonical form. Signing means "sign the prefix up to the signature
 * field", so there is no separate canonicalisation step to get wrong.
 *
 * MEASURED SIZE BUDGET (drives QR scannability on cheap cameras)
 *   VouchRequest  125 B → 172 b64url chars → QR v9  ECC-M (53×53 modules)
 *   TrustVoucher  153 B → 209 b64url chars → QR v10 ECC-M (57×57 modules)
 *
 * v10 is denser than ideal. It is also the floor for a self-describing
 * Ed25519 voucher: signature (64) + both public keys (64) + nonce (8) +
 * two timestamps (12) + tier + header leaves nothing worth shaving — trimming
 * the nonce and packing timestamps saves ~8 bytes and does not cross a version
 * boundary.
 *
 * There IS a way to reach v8: omit subjectPub and nonce from the wire, since
 * the receiving device already holds both, and have it reconstruct the signed
 * prefix locally before verifying. That saves 40 bytes. We deliberately do NOT
 * do this. It makes the payload non-self-describing, so a voucher scanned on
 * the wrong phone fails with "signature invalid" instead of "this vouch was
 * issued to someone else" — and in the field, a rejection someone cannot act on
 * is worse than a QR that takes a second attempt to read.
 */

export const MAGIC = 0x4c // 'L'
export const WIRE_VERSION = 1

export enum PayloadType {
  VouchRequest = 1,
  TrustVoucher = 2,
  ResourceListing = 3,
  SyncBundleRef = 4,
  SettlementProposal = 5,
  SettlementConfirmation = 6,
}

/* ────────────────────────────── base64url ────────────────────────────── */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Hand-rolled so it behaves identically in Node, browsers and service workers. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64_ALPHABET[(n >>> 18) & 63]! + B64_ALPHABET[(n >>> 12) & 63]! +
           B64_ALPHABET[(n >>> 6) & 63]! + B64_ALPHABET[n & 63]!
  }
  const rem = bytes.length - i
  if (rem === 1) {
    const n = bytes[i]! << 16
    out += B64_ALPHABET[(n >>> 18) & 63]! + B64_ALPHABET[(n >>> 12) & 63]!
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64_ALPHABET[(n >>> 18) & 63]! + B64_ALPHABET[(n >>> 12) & 63]! +
           B64_ALPHABET[(n >>> 6) & 63]!
  }
  return out
}

const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i
  // Tolerate standard base64 too — some QR scanners helpfully "fix" the charset.
  table['+'.charCodeAt(0)] = 62
  table['/'.charCodeAt(0)] = 63
  return table
})()

export function fromBase64Url(text: string): Uint8Array {
  // Trim before stripping padding — a trailing newline from a scanner would
  // otherwise hide the '=' from the regex and corrupt the length maths.
  const clean = text.trim().replace(/=+$/, '')
  const groups = Math.floor(clean.length / 4)
  const rem = clean.length % 4
  if (rem === 1) throw new CodecError('base64url has an orphan character')

  const at = (idx: number): number => {
    const code = clean.charCodeAt(idx)
    const v = code < 128 ? B64_LOOKUP[code]! : -1
    if (v < 0) throw new CodecError(`illegal base64url character at index ${idx}`)
    return v
  }

  const out = new Uint8Array(groups * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0))
  let o = 0
  let i = 0

  for (let g = 0; g < groups; g++, i += 4) {
    const n = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6) | at(i + 3)
    out[o++] = (n >>> 16) & 255
    out[o++] = (n >>> 8) & 255
    out[o++] = n & 255
  }

  if (rem === 2) {
    out[o++] = (((at(i) << 18) | (at(i + 1) << 12)) >>> 16) & 255
  } else if (rem === 3) {
    const n = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6)
    out[o++] = (n >>> 16) & 255
    out[o++] = (n >>> 8) & 255
  }
  return out
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new CodecError('hex string has odd length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new CodecError(`illegal hex at byte ${i}`)
    out[i] = byte
  }
  return out
}

export class CodecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodecError'
  }
}

/* ──────────────────────────── binary writer ──────────────────────────── */

export class ByteWriter {
  private buf: Uint8Array
  private pos = 0

  constructor(capacity = 512) {
    this.buf = new Uint8Array(capacity)
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return
    let next = this.buf.length * 2
    while (next < this.pos + extra) next *= 2
    const grown = new Uint8Array(next)
    grown.set(this.buf.subarray(0, this.pos))
    this.buf = grown
  }

  u8(value: number): this {
    this.ensure(1)
    this.buf[this.pos++] = value & 255
    return this
  }

  u16(value: number): this {
    this.ensure(2)
    this.buf[this.pos++] = (value >>> 8) & 255
    this.buf[this.pos++] = value & 255
    return this
  }

  u32(value: number): this {
    this.ensure(4)
    this.buf[this.pos++] = (value >>> 24) & 255
    this.buf[this.pos++] = (value >>> 16) & 255
    this.buf[this.pos++] = (value >>> 8) & 255
    this.buf[this.pos++] = value & 255
    return this
  }

  /**
   * 48-bit big-endian — our timestamp width. Milliseconds since epoch fit until
   * year 10889, and 6 bytes instead of 8 is 2 fewer bytes of QR per timestamp.
   * Written via division rather than shifts because `<<` truncates to 32 bits.
   */
  u48(value: number): this {
    if (!Number.isFinite(value) || value < 0 || value > 0xffffffffffff) {
      throw new CodecError(`u48 out of range: ${value}`)
    }
    this.ensure(6)
    const v = Math.floor(value)
    const high = Math.floor(v / 0x100000000)
    const low = v >>> 0 === v ? v : v - high * 0x100000000
    this.buf[this.pos++] = (high >>> 8) & 255
    this.buf[this.pos++] = high & 255
    this.buf[this.pos++] = (low >>> 24) & 255
    this.buf[this.pos++] = (low >>> 16) & 255
    this.buf[this.pos++] = (low >>> 8) & 255
    this.buf[this.pos++] = low & 255
    return this
  }

  bytes(value: Uint8Array): this {
    this.ensure(value.length)
    this.buf.set(value, this.pos)
    this.pos += value.length
    return this
  }

  fixed(value: Uint8Array, length: number): this {
    if (value.length !== length) {
      throw new CodecError(`expected exactly ${length} bytes, got ${value.length}`)
    }
    return this.bytes(value)
  }

  /**
   * u8 length prefix + UTF-8 body, truncated at a codepoint boundary.
   *
   * Naively cutting at `maxBytes` corrupts any multi-byte codepoint straddling
   * the boundary, and the far side decodes U+FFFD. Nigerian names make this the
   * common case, not an edge case: "Ọlá", "Ngọzi", "Àìná" are all multi-byte in
   * the exact positions a 40-byte cap lands on.
   *
   * Walking back over continuation bytes alone is NOT enough — that leaves an
   * orphaned lead byte when the cut falls immediately after one. We locate the
   * last sequence start, read its declared length, and drop the whole sequence
   * if it does not fit.
   */
  shortString(value: string, maxBytes = 255): this {
    let encoded = new TextEncoder().encode(value)

    if (encoded.length > maxBytes) {
      let end = maxBytes

      // Walk back to the start of the sequence containing byte `end - 1`.
      let start = end - 1
      while (start >= 0 && (encoded[start]! & 0xc0) === 0x80) start--

      if (start >= 0) {
        const lead = encoded[start]!
        const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
        // Incomplete sequence at the cut → drop it entirely.
        if (start + seqLen > end) end = start
      }

      encoded = encoded.subarray(0, end)
    }

    this.u8(encoded.length)
    return this.bytes(encoded)
  }

  get length(): number {
    return this.pos
  }

  /** Bytes written so far — this is what gets signed. */
  snapshot(): Uint8Array {
    return this.buf.slice(0, this.pos)
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos)
  }
}

/* ──────────────────────────── binary reader ──────────────────────────── */

export class ByteReader {
  private pos = 0

  constructor(private readonly buf: Uint8Array) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new CodecError(
        `truncated payload: needed ${n} bytes at offset ${this.pos}, only ${this.buf.length - this.pos} remain`,
      )
    }
  }

  u8(): number {
    this.need(1)
    return this.buf[this.pos++]!
  }

  u16(): number {
    this.need(2)
    return (this.buf[this.pos++]! << 8) | this.buf[this.pos++]!
  }

  // Read multi-byte integers through explicit locals rather than chained
  // `this.pos++` inside one expression. Both are correct in JS, but the
  // explicit form survives refactoring by someone who isn't thinking about
  // evaluation order at 2am.
  u32(): number {
    this.need(4)
    const b0 = this.buf[this.pos++]!
    const b1 = this.buf[this.pos++]!
    const b2 = this.buf[this.pos++]!
    const b3 = this.buf[this.pos++]!
    return b0 * 0x1000000 + ((b1 << 16) | (b2 << 8) | b3)
  }

  u48(): number {
    this.need(6)
    const b0 = this.buf[this.pos++]!
    const b1 = this.buf[this.pos++]!
    const b2 = this.buf[this.pos++]!
    const b3 = this.buf[this.pos++]!
    const b4 = this.buf[this.pos++]!
    const b5 = this.buf[this.pos++]!
    const high = (b0 << 8) | b1
    const low = b2 * 0x1000000 + ((b3 << 16) | (b4 << 8) | b5)
    return high * 0x100000000 + low
  }

  bytes(n: number): Uint8Array {
    this.need(n)
    const out = this.buf.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  shortString(): string {
    const len = this.u8()
    return new TextDecoder().decode(this.bytes(len))
  }

  /** The prefix consumed so far — i.e. the exact bytes that were signed. */
  consumed(): Uint8Array {
    return this.buf.slice(0, this.pos)
  }

  get offset(): number {
    return this.pos
  }

  get remaining(): number {
    return this.buf.length - this.pos
  }
}

/* ───────────────────────────── QR envelope ───────────────────────────── */

/**
 * Human-visible scheme prefix. Camera apps and generic scanners show this to
 * the user, so it doubles as "which app opens this". Keep it short — every
 * character costs QR density.
 */
export const QR_SCHEME = 'LCN1:'

export function wrapForQR(payload: Uint8Array): string {
  return QR_SCHEME + toBase64Url(payload)
}

export function unwrapFromQR(text: string): Uint8Array {
  const trimmed = text.trim()
  const body = trimmed.startsWith(QR_SCHEME) ? trimmed.slice(QR_SCHEME.length) : trimmed
  if (!body) throw new CodecError('empty QR payload')
  return fromBase64Url(body)
}

/** Reads and validates the 4-byte header common to every payload type. */
export function readHeader(reader: ByteReader): { type: PayloadType; flags: number } {
  const magic = reader.u8()
  if (magic !== MAGIC) {
    throw new CodecError(`not a Lacinia payload (magic 0x${magic.toString(16)})`)
  }
  const version = reader.u8()
  if (version !== WIRE_VERSION) {
    throw new CodecError(
      `unsupported wire version ${version} — this device speaks v${WIRE_VERSION}. Update the app.`,
    )
  }
  return { type: reader.u8() as PayloadType, flags: reader.u8() }
}

export function writeHeader(writer: ByteWriter, type: PayloadType, flags = 0): ByteWriter {
  return writer.u8(MAGIC).u8(WIRE_VERSION).u8(type).u8(flags)
}
