/**
 * The unlocked key, held in memory only.
 *
 * When the vault is sealed there is no usable key on disk — only ciphertext.
 * Unlocking derives the key and parks it here for the life of the tab. It is
 * deliberately NOT written back to IndexedDB, because writing it back would
 * silently undo the sealing the moment someone unlocked once.
 *
 * Module scope rather than React state so it survives re-renders and every
 * `refresh()`, and dies with the tab — which is exactly the lifetime a session
 * should have. Closing the app relocks it.
 */

import type { KeyPair } from './keys'
import { log } from '../telemetry'

let sessionKey: KeyPair | null = null

export function setSessionKey(keyPair: KeyPair | null): void {
  sessionKey = keyPair
  log.info('crypto', keyPair ? 'vault unlocked for this session' : 'session key cleared')
}

export function getSessionKey(): KeyPair | null {
  return sessionKey
}

export function hasSessionKey(): boolean {
  return sessionKey !== null
}
