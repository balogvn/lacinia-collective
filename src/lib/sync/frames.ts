/**
 * Multi-frame QR transfer — offline device-to-device sync with no network.
 *
 * A vouch fits in one QR. A bundle does not: even a modest 20-op bundle is
 * several kilobytes, which is two orders of magnitude past what a QR can hold.
 * So the payload is compressed, split into frames, and animated; the receiver
 * scans until it has collected every frame.
 *
 * DESIGN NOTES THAT MATTER IN PRACTICE
 *
 * • Frames are SELF-IDENTIFYING and order-independent. Each carries the
 *   transfer id, its index, and the total. A receiver can join halfway through
 *   the animation, collect 7..12 then 1..6 on the next loop, and finish. If
 *   frames had to be scanned in order, every missed frame would restart the
 *   whole transfer — which on a shaky hand-held camera is most of them.
 *
 * • The sender loops forever. There is no back-channel, so the sender cannot
 *   know when the receiver is done; the receiver simply stops watching.
 *
 * • Gzip via CompressionStream, feature-detected. JSON bundles compress by
 *   roughly 70%, which is the difference between 40 frames and 12. Where
 *   CompressionStream is missing (old WebViews) the flag byte records that the
 *   payload is raw, so a modern receiver still reads an old sender's frames.
 *
 * • A digest of the whole payload is carried in every frame, so a receiver that
 *   accidentally mixes frames from two different transfers detects it instead
 *   of assembling garbage.
 */

import { toBase64Url, fromBase64Url, CodecError } from '../codec'
import { contentId } from '../crypto/keys'
import { log } from '../telemetry'

export const FRAME_SCHEME = 'LCNF1:'

/**
 * Payload bytes per frame.
 *
 * 160 bytes → ~214 base64url chars + header ≈ QR v10 at ECC-M, matching the
 * density we already validated for vouchers in Task 1. Larger frames mean fewer
 * of them but a denser symbol, and past ~v12 a cheap camera stops locking on at
 * all — at which point the transfer never completes regardless of frame count.
 */
export const FRAME_PAYLOAD_BYTES = 160

export interface FrameHeader {
  transferId: string
  index: number
  total: number
  compressed: boolean
}

export interface TransferPlan {
  transferId: string
  frames: string[]
  totalBytes: number
  compressedBytes: number
  compressed: boolean
}

async function gzip(bytes: Uint8Array): Promise<{ out: Uint8Array; compressed: boolean }> {
  const Ctor = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream
  if (!Ctor) {
    log.warn('sync', 'CompressionStream unavailable — sending frames uncompressed')
    return { out: bytes, compressed: false }
  }
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new Ctor('gzip'))
    const buf = await new Response(stream).arrayBuffer()
    return { out: new Uint8Array(buf), compressed: true }
  } catch (err) {
    log.warn('sync', 'gzip failed, falling back to raw', { error: String(err) })
    return { out: bytes, compressed: false }
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream
  if (!Ctor) throw new CodecError('this device cannot decompress — ask the sender to resend raw')
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new Ctor('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Splits a payload into scannable frames. */
export async function planTransfer(payload: string): Promise<TransferPlan> {
  const raw = new TextEncoder().encode(payload)
  const { out, compressed } = await gzip(raw)
  const transferId = contentId(out).slice(0, 8)

  const total = Math.max(1, Math.ceil(out.length / FRAME_PAYLOAD_BYTES))
  const frames: string[] = []

  for (let i = 0; i < total; i++) {
    const chunk = out.subarray(i * FRAME_PAYLOAD_BYTES, (i + 1) * FRAME_PAYLOAD_BYTES)
    // Header is plain text so a generic scanner shows something meaningful, and
    // so a human debugging a failed transfer can read the frame numbers.
    frames.push(
      `${FRAME_SCHEME}${transferId}.${i}.${total}.${compressed ? 'z' : 'r'}.${toBase64Url(chunk)}`,
    )
  }

  log.info('sync', 'transfer planned', {
    transferId,
    frames: total,
    rawBytes: raw.length,
    wireBytes: out.length,
    ratio: `${((1 - out.length / Math.max(1, raw.length)) * 100).toFixed(0)}% smaller`,
  })

  return {
    transferId,
    frames,
    totalBytes: raw.length,
    compressedBytes: out.length,
    compressed,
  }
}

export function parseFrame(text: string): { header: FrameHeader; payload: Uint8Array } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(FRAME_SCHEME)) return null

  const body = trimmed.slice(FRAME_SCHEME.length)
  // Split only on the first four separators; base64url never contains '.', but
  // splitting with a limit keeps this robust if that ever changes.
  const firstDot = body.indexOf('.')
  const secondDot = body.indexOf('.', firstDot + 1)
  const thirdDot = body.indexOf('.', secondDot + 1)
  const fourthDot = body.indexOf('.', thirdDot + 1)
  if (firstDot < 0 || secondDot < 0 || thirdDot < 0 || fourthDot < 0) return null

  const transferId = body.slice(0, firstDot)
  const index = Number(body.slice(firstDot + 1, secondDot))
  const total = Number(body.slice(secondDot + 1, thirdDot))
  const mode = body.slice(thirdDot + 1, fourthDot)
  const data = body.slice(fourthDot + 1)

  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 0 || index >= total) {
    return null
  }

  try {
    return {
      header: { transferId, index, total, compressed: mode === 'z' },
      payload: fromBase64Url(data),
    }
  } catch {
    return null
  }
}

/**
 * Accumulates frames until a transfer is complete.
 *
 * Holds exactly one transfer at a time: seeing a frame from a different
 * transferId resets the buffer rather than interleaving, because two people
 * showing codes near each other is a realistic way to corrupt an assembly.
 */
export class FrameCollector {
  private transferId: string | null = null
  private total = 0
  private compressed = false
  private chunks = new Map<number, Uint8Array>()

  get progress(): { received: number; total: number; transferId: string | null } {
    return { received: this.chunks.size, total: this.total, transferId: this.transferId }
  }

  get missing(): number[] {
    const out: number[] = []
    for (let i = 0; i < this.total; i++) if (!this.chunks.has(i)) out.push(i)
    return out
  }

  reset(): void {
    this.transferId = null
    this.total = 0
    this.chunks.clear()
  }

  /** Returns the assembled payload once every frame has been seen. */
  async accept(text: string): Promise<{ done: false } | { done: true; payload: string }> {
    const frame = parseFrame(text)
    if (!frame) return { done: false }

    if (this.transferId !== frame.header.transferId) {
      if (this.transferId !== null) {
        log.info('sync', 'different transfer detected, restarting collection', {
          was: this.transferId,
          now: frame.header.transferId,
        })
      }
      this.transferId = frame.header.transferId
      this.total = frame.header.total
      this.compressed = frame.header.compressed
      this.chunks.clear()
    }

    this.chunks.set(frame.header.index, frame.payload)
    if (this.chunks.size < this.total) return { done: false }

    const parts: Uint8Array[] = []
    let size = 0
    for (let i = 0; i < this.total; i++) {
      const chunk = this.chunks.get(i)!
      parts.push(chunk)
      size += chunk.length
    }
    const joined = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      joined.set(part, offset)
      offset += part.length
    }

    // Guards against frames from two transfers that happened to share an id
    // prefix — cheap, and the failure it prevents is silent data corruption.
    if (contentId(joined).slice(0, 8) !== this.transferId) {
      log.error('sync', 'assembled payload digest mismatch — discarding transfer')
      this.reset()
      return { done: false }
    }

    const bytes = this.compressed ? await gunzip(joined) : joined
    const payload = new TextDecoder().decode(bytes)

    log.info('sync', 'transfer assembled', { transferId: this.transferId, bytes: bytes.length })
    this.reset()
    return { done: true, payload }
  }
}
