/**
 * QR rendering.
 *
 * SVG rather than canvas/PNG: it stays sharp when a user pinch-zooms to help a
 * struggling camera lock on, it inherits our two colours with no image
 * pipeline, and it costs nothing to hand to <img> as a data URI.
 *
 * ERROR CORRECTION LEVEL — 'M' (15%) is deliberate. 'L' is denser and scans
 * worse on a cracked screen; 'H' (30%) survives more damage but inflates the
 * module count enough to push our 209-char voucher into a larger QR version,
 * which costs more than the redundancy buys. 'M' is the sweet spot for
 * screen-to-camera transfer, where the failure mode is glare and focus, not
 * physical damage.
 */

import QRCode from 'qrcode'
import { log } from '../telemetry'

export interface QROptions {
  /** Module colour. Defaults to the deep green. */
  dark?: string
  /** Background. Defaults to paper. */
  light?: string
  /** Quiet-zone width in modules. Below 2 some scanners fail to find the symbol. */
  margin?: number
}

const DEFAULTS: Required<QROptions> = {
  dark: '#0B4A33',
  light: '#F1EFE3',
  margin: 2,
}

export async function renderQRSVG(payload: string, opts: QROptions = {}): Promise<string> {
  const o = { ...DEFAULTS, ...opts }
  const svg = await QRCode.toString(payload, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: o.margin,
    color: { dark: o.dark, light: o.light },
  })

  log.trace('qr', 'rendered QR', { chars: payload.length })
  // Let the SVG fill its container rather than carry a fixed pixel size.
  return svg.replace(/<svg /, '<svg preserveAspectRatio="xMidYMid meet" ')
}

export async function renderQRDataURI(payload: string, opts: QROptions = {}): Promise<string> {
  const svg = await renderQRSVG(payload, opts)
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/**
 * Reports the symbol version a payload will need.
 *
 * Surfaced in the dev panel because payload size is the difference between a
 * code that scans instantly and one that needs three attempts — and it is very
 * easy to add "just one more field" and silently cross a version boundary.
 */
export function estimateQRVersion(payloadLength: number): { version: number; note: string } {
  // Byte-mode capacities at ECC level M.
  const CAPACITY_M = [
    14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666,
  ]
  for (let i = 0; i < CAPACITY_M.length; i++) {
    if (payloadLength <= CAPACITY_M[i]!) {
      const version = i + 1
      const note =
        version <= 8
          ? 'scans reliably on low-end cameras'
          : version <= 12
            ? 'usable, needs a steadier hand'
            : 'too dense for cheap cameras — shrink the payload'
      return { version, note }
    }
  }
  return { version: 21, note: 'exceeds practical screen-to-camera transfer' }
}
