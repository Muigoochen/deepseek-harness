// checkers.js — bundled engine registry. Each engine is a directory under
// <pluginRoot>/checkers/<engine>/ that declares engine.json:
//   { name, marker, extensions: ['.gd', …], bridge: '<file>.mjs' }
// and ships the bridge CLI (<file>.mjs) with host|status|stop|check subcommands.
// Adding a language = adding one directory here; no registry-row edit needed.
import path from 'node:path'
import fs from 'node:fs'

const DEFAULT_BRIDGE_NAME = 'bridge.mjs'

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** The engine.json descriptor for one engine directory (undefined when absent/invalid). */
function descriptor(dir) {
  const raw = readJson(path.join(dir, 'engine.json'))
  if (!raw || typeof raw !== 'object') return undefined
  const marker = typeof raw.marker === 'string' ? raw.marker : undefined
  const extensions = Array.isArray(raw.extensions)
    ? raw.extensions.filter((e) => typeof e === 'string' && e.startsWith('.'))
    : undefined
  if (!marker || !extensions || !extensions.length) return undefined
  return {
    name: typeof raw.name === 'string' && raw.name ? raw.name : path.basename(dir),
    marker,
    extensions,
    bridgeName: typeof raw.bridge === 'string' && raw.bridge ? raw.bridge : DEFAULT_BRIDGE_NAME,
  }
}

/**
 * Describe the bundled engines available under the plugin root. Each engine
 * directory must carry an engine.json (see descriptor()); its bridge CLI is
 * resolved to the declared file inside that directory, falling back to
 * bridge.mjs. Directories without a usable descriptor are skipped.
 * @param {string} pluginRoot absolute plugin package root.
 * @returns {Record<string, { id: string; name: string; bridge: string; marker: string; extensions: string[] }>}
 */
export function engines(pluginRoot) {
  const base = path.join(pluginRoot, 'checkers')
  const list = {}
  let entries
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return list
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(base, entry.name)
    const desc = descriptor(dir)
    if (!desc) continue
    const bridge = path.join(dir, desc.bridgeName)
    if (!fs.existsSync(bridge)) continue
    list[entry.name] = {
      id: entry.name,
      name: desc.name,
      bridge,
      marker: desc.marker,
      extensions: desc.extensions,
    }
  }
  return list
}

/**
 * All engine marker file names (deduped), for project-root probing.
 * @param {Record<string, { marker: string }>} table engine table from engines()
 * @returns {string[]}
 */
export function markers(table) {
  const out = []
  for (const eng of Object.values(table)) {
    if (eng && eng.marker && !out.includes(eng.marker)) out.push(eng.marker)
  }
  return out
}

/**
 * True when the file path carries one of the engine's managed extensions.
 * @param {{ extensions: string[] }} eng engine record from engines()
 * @param {string} file absolute or relative path
 * @returns {boolean}
 */
export function matchExtension(eng, file) {
  if (!eng || !eng.extensions || !file) return false
  const lower = file.toLowerCase()
  return eng.extensions.some((e) => lower.endsWith(e.toLowerCase()))
}

/**
 * All extensions the given engines manage (deduped, lowercased, '.gd'-style).
 * @param {Array<{ extensions: string[] }>} engs engine records
 * @returns {string[]}
 */
export function extensionsUnion(engs) {
  const out = []
  for (const eng of engs) {
    for (const e of eng && eng.extensions ? eng.extensions : []) {
      const lower = e.toLowerCase()
      if (!out.includes(lower)) out.push(lower)
    }
  }
  return out
}
