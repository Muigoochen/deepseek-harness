// dependents.js — which other files a change can invalidate.
//
// An engine answers for the file it is handed, so a signature change inside a
// script shows up in the files that reference it and nowhere else: the changed
// file itself stays clean. Checking only the changed file therefore reports no
// change at all. This module finds those referencing files from the two ways a
// GDScript project names another script: its `class_name`, and its `res://` path
// in a preload/load call.
import fs from 'node:fs'
import path from 'node:path'

// A declaration, not a mention: the marker starts the line and only a trailing
// comment may follow, so `# class_name Foo` and a string mentioning it miss.
const CLASS_NAME_RE = /^[ \t]*class_name[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:#.*)?$/m

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The names a changed script can be referenced by.
 * @param {string} project project root
 * @param {string[]} changedFiles absolute paths of this round's changed files
 * @returns {{ name?: string, res: string }[]} one entry per changed GDScript
 */
export function referenceTargets(project, changedFiles) {
  const targets = []
  for (const abs of changedFiles) {
    if (!abs.toLowerCase().endsWith('.gd')) continue
    let text
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch {
      continue // deleted or unreadable since the scan: nothing to reference
    }
    const declared = CLASS_NAME_RE.exec(text)
    targets.push({
      name: declared ? declared[1] : undefined,
      res: `res://${path.relative(project, abs).split(path.sep).join('/')}`,
    })
  }
  return targets
}

/**
 * Project files that reference one of the changed scripts. A changed file is
 * never its own dependent, and only GDScript files are considered.
 * @param {string} project project root
 * @param {string[]} changedFiles absolute paths of this round's changed files
 * @param {Iterable<string>} candidates the project's GDScript files; consumed
 *   once, so pass a fresh iterable (a spent iterator silently yields no hits)
 * @returns {string[]} absolute paths to check alongside the changed ones
 */
export function dependentsOf(project, changedFiles, candidates) {
  const targets = referenceTargets(project, changedFiles)
  if (!targets.length) return []
  const changed = new Set(changedFiles.map((f) => path.resolve(f)))
  const patterns = targets.map((t) => ({
    name: t.name ? new RegExp(`\\b${escapeRe(t.name)}\\b`) : undefined,
    // The path must end where the literal does, or res://a.gd would also match
    // a reference to res://a.gdshader. Case-insensitive because Godot resolves
    // res:// paths case-insensitively on Windows.
    res: new RegExp(`${escapeRe(t.res)}(?![A-Za-z0-9_])`, 'i'),
  }))
  const out = []
  for (const file of candidates) {
    const abs = path.resolve(file)
    if (changed.has(abs) || !abs.toLowerCase().endsWith('.gd')) continue
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue // unreadable: the check itself reports what it can
    }
    if (patterns.some((p) => (p.name && p.name.test(text)) || p.res.test(text))) out.push(abs)
  }
  return out
}
