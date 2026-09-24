// registry.js — project discovery primitives (storage lives in the harness
// settings namespace `lsp-echo`, not in a plugin-owned file).
//
// Value shape stored under the namespace:
//   discovered: keyed by HARNESS WORKSPACE id — a workspace's Godot projects
//               live and die with it (sync prunes ids no longer registered).
//   manual:     keyed by project path — user bindings independent of
//               workspaces (the future GUI manages this layer).
// Scans run only at plugin enable over existing workspaces and when a session
// enters a not-yet-scanned workspace. Never periodic.
import fs from 'node:fs'
import path from 'node:path'

/** Empty store value for the settings namespace. */
export const EMPTY_STORE = { discovered: {}, manual: {} }

/**
 * True when `dir` carries the marker. A marker without `*` is a file name; a
 * marker containing `*` matches against the directory's own file names, which is
 * how an engine whose project root is identified by an extension-bearing file
 * (a Godot GDExtension's `*.gdextension`) declares itself.
 * @param {string} dir directory to probe
 * @param {string} marker marker file name or glob pattern
 * @returns {boolean}
 */
export function markerHit(dir, marker) {
  if (!dir || !marker) return false
  if (!marker.includes('*')) return fs.existsSync(path.join(dir, marker))
  const re = evidencePattern(marker)
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && re.test(e.name))
  } catch {
    return false
  }
}

/**
 * One-shot scan of a workspace root for engine marker files (default
 * `project.godot`, configurable for multi-engine registries). A directory
 * containing any marker is itself a project and is not descended into.
 * Hidden/configured directories are skipped and descent is depth-capped so
 * scanning a large non-matching workspace stays cheap.
 * @param {string} root workspace root to scan
 * @param {object} [opts]
 * @param {string[]} [opts.markers] marker file names to probe (default ['project.godot'])
 * @param {string[]} [opts.skipDirs] directory basenames to skip
 * @param {number} [opts.maxDepth] descent depth cap below the root (default 4)
 * @returns {string[]} absolute project roots found (empty when no marker workspace)
 */
export function scanProjectRoots(root, { markers = ['project.godot'], skipDirs = ['.git', '.godot', 'node_modules', 'dsh_echo_bridge', '.venv', 'dist', 'build', 'plugins', 'vendor', '.pnpm-store', '.dsh-build'], maxDepth = 4 } = {}) {
  const found = []
  const hasMarker = (dir) => markers.some((m) => markerHit(dir, m))
  const walk = (dir, depth) => {
    if (hasMarker(dir)) {
      found.push(path.resolve(dir))
      return // a project dir is self-contained; do not scan inside it
    }
    if (depth >= maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith('.') || skipDirs.includes(e.name)) continue
      walk(path.join(dir, e.name), depth + 1)
    }
  }
  walk(path.resolve(root), 0)
  return found
}

// Engine evidence: file-name patterns that prove an engine applies to a project
// whose build entry sits below the project root. A Godot GDExtension keeps its
// SConstruct next to its .gdextension under addons/<plugin>/platform/native, so
// neither a root-level marker probe nor a shallow extension walk finds it.
// Patterns match file names; `*` stands for any run of characters.
export const EVIDENCE_MAX_DEPTH = 6
const EVIDENCE_SKIP = new Set([
  '.git', '.godot', '.dsh-build', '.cache', 'node_modules', '.venv', 'venv',
  'dist', 'build', 'bin', 'obj', '__pycache__', 'godot-cpp',
])

function evidencePattern(pattern) {
  // Windows file names are case-insensitive, POSIX ones are not: an exact
  // pattern keeps the platform's own rule, a glob gets the flag because it is
  // written by hand against a name the engine cannot know the casing of.
  const flags = pattern.includes('*') || process.platform === 'win32' ? 'i' : ''
  return new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, flags)
}

/**
 * True when every pattern matches some file under `root`. The walk stops at the
 * first directory that satisfies the whole set, skips build/VCS noise, and is
 * depth-capped.
 * @param {string} root project root
 * @param {string[]} patterns file-name patterns (see EVIDENCE_MAX_DEPTH note)
 * @returns {boolean}
 */
export function hasEvidence(root, patterns) {
  const wanted = patterns.map(evidencePattern)
  const walk = (dir, depth) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return false }
    for (let i = wanted.length - 1; i >= 0; i--) {
      if (entries.some((e) => e.isFile() && wanted[i].test(e.name))) wanted.splice(i, 1)
    }
    if (!wanted.length) return true
    if (depth >= EVIDENCE_MAX_DEPTH) return false
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || EVIDENCE_SKIP.has(e.name)) continue
      if (walk(path.join(dir, e.name), depth + 1)) return true
    }
    return false
  }
  return walk(path.resolve(root), 0)
}

/**
 * Engines whose declared evidence all exists under `root`.
 * @param {string} root project root
 * @param {Record<string, { evidence?: string[] }>} table engine table from engines()
 * @returns {string[]} engine ids
 */
export function evidenceEngines(root, table) {
  const ids = []
  for (const [id, eng] of Object.entries(table || {})) {
    if (eng && Array.isArray(eng.evidence) && eng.evidence.length && hasEvidence(root, eng.evidence)) ids.push(id)
  }
  return ids
}
