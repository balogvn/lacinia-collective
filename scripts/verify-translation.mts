/**
 * Headless adversarial verification of translation.
 *
 * Translation carries a failure mode nothing else here has: it is read by
 * exactly the people who cannot read the original, so a forged or substituted
 * translation is the one lie its audience is least equipped to catch. Most of
 * what follows is about that, and about the second rule — that nothing may ever
 * be hidden because of the language it is in.
 *
 *   npm run verify:translation
 */

import {
  createTranslation,
  verifyTranslation,
  translationsFor,
  needsTranslation,
  MAX_TRANSLATION_CHARS,
  TRANSLATION_DOMAIN,
} from '../src/lib/lang/translation'
import { LANGUAGES, languageName, isLanguageCode, guessLanguage } from '../src/lib/lang/languages'
import { generateEphemeralKeyPair } from '../src/lib/crypto/keys'
import type { Translation } from '../src/lib/db/schema'
import { configureTelemetry } from '../src/lib/telemetry'

configureTelemetry({ mirrorToConsole: false })

let passed = 0
let failed = 0
const failures: string[] = []

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ${GREEN}✓${RESET} ${name}${detail ? ` ${DIM}${detail}${RESET}` : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ${RED}✗ ${name}${RESET}${detail ? ` ${DIM}${detail}${RESET}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${BOLD}${title}${RESET}`)
}

const amina = generateEphemeralKeyPair()
const tunde = generateEphemeralKeyPair()
const mallam = generateEphemeralKeyPair()

const STATEMENT = 'stmt-levy-001'

/* ─────────────────── 1. the signed act ─────────────────── */

section('1. A translation is a signed human act')
{
  const t = createTranslation(amina, {
    targetId: STATEMENT,
    targetEntity: 'statement',
    lang: 'yo',
    sourceLang: 'ha',
    text: 'Owó orí ọjà náà pọ̀ jù.',
  })

  check('it verifies against the translator’s key', verifyTranslation(t))
  check('it carries who made it', t.translatorPub === amina.pubKeyId)
  check('it names the language it renders into', t.lang === 'yo')
  check('it records what it was translated from', t.sourceLang === 'ha')
  check('the domain is bound into the signature', t.signedBytes.includes(TRANSLATION_DOMAIN))

  // The forgery this exists to stop: a relay attributing a translation to
  // someone who never wrote it, read by people who cannot check the original.
  const forged: Translation = { ...t, translatorPub: tunde.pubKeyId }
  check('re-attributing it to someone else fails', !verifyTranslation(forged))

  const edited: Translation = { ...t, text: 'Something else entirely.' }
  check('editing the text after signing fails', !verifyTranslation(edited))

  const relabelled: Translation = { ...t, lang: 'ig' }
  check('relabelling the language fails', !verifyTranslation(relabelled))

  const retargeted: Translation = { ...t, targetId: 'a-different-statement' }
  check('pointing it at another statement fails', !verifyTranslation(retargeted))
}

/* ─────────────────── 2. it never replaces the original ─────────────────── */

section('2. Rule 1 — the original is the record, a translation hangs beside it')
{
  const t = createTranslation(amina, {
    targetId: STATEMENT,
    targetEntity: 'statement',
    lang: 'yo',
    text: 'Ìtumọ̀.',
  })

  // A translation names its target and carries no authority over it. Nothing in
  // the record can rewrite the original, and nothing in the view returns it in
  // the original's place.
  const view = translationsFor(STATEMENT, [t])
  check('the view is additive — it returns translations, not a replacement', view.all.length === 1)
  check('the translated text never claims the original’s id', t.id !== STATEMENT)
  check('the translator is not recorded as the author of the original', !('authorPub' in t))
}

/* ─────────────────── 3. translations coexist ─────────────────── */

section('3. Rule 2 — two renderings of the same sentence both stand')
{
  const a = createTranslation(amina, {
    targetId: STATEMENT,
    targetEntity: 'statement',
    lang: 'yo',
    text: 'Àkọ́kọ́.',
    now: 1000,
  })
  const b = createTranslation(tunde, {
    targetId: STATEMENT,
    targetEntity: 'statement',
    lang: 'yo',
    text: 'Ìkejì, ó yàtọ̀.',
    now: 2000,
  })

  const view = translationsFor(STATEMENT, [a, b])
  check('two people translating into the same language both stand', view.all.length === 2)
  check('…and the language is listed once', view.languages.length === 1)

  // Disagreement about meaning is information. Nothing here picks a winner.
  check('neither is marked authoritative', !('authoritative' in a) && !('preferred' in a))

  // But one person revising their own work is an update, not a second voice.
  const revised = createTranslation(amina, {
    targetId: STATEMENT,
    targetEntity: 'statement',
    lang: 'yo',
    text: 'Àkọ́kọ́, tí a tún ṣe.',
    now: 3000,
  })
  // Ids are content addresses — a revision cannot overwrite in place, so the
  // view collapses a translator's own revisions to their newest instead.
  check('a revision is a distinct signed record', revised.id !== a.id && verifyTranslation(revised))
  const afterRevision = translationsFor(STATEMENT, [a, b, revised])
  check(
    'one voice per translator per language survives',
    afterRevision.all.length === 2 &&
      afterRevision.all.filter((x) => x.translatorPub === amina.pubKeyId).length === 1,
  )
  check(
    '…and it is the newest wording',
    afterRevision.all.find((x) => x.translatorPub === amina.pubKeyId)?.text === 'Àkọ́kọ́, tí a tún ṣe.',
  )
  check(
    'a second translator is never collapsed into the first',
    afterRevision.all.some((x) => x.translatorPub === tunde.pubKeyId),
  )
  check(
    'the same person translating into ANOTHER language is a new record',
    createTranslation(amina, { targetId: STATEMENT, targetEntity: 'statement', lang: 'ig', text: 'x' })
      .id !== a.id,
  )
  check(
    'a different person translating the same thing is a new record',
    b.id !== a.id,
  )
}

/* ─────────────────── 4. determinism ─────────────────── */

section('4. Two phones show the same order without talking')
{
  const t = (k: typeof amina, lang: string, now: number, text: string) =>
    createTranslation(k, { targetId: STATEMENT, targetEntity: 'statement', lang, text, now })

  const set = [
    t(amina, 'yo', 1000, 'a'),
    t(tunde, 'ig', 2000, 'b'),
    t(mallam, 'yo', 3000, 'c'),
  ]
  const forward = translationsFor(STATEMENT, set).all.map((x) => x.id).join(',')
  const reversed = translationsFor(STATEMENT, [...set].reverse()).all.map((x) => x.id).join(',')
  check('order does not depend on arrival order', forward === reversed)

  const view = translationsFor(STATEMENT, set, { readerLangs: ['ig'] })
  check('the reader’s language is found when present', view.preferred?.lang === 'ig')
  check('…and everything else is still returned', view.all.length === 3)

  const none = translationsFor(STATEMENT, set, { readerLangs: ['sw'] })
  check('a reader with no rendering gets no preference, not an empty list', none.preferred === undefined && none.all.length === 3)
  check('languages are listed deterministically', none.languages.join(',') === 'ig,yo')
}

/* ─────────────────── 5. nothing is hidden ─────────────────── */

section('5. Rule 3 — the queue surfaces work; it never filters')
{
  const items = [
    { id: 's1', lang: 'ha' },
    { id: 's2', lang: 'yo' },
    { id: 's3', lang: 'en' },
    { id: 's4' }, // untagged
  ]
  const done = createTranslation(amina, {
    targetId: 's1',
    targetEntity: 'statement',
    lang: 'en',
    text: 'rendered',
  })

  const queue = needsTranslation(items, [done], ['en'])
  check('an item already rendered into a language you read is not in the queue', !queue.some((i) => i.id === 's1'))
  check('an item in a language you do not read is in the queue', queue.some((i) => i.id === 's2'))
  check('an item you can already read is not in the queue', !queue.some((i) => i.id === 's3'))

  // Guessing would sweep everything anyone forgot to label into the queue.
  check('an untagged item is never assumed foreign', !queue.some((i) => i.id === 's4'))

  // The property that makes this the opposite of a language filter: the queue
  // is a to-do list for people who CAN read it, and it never subtracts from
  // what anyone sees. Nothing in this module removes an item from a feed.
  check('the queue is a strict subset, never a replacement feed', queue.length < items.length)

  const multilingual = needsTranslation(items, [done], ['en', 'yo'])
  check('reading more languages shrinks the queue, never the feed', multilingual.length < queue.length)

  const withdrawn: Translation = { ...done, deleted: true }
  check(
    'a withdrawn translation puts the work back in the queue',
    needsTranslation(items, [withdrawn], ['en']).some((i) => i.id === 's1'),
  )
}

/* ─────────────────── 6. refusals ─────────────────── */

section('6. What it refuses to sign')
{
  const attempt = (fn: () => unknown): boolean => {
    try {
      fn()
      return false
    } catch {
      return true
    }
  }

  check(
    'an empty translation is refused',
    attempt(() => createTranslation(amina, { targetId: 's', targetEntity: 'statement', lang: 'yo', text: '   ' })),
  )
  check(
    'an unknown target language is refused',
    attempt(() => createTranslation(amina, { targetId: 's', targetEntity: 'statement', lang: 'xx', text: 'a' })),
  )
  check(
    'an unknown source language is refused',
    attempt(() =>
      createTranslation(amina, { targetId: 's', targetEntity: 'statement', lang: 'yo', sourceLang: 'zz', text: 'a' }),
    ),
  )
  check(
    'translating a thing into its own language is refused',
    attempt(() =>
      createTranslation(amina, { targetId: 's', targetEntity: 'statement', lang: 'ha', sourceLang: 'ha', text: 'a' }),
    ),
  )

  const long = createTranslation(amina, {
    targetId: 's',
    targetEntity: 'statement',
    lang: 'yo',
    text: 'x'.repeat(MAX_TRANSLATION_CHARS + 400),
  })
  check('an over-long translation is truncated, not refused', long.text.length === MAX_TRANSLATION_CHARS)
  check('…and the truncated form is what was signed', verifyTranslation(long))
}

/* ─────────────────── 7. the language list ─────────────────── */

section('7. Languages — matching across devices is the whole point')
{
  const codes = LANGUAGES.map((l) => l.code)
  check('the list parsed', LANGUAGES.length > 40, `${LANGUAGES.length} languages`)
  check('no duplicate codes', new Set(codes).size === codes.length)
  check(
    'every entry has a code, a name and an endonym',
    LANGUAGES.every((l) => /^[a-z]{2,3}$/.test(l.code) && l.name.length > 1 && l.endonym.length > 0),
  )

  // The four this project exists to bridge between.
  for (const code of ['ha', 'yo', 'ig', 'pcm']) {
    check(`${code} is present`, isLanguageCode(code), languageName(code))
  }

  check('a language shows its own name first', languageName('yo') === 'Yorùbá (Yoruba)')
  check('…and is not repeated when they match', languageName('Hausa'.toLowerCase().slice(0, 2)) === 'Hausa')
  check('an invented code resolves to nothing', languageName('zz') === undefined && !isLanguageCode('zz'))
  check('guessing never throws without a browser', guessLanguage() === undefined || typeof guessLanguage() === 'string')
}

/* ─────────────────────────── report ─────────────────────────── */

console.log(`\n${BOLD}${'─'.repeat(64)}${RESET}`)
if (failed === 0) {
  console.log(`${GREEN}${BOLD}  ${passed} checks passed.${RESET} Translation holds.`)
} else {
  console.log(`${RED}${BOLD}  ${failed} failed${RESET}, ${passed} passed`)
  for (const f of failures) console.log(`   ${RED}·${RESET} ${f}`)
}
console.log(`${BOLD}${'─'.repeat(64)}${RESET}\n`)

process.exit(failed === 0 ? 0 : 1)
