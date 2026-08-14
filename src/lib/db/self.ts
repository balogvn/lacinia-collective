/**
 * Resolving which identity row belongs to this device.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * `UserIdentity.isSelf` is a LOCAL fact — "this row is my device's owner" — but
 * it sits inside the record, and the record is signed and synced. So every
 * published identity carries `isSelf: true`, and any device that syncs one ends
 * up holding several rows all claiming to be it.
 *
 * The original `getSelf()` did `identities.find(i => i.isSelf)`. Dexie returns
 * rows in primary-key order, and the primary key is a base64url public key, in
 * which lowercase sorts last. So after syncing a founder whose key begins with
 * `g`, roughly every user whose own key begins with a later letter would have
 * `getSelf()` hand back the FOUNDER'S identity: the app would show someone
 * else's name and fingerprint while signing with their own key.
 *
 * The fix is to stop asking the data who you are. The vault holds the key this
 * device actually controls, and that is the only authoritative answer — it
 * cannot be synced, forged, or shadowed, because it is the thing that decides
 * what this device can sign.
 *
 * `isSelf` is left in the schema because it is inside already-signed bytes on
 * published records and cannot be removed without invalidating them. It is
 * simply never trusted.
 */

import type { PubKeyId, UserIdentity } from './schema'

/**
 * Picks this device's identity from a set of rows.
 *
 * Pure and Dexie-free so the rule can be tested headlessly — the failure mode
 * it guards against only appears after a real sync, which is exactly the case
 * that is awkward to reach in a unit test.
 */
export function pickSelf(
  identities: readonly UserIdentity[],
  vaultPubKey: PubKeyId | null,
): UserIdentity | undefined {
  if (!vaultPubKey) return undefined
  return identities.find((i) => i.pubKey === vaultPubKey && !i.deleted)
}

/**
 * Rows that are demonstrably NOT this device, whatever they claim.
 *
 * Used for the peer list, which would otherwise include synced records that
 * assert `isSelf: true` about themselves.
 */
export function peersOf(
  identities: readonly UserIdentity[],
  vaultPubKey: PubKeyId | null,
): UserIdentity[] {
  return identities.filter((i) => !i.deleted && i.pubKey !== vaultPubKey)
}
