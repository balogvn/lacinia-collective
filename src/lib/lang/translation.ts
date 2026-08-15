/**
 * Translation — bridging work, done by people, paid for like any other help.
 *
 * THE GAP THIS ADDRESSES
 * A commons built to bridge ethno-religious divides, in a country with hundreds
 * of languages, spoke one of them. A statement written in Hausa was invisible
 * to a Yorùbá speaker standing in the same market. That is not a missing
 * feature at the edge of the product; it is the mission failing in the middle.
 *
 * WHY NOT A LANGUAGE FILTER
 * The obvious fix — tag everything and let people read only what they
 * understand — makes it worse. Here language tracks the very divides this app
 * exists to cross, so "show me only what I can read" is ethnic filtering with a
 * friendly label. Worse, deliberate/ ranks statements by what BRIDGES opinion
 * groups; filtering by language would partition those groups before the
 * algorithm ever ran, and the thing it surfaced would be consensus inside one
 * bloc. There is deliberately no way to hide another language here.
 *
 * WHY NOT MACHINE TRANSLATION
 * A model small enough for a 2GB Android phone is not good enough to be trusted
 * with what a neighbour said, and a translation pass in CI would put a machine
 * in the middle of every sentence people exchange — in an app whose entire
 * claim is that nothing sits between them. It would also be one more thing to
 * capture: whoever ran the pass would decide what everyone else understood.
 *
 * SO: A TRANSLATION IS A SIGNED HUMAN ACT
 * Someone who reads both languages writes it, signs it, and can be paid in time
 * credits like anyone doing an hour of work. It carries their key, so you can
 * see who translated it and what standing they hold. That makes translation
 * exactly what it is here — bridging labour — and makes it visible, attributed
 * and rewardable rather than free, invisible and anonymous.
 *
 * THREE RULES ENCODED BELOW
 *   1. A translation NEVER replaces the original. The original is the record;
 *      a translation is an annotation hung beside it. Replacing it would make
 *      the translator the author of someone else's words.
 *   2. Translations do not compete. Two people may render the same sentence
 *      differently and both stand — disagreement about meaning is information,
 *      not a conflict to resolve. One person revising their OWN rendering is a
 *      new signed record (ids are content addresses and cannot be otherwise),
 *      so the view keeps their newest and leaves the rest as history.
 *   3. Nothing is hidden. There is no call anywhere that removes content in a
 *      language you do not read.
 */

import { attest, verifyAttestation } from '../crypto/attest'
import type { KeyPair } from '../crypto/keys'
import { isLanguageCode } from './languages'
import type { Translation, TranslationTarget } from '../db/schema'
import { log } from '../telemetry'

export const TRANSLATION_DOMAIN = 'lacinia/translation/v1'

/** Long enough for a market notice or a deliberation statement, not an essay. */
export const MAX_TRANSLATION_CHARS = 480

/**
 * WHY THERE IS NO (translator, target, language) ID.
 *
 * The first draft derived ids that way so a revision would overwrite in place.
 * It cannot: `verifyAttestation` binds a record's id to the content address of
 * its own signed bytes, so an id chosen by any other rule fails verification —
 * correctly, since that binding is what stops an edited row keeping a valid
 * signature. A revision is therefore a new signed record, and collapsing to the
 * newest is a job for the view, below.
 */

export function createTranslation(
  translator: KeyPair,
  input: {
    targetId: string
    targetEntity: TranslationTarget
    /** The language being translated INTO. */
    lang: string
    text: string
    /** What the translator believes the original is written in, if known. */
    sourceLang?: string
    now?: number
  },
): Translation {
  const text = input.text.trim().slice(0, MAX_TRANSLATION_CHARS)
  if (!text) throw new Error('a translation cannot be empty')
  if (!isLanguageCode(input.lang)) throw new Error(`unknown language: ${input.lang}`)
  if (input.sourceLang && !isLanguageCode(input.sourceLang)) {
    throw new Error(`unknown source language: ${input.sourceLang}`)
  }
  if (input.sourceLang === input.lang) {
    throw new Error('a translation into its own source language is not a translation')
  }

  const body = {
    targetId: input.targetId,
    targetEntity: input.targetEntity,
    lang: input.lang,
    ...(input.sourceLang ? { sourceLang: input.sourceLang } : {}),
    text,
    translatorPub: translator.pubKeyId,
    createdAt: input.now ?? Date.now(),
  }

  const attestation = attest(translator, TRANSLATION_DOMAIN, body)

  log.info('sync', 'translation written', {
    target: input.targetId.slice(0, 12),
    lang: input.lang,
    chars: text.length,
  })

  return {
    ...body,
    id: attestation.id,
    signature: attestation.signature,
    signedBytes: attestation.signedBytes,
    hlc: '',
  }
}

/**
 * Signed by the translator themselves, so anyone may relay it.
 *
 * Without this check a relay could put words in a translator's mouth — and
 * since a translation is what a reader takes the original to MEAN, a forged one
 * is a way to make someone appear to have said something they did not, in a
 * language they cannot read to check.
 */
export function verifyTranslation(t: Translation): boolean {
  return verifyAttestation(
    TRANSLATION_DOMAIN,
    t as unknown as Record<string, unknown>,
    t.translatorPub,
  )
}

export interface TranslationView {
  /** Every translation of this item, newest first within each language. */
  all: Translation[]
  /** Languages this item has been rendered into. */
  languages: string[]
  /** The reader's preferred rendering, if one exists. Never hides the original. */
  preferred: Translation | undefined
}

/**
 * What to show beside one item.
 *
 * `preferred` is a convenience for scrolling to the reader's language first —
 * it is NOT a replacement, and callers render the original regardless. Sorting
 * is fully deterministic so two devices holding the same records show the same
 * order without talking to each other.
 */
export function translationsFor(
  targetId: string,
  translations: readonly Translation[],
  opts: { readerLangs?: readonly string[] } = {},
): TranslationView {
  const sorted = translations
    .filter((t) => t.targetId === targetId && !t.deleted)
    .sort((a, b) => {
      if (a.lang !== b.lang) return a.lang < b.lang ? -1 : 1
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
      return a.id < b.id ? -1 : 1
    })

  // One voice per translator per language: someone correcting their own wording
  // is the same person saying the same thing better, and showing both would
  // make one translator look like two agreeing with each other. Different
  // people are never collapsed — that disagreement is the point.
  const seen = new Set<string>()
  const mine = sorted.filter((t) => {
    const voice = `${t.translatorPub}|${t.lang}`
    if (seen.has(voice)) return false
    seen.add(voice)
    return true
  })

  const languages = [...new Set(mine.map((t) => t.lang))]

  let preferred: Translation | undefined
  for (const lang of opts.readerLangs ?? []) {
    preferred = mine.find((t) => t.lang === lang)
    if (preferred) break
  }

  return { all: mine, languages, preferred }
}

/**
 * Items written in a language the reader does not read, and not yet rendered
 * into one they do — the queue of bridging work waiting to be done.
 *
 * This is the inverse of a language filter, and deliberately so. A filter hides
 * what you cannot read; this surfaces it, to the people who CAN read it, as
 * something worth doing and worth being paid for.
 */
export function needsTranslation<T extends { id: string; lang?: string }>(
  items: readonly T[],
  translations: readonly Translation[],
  readerLangs: readonly string[],
): T[] {
  const reads = new Set(readerLangs)
  const rendered = new Map<string, Set<string>>()
  for (const t of translations) {
    if (t.deleted) continue
    const set = rendered.get(t.targetId) ?? new Set<string>()
    set.add(t.lang)
    rendered.set(t.targetId, set)
  }

  return items.filter((item) => {
    // An untagged item is not assumed to be foreign. Guessing would fill this
    // queue with everything anyone forgot to label.
    if (!item.lang) return false
    if (reads.has(item.lang)) return false
    const into = rendered.get(item.id)
    if (!into) return true
    return ![...reads].some((l) => into.has(l))
  })
}
