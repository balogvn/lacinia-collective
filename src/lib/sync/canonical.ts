/**
 * Canonical JSON — RFC 8785 (JCS) shaped, with one deliberate addition.
 *
 * WHY THIS EXISTS
 * Signed ops are structured records, and a per-entity byte encoder (as used for
 * QR payloads in codec.ts) would mean writing and maintaining a new encoder for
 * every entity type forever. Canonical JSON gives one encoder for all of them.
 *
 * The catch JCS carries is number formatting: ECMAScript number-to-string is
 * well-defined, but the moment a float enters a signed document you are relying
 * on every producer and consumer agreeing about 0.1 + 0.2. Rather than hope, we
 * REJECT any non-integer number outright. Every number in our schema is a
 * millisecond timestamp, a count, or a tier — all integers. If a float ever
 * appears in a signed payload it is a bug, and this throws loudly at the point
 * of signing instead of producing a document that verifies on one device and
 * fails on another six months later.
 *
 * The other rule that matters: `undefined` is rejected rather than dropped.
 * Silently omitting a key changes the signed bytes, so `{a:1, b:undefined}` and
 * `{a:1}` would produce identical signatures for semantically different
 * records. Optional fields must be genuinely absent, not present-and-undefined.
 */

export class CanonicalError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path || '<root>'})`)
    this.name = 'CanonicalError'
  }
}

function encode(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push('null')
    return
  }

  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false')
      return

    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalError(`non-finite number (${value}) cannot be signed`, path)
      }
      if (!Number.isInteger(value)) {
        throw new CanonicalError(
          `non-integer number (${value}) cannot be signed — see the note in canonical.ts`,
          path,
        )
      }
      // Integers within Number.MAX_SAFE_INTEGER stringify identically in every
      // engine. -0 is normalised so it cannot produce a second encoding of 0.
      out.push(Object.is(value, -0) ? '0' : String(value))
      return
    }

    case 'string':
      // JSON.stringify on a *string* is fully specified and escape-stable.
      out.push(JSON.stringify(value))
      return

    case 'object': {
      if (Array.isArray(value)) {
        out.push('[')
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out.push(',')
          encode(value[i], `${path}[${i}]`, out)
        }
        out.push(']')
        return
      }

      const record = value as Record<string, unknown>
      // Sort by UTF-16 code unit, which is what String.prototype.localeCompare
      // is NOT — a locale-aware sort would differ across devices.
      const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

      out.push('{')
      let first = true
      for (const key of keys) {
        const child = record[key]
        if (child === undefined) {
          throw new CanonicalError(
            `key "${key}" is present but undefined — omit it entirely instead`,
            path,
          )
        }
        if (!first) out.push(',')
        first = false
        out.push(JSON.stringify(key), ':')
        encode(child, path ? `${path}.${key}` : key, out)
      }
      out.push('}')
      return
    }

    case 'undefined':
      throw new CanonicalError('undefined cannot be signed', path)

    case 'bigint':
      throw new CanonicalError('bigint cannot be signed', path)

    default:
      throw new CanonicalError(`${typeof value} cannot be signed`, path)
  }
}

export function canonicalize(value: unknown): string {
  const out: string[] = []
  encode(value, '', out)
  return out.join('')
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value))
}

/**
 * Strips keys whose value is `undefined`, recursively.
 *
 * TypeScript's optional properties produce `{ locality: undefined }` all over
 * the place once a record round-trips through a spread. Since `canonicalize`
 * refuses those by design, this is the sanctioned way to prepare a record for
 * signing — explicit, at the call site, rather than hidden inside the encoder.
 */
export function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => pruneUndefined(v)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = pruneUndefined(v)
    }
    return out as T
  }
  return value
}
