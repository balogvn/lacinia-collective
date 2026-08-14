/**
 * Identity primitives. Rule 4: no email, no password, no server.
 *
 * An identity here is exactly one thing — an Ed25519 keypair generated on the
 * device and never transmitted. There is no account to recover from a support
 * desk, so recovery is a BIP-39 phrase the user writes on paper. That is a real
 * tradeoff and we state it plainly in the UI rather than pretending otherwise.
 *
 * WHY @noble/ed25519 AND NOT WebCrypto
 * WebCrypto's Ed25519 landed in Chrome 137 / Safari 17 / Firefox 129. Our
 * target device is a ₦25–40k Android running an old System WebView, where it is
 * simply absent. A 4KB pure-JS implementation that works on every device beats
 * a native one that works on the devices we are least worried about.
 */

import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { sha256 } from '@noble/hashes/sha256'
import { randomBytes } from '@noble/hashes/utils'
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'

import { toBase64Url, fromBase64Url, toHex } from '../codec'
import { log, timed } from '../telemetry'

// @noble/ed25519 v2 ships no hash. Wiring the sync SHA-512 gives us synchronous
// sign/verify, which keeps signature checks out of the microtask queue during a
// tight scan loop.
ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages))

export const PUBLIC_KEY_BYTES = 32
export const SECRET_KEY_BYTES = 32
export const SIGNATURE_BYTES = 64

export interface KeyPair {
  /** 32 raw bytes. Never leaves the device. */
  secretKey: Uint8Array
  /** 32 raw bytes. */
  publicKey: Uint8Array
  /** base64url of publicKey — the canonical string id used everywhere else. */
  pubKeyId: string
}

export class CryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CryptoError'
  }
}

/* ─────────────────────────── generation ─────────────────────────── */

/** Domain separator: the same seed must never yield the same key in two protocols. */
const DERIVATION_DOMAIN = new TextEncoder().encode('lacinia-collective/identity/v1')

export function generateRecoveryPhrase(): string {
  // 128 bits → 12 words. 24 words is stronger on paper and materially worse in
  // practice: people transcribe half of it and lose the identity anyway.
  return generateMnemonic(wordlist, 128)
}

export function isValidRecoveryPhrase(phrase: string): boolean {
  try {
    return validateMnemonic(normalisePhrase(phrase), wordlist)
  } catch {
    return false
  }
}

/** Collapse whitespace and case so a phrase typed on a phone keyboard still works. */
export function normalisePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function keyPairFromPhrase(phrase: string): KeyPair {
  const normalised = normalisePhrase(phrase)
  if (!validateMnemonic(normalised, wordlist)) {
    throw new CryptoError('Recovery phrase is not valid — check the spelling and word order.')
  }
  const seed = mnemonicToSeedSync(normalised)
  const derived = sha512(ed.etc.concatBytes(DERIVATION_DOMAIN, seed))
  return keyPairFromSecret(derived.slice(0, SECRET_KEY_BYTES))
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  if (secretKey.length !== SECRET_KEY_BYTES) {
    throw new CryptoError(`secret key must be ${SECRET_KEY_BYTES} bytes, got ${secretKey.length}`)
  }
  const publicKey = ed.getPublicKey(secretKey)
  return { secretKey, publicKey, pubKeyId: toBase64Url(publicKey) }
}

/** Fresh identity with no recoverability — used only for ephemeral test fixtures. */
export function generateEphemeralKeyPair(): KeyPair {
  return keyPairFromSecret(randomBytes(SECRET_KEY_BYTES))
}

/* ──────────────────────────── sign/verify ──────────────────────────── */

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return timed('crypto', 'ed25519 sign', () => ed.sign(message, secretKey))
}

/**
 * Never throws. A malformed key or signature from a scanned QR is an expected
 * input, not an exception — the caller wants `false`, not a stack trace inside
 * a camera frame handler running 30 times a second.
 */
export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return timed('crypto', 'ed25519 verify', () => ed.verify(signature, message, publicKey))
  } catch (err) {
    log.warn('crypto', 'verify rejected malformed input', {
      error: err instanceof Error ? err.message : String(err),
      sigLen: signature.length,
      keyLen: publicKey.length,
    })
    return false
  }
}

/* ──────────────────────────── identifiers ──────────────────────────── */

export function pubKeyToId(publicKey: Uint8Array): string {
  return toBase64Url(publicKey)
}

export function idToPubKey(pubKeyId: string): Uint8Array {
  const bytes = fromBase64Url(pubKeyId)
  if (bytes.length !== PUBLIC_KEY_BYTES) {
    throw new CryptoError(`public key id decodes to ${bytes.length} bytes, expected ${PUBLIC_KEY_BYTES}`)
  }
  return bytes
}

/**
 * Short human-checkable fingerprint, e.g. "K4T9-M2XW-8BQR".
 *
 * Two people comparing 43-character base64 aloud in a noisy market will not do
 * it. They will do 12 characters. Crockford-style alphabet drops I/L/O/U so
 * there is nothing to misread or mis-say.
 */
const FINGERPRINT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function fingerprint(publicKey: Uint8Array): string {
  const digest = sha256(publicKey)
  let out = ''
  for (let i = 0; i < 12; i++) out += FINGERPRINT_ALPHABET[digest[i]! % 32]!
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`
}

export function fingerprintFromId(pubKeyId: string): string {
  return fingerprint(idToPubKey(pubKeyId))
}

/** Content address for any signed blob — stable across devices, so merges dedupe for free. */
export function contentId(bytes: Uint8Array): string {
  return toHex(sha256(bytes)).slice(0, 32)
}

export { randomBytes, sha256, sha512 }
