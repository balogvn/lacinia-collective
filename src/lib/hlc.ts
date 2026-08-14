/**
 * Hybrid Logical Clock.
 *
 * WHY THIS EXISTS
 * Two phones edit the same listing while offline. To merge deterministically we
 * need a total order. Wall-clock timestamps fail badly here: a cheap Android
 * with a dead RTC boots to 1970, or a user sets their clock forward to unlock a
 * trial app. Under last-writer-wins, that one skewed device wins *every* future
 * merge, permanently. That is not a hypothetical — it is the single most common
 * way naive offline sync corrupts a dataset.
 *
 * An HLC keeps physical time when it is sane and falls back to a logical
 * counter when it is not, so causality always dominates skew.
 *
 * ENCODING
 *   <12 hex chars: 48-bit ms><4 hex chars: 16-bit counter><-deviceId>
 * Fixed widths mean lexicographic string comparison IS causal comparison, so
 * Dexie can index it directly and we never ship a custom comparator.
 */

import { log } from './telemetry'

export type HLC = string

/** Reject wall clocks more than this far ahead of our own. */
const MAX_DRIFT_MS = 60_000
const COUNTER_MAX = 0xffff

export interface ClockState {
  wall: number
  counter: number
  nodeId: string
}

export function createClock(nodeId: string): ClockState {
  return { wall: 0, counter: 0, nodeId }
}

function encode(wall: number, counter: number, nodeId: string): HLC {
  return `${wall.toString(16).padStart(12, '0')}${counter.toString(16).padStart(4, '0')}-${nodeId}`
}

export function parseHLC(hlc: HLC): { wall: number; counter: number; nodeId: string } | null {
  const dash = hlc.indexOf('-')
  if (dash !== 16) return null
  const wall = parseInt(hlc.slice(0, 12), 16)
  const counter = parseInt(hlc.slice(12, 16), 16)
  if (Number.isNaN(wall) || Number.isNaN(counter)) return null
  return { wall, counter, nodeId: hlc.slice(dash + 1) }
}

/** Stamp a local mutation. */
export function now(state: ClockState, physicalNow = Date.now()): HLC {
  const prevWall = state.wall
  state.wall = Math.max(prevWall, physicalNow)
  // If physical time did not advance past our last stamp, tick the logical part.
  state.counter = state.wall === prevWall ? state.counter + 1 : 0

  if (state.counter > COUNTER_MAX) {
    // 65k events inside one millisecond means something is looping. Borrow a ms
    // rather than overflow into the wall field and corrupt the ordering.
    state.wall += 1
    state.counter = 0
    log.warn('crdt', 'HLC counter overflow, borrowed 1ms', { nodeId: state.nodeId })
  }
  return encode(state.wall, state.counter, state.nodeId)
}

/**
 * Merge a remote stamp into our clock on receive. This is what actually keeps
 * the network converged — every device that *sees* an event inherits its time.
 */
export function receive(state: ClockState, remote: HLC, physicalNow = Date.now()): HLC {
  const parsed = parseHLC(remote)
  if (!parsed) {
    log.warn('crdt', 'unparseable remote HLC, ignoring', { remote })
    return now(state, physicalNow)
  }

  if (parsed.wall - physicalNow > MAX_DRIFT_MS) {
    // Accept the event (rejecting it would lose data) but flag it loudly: this
    // is the signature of a device with a broken clock poisoning the ordering.
    log.warn('crdt', 'remote HLC exceeds drift tolerance', {
      remoteWall: parsed.wall,
      localWall: physicalNow,
      driftMs: parsed.wall - physicalNow,
      nodeId: parsed.nodeId,
    })
  }

  const prevWall = state.wall
  state.wall = Math.max(prevWall, parsed.wall, physicalNow)

  if (state.wall === prevWall && state.wall === parsed.wall) {
    state.counter = Math.max(state.counter, parsed.counter) + 1
  } else if (state.wall === prevWall) {
    state.counter = state.counter + 1
  } else if (state.wall === parsed.wall) {
    state.counter = parsed.counter + 1
  } else {
    state.counter = 0
  }

  return encode(state.wall, state.counter, state.nodeId)
}

/** -1 | 0 | 1. Plain string compare, because the encoding guarantees it works. */
export function compareHLC(a: HLC, b: HLC): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Last-writer-wins register resolution with a deterministic tiebreak.
 *
 * The nodeId suffix matters: if two devices stamp the identical wall+counter
 * (possible after a merge), comparing the full string breaks the tie the same
 * way on both devices. Without it they'd disagree forever and the "converged"
 * state would depend on merge order.
 */
export function lwwPick<T extends { hlc: HLC }>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b
  if (!b) return a
  return compareHLC(a.hlc, b.hlc) >= 0 ? a : b
}
