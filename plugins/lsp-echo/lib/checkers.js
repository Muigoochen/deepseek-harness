// checkers.js — bundled engine registry. Each engine is a directory under
// <pluginRoot>/checkers/<engine>/ that declares engine.json:
//   { name, marker, extensions: ['.gd', …], bridge: '<file>.mjs' }
// and ships the bridge CLI (<file>.mjs) with host|status|stop|check subcommands.
// Adding a language = adding one directory here; no registry-row edit needed.
// A descriptor may also declare `evidence`: file-name patterns whose presence
// anywhere in a project proves the engine applies there (build layouts whose
// entry points sit deep below the project root).
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
    // Optional engine capabilities. `rescan` marks engines whose bridge can ask
    // a running engine to rescan the project filesystem; `rescanPort` is that
    // control socket's default port; `addon` names the in-project addon
    // directory shipped next to the bridge that serves the request.
    rescan: raw.rescan === true,
    rescanPort: typeof raw.rescanPort === 'number' && Number.isInteger(raw.rescanPort) && raw.rescanPort > 0 && raw.rescanPort <= 65535
      ? raw.rescanPort
      : undefined,
    addon: typeof raw.addon === 'string' && raw.addon ? raw.addon : undefined,
    // `evidence` patterns are checked by lib/index.js against a project tree:
    // every listed pattern must be present for the engine to be bound.
    evidence: Array.isArray(raw.evidence)
      ? raw.evidence.filter((p) => typeof p === 'string' && p)
      : undefined,
    // `fallback` marks the engine a project gets when no marker matched. Without
    // it the winner would be whichever directory the filesystem lists first.
    fallback: raw.fallback === true,
    // `syntheticKeys` are snapshot keys this engine writes without a file behind
    // them (the cpp bridge's `<link>` for link/build failures). They belong to
    // exactly this engine: it may replace them, no other engine evicts them, and
    // they surface in this engine's rounds only.
    syntheticKeys: Array.isArray(raw.syntheticKeys)
      ? raw.syntheticKeys.filter((k) => typeof k === 'string' && k)
      : undefined,
    // `budgetMs` caps the build one check may run in the pre-step channel. An
    // engine whose check is a real build (C++) declares a small budget so a step
    // is never blocked by a cold rebuild; without it the engine gets the
    // interactive budget.
    budgetMs: typeof raw.budgetMs === 'number' && Number.isFinite(raw.budgetMs) && raw.budgetMs > 0
      ? raw.budgetMs
      : undefined,
    // `noWait` marks an engine whose pre-step check must report a busy build
    // directory at once instead of waiting for it (same reason as budgetMs).
    noWait: raw.noWait === true,
    // `preStepStage` is the stage this engine's pre-step check asks for, in the
    // engine's own vocabulary (the cpp bridge's `auto` prefers its fast
    // compiler-only stage and falls back to the build when it cannot run here).
    // Declared by the engine because the name means nothing to this package: a
    // build-backed engine that declares none keeps its bridge's default stage.
    preStepStage: typeof raw.preStepStage === 'string' && raw.preStepStage ? raw.preStepStage : undefined,
  }
}

/**
 * Describe the bundled engines available under the plugin root. Each engine
 * directory must carry an engine.json (see descriptor()); its bridge CLI is
 * resolved to the declared file inside that directory, falling back to
 * bridge.mjs. Directories without a usable descriptor are skipped.
 * @param {string} pluginRoot absolute plugin package root.
 * @returns {Record<string, { id: string; name: string; bridge: string; marker: string; extensions: string[]; evidence?: string[]; fallback?: boolean; syntheticKeys?: string[]; budgetMs?: number; noWait?: boolean; preStepStage?: string }>}
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
      rescan: desc.rescan,
      rescanPort: desc.rescanPort,
      addon: desc.addon,
      evidence: desc.evidence,
      fallback: desc.fallback,
      syntheticKeys: desc.syntheticKeys,
      budgetMs: desc.budgetMs,
      noWait: desc.noWait,
      preStepStage: desc.preStepStage,
    }
  }
  return list
}

/**
 * The limits a pre-step check hands to a build-backed engine, or undefined for an
 * engine that is not one. Such an engine declares a small budget, refuses to wait
 * for a build directory that is busy, and names the stage its cheap check uses (the
 * cpp bridge's `auto` prefers its compiler-only stage and falls back to the build);
 * an engine that declares none of this keeps its bridge's default stage.
 * @param {{ budgetMs?: number; noWait?: boolean; preStepStage?: string }} eng engine record from engines()
 * @returns {{ budgetMs?: number; noWait?: boolean; stage?: string }|undefined}
 */
export function preStepLimits(eng) {
  if (!eng || !(eng.budgetMs || eng.noWait)) return undefined
  return { budgetMs: eng.budgetMs, noWait: eng.noWait, stage: eng.preStepStage }
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
