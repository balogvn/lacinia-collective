/**
 * CRDT merge.
 *
 * ORDER INDEPENDENCE IS STRUCTURAL, NOT ACHIEVED BY SORTING.
 * The rule is: if the record we already hold has an HLC >= the incoming op's,
 * skip; otherwise apply. That single comparison makes application commutative
 * and idempotent, so bundles arriving in any order — duplicated, interleaved,
 * years apart — converge to the same state on every device.
 *
 * Sorting first would also work for one pass and would quietly fail the moment
 * a late bundle arrived out of order, which on a network of phones that sync
 * every few weeks is the normal case rather than the exception.
 *
 * TOMBSTONES ARE ORDINARY OPS. "Delete" does not short-circuit; it races an
 * "edit" by HLC like any other write. If a device deletes a listing at t=5 and
 * another edits it at t=7, the edit wins and the listing lives — which is the
 * correct last-writer-wins outcome and not a special case.
 *
 * The merge engine talks to an abstract store so it can run against an
 * in-memory map in tests and Dexie in the app, with the same code path.
 */

import type { OpEntity } from '../db/schema'
import type { HLC } from '../hlc'
import { compareHLC } from '../hlc'
import { log } from '../telemetry'
import type { SignedOp } from './ops'

export interface MergeStore {
  /** Existing record's HLC, or undefined if we hold nothing for this key. */
  currentHlc(entity: OpEntity, entityId: string): Promise<HLC | undefined>
  /**
   * `hlc` is passed explicitly rather than read off the record: a tombstone
   * body can be as small as `{id}` and carries no clock of its own. Deriving it
   * from the record would store an empty HLC, and every later op for that key
   * would then look newer than a delete that actually happened after them.
   */
  put(
    entity: OpEntity,
    entityId: string,
    record: unknown,
    meta: { hlc: HLC; deleted: boolean },
  ): Promise<void>
  /** Have we already processed this op id? */
  hasOp(id: string): Promise<boolean>
  /** Persist the op for relay and audit. */
  recordOp(op: SignedOp): Promise<void>
  /** Fold a remote HLC into the local clock so future local writes sort after. */
  observeHlc(hlc: HLC): Promise<void>
}

export interface MergeReport {
  applied: number
  duplicates: number
  stale: number
  tombstones: number
  byEntity: Record<string, number>
}

export async function mergeOps(
  ops: ReadonlyArray<{ op: SignedOp; record: unknown }>,
  store: MergeStore,
): Promise<MergeReport> {
  const report: MergeReport = {
    applied: 0,
    duplicates: 0,
    stale: 0,
    tombstones: 0,
    byEntity: {},
  }

  for (const { op, record } of ops) {
    // Content-addressed ids make this exact, not heuristic.
    if (await store.hasOp(op.id)) {
      report.duplicates++
      continue
    }

    const existing = await store.currentHlc(op.entity, op.entityId)

    // Always observe the clock, even for ops we discard as stale — we have
    // still *seen* that time, and refusing to advance would let our future
    // writes sort before events we already know about.
    await store.observeHlc(op.hlc)

    if (existing !== undefined && compareHLC(existing, op.hlc) >= 0) {
      report.stale++
      // Still record it: we need to know we have seen this op so a later bundle
      // carrying it again is a cheap duplicate check rather than a re-merge.
      await store.recordOp(op)
      continue
    }

    const deleted = op.op === 'tombstone'
    await store.put(op.entity, op.entityId, record, { hlc: op.hlc, deleted })
    await store.recordOp(op)

    report.applied++
    if (deleted) report.tombstones++
    report.byEntity[op.entity] = (report.byEntity[op.entity] ?? 0) + 1
  }

  log.info('crdt', 'merge complete', {
    applied: report.applied,
    duplicates: report.duplicates,
    stale: report.stale,
    tombstones: report.tombstones,
  })

  return report
}

/* ─────────────────────── in-memory store (tests) ─────────────────────── */

/**
 * Reference implementation used by the verification suite. Deliberately shares
 * the merge code path with the Dexie store — a test that exercises different
 * merge logic from production proves nothing about production.
 */
export class InMemoryMergeStore implements MergeStore {
  readonly records = new Map<string, { record: unknown; hlc: HLC; deleted: boolean }>()
  readonly ops = new Map<string, SignedOp>()
  observed: HLC | null = null

  private key(entity: OpEntity, entityId: string): string {
    return `${entity}:${entityId}`
  }

  async currentHlc(entity: OpEntity, entityId: string): Promise<HLC | undefined> {
    return this.records.get(this.key(entity, entityId))?.hlc
  }

  async put(
    entity: OpEntity,
    entityId: string,
    record: unknown,
    meta: { hlc: HLC; deleted: boolean },
  ): Promise<void> {
    this.records.set(this.key(entity, entityId), {
      record,
      hlc: meta.hlc,
      deleted: meta.deleted,
    })
  }

  async hasOp(id: string): Promise<boolean> {
    return this.ops.has(id)
  }

  async recordOp(op: SignedOp): Promise<void> {
    this.ops.set(op.id, op)
  }

  async observeHlc(hlc: HLC): Promise<void> {
    if (!this.observed || compareHLC(hlc, this.observed) > 0) this.observed = hlc
  }

  /** Convenience for assertions: live (non-tombstoned) records of one entity. */
  live<T>(entity: OpEntity): T[] {
    const out: T[] = []
    for (const [key, value] of this.records) {
      if (key.startsWith(`${entity}:`) && !value.deleted) out.push(value.record as T)
    }
    return out
  }
}
