/**
 * Camera scanning via jsQR.
 *
 * WHY NOT BarcodeDetector: it is the obvious choice and it is absent on iOS
 * Safari and on the old Android WebViews we target. jsQR is ~40KB, pure JS, and
 * works identically everywhere. We do feature-detect BarcodeDetector and prefer
 * it when present, because it is hardware-accelerated and saves battery.
 *
 * The scan loop is throttled rather than run per-frame: decoding at 60fps pins
 * a cheap CPU, heats the phone, and does not find codes any faster than 8fps.
 */

import jsQR from 'jsqr'
import { log } from '../telemetry'

export interface ScannerHandle {
  stop: () => void
}

interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>
}

const SCAN_INTERVAL_MS = 125 // 8 fps

export class CameraUnavailableError extends Error {
  constructor(
    message: string,
    readonly kind: 'insecure-context' | 'no-api' | 'denied' | 'no-camera' | 'unknown',
  ) {
    super(message)
    this.name = 'CameraUnavailableError'
  }
}

/** Translates the browser's opaque errors into something we can show a user. */
function classify(err: unknown): CameraUnavailableError {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CameraUnavailableError(
      'Camera permission was refused. Allow it in your browser settings, or paste the code instead.',
      'denied',
    )
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new CameraUnavailableError('No camera found on this device.', 'no-camera')
  }
  return new CameraUnavailableError(
    err instanceof Error ? err.message : 'Camera could not be started.',
    'unknown',
  )
}

/**
 * Starts scanning into `video`, calling `onResult` for each distinct decode.
 * Always returns a handle whose `stop()` is safe to call more than once.
 */
export async function startScanner(
  video: HTMLVideoElement,
  onResult: (text: string) => void,
  onError?: (err: CameraUnavailableError) => void,
): Promise<ScannerHandle> {
  if (typeof window === 'undefined') {
    throw new CameraUnavailableError('Scanner requires a browser.', 'no-api')
  }
  if (!window.isSecureContext) {
    const e = new CameraUnavailableError(
      'Camera needs a secure connection (https:// or localhost).',
      'insecure-context',
    )
    onError?.(e)
    throw e
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    const e = new CameraUnavailableError('This browser cannot open a camera.', 'no-api')
    onError?.(e)
    throw e
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
  } catch (err) {
    const e = classify(err)
    log.warn('qr', 'camera unavailable', { kind: e.kind, message: e.message })
    onError?.(e)
    throw e
  }

  video.srcObject = stream
  video.setAttribute('playsinline', 'true') // iOS refuses inline playback without this
  await video.play().catch(() => undefined)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  const DetectorCtor = (window as unknown as { BarcodeDetector?: new (o: object) => BarcodeDetectorLike })
    .BarcodeDetector
  let detector: BarcodeDetectorLike | null = null
  if (DetectorCtor) {
    try {
      detector = new DetectorCtor({ formats: ['qr_code'] })
      log.info('qr', 'using native BarcodeDetector')
    } catch {
      detector = null
    }
  }
  if (!detector) log.info('qr', 'using jsQR fallback')

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // Suppress repeats: a QR stays in frame for many cycles and we do not want to
  // re-run signature verification and re-write IndexedDB dozens of times.
  let lastValue = ''

  const emit = (text: string): void => {
    if (text === lastValue) return
    lastValue = text
    log.info('qr', 'code decoded', { chars: text.length })
    onResult(text)
  }

  const tick = async (): Promise<void> => {
    if (stopped) return

    if (video.readyState === video.HAVE_ENOUGH_DATA && ctx) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight

      if (canvas.width && canvas.height) {
        try {
          if (detector) {
            // BarcodeDetector reads the video element directly — no canvas copy.
            const found = await detector.detect(video)
            if (found.length > 0 && found[0]?.rawValue) emit(found[0].rawValue)
          } else {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
            const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
            const result = jsQR(image.data, image.width, image.height, {
              inversionAttempts: 'dontInvert',
            })
            if (result?.data) emit(result.data)
          }
        } catch (err) {
          log.warn('qr', 'decode pass threw', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    if (!stopped) timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS)
  }

  void tick()

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      if (timer) clearTimeout(timer)
      for (const track of stream.getTracks()) track.stop()
      video.srcObject = null
      log.info('qr', 'scanner stopped')
    },
  }
}

/** Decode a still image — the paste-a-screenshot path when a camera is unavailable. */
export async function decodeImageFile(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return jsQR(image.data, image.width, image.height)?.data ?? null
}
