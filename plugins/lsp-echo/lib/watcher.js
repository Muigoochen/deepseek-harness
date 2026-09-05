// watcher.js — poll managed files (extensions declared by the project's
// engines) under a project and expose a "dirty files since last drain" set.
// Polling is intentionally dumb and portable (works for editor-external edits
// too); costs a directory walk on the configured interval only.
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_EXTENSIONS = ['.gd', '.gdshader']

function endsWithAny(file, extensions) {
  const lower = file.toLowerCase()
  return extensions.some((e) => lower.endsWith(e.toLowerCase()))
}

/** Walk a project tree, skipping hidden and configured directories. */
export function scanFiles(root, skipDirs, extensions = DEFAULT_EXTENSIONS) {
  const out = new Map()
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || skipDirs.includes(e.name)) continue
        stack.push(full)
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
  }

  /** Diff current mtimes against the last scan; record changes as dirty. */
  tick() {
    const next = scanFiles(this.project, this.skipDirs, this.extensions)
    const changed = []
    for (const [f, mt] of next) {
      if (this.map.get(f) !== mt) changed.push(f)
    }
    for (const f of this.map.keys()) {
      if (!next.has(f)) changed.push(f) // deleted
    }
    this.map = next
    for (const f of changed) this.dirty.add(f)
    return changed
  }

  /** Remove and return all pending dirty files. */
  drain() {
    const files = [...this.dirty]
    this.dirty.clear()
    return files
  }

  /** Adopt the pending changes of another watcher (rebuild without loss). */
  adopt(other) {
    for (const f of other ? other.dirty : []) this.dirty.add(f)
  }
}
