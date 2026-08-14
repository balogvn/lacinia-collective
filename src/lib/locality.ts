/**
 * Reading and writing places, across two record shapes.
 *
 * The Nigeria-only build wrote `{ state, lga }`. Those records are published
 * and signed, so the fields cannot be renamed — the bytes have to keep
 * verifying. Everything since writes `{ country, region, area }`.
 *
 * Rather than scatter `l.area ?? l.lga` through a dozen components, all reading
 * goes through here. One place to get the fallback right, and one place to
 * delete when the legacy shape is finally gone.
 */

import { countryName } from './data/countries'
import type { Locality } from './db/schema'

/** The local unit — the thing proximity is judged on. */
export function localityArea(l: Locality | undefined): string | undefined {
  if (!l) return undefined
  return l.area?.trim() || l.lga?.trim() || undefined
}

/** The larger division, if the record has one. */
export function localityRegion(l: Locality | undefined): string | undefined {
  if (!l) return undefined
  return l.region?.trim() || l.state?.trim() || undefined
}

/**
 * Human-readable place, most specific first — "Ikorodu, Lagos, Nigeria".
 *
 * Country is spelled out rather than shown as a code: "NG" means nothing to
 * most people, and this string appears next to offers of help.
 */
export function formatLocality(l: Locality | undefined): string | undefined {
  if (!l) return undefined
  const parts = [localityArea(l), localityRegion(l), countryName(l.country)].filter(
    (p): p is string => !!p,
  )
  return parts.length > 0 ? parts.join(', ') : undefined
}

/** Same place? Compared on country + area, the units proximity actually means. */
export function sameArea(a: Locality | undefined, b: Locality | undefined): boolean {
  const areaA = localityArea(a)?.toLowerCase()
  const areaB = localityArea(b)?.toLowerCase()
  if (!areaA || !areaB || areaA !== areaB) return false
  // Legacy records carry no country; treat a missing one as "don't disqualify",
  // otherwise every pre-existing listing would stop matching its own neighbours.
  if (a?.country && b?.country && a.country !== b.country) return false
  return true
}

/** Strips empties so the record does not carry blank strings into signed bytes. */
export function cleanLocality(input: {
  country?: string
  region?: string
  area?: string
}): Locality | undefined {
  const out: Locality = {}
  if (input.country?.trim()) out.country = input.country.trim()
  if (input.region?.trim()) out.region = input.region.trim()
  if (input.area?.trim()) out.area = input.area.trim()
  return Object.keys(out).length > 0 ? out : undefined
}
