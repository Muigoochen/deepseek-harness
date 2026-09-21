// i18n.js — the plugin's own text, one JSON file per language.
//
// The browser client is a zero-build module that can only `require` the React
// seed, so it cannot import JSON directly. Both halves therefore read the same
// files: the Host loads them here and hands them to the client through the API
// (`action=locales`), which registers them with the Client's `locale` service so
// the GUI follows the language the user picked in DSH settings.
//
// Host-side text (toast notifications) is translated here, which needs the
// active language: only the browser knows it, so the client reports it through
// `action=setLocale` and this module keeps the latest value. Until it reports,
// DEFAULT_LOCALE applies — a missing translation must never produce a blank
// toast.
//
// A value is either a string or an array of strings. An array is one message
// split into paragraphs: a long explanation stays readable instead of becoming a
// wall of text, and each rendering target decides how to lay the parts out.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locales')

/**
 * Language used before the browser reports the active one, and for unknown keys.
 *
 * The platform's own fallback is English, but the toasts this plugin can emit
 * before the browser reports (project registered, projects discovered) belong to
 * the first moments of a session — and the browser reports within a second of the
 * GUI loading, so this only covers the gap before that. Chinese is the source
 * language of these dictionaries, so an unreported default shows the language the
 * text was written in rather than a machine translation of it.
 */
export const DEFAULT_LOCALE = 'zh'

/** Fallback chain per language: the active language first, then this, then the key. */
const FALLBACK = { zh: [], en: ['zh'] }

/** @type {Map<string, Record<string, string|string[]>>} */
const dictionaries = new Map()

/**
 * Load one language's dictionary, once per process.
 * @param {string} locale BCP 47-style language id
 * @returns {Record<string, string|string[]>} the dictionary, empty when unreadable
 */
function dictionaryOf(locale) {
  const cached = dictionaries.get(locale)
  if (cached) return cached
  let parsed = {}
  try {
    const raw = fs.readFileSync(path.join(DIR, `${locale}.json`), 'utf8')
    const data = JSON.parse(raw)
    if (data && typeof data === 'object' && !Array.isArray(data)) parsed = data
  } catch { /* an unreadable dictionary falls back to the key, never to a crash */ }
  dictionaries.set(locale, parsed)
  return parsed
}

let active = DEFAULT_LOCALE

/** Languages this plugin ships dictionaries for. */
export function localeIds() {
  return [...new Set([DEFAULT_LOCALE, ...Object.keys(FALLBACK)])]
}

/** Every dictionary, keyed by language — what the client registers. */
export function allDictionaries() {
  const out = {}
  for (const id of localeIds()) out[id] = dictionaryOf(id)
  return out
}

/**
 * The language the browser last reported.
 * @returns {string} active language id
 */
export function getActiveLocale() {
  return active
}

/**
 * Record the language the browser is showing, so Host-side text matches the GUI.
 * @param {string} locale BCP 47-style language id
 * @returns {string} the language now in effect
 */
export function setActiveLocale(locale) {
  // Only a language this plugin ships is accepted: trusting an arbitrary tag
  // would silently drop every toast to the key.
  if (typeof locale === 'string' && localeIds().includes(locale)) active = locale
  return active
}

/**
 * Translate a key for the active language.
 *
 * Lookup tries the active language, then its fallback chain, then the default
 * language, and finally returns the key itself — a missing translation shows up
 * as an obvious key rather than as an empty notification.
 * @param {string} key dictionary key
 * @param {Record<string, string|number>} [params] `{name}` placeholders to substitute
 * @returns {string|string[]} the message, or its paragraphs as an array
 */
export function t(key, params) {
  const chain = [active, ...(Object.prototype.hasOwnProperty.call(FALLBACK, active) ? FALLBACK[active] : []), DEFAULT_LOCALE]
  let value
  for (const locale of chain) {
    const hit = dictionaryOf(locale)[key]
    if (hit !== undefined) { value = hit; break }
  }
  if (value === undefined) return key
  const fill = (text) => String(text).replace(/\{(\w+)\}/g, (whole, name) => (
    params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
  ))
  return Array.isArray(value) ? value.map(fill) : fill(value)
}

/**
 * Translate a key into one line, for targets that cannot render paragraphs.
 * @param {string} key dictionary key
 * @param {Record<string, string|number>} [params] `{name}` placeholders to substitute
 * @returns {string} the message with its paragraphs joined by a newline
 */
export function tLine(key, params) {
  const value = t(key, params)
  return Array.isArray(value) ? value.join('\n') : value
}
