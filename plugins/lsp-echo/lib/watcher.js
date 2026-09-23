// watcher.js — poll managed files (extensions declared by the project's
// engines) under a project and expose a "dirty files since last drain" set.
// Polling is intentionally dumb and portable (works for editor-external edits
// too); costs a directory walk on the configured interval only.
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_EXTENSIONS = ['.gd', '.gdshader']

// Windows paths are case-insensitive, so a user typing `Addons` there means the
// `addons` on disk; on a case-sensitive filesystem it is a different directory.
const CASE_INSENSITIVE = process.platform === 'win32'

function endsWithAny(file, extensions) {
  const lower = file.toLowerCase()
  return extensions.some((e) => lower.endsWith(e.toLowerCase()))
}

/** Walk a project tree, skipping hidden and configured directories. */
export function scanFiles(root, skipDirs, extensions = DEFAULT_EXTENSIONS) {
  const out = new Map()
  const stack = [['', root]]
  while (stack.length) {
    const [relDir, dir] = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || isSkippedDir(rel, e.name, skipDirs)) continue
        stack.push([rel, full])
      } else if (e.isFile() && endsWithAny(e.name, extensions)) {
        try {
          out.set(full, fs.statSync(full).mtimeMs)
        } catch {
          /* raced with deletion */
        }
      }
    }
  }
  return out
}

/**
 * Normalize one configured skip entry to forward slashes without a leading or
 * trailing separator, so `/addons/`, `.\addons` and `addons` compare equal.
 * Repeated leading `./` is stripped too: `././addons` would otherwise become a
 * dead entry that silently matches nothing.
 * @param {string} entry raw configured entry
 * @returns {string} normalized entry, '' when it carries no name
 */
export function normalizeSkipEntry(entry) {
  return String(entry == null ? '' : entry)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.?\/)+/, '')
    .replace(/\/+$/, '')
}

/**
 * Whether two configured directory entries name the same directory, applying the
 * same normalization and platform case rule as {@link isSkippedDir}. Callers that
 * must reject an entry (a forced directory, a duplicate) use this instead of
 * comparing raw strings, so a value the matcher treats as forced is never stored.
 * @param {string} a first entry
 * @param {string} b second entry
 * @returns {boolean} true when both normalize to the same directory
 */
export function sameSkipEntry(a, b) {
  const na = normalizeSkipEntry(a)
  const nb = normalizeSkipEntry(b)
  if (!na || !nb) return false
  return CASE_INSENSITIVE ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

/**
 * Whether a directory is skipped by `skipDirs`.
 *
 * An entry without `/` matches that directory name at ANY depth (the behavior
 * machine directories like `node_modules` rely on). An entry with `/` matches a
 * project-relative path, which is how a caller keeps a nested directory while
 * its parent stays watched (`addons` watched, `addons/dsh_echo_bridge` skipped).
 * @param {string} rel project-relative path of the directory, '/' separated
 * @param {string} name directory basename
 * @param {string[]} skipDirs configured entries
 * @returns {boolean} true when this directory and its subtree are skipped
 */
export function isSkippedDir(rel, name, skipDirs) {
  const cmpRel = CASE_INSENSITIVE ? rel.toLowerCase() : rel
  const cmpName = CASE_INSENSITIVE ? name.toLowerCase() : name
  for (const raw of skipDirs || []) {
    let entry = normalizeSkipEntry(raw)
    if (!entry) continue
    if (CASE_INSENSITIVE) entry = entry.toLowerCase()
    if (entry.includes('/')) {
      if (cmpRel === entry || cmpRel.startsWith(`${entry}/`)) return true
    } else if (cmpName === entry) {
      return true
    }
  }
  return false
}

export class ProjectWatcher {
  /** @param {string} project project root
   *  @param {string[]} skipDirs directory basenames to skip
   *  @param {string[]} [extensions] file extensions to watch (default .gd/.gdshader) */
  constructor(project, skipDirs, extensions) {
    this.project = project
    this.skipDirs = skipDirs
    this.extensions = extensions || DEFAULT_EXTENSIONS
    this.map = scanFiles(project, skipDirs, this.extensions)
    this.dirty = new Set()
    this.created = new Set()
    this.deleted = new Set()
  }

  /** Diff current mtimes against the last scan; record changes as dirty. */
  tick() {
    const next = scanFiles(this.project, this.skipDirs, this.extensions)
    const changed = []
    for (const [f, mt] of next) {
      if (!this.map.has(f)) this.created.add(f)
      else if (this.map.get(f) !== mt) changed.push(f)
    }
    for (const f of this.map.keys()) {
      if (!next.has(f)) {
        changed.push(f) // deleted
        this.created.delete(f)
        this.deleted.add(f)
      }
    }
    this.map = next
    for (const f of changed) this.dirty.add(f)
    return changed
  }

  /**
   * Remove and return files that appeared or disappeared since the last call.
   * Engines that only register global class names while scanning the project
   * filesystem (Godot) need this signal: a class_name script created after the
   * engine started is invisible to diagnostics until the engine rescans.
   * @returns {{ created: string[]; deleted: string[] }}
   */
  drainStructural() {
    const out = { created: [...this.created], deleted: [...this.deleted] }
    this.created.clear()
    this.deleted.clear()
    return out
  }

  /** Remove and return all pending dirty files. */
  drain() {
    const files = [...this.dirty]
    this.dirty.clear()
    return files
  }

  /** Adopt the pending changes of another watcher (rebuild without loss). */
  adopt(other) {
    if (!other) return
    for (const f of other.dirty) this.dirty.add(f)
    // Structural changes matter as much as dirty files: the rebuilt watcher
    // must still report the new/deleted scripts the engine has to rescan for.
    for (const f of other.created) this.created.add(f)
    for (const f of other.deleted) this.deleted.add(f)
  }
}
