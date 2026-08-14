/**
 * ISO 3166-1 alpha-2 countries and territories.
 *
 * WHY A COUNTRY LIST AND NOT AN ADMINISTRATIVE-DIVISION DATABASE
 * The obvious "make it global" move is to ship every country's states,
 * counties, districts and municipalities. That dataset is megabytes, and this
 * app exists to work on a metered connection — it would cost every user, in
 * every country, forever, to save a few keystrokes.
 *
 * So: a country code from a fixed list, plus the local area as free text.
 * Around 4KB of source, and it fits every naming scheme on earth without
 * imposing one country's vocabulary on the rest. A Nigerian types their LGA, a
 * Kenyan their ward, a Brazilian their bairro, a Scot their council area.
 *
 * Stored as one delimited string and parsed once: the same data as an array of
 * objects costs roughly three times the bytes over the wire.
 */

const DATA =
  'AF:Afghanistan|AX:Åland Islands|AL:Albania|DZ:Algeria|AS:American Samoa|AD:Andorra|AO:Angola|' +
  'AI:Anguilla|AG:Antigua and Barbuda|AR:Argentina|AM:Armenia|AW:Aruba|AU:Australia|AT:Austria|' +
  'AZ:Azerbaijan|BS:Bahamas|BH:Bahrain|BD:Bangladesh|BB:Barbados|BY:Belarus|BE:Belgium|BZ:Belize|' +
  'BJ:Benin|BM:Bermuda|BT:Bhutan|BO:Bolivia|BA:Bosnia and Herzegovina|BW:Botswana|BR:Brazil|' +
  'BN:Brunei|BG:Bulgaria|BF:Burkina Faso|BI:Burundi|CV:Cabo Verde|KH:Cambodia|CM:Cameroon|' +
  'CA:Canada|KY:Cayman Islands|CF:Central African Republic|TD:Chad|CL:Chile|CN:China|CO:Colombia|' +
  'KM:Comoros|CG:Congo|CD:Congo (DRC)|CK:Cook Islands|CR:Costa Rica|CI:Côte d’Ivoire|HR:Croatia|' +
  'CU:Cuba|CW:Curaçao|CY:Cyprus|CZ:Czechia|DK:Denmark|DJ:Djibouti|DM:Dominica|' +
  'DO:Dominican Republic|EC:Ecuador|EG:Egypt|SV:El Salvador|GQ:Equatorial Guinea|ER:Eritrea|' +
  'EE:Estonia|SZ:Eswatini|ET:Ethiopia|FO:Faroe Islands|FJ:Fiji|FI:Finland|FR:France|' +
  'GF:French Guiana|PF:French Polynesia|GA:Gabon|GM:Gambia|GE:Georgia|DE:Germany|GH:Ghana|' +
  'GI:Gibraltar|GR:Greece|GL:Greenland|GD:Grenada|GP:Guadeloupe|GU:Guam|GT:Guatemala|GG:Guernsey|' +
  'GN:Guinea|GW:Guinea-Bissau|GY:Guyana|HT:Haiti|HN:Honduras|HK:Hong Kong|HU:Hungary|IS:Iceland|' +
  'IN:India|ID:Indonesia|IR:Iran|IQ:Iraq|IE:Ireland|IM:Isle of Man|IL:Israel|IT:Italy|JM:Jamaica|' +
  'JP:Japan|JE:Jersey|JO:Jordan|KZ:Kazakhstan|KE:Kenya|KI:Kiribati|XK:Kosovo|KW:Kuwait|' +
  'KG:Kyrgyzstan|LA:Laos|LV:Latvia|LB:Lebanon|LS:Lesotho|LR:Liberia|LY:Libya|LI:Liechtenstein|' +
  'LT:Lithuania|LU:Luxembourg|MO:Macao|MG:Madagascar|MW:Malawi|MY:Malaysia|MV:Maldives|ML:Mali|' +
  'MT:Malta|MH:Marshall Islands|MQ:Martinique|MR:Mauritania|MU:Mauritius|YT:Mayotte|MX:Mexico|' +
  'FM:Micronesia|MD:Moldova|MC:Monaco|MN:Mongolia|ME:Montenegro|MS:Montserrat|MA:Morocco|' +
  'MZ:Mozambique|MM:Myanmar|NA:Namibia|NR:Nauru|NP:Nepal|NL:Netherlands|NC:New Caledonia|' +
  'NZ:New Zealand|NI:Nicaragua|NE:Niger|NG:Nigeria|NU:Niue|MK:North Macedonia|KP:North Korea|' +
  'NO:Norway|OM:Oman|PK:Pakistan|PW:Palau|PS:Palestine|PA:Panama|PG:Papua New Guinea|PY:Paraguay|' +
  'PE:Peru|PH:Philippines|PL:Poland|PT:Portugal|PR:Puerto Rico|QA:Qatar|RE:Réunion|RO:Romania|' +
  'RU:Russia|RW:Rwanda|BL:Saint Barthélemy|KN:Saint Kitts and Nevis|LC:Saint Lucia|' +
  'MF:Saint Martin|VC:Saint Vincent and the Grenadines|WS:Samoa|SM:San Marino|' +
  'ST:São Tomé and Príncipe|SA:Saudi Arabia|SN:Senegal|RS:Serbia|SC:Seychelles|SL:Sierra Leone|' +
  'SG:Singapore|SX:Sint Maarten|SK:Slovakia|SI:Slovenia|SB:Solomon Islands|SO:Somalia|' +
  'ZA:South Africa|KR:South Korea|SS:South Sudan|ES:Spain|LK:Sri Lanka|SD:Sudan|SR:Suriname|' +
  'SE:Sweden|CH:Switzerland|SY:Syria|TW:Taiwan|TJ:Tajikistan|TZ:Tanzania|TH:Thailand|TL:Timor-Leste|' +
  'TG:Togo|TO:Tonga|TT:Trinidad and Tobago|TN:Tunisia|TR:Türkiye|TM:Turkmenistan|' +
  'TC:Turks and Caicos Islands|TV:Tuvalu|UG:Uganda|UA:Ukraine|AE:United Arab Emirates|' +
  'GB:United Kingdom|US:United States|UY:Uruguay|UZ:Uzbekistan|VU:Vanuatu|VA:Vatican City|' +
  'VE:Venezuela|VN:Vietnam|VG:Virgin Islands (British)|VI:Virgin Islands (U.S.)|' +
  'EH:Western Sahara|YE:Yemen|ZM:Zambia|ZW:Zimbabwe'

export interface Country {
  code: string
  name: string
}

export const COUNTRIES: readonly Country[] = DATA.split('|').map((entry) => {
  const at = entry.indexOf(':')
  return { code: entry.slice(0, at), name: entry.slice(at + 1) }
})

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c.name]))

export function countryName(code: string | undefined): string | undefined {
  return code ? BY_CODE.get(code) : undefined
}

export function isCountryCode(code: string | undefined): boolean {
  return !!code && BY_CODE.has(code)
}

/**
 * Best guess from the browser, used only to preselect the dropdown.
 *
 * Never inferred silently into a record — a wrong guess would quietly file
 * someone's listing in the wrong country, where nobody near them would see it.
 * The user always confirms.
 */
export function guessCountry(): string | undefined {
  if (typeof navigator === 'undefined') return undefined
  for (const tag of navigator.languages ?? [navigator.language]) {
    const region = tag?.split('-')[1]?.toUpperCase()
    if (region && BY_CODE.has(region)) return region
  }
  return undefined
}
