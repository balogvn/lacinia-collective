/**
 * Repositories — the only module allowed to touch Dexie.
 *
 * Everything above this layer works with plain objects, which is what makes the
 * protocol and trust modules runnable in a headless Node test with no IndexedDB
 * shim (see scripts/verify-protocol.ts).
 *
 * Every mutation writes BOTH the materialised row and an oplog entry, in one
 * transaction. If those two ever diverge, sync silently drops writes — so they
 * must succeed or fail together.
 */

import { getDB } from './db'
import {
  type UserIdentity,
  type TrustVoucher,
  type ResourceListing,
  type OpLogEntry,
  type VaultRecord,
  type PubKeyId,
  type OpEntity,
  type SyncSourceRecord,
  type LedgerEntry,
  type Conversation,
  type Statement,
  type Vote,
  type Flag,
  type VoucherRevocation,
  type AnchorAction,
  TrustTier,
  VoucherStatus,
  VoteValue,
} from './schema'
import { voteIdFor } from '../deliberate/ids'
import { pickSelf } from './self'
import { verifyFlag } from '../moderate/flag'
import { verifyRevocation } from '../moderate/revoke'
import { verifyAnchorAction } from '../anchor/governance'
import { emptyPullState, type PullState } from '../sync/transport'
import { createClock, now as hlcNow, receive as hlcReceive, compareHLC, type ClockState, type HLC } from '../hlc'
import { contentId, fingerprint, idToPubKey, type KeyPair } from '../crypto/keys'
import { reverifyStoredVoucher } from '../vouch/protocol'
import { reverifyEntry, PROPOSAL_FRESHNESS_MS, type SettlementProposal } from '../ledger/entry'
import { createSignedOp, type SignedOp } from '../sync/ops'
import { pruneUndefined } from '../sync/canonical'
import type { MergeStore } from '../sync/merge'
import { log } from '../telemetry'

/* ──────────────────────────── clock state ──────────────────────────── */

const CLOCK_KEY = 'hlc.state'
const DEVICE_KEY = 'device.id'
const PENDING_NONCE_KEY = 'vouch.pendingNonce'
const ANCHORS_KEY = 'trust.anchors'

let clock: ClockState | null = null

export async function getDeviceId(): Promise<string> {
  const db = getDB()
  const existing = await db.meta.get(DEVICE_KEY)
  if (existing) return existing.value as string

  // 8 hex chars is plenty to disambiguate the handful of devices one identity
  // realistically runs on, and keeps every HLC string short.
  const id = contentId(crypto.getRandomValues(new Uint8Array(16))).slice(0, 8)
  await db.meta.put({ key: DEVICE_KEY, value: id })
  log.info('db', 'minted device id', { deviceId: id })
  return id
}

export async function getClock(): Promise<ClockState> {
  if (clock) return clock
  const db = getDB()
  const deviceId = await getDeviceId()
  const persisted = await db.meta.get(CLOCK_KEY)
  clock = persisted
    ? { ...(persisted.value as ClockState), nodeId: deviceId }
    : createClock(deviceId)
  return clock
}

/**
 * Persisting after every stamp is what makes the clock monotonic across a
 * reload. Without it, a refresh resets `wall` to 0 and the next stamp sorts
 * before everything already written.
 */
export async function stamp(): Promise<HLC> {
  const state = await getClock()
  const value = hlcNow(state)
  await getDB().meta.put({ key: CLOCK_KEY, value: { ...state } })
  return value
}

/* ──────────────────────────── signer ──────────────────────────── */

/**
 * The key used to sign outgoing ops.
 *
 * Module-level rather than threaded through every call because there is
 * exactly one identity per installation, and passing a keypair into
 * `saveListing` would push crypto plumbing through every UI callsite. It is set
 * once by `useCommons` after the vault is read, and cleared on wipe. Writes
 * attempted before it is set fail loudly rather than silently producing
 * unsigned ops that no peer would ever accept.
 */
let activeSigner: KeyPair | null = null

export function setActiveSigner(keyPair: KeyPair | null): void {
  activeSigner = keyPair
  log.info('db', keyPair ? 'active signer installed' : 'active signer cleared')
}

export function getActiveSigner(): KeyPair {
  if (!activeSigner) {
    throw new Error(
      'No active signer. The identity vault must be loaded before writing — see setActiveSigner().',
    )
  }
  return activeSigner
}

/* ──────────────────────────── oplog ──────────────────────────── */

async function appendOp(
  entity: OpEntity,
  entityId: string,
  op: 'put' | 'tombstone',
  record: unknown,
  hlc: HLC,
): Promise<OpLogEntry> {
  const signed = createSignedOp(getActiveSigner(), { hlc, entity, entityId, op, record })
  const entry: OpLogEntry = { ...signed, synced: 0, origin: 'local', createdAt: Date.now() }
  await getDB().oplog.put(entry)
  return entry
}

/**
 * Ops eligible for outbound sync.
 *
 * Excludes unsigned v1 rows (see the v2 migration) — shipping an op nobody can
 * verify wastes the recipient's bandwidth and their signature-verification
 * budget, both of which are scarce.
 */
export async function unsyncedOps(limit = 500): Promise<OpLogEntry[]> {
  // [synced+hlc] compound index → already in causal order, no sort needed.
  const rows = await getDB()
    .oplog.where('[synced+hlc]')
    .between([0, ''], [0, '￿'])
    .limit(limit)
    .toArray()

  const signed = rows.filter((r) => r.sig)
  if (signed.length !== rows.length) {
    log.warn('sync', 'excluded unsigned legacy ops from export', {
      excluded: rows.length - signed.length,
    })
  }
  return signed
}

/**
 * Re-signs ops written before Task 2 introduced signatures.
 *
 * The v2 migration cannot do this itself: it runs inside a Dexie upgrade
 * transaction, long before the vault is read and a key exists. Without this
 * pass, every device created under Task 1 keeps its own identity and vouches in
 * the oplog permanently unsigned — and `unsyncedOps` correctly refuses to
 * publish unsigned ops, so those users could never share their own identity or
 * relay the vouches they hold. They would appear to sync fine and silently
 * contribute nothing.
 *
 * We can only re-sign what we are authorised to author: our own identity and
 * listings, plus any voucher (relaying is open by design — see sync/ops.ts).
 * Anything else stays unsigned and stays local, which is the correct outcome.
 */
export async function resignLegacyOps(signer: KeyPair): Promise<number> {
  const db = getDB()
  const unsigned = await db.oplog.filter((row) => !row.sig).toArray()
  if (unsigned.length === 0) return 0

  let resigned = 0
  for (const row of unsigned) {
    let record: Record<string, unknown>
    try {
      record = JSON.parse(row.body) as Record<string, unknown>
    } catch {
      continue
    }

    const mayAuthor =
      row.entity === 'voucher' ||
      (row.entity === 'identity' && record.pubKey === signer.pubKeyId) ||
      (row.entity === 'listing' && record.authorPub === signer.pubKeyId)
    if (!mayAuthor) continue

    try {
      const signed = createSignedOp(signer, {
        hlc: row.hlc,
        entity: row.entity,
        entityId: row.entityId,
        op: row.op,
        record: pruneUndefined(record),
      })
      await db.transaction('rw', db.oplog, async () => {
        // The id is a hash of the signed document, so signing mints a new id —
        // the old row must go or the op would exist twice.
        await db.oplog.delete(row.id)
        await db.oplog.put({ ...signed, synced: 0, origin: 'local', createdAt: row.createdAt })
      })
      resigned++
    } catch (err) {
      log.warn('sync', 'could not re-sign legacy op', {
        entity: row.entity,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (resigned > 0) log.info('sync', 'legacy ops re-signed and queued for publish', { resigned })
  return resigned
}

/** Recent ops regardless of sync state — used to relay other people's data. */
export async function relayableOps(limit = 300): Promise<OpLogEntry[]> {
  const rows = await getDB().oplog.orderBy('hlc').reverse().limit(limit).toArray()
  return rows.filter((r) => r.sig).reverse()
}

export async function markOpsSynced(ids: readonly string[]): Promise<void> {
  const db = getDB()
  await db.transaction('rw', db.oplog, async () => {
    for (const id of ids) await db.oplog.update(id, { synced: 1 })
  })
  log.info('sync', 'marked ops synced', { count: ids.length })
}

/* ──────────────────────────── identity ──────────────────────────── */

export async function getSelf(): Promise<UserIdentity | undefined> {
  // Resolved from the VAULT's key, never from the synced `isSelf` flag — see
  // db/self.ts for the shadowing bug that caused.
  const db = getDB()
  const vault = await db.vault.get('self')
  if (!vault) return undefined
  const all = await db.identities.toArray()
  return pickSelf(all, vault.pubKey)
}

export async function createSelfIdentity(
  keyPair: KeyPair,
  input: {
    displayName: string
    locality?: UserIdentity['locality']
    declaredTier?: TrustTier
  },
): Promise<UserIdentity> {
  const db = getDB()
  const existing = await getSelf()
  if (existing) throw new Error('This device already holds an identity. Erase it first.')

  const hlc = await stamp()
  const identity: UserIdentity = {
    pubKey: keyPair.pubKeyId,
    fingerprint: fingerprint(keyPair.publicKey),
    displayName: input.displayName.trim() || 'Unnamed',
    isSelf: true,
    deviceId: (await getClock()).nodeId,
    ...(input.locality ? { locality: input.locality } : {}),
    ...(input.declaredTier !== undefined ? { declaredTier: input.declaredTier } : {}),
    createdAt: Date.now(),
    hlc,
  }

  // Install the signer before the first op is written — identity creation is
  // the one write that happens before any vault exists to load a key from.
  setActiveSigner(keyPair)

  await db.transaction('rw', db.identities, db.oplog, db.meta, async () => {
    await db.identities.put(identity)
    await appendOp('identity', identity.pubKey, 'put', identity, hlc)
  })

  log.info('db', 'self identity created', { fingerprint: identity.fingerprint })
  return identity
}

/** Cache a peer we met, so their name shows next to their vouch instead of a raw key. */
export async function upsertPeer(
  pubKey: PubKeyId,
  displayName: string,
): Promise<UserIdentity> {
  const db = getDB()
  const existing = await db.identities.get(pubKey)
  const hlc = await stamp()

  const peer: UserIdentity = existing
    ? { ...existing, displayName, hlc }
    : {
        pubKey,
        fingerprint: fingerprint(idToPubKey(pubKey)),
        displayName,
        isSelf: false,
        deviceId: '',
        createdAt: Date.now(),
        hlc,
      }

  await db.identities.put(peer)
  return peer
}

export async function listIdentities(): Promise<UserIdentity[]> {
  const all = await getDB().identities.toArray()
  return all.filter((i) => !i.deleted)
}

/* ──────────────────────────── vault ──────────────────────────── */

export async function saveVault(record: VaultRecord): Promise<void> {
  await getDB().vault.put(record)
  log.info('db', 'vault written', { sealed: !!record.sealed })
}

export async function getVault(): Promise<VaultRecord | undefined> {
  return getDB().vault.get('self')
}

/* ──────────────────────────── vouchers ──────────────────────────── */

export async function savePendingNonce(nonce: string): Promise<void> {
  await getDB().meta.put({ key: PENDING_NONCE_KEY, value: { nonce, at: Date.now() } })
}

export async function getPendingNonce(): Promise<string | null> {
  const row = await getDB().meta.get(PENDING_NONCE_KEY)
  return row ? ((row.value as { nonce: string }).nonce ?? null) : null
}

export async function clearPendingNonce(): Promise<void> {
  await getDB().meta.delete(PENDING_NONCE_KEY)
}

/**
 * Idempotent by construction: the voucher id is the hash of its signed bytes,
 * so re-scanning the same QR — or receiving it via three different sync
 * bundles — writes the same row, not four duplicates.
 */
export async function saveVoucher(voucher: TrustVoucher): Promise<{ isNew: boolean }> {
  const db = getDB()
  const existing = await db.vouchers.get(voucher.id)
  if (existing) {
    log.info('vouch', 'voucher already held, ignoring duplicate', { id: voucher.id })
    return { isNew: false }
  }

  const hlc = voucher.hlc || (await stamp())
  const record: TrustVoucher = { ...voucher, hlc }

  await db.transaction('rw', db.vouchers, db.oplog, db.meta, async () => {
    await db.vouchers.put(record)
    await appendOp('voucher', record.id, 'put', record, hlc)
  })

  log.info('vouch', 'voucher stored', {
    id: record.id.slice(0, 12),
    direction: record.direction,
    tier: TrustTier[record.tier],
  })
  return { isNew: true }
}

export async function listVouchers(): Promise<TrustVoucher[]> {
  return getDB().vouchers.toArray()
}

export async function listInboundVouchers(subjectPub: PubKeyId): Promise<TrustVoucher[]> {
  return getDB().vouchers.where('subjectPub').equals(subjectPub).toArray()
}

export async function listOutboundVouchers(issuerPub: PubKeyId): Promise<TrustVoucher[]> {
  return getDB().vouchers.where('issuerPub').equals(issuerPub).toArray()
}

export async function hasVouchedFor(
  issuerPub: PubKeyId,
  subjectPub: PubKeyId,
): Promise<TrustVoucher | undefined> {
  const rows = await getDB()
    .vouchers.where('[issuerPub+subjectPub]')
    .equals([issuerPub, subjectPub])
    .toArray()
  return rows.find((v) => !v.deleted && v.status === VoucherStatus.Valid)
}

/**
 * Re-verify every stored voucher and write back changed statuses.
 *
 * Run on app start. A row sitting in IndexedDB is not evidence — anything with
 * access to this origin could have edited it, and vouchers expire on a wall
 * clock that keeps moving while the app is closed.
 */
export async function revalidateVouchers(now = Date.now()): Promise<{
  checked: number
  changed: number
}> {
  const db = getDB()
  const all = await db.vouchers.toArray()
  let changed = 0

  await db.transaction('rw', db.vouchers, async () => {
    for (const v of all) {
      const status = reverifyStoredVoucher(v, now)
      if (status !== v.status) {
        await db.vouchers.update(v.id, { status })
        changed++
        if (status === VoucherStatus.Invalid) {
          log.error('vouch', 'stored voucher failed re-verification', { id: v.id })
        }
      }
    }
  })

  log.info('vouch', 'revalidation pass complete', { checked: all.length, changed })
  return { checked: all.length, changed }
}

/* ──────────────────────────── anchors ──────────────────────────── */

/**
 * Anchors are the root of trust and are configured out-of-band — a community
 * body publishes its key on a printed poster, a radio slot, a WhatsApp
 * broadcast. Deliberately NOT derivable from anything in the app: if the app
 * could mint anchors, the whole graph would be forgeable from inside.
 */
export async function getAnchors(): Promise<PubKeyId[]> {
  const row = await getDB().meta.get(ANCHORS_KEY)
  return (row?.value as PubKeyId[]) ?? []
}

export async function setAnchors(anchors: readonly PubKeyId[]): Promise<void> {
  await getDB().meta.put({ key: ANCHORS_KEY, value: [...new Set(anchors)] })
  log.info('trust', 'anchor set updated', { count: anchors.length })
}

/* ──────────────────────────── listings ──────────────────────────── */

export async function saveListing(listing: ResourceListing): Promise<void> {
  const db = getDB()
  const hlc = await stamp()
  const record: ResourceListing = { ...listing, hlc }

  await db.transaction('rw', db.listings, db.oplog, db.meta, async () => {
    await db.listings.put(record)
    await appendOp('listing', record.id, 'put', record, hlc)
  })
}

export async function listOpenListings(): Promise<ResourceListing[]> {
  const all = await getDB().listings.where('status').equals('OPEN').toArray()
  return all.filter((l) => !l.deleted && l.expiresAt > Date.now())
}

/* ──────────────────────────── ledger ──────────────────────────── */

const PENDING_PROPOSALS_KEY = 'ledger.pendingProposals'

/**
 * Pending settlement proposals awaiting the payer's confirmation.
 *
 * Persisted rather than held in component state because the provider may show
 * their code, lock the phone, and take a minute to get the other person's
 * camera working. Losing the proposal on reload would mean the confirmation
 * they eventually scan matches nothing.
 */
export async function savePendingProposal(proposal: SettlementProposal): Promise<void> {
  const existing = await getPendingProposals()
  const cutoff = Date.now() - PROPOSAL_FRESHNESS_MS
  const next = [...existing.filter((p) => p.agreedAt > cutoff && p.nonce !== proposal.nonce), proposal]
  await getDB().meta.put({ key: PENDING_PROPOSALS_KEY, value: next })
}

export async function getPendingProposals(): Promise<SettlementProposal[]> {
  const row = await getDB().meta.get(PENDING_PROPOSALS_KEY)
  const all = (row?.value as SettlementProposal[]) ?? []
  // Expire on read: a stale proposal that later matched a confirmation would
  // settle an exchange both people have long forgotten.
  return all.filter((p) => p.agreedAt > Date.now() - PROPOSAL_FRESHNESS_MS)
}

export async function clearPendingProposal(nonce: string): Promise<void> {
  const remaining = (await getPendingProposals()).filter((p) => p.nonce !== nonce)
  await getDB().meta.put({ key: PENDING_PROPOSALS_KEY, value: remaining })
}

/**
 * Stores a completed entry. Idempotent — entries are content-addressed and
 * immutable, so the same exchange arriving from both parties and three relays
 * collapses to one row with no merge logic.
 */
export async function saveLedgerEntry(entry: LedgerEntry): Promise<{ isNew: boolean }> {
  const db = getDB()
  if (await db.ledger.get(entry.id)) {
    log.info('sync', 'ledger entry already held', { id: entry.id.slice(0, 12) })
    return { isNew: false }
  }

  // Refuse to store anything that does not verify, even locally. A bad entry in
  // our own table would corrupt every balance we compute from it.
  if (!reverifyEntry(entry)) {
    throw new Error('Refusing to store a ledger entry that fails its two-signature check.')
  }

  const hlc = entry.hlc || (await stamp())
  const record: LedgerEntry = { ...entry, hlc }

  await db.transaction('rw', db.ledger, db.oplog, db.meta, async () => {
    await db.ledger.put(record)
    await appendOp('ledger', record.id, 'put', record, hlc)
  })

  log.info('sync', 'ledger entry stored', {
    id: record.id.slice(0, 12),
    amount: record.amount,
  })
  return { isNew: true }
}

export async function listLedgerEntries(): Promise<LedgerEntry[]> {
  return getDB().ledger.toArray()
}

export async function listEntriesFor(pubKey: PubKeyId): Promise<LedgerEntry[]> {
  const db = getDB()
  const [paid, received] = await Promise.all([
    db.ledger.where('fromPub').equals(pubKey).toArray(),
    db.ledger.where('toPub').equals(pubKey).toArray(),
  ])
  return [...paid, ...received].sort((a, b) => b.agreedAt - a.agreedAt)
}

/**
 * Re-verify every stored entry, dropping any that fail.
 *
 * Run on start alongside voucher revalidation. Unlike vouchers, a forged entry
 * does not just misrepresent trust — it silently creates credits out of
 * nothing, which is the one failure a currency cannot recover from.
 */
export async function revalidateLedger(): Promise<{ checked: number; removed: number }> {
  const db = getDB()
  const all = await db.ledger.toArray()
  const bad = all.filter((entry) => !reverifyEntry(entry))

  if (bad.length > 0) {
    await db.transaction('rw', db.ledger, async () => {
      for (const entry of bad) {
        log.error('crdt', 'removing ledger entry that failed re-verification', { id: entry.id })
        await db.ledger.delete(entry.id)
      }
    })
  }
  return { checked: all.length, removed: bad.length }
}

/* ──────────────────────────── deliberation ──────────────────────────── */

export async function saveConversation(conversation: Conversation): Promise<void> {
  const db = getDB()
  const hlc = await stamp()
  const record: Conversation = { ...conversation, hlc }
  await db.transaction('rw', db.conversations, db.oplog, db.meta, async () => {
    await db.conversations.put(record)
    await appendOp('conversation', record.id, 'put', record, hlc)
  })
}

export async function listConversations(): Promise<Conversation[]> {
  const all = await getDB().conversations.toArray()
  return all.filter((c) => !c.deleted).sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveStatement(statement: Statement): Promise<void> {
  const db = getDB()
  const hlc = await stamp()
  const record: Statement = { ...statement, hlc }
  await db.transaction('rw', db.statements, db.oplog, db.meta, async () => {
    await db.statements.put(record)
    await appendOp('statement', record.id, 'put', record, hlc)
  })
}

export async function listStatements(conversationId?: string): Promise<Statement[]> {
  const db = getDB()
  const all = conversationId
    ? await db.statements.where('conversationId').equals(conversationId).toArray()
    : await db.statements.toArray()
  return all.filter((s) => !s.deleted)
}

/**
 * Casts or changes a vote.
 *
 * The id is derived from (voter, statement), so this is an upsert by
 * construction: changing your mind replaces the row rather than adding a second
 * one. A content-addressed id here would let one person be counted twice on the
 * same statement after an offline flip-flop.
 */
export async function castVote(input: {
  authorPub: PubKeyId
  statementId: string
  conversationId: string
  value: VoteValue
}): Promise<Vote> {
  const db = getDB()
  const hlc = await stamp()
  const record: Vote = {
    id: voteIdFor(input.authorPub, input.statementId),
    statementId: input.statementId,
    conversationId: input.conversationId,
    authorPub: input.authorPub,
    value: input.value,
    createdAt: Date.now(),
    hlc,
  }

  await db.transaction('rw', db.votes, db.oplog, db.meta, async () => {
    await db.votes.put(record)
    await appendOp('vote', record.id, 'put', record, hlc)
  })
  return record
}

export async function listVotes(conversationId?: string): Promise<Vote[]> {
  const db = getDB()
  const all = conversationId
    ? await db.votes.where('conversationId').equals(conversationId).toArray()
    : await db.votes.toArray()
  return all.filter((v) => !v.deleted)
}

export async function listMyVotes(
  conversationId: string,
  authorPub: PubKeyId,
): Promise<Vote[]> {
  const rows = await getDB()
    .votes.where('[conversationId+authorPub]')
    .equals([conversationId, authorPub])
    .toArray()
  return rows.filter((v) => !v.deleted)
}

/* ──────────────────────────── moderation ──────────────────────────── */

/**
 * Raises or updates a flag. Idempotent per (flagger, target) by construction —
 * the id is derived, so re-flagging under a different reason replaces the row
 * instead of letting one person count as several.
 */
export async function saveFlag(flag: Flag): Promise<void> {
  const db = getDB()
  if (!verifyFlag(flag)) {
    throw new Error('Refusing to store a flag that fails its own signature check.')
  }
  const hlc = flag.hlc || (await stamp())
  const record: Flag = { ...flag, hlc }
  await db.transaction('rw', db.flags, db.oplog, db.meta, async () => {
    await db.flags.put(record)
    await appendOp('flag', record.id, 'put', record, hlc)
  })
}

/** Withdrawing a flag is a tombstone — the record stays, its effect stops. */
export async function withdrawFlag(flagId: string): Promise<void> {
  const db = getDB()
  const existing = await db.flags.get(flagId)
  if (!existing) return
  const hlc = await stamp()
  const record: Flag = { ...existing, deleted: true, hlc }
  await db.transaction('rw', db.flags, db.oplog, db.meta, async () => {
    await db.flags.put(record)
    await appendOp('flag', record.id, 'put', record, hlc)
  })
}

export async function listFlags(): Promise<Flag[]> {
  return getDB().flags.toArray()
}

export async function myFlagFor(
  targetId: string,
  authorPub: PubKeyId,
): Promise<Flag | undefined> {
  const rows = await getDB()
    .flags.where('[targetId+authorPub]')
    .equals([targetId, authorPub])
    .toArray()
  return rows.find((f) => !f.deleted)
}

export async function saveRevocation(revocation: VoucherRevocation): Promise<void> {
  const db = getDB()
  if (!verifyRevocation(revocation)) {
    throw new Error('Refusing to store a revocation that fails its own signature check.')
  }
  const hlc = revocation.hlc || (await stamp())
  const record: VoucherRevocation = { ...revocation, hlc }

  await db.transaction('rw', db.revocations, db.vouchers, db.oplog, db.meta, async () => {
    await db.revocations.put(record)
    // Mark the voucher immediately so the local trust graph reflects it before
    // the next full rebuild — a revoked vouch should stop counting at once.
    const voucher = await db.vouchers.get(record.voucherId)
    if (voucher && voucher.issuerPub === record.issuerPub) {
      await db.vouchers.update(record.voucherId, { status: VoucherStatus.Revoked })
    }
    await appendOp('revocation', record.id, 'put', record, hlc)
  })
}

export async function listRevocations(): Promise<VoucherRevocation[]> {
  return getDB().revocations.toArray()
}

export async function saveAnchorAction(action: AnchorAction): Promise<void> {
  const db = getDB()
  if (!verifyAnchorAction(action)) {
    throw new Error('Refusing to store an anchor action that fails its own signature check.')
  }
  const hlc = action.hlc || (await stamp())
  const record: AnchorAction = { ...action, hlc }
  await db.transaction('rw', db.anchorActions, db.oplog, db.meta, async () => {
    await db.anchorActions.put(record)
    await appendOp('anchorAction', record.id, 'put', record, hlc)
  })
}

export async function listAnchorActions(): Promise<AnchorAction[]> {
  return getDB().anchorActions.toArray()
}

/* ──────────────────────────── sync ──────────────────────────── */

const SYNC_STATE_PREFIX = 'sync.state.'
const SYNC_SOURCES_KEY = 'sync.sources'

export async function getSyncSources(): Promise<SyncSourceRecord[]> {
  const row = await getDB().meta.get(SYNC_SOURCES_KEY)
  return (row?.value as SyncSourceRecord[]) ?? []
}

export async function saveSyncSource(source: SyncSourceRecord): Promise<void> {
  const existing = await getSyncSources()
  const next = existing.filter((s) => s.url !== source.url)
  next.push(source)
  await getDB().meta.put({ key: SYNC_SOURCES_KEY, value: next })
  log.info('sync', 'sync source saved', { url: source.url })
}

export async function removeSyncSource(url: string): Promise<void> {
  const next = (await getSyncSources()).filter((s) => s.url !== url)
  await getDB().meta.put({ key: SYNC_SOURCES_KEY, value: next })
  await getDB().meta.delete(SYNC_STATE_PREFIX + url)
}

export async function getPullState(url: string): Promise<PullState> {
  const row = await getDB().meta.get(SYNC_STATE_PREFIX + url)
  return (row?.value as PullState) ?? emptyPullState()
}

export async function savePullState(url: string, state: PullState): Promise<void> {
  await getDB().meta.put({ key: SYNC_STATE_PREFIX + url, value: state })
}

/**
 * MergeStore bound to Dexie.
 *
 * Deliberately shares the merge code path in sync/merge.ts with the in-memory
 * store used by the tests — a suite that exercises different merge logic from
 * production proves nothing about production.
 */
export class DexieMergeStore implements MergeStore {
  private readonly tableFor = {
    identity: () => getDB().identities,
    voucher: () => getDB().vouchers,
    listing: () => getDB().listings,
    ledger: () => getDB().ledger,
    conversation: () => getDB().conversations,
    statement: () => getDB().statements,
    vote: () => getDB().votes,
    flag: () => getDB().flags,
    revocation: () => getDB().revocations,
    anchorAction: () => getDB().anchorActions,
  } as const

  async currentHlc(entity: OpEntity, entityId: string): Promise<HLC | undefined> {
    const resolve = this.tableFor[entity as keyof typeof this.tableFor]
    if (!resolve) return undefined
    const row = (await resolve().get(entityId)) as { hlc?: HLC } | undefined
    return row?.hlc
  }

  async put(
    entity: OpEntity,
    entityId: string,
    record: unknown,
    meta: { hlc: HLC; deleted: boolean },
  ): Promise<void> {
    const resolve = this.tableFor[entity as keyof typeof this.tableFor]
    if (!resolve) {
      // statement/vote arrive in Task 4. Dropping them here is correct for now,
      // but log it — silently discarding valid signed data would be invisible.
      log.info('sync', 'no table for entity yet, op retained in oplog only', { entity })
      return
    }

    if (meta.deleted) {
      const existing = (await resolve().get(entityId)) as Record<string, unknown> | undefined
      // A tombstone for something we never held still needs a row, or a later
      // bundle carrying the original `put` would resurrect it.
      await resolve().put({
        ...(existing ?? (record as Record<string, unknown>)),
        deleted: true,
        hlc: meta.hlc,
      } as never)
      return
    }

    await resolve().put({ ...(record as Record<string, unknown>), hlc: meta.hlc } as never)
  }

  async hasOp(id: string): Promise<boolean> {
    return (await getDB().oplog.get(id)) !== undefined
  }

  async recordOp(op: SignedOp): Promise<void> {
    await getDB().oplog.put({
      ...op,
      // Received ops are already public, so they are not "pending upload".
      // They stay relayable via relayableOps().
      synced: 1,
      origin: 'remote',
      createdAt: Date.now(),
    })
  }

  async observeHlc(hlc: HLC): Promise<void> {
    const state = await getClock()
    hlcReceive(state, hlc)
    await getDB().meta.put({ key: CLOCK_KEY, value: { ...state } })
  }
}

/** Newest HLC anywhere in the local log — the outbound cursor. */
export async function localHlcMax(): Promise<HLC | null> {
  const row = await getDB().oplog.orderBy('hlc').last()
  return row?.hlc ?? null
}

/** Tombstone, never delete — see the note at the top of schema.ts. */
export async function tombstoneListing(id: string, authorPub: PubKeyId): Promise<void> {
  const db = getDB()
  const hlc = await stamp()
  await db.transaction('rw', db.listings, db.oplog, db.meta, async () => {
    await db.listings.update(id, { deleted: true, hlc })
    // The tombstone body carries authorPub so the per-entity authorizer can
    // confirm the deleter owns the listing — an id alone would let anyone
    // delete anything.
    await appendOp('listing', id, 'tombstone', { id, authorPub }, hlc)
  })
}
