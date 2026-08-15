/**
 * Languages people actually write in here.
 *
 * WHY A LIST AND NOT A FREE-TEXT FIELD
 * Unlike a place — where a free-text area is right, because the local unit is
 * called something different everywhere — a language tag has to MATCH across
 * devices for a translation to find its original. "Yoruba", "Yorùbá", "yoruba"
 * and "YR" are one language and four strings, and four strings mean a
 * translation nobody can find.
 *
 * Codes are ISO 639-1 where one exists and ISO 639-3 otherwise, so `pcm`
 * (Nigerian Pidgin) sits beside `ha`, `yo` and `ig` without special-casing.
 * Every name is written in the language itself as well as in English, because
 * a picker that only says "Hausa" is asking someone to find their own language
 * in a list written for somebody else.
 */

const DATA =
  'en:English:English|pcm:Nigerian Pidgin:Naijá|ha:Hausa:Hausa|yo:Yoruba:Yorùbá|' +
  'ig:Igbo:Igbo|ff:Fulfulde:Fulfulde|kr:Kanuri:Kanuri|ti:Tiv:Tiv|ibb:Ibibio:Ibibio|' +
  'efi:Efik:Efik|ijc:Izon:Ịjọ|idu:Idoma:Idoma|nup:Nupe:Nupe|urh:Urhobo:Urhobo|' +
  'fr:French:Français|ar:Arabic:العربية|sw:Swahili:Kiswahili|am:Amharic:አማርኛ|' +
  'so:Somali:Soomaali|om:Oromo:Afaan Oromoo|zu:Zulu:isiZulu|xh:Xhosa:isiXhosa|' +
  'af:Afrikaans:Afrikaans|st:Sotho:Sesotho|tn:Tswana:Setswana|sn:Shona:chiShona|' +
  'ny:Chichewa:Chichewa|rw:Kinyarwanda:Ikinyarwanda|lg:Luganda:Luganda|' +
  'wo:Wolof:Wolof|bm:Bambara:Bamanankan|mos:Mooré:Mooré|ak:Akan:Akan|ee:Ewe:Eʋegbe|' +
  'tw:Twi:Twi|pt:Portuguese:Português|es:Spanish:Español|de:German:Deutsch|' +
  'it:Italian:Italiano|nl:Dutch:Nederlands|hi:Hindi:हिन्दी|ur:Urdu:اردو|' +
  'bn:Bengali:বাংলা|ta:Tamil:தமிழ்|zh:Chinese:中文|ja:Japanese:日本語|' +
  'ko:Korean:한국어|id:Indonesian:Bahasa Indonesia|ms:Malay:Bahasa Melayu|' +
  'tr:Turkish:Türkçe|ru:Russian:Русский|uk:Ukrainian:Українська|fa:Persian:فارسی'

export interface Language {
  code: string
  /** English name, for the person choosing on someone else's behalf. */
  name: string
  /** The language's own name, for the person who speaks it. */
  endonym: string
}

export const LANGUAGES: readonly Language[] = DATA.split('|').map((entry) => {
  const [code, name, endonym] = entry.split(':')
  return { code: code!, name: name!, endonym: endonym! }
})

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]))

export function languageName(code: string | undefined): string | undefined {
  if (!code) return undefined
  const l = BY_CODE.get(code)
  if (!l) return undefined
  return l.endonym === l.name ? l.name : `${l.endonym} (${l.name})`
}

export function isLanguageCode(code: string | undefined): boolean {
  return !!code && BY_CODE.has(code)
}

/**
 * Best guess from the browser, used only to preselect a picker.
 *
 * Never written into a record without the author confirming: a wrong tag sends
 * a translation request to speakers of the wrong language, and mislabels the
 * original for everyone downstream.
 */
export function guessLanguage(): string | undefined {
  if (typeof navigator === 'undefined') return undefined
  for (const tag of navigator.languages ?? [navigator.language]) {
    const primary = tag?.split('-')[0]?.toLowerCase()
    if (primary && BY_CODE.has(primary)) return primary
  }
  return undefined
}
