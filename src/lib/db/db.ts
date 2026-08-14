/**
 * IndexedDB wrapper (Dexie).
 *
 * WHY DEXIE OVER localforage
 * localforage is a key/value shim — it gives us `get`/`set` and nothing else.
 * The queries this app actually runs are relational: "all inbound vouchers for
 * my key, not expired", "open FOOD listings in Ikorodu under 90 minutes". With
 * localforage each of those becomes a full scan and a manual filter in JS,
 * which on 5,000 records is a visible stall on a low-end phone. Dexie gives us
 * real compound indexes for ~25KB gzipped.
 *
 * LAZY SINGLETON
 * Next.js prerenders these routes at build time in Node, where `indexedDB` does
 * not exist. Constructing Dexie at module scope would crash the build, so the
 * instance is created on first access from a browser context.
 */

import Dexie, { type Table } from 'dexie'

import type {
  UserIdentity,
  TrustVoucher,
  ResourceListing,
  OpLogEntry,
  MetaRecord,
  VaultRecord,
  LedgerEntry,
  Conversation,
  Statement,
  Vote,
  Flag,
  VoucherRevocation,
  AnchorAction,
} from './schema'
import { log } from '../telemetry'

export class LaciniaDB extends Dexie {
  identities!: Table<UserIdentity, string>
  vouchers!: Table<TrustVoucher, string>
  listings!: Table<ResourceListing, string>
  ledger!: Table<LedgerEntry, string>
  conversations!: Table<Conversation, string>
  statements!: Table<Statement, string>
  votes!: Table<Vote, string>
  flags!: Table<Flag, string>
  revocations!: Table<VoucherRevocation, string>
  anchorActions!: Table<AnchorAction, string>
  oplog!: Table<OpLogEntry, string>
  vault!: Table<VaultRecord, string>
  meta!: Table<MetaRecord, string>

  constructor() {
    super('lacinia-collective')

    // Index selection notes — each of these exists to serve one real query:
    //   [subjectPub+status]  → "my valid inbound vouchers" (trust score, hot path)
    //   [issuerPub+subjectPub] → duplicate-vouch detection before signing
    //   [status+category]    → marketplace browse, the default screen
    //   [synced+hlc]         → "ops since last bundle", in causal order
    this.version(1).stores({
      identities: 'pubKey, displayName, isSelf, createdAt, hlc, deleted',
      vouchers:
        'id, issuerPub, subjectPub, status, direction, expiresAt, [subjectPub+status], [issuerPub+subjectPub], hlc',
      listings:
        'id, authorPub, kind, category, status, expiresAt, minTrustTier, [status+category], [status+kind], hlc',
      oplog: 'id, hlc, entity, entityId, synced, [synced+hlc], createdAt',
      vault: 'id, pubKey',
      meta: 'key',
    })

    // v2 — Task 2. Ops became individually signed so they can cross an
    // untrusted relay. `origin` distinguishes what we authored from what we
    // received, which is what lets us relay other people's ops without
    // claiming them.
    this.version(2)
      .stores({
        oplog: 'id, hlc, entity, entityId, synced, origin, author, [synced+hlc], [origin+hlc], createdAt',
      })
      .upgrade(async (tx) => {
        // v1 ops carried `payload`/`authorPub` and no signature. They cannot be
        // retro-signed — we do not hold the authoring key for anything received
        // — so they are marked unsigned and excluded from export rather than
        // deleted. Local state stays intact; only outbound sync ignores them.
        const table = tx.table('oplog')
        const rows = await table.toArray()
        let migrated = 0
        for (const row of rows) {
          await table.put({
            ...row,
            author: row.author ?? row.authorPub ?? '',
            body: row.body ?? row.payload ?? '{}',
            sig: row.sig ?? '',
            origin: row.origin ?? 'local',
          })
          migrated++
        }
        log.info('db', 'upgraded oplog to v2 (signed ops)', { migrated })
      })

    // v3 — Task 3. The time-credit ledger. Entries are immutable and
    // content-addressed, so no migration of existing rows is needed; the table
    // simply starts empty.
    //   [fromPub+toPub] → "what have we two settled between us", the hot path
    //                     when deciding whether to extend someone credit.
    this.version(3).stores({
      ledger: 'id, fromPub, toPub, agreedAt, listingRef, [fromPub+toPub], hlc',
    })

    // v4 — Task 4. Augmented deliberation.
    //   votes [conversationId+authorPub] → "everything this person has voted on
    //     here", the query the vote queue runs on every card.
    //   votes [statementId+value]        → per-statement tallies without a scan.
    this.version(4).stores({
      conversations: 'id, authorPub, createdAt, closesAt, hlc, deleted',
      statements: 'id, conversationId, authorPub, createdAt, [conversationId+authorPub], hlc, deleted',
      votes:
        'id, statementId, conversationId, authorPub, [conversationId+authorPub], [statementId+value], hlc, deleted',
    })

    // v5 — moderation. Flags and revocations, both self-signed and relayable.
    //   flags [targetId+authorPub] → "have I already flagged this", the query
    //     every rendered item runs.
    //   revocations voucherId      → applied whenever the trust graph rebuilds.
    this.version(5).stores({
      flags:
        'id, targetId, targetEntity, authorPub, conversationId, [targetId+authorPub], hlc, deleted',
      revocations: 'id, voucherId, issuerPub, subjectPub, revokedAt, hlc',
    })

    // v6 — anchor governance. Signed statements by anchors about the anchor
    // set. Nothing here applies automatically; see anchor/governance.ts.
    this.version(6).stores({
      anchorActions: 'id, kind, anchorPub, targetPub, actedAt, hlc',
    })

    this.on('populate', () => log.info('db', 'database created at version 1'))
    this.on('blocked', () =>
      log.warn('db', 'upgrade blocked — another tab holds an older connection open'),
    )
  }
}

let instance: LaciniaDB | null = null

export function getDB(): LaciniaDB {
  if (typeof indexedDB === 'undefined') {
    throw new Error(
      'IndexedDB unavailable. getDB() must be called from the browser, not during prerender.',
    )
  }
  if (!instance) {
    instance = new LaciniaDB()
    log.info('db', 'Dexie instance opened', { name: instance.name })
  }
  return instance
}

export function isPersistenceAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
}

/**
 * Ask the browser to exempt us from storage eviction.
 *
 * This matters more here than in most apps: eviction under storage pressure
 * would delete an identity and every vouch attached to it, and there is no
 * server copy to restore from. Chrome grants this silently once the app is
 * installed or sufficiently engaged with.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    log.warn('db', 'StorageManager unavailable — data is evictable')
    return false
  }
  const already = await navigator.storage.persisted()
  if (already) return true

  const granted = await navigator.storage.persist()
  log.info('db', granted ? 'persistent storage granted' : 'persistent storage denied', { granted })
  return granted
}

export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}

/** Destructive. Wired to an explicit, double-confirmed action in the UI only. */
export async function wipeLocalCommons(): Promise<void> {
  const db = getDB()
  await db.delete()
  instance = null
  log.warn('db', 'local database deleted')
}
