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
export function scanProjectRoots(root, { markers = ['project.godot'], skipDirs = ['.git', '.godot', 'node_modules', 'addons', '.venv', 'dist', 'build', 'plugins', 'vendor', '.pnpm-store', '.dsh-build'], maxDepth = 4 } = {}) {
  const found = []
  const hasMarker = (dir) => markers.some((m) => m && fs.existsSync(path.join(dir, m)))
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
