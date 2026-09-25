// snapshot-probe.mjs — what a snapshot write does to records it did not carry.
//
//   node plugins/lsp-echo/reference/snapshot-probe.mjs
//
// A round is not the whole project. The C++ syntax stage checks the files that
// changed; if that write replaced its whole extension keyspace, the records of
// every other file — and the build stage's `<link>` record — would vanish, and
// "no record" reads downstream as "no errors".
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-snapshot-probe-'))
process.env.DSH_HOME = HOME
const { writeSnapshot } = await import(new URL('../lib/manager.js', import.meta.url))

/** The snapshot this harness wrote, found by what it is: the newest JSON in HOME. */
function snapshotPath() {
  const found = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.json')) found.push(p)
    }
  }
  walk(HOME)
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return found[0]
}

const project = path.join(HOME, 'proj')
fs.mkdirSync(path.join(project, 'src'), { recursive: true })
for (const f of ['src/a.cpp', 'src/b.cpp']) fs.writeFileSync(path.join(project, f), 'int x;\n', 'utf8')

let checks = 0
let failures = 0
function ok(cond, label, detail) {
  checks++
  if (cond) { console.log(`  ok   ${label}`); return }
  failures++
  console.log(`  FAIL ${label}${detail ? `  ${detail}` : ''}`)
}
const rec = (errors, diagnostics = []) => ({ checked_at: new Date().toISOString(), diagnostics, errors, warnings: 0 })
const read = () => JSON.parse(fs.readFileSync(snapshotPath(), 'utf8'))
const cpp = ['.cpp', '.h']

// 1. a build round: two files plus the link bucket
await writeSnapshot(project, {
  tool: 'cpp-gdextension', version: 1, project, syntheticKeys: ['<link>'],
  files: {
    'src/a.cpp': rec(1, [{ severity: 1, line: 1, message: 'a is broken' }]),
    'src/b.cpp': rec(0),
    '<link>': rec(1, [{ severity: 1, line: 0, message: 'undefined reference to x' }]),
  },
}, cpp, cpp)
let snap = read()
ok(!!snap.files['<link>'], 'the build round wrote <link>')
ok(snap.summary.errors === 2, 'summary counts both errors', JSON.stringify(snap.summary))

// 2. a syntax round over one file: it carries no <link> and no sibling record
await writeSnapshot(project, {
  tool: 'cpp-gdextension', version: 1, project, syntheticKeys: [], stage: 'syntax',
  files: { 'src/b.cpp': rec(0) },
}, cpp, cpp)
snap = read()
ok(!!snap.files['<link>'], 'a syntax round does not erase the <link> record', JSON.stringify(Object.keys(snap.files)))
ok(!!snap.files['src/a.cpp'], "nor another file's record it did not look at", JSON.stringify(Object.keys(snap.files)))
ok(snap.files['src/a.cpp'].errors === 1, 'the untouched record keeps its errors', JSON.stringify(snap.files['src/a.cpp']))
ok(snap.summary.errors === 2, 'summary still counts the untouched error plus <link>', JSON.stringify(snap.summary))

// 3. the checked file is replaced by the new verdict
await writeSnapshot(project, {
  tool: 'cpp-gdextension', version: 1, project, syntheticKeys: [], stage: 'syntax',
  files: { 'src/a.cpp': rec(0) },
}, cpp, cpp)
snap = read()
ok(snap.files['src/a.cpp'].errors === 0, 'a carried file is replaced by this verdict', JSON.stringify(snap.files['src/a.cpp']))
ok(snap.summary.errors === 1, 'summary follows the replacement', JSON.stringify(snap.summary))

// 4. a deleted file leaves no record behind
fs.unlinkSync(path.join(project, 'src/a.cpp'))
await writeSnapshot(project, {
  tool: 'cpp-gdextension', version: 1, project, syntheticKeys: [], stage: 'syntax',
  files: { 'src/b.cpp': rec(0) },
}, cpp, cpp)
snap = read()
ok(!snap.files['src/a.cpp'], 'a record whose file is gone is evicted', JSON.stringify(Object.keys(snap.files)))

// 5. an engine leaving the project evicts its keyspace (the write itself carries
// only the still-bound engine's file; <link> is extensionless and belongs to the
// prune path, which passes the still-bound engines' synthetic keys)
await writeSnapshot(project, {
  tool: 'godot-lsp', version: 1, project, syntheticKeys: [],
  files: { 'src/g.gd': rec(0) },
}, ['.gd'], ['.gd'])
snap = read()
ok(!snap.files['src/b.cpp'], 'a keyspace no longer bound is evicted', JSON.stringify(Object.keys(snap.files)))
ok(snap.files['src/g.gd'] && snap.files['src/g.gd'].errors === 0, 'and the new keyspace is written', JSON.stringify(Object.keys(snap.files)))

// 6. a clean build owns <link> and produced none: the old record must go. Keeping
// it would leave a fixed link error in the snapshot forever, counted by the summary
// while `files_with_errors` names no file that has errors.
await writeSnapshot(project, {
  tool: 'cpp-gdextension', version: 1, project, syntheticKeys: ['<link>'],
  files: { 'src/b.cpp': rec(0) },
}, ['.gd', '.cpp', '.h'], ['.gd', '.cpp', '.h'])
snap = read()
ok(!snap.files['<link>'], 'a clean build clears the <link> record it owns', JSON.stringify(Object.keys(snap.files)))
ok(snap.summary.errors === 0, 'so the summary stops counting a fixed link error', JSON.stringify(snap.summary))

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${checks - failures}/${checks} checks`)
fs.rmSync(HOME, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
