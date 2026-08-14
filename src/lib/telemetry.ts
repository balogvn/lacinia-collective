/**
 * Rule 5 — Agent Ops.
 *
 * Offline CRDT bugs are near-impossible to reproduce after the fact: the device
 * that caused them is on someone else's phone, in a market, with no signal. So
 * we keep a bounded ring buffer of structured events in memory and mirror the
 * important ones to console. `dumpTelemetry()` produces a paste-able report a
 * user can send over WhatsApp when something goes wrong.
 *
 * Deliberately dependency-free and synchronous — it must work inside a
 * try/catch in a service worker, in a Node test script, and in the browser.
 */

export type Severity = 'trace' | 'info' | 'warn' | 'error'

export type Channel =
  | 'crypto'
  | 'db'
  | 'vouch'
  | 'trust'
  | 'qr'
  | 'sync'
  | 'crdt'
  | 'ui'

export interface TelemetryEvent {
  t: number
  severity: Severity
  channel: Channel
  message: string
  data?: Record<string, unknown>
}

const RING_CAPACITY = 500
const ring: TelemetryEvent[] = []

let minSeverity: Severity = 'trace'
let mirrorToConsole = true

const RANK: Record<Severity, number> = { trace: 0, info: 1, warn: 2, error: 3 }

const CONSOLE_STYLE: Record<Severity, string> = {
  trace: 'color:#7a8f85',
  info: 'color:#0B4A33;font-weight:600',
  warn: 'color:#8a6d1f;font-weight:600',
  error: 'color:#a33b1f;font-weight:700',
}

function push(
  severity: Severity,
  channel: Channel,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (RANK[severity] < RANK[minSeverity]) return

  const event: TelemetryEvent = { t: Date.now(), severity, channel, message }
  if (data !== undefined) event.data = data

  ring.push(event)
  if (ring.length > RING_CAPACITY) ring.shift()

  if (!mirrorToConsole) return
  const label = `%c[lacinia:${channel}]`
  const style = CONSOLE_STYLE[severity]
  const sink =
    severity === 'error'
      ? console.error
      : severity === 'warn'
        ? console.warn
        : console.log
  if (data !== undefined) sink(label, style, message, data)
  else sink(label, style, message)
}

export const log = {
  trace: (c: Channel, m: string, d?: Record<string, unknown>) => push('trace', c, m, d),
  info: (c: Channel, m: string, d?: Record<string, unknown>) => push('info', c, m, d),
  warn: (c: Channel, m: string, d?: Record<string, unknown>) => push('warn', c, m, d),
  error: (c: Channel, m: string, d?: Record<string, unknown>) => push('error', c, m, d),
}

export function configureTelemetry(opts: {
  minSeverity?: Severity
  mirrorToConsole?: boolean
}): void {
  if (opts.minSeverity) minSeverity = opts.minSeverity
  if (opts.mirrorToConsole !== undefined) mirrorToConsole = opts.mirrorToConsole
}

export function getTelemetry(): readonly TelemetryEvent[] {
  return ring
}

export function clearTelemetry(): void {
  ring.length = 0
}

/**
 * Times an operation and records its duration. Used around every signature
 * verification and every Dexie transaction, because on a low-end device the
 * difference between 4ms and 400ms is the difference between "works" and
 * "user force-quits the app".
 */
export function timed<T>(channel: Channel, message: string, fn: () => T): T {
  const start = performance.now()
  try {
    const out = fn()
    push('trace', channel, message, { ms: +(performance.now() - start).toFixed(2) })
    return out
  } catch (err) {
    push('error', channel, `${message} — threw`, {
      ms: +(performance.now() - start).toFixed(2),
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

export async function timedAsync<T>(
  channel: Channel,
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now()
  try {
    const out = await fn()
    push('trace', channel, message, { ms: +(performance.now() - start).toFixed(2) })
    return out
  } catch (err) {
    push('error', channel, `${message} — threw`, {
      ms: +(performance.now() - start).toFixed(2),
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

/** Paste-able plaintext report. Contains no secret key material by construction. */
export function dumpTelemetry(): string {
  const header = `lacinia telemetry — ${ring.length} events — generated ${new Date().toISOString()}`
  const lines = ring.map((e) => {
    const ts = new Date(e.t).toISOString().slice(11, 23)
    const tail = e.data ? ` ${JSON.stringify(e.data)}` : ''
    return `${ts} ${e.severity.toUpperCase().padEnd(5)} ${e.channel.padEnd(6)} ${e.message}${tail}`
  })
  return [header, '─'.repeat(header.length), ...lines].join('\n')
}
