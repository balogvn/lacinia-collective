/**
 * At-rest protection for the secret key.
 *
 * HONEST THREAT MODEL — read before trusting this.
 * IndexedDB is readable by anything running in this origin, and by anyone
 * holding an unlocked phone. A PIN here defends against exactly one thing: a
 * borrowed or stolen handset. It does NOT defend against malicious script in
 * the page, a compromised device, or a forensic image plus time.
 *
 * We ship the PIN as opt-in rather than mandatory because a forgotten PIN on a
 * shared family phone destroys an identity that took months of vouches to
 * build, and because "enter a password" is precisely the pattern Rule 4 tells
 * us to avoid. The recovery phrase — not the PIN — is the real backup.
 *
 * PBKDF2-SHA256 is used because it is available in every WebView that has
 * WebCrypto at all. Argon2id would be stronger; it would also be 40KB of WASM
 * that a 2G connection has to deliver.
 */

import { randomBytes } from '@noble/hashes/utils'
import { toBase64Url, fromBase64Url } from '../codec'
import { log } from '../telemetry'
import { CryptoError } from './keys'

/**
 * A 6-digit PIN has 10^6 candidates, so iteration count is the only thing
 * standing between a stolen phone and the key. 310k is the OWASP floor for
 * PBKDF2-SHA256; it costs roughly 200–400ms on a low-end device, which is an
 * acceptable one-time unlock cost.
 */
const PBKDF2_ITERATIONS = 310_000
const SALT_BYTES = 16
const IV_BYTES = 12

export interface SealedSecret {
  /** base64url ciphertext (AES-GCM, tag appended by WebCrypto). */
  ciphertext: string
  salt: string
  iv: string
  iterations: number
  algorithm: 'PBKDF2-SHA256/AES-256-GCM'
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) {
    throw new CryptoError(
      'WebCrypto unavailable — PIN lock needs a secure context (https:// or localhost).',
    )
  }
  return c.subtle
}

async function deriveKey(pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await subtle().importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function sealSecret(secretKey: Uint8Array, pin: string): Promise<SealedSecret> {
  if (pin.length < 4) throw new CryptoError('PIN must be at least 4 characters.')

  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = await deriveKey(pin, salt, PBKDF2_ITERATIONS)
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    secretKey as BufferSource,
  )

  log.info('crypto', 'secret sealed under PIN', { iterations: PBKDF2_ITERATIONS })
  return {
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    salt: toBase64Url(salt),
    iv: toBase64Url(iv),
    iterations: PBKDF2_ITERATIONS,
    algorithm: 'PBKDF2-SHA256/AES-256-GCM',
  }
}

export async function openSecret(sealed: SealedSecret, pin: string): Promise<Uint8Array> {
  const salt = fromBase64Url(sealed.salt)
  const iv = fromBase64Url(sealed.iv)
  // Honour the stored iteration count, not the current constant — otherwise
  // raising PBKDF2_ITERATIONS in a future release silently bricks every
  // existing vault on every device.
  const key = await deriveKey(pin, salt, sealed.iterations)

  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      fromBase64Url(sealed.ciphertext) as BufferSource,
    )
    log.info('crypto', 'secret unsealed')
    return new Uint8Array(plain)
  } catch {
    // AES-GCM auth failure is indistinguishable from a wrong PIN, which is the
    // behaviour we want — no oracle telling an attacker they're close.
    log.warn('crypto', 'unseal failed — wrong PIN or tampered vault')
    throw new CryptoError('Incorrect PIN.')
  }
}
