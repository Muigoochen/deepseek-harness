// binding-probe.mjs — checks that the cpp-gdextension engine binds to a project
// through its declared evidence, without starting DSH.
//
//   node reference/binding-probe.mjs [--project <dir>] [--keep]
//
// `--project` points at a real GDExtension project (the layout this engine
// exists for); without it only the throwaway fixtures are exercised.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { engines, markers } from '../../../lib/checkers.js'
import { evidenceEngines, hasEvidence, markerHit } from '../../../lib/registry.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..')
const ARGS = process.argv.slice(2)
const flag = (name) => {
  const i = ARGS.indexOf(name)
  return i >= 0 ? ARGS[i + 1] : undefined
}
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cpp-bind-'))
let checks = 0
let failures = 0
function ok(cond, label, detail) {
  checks++
  if (cond) { console.log(`  ok   ${label}`); return true }
  failures++
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  return false
}
function project(name, { sconstruct = true, gdext = true, depth = 4 } = {}) {
  const native = path.join(ROOT, name, ...Array(depth).fill('lvl'), 'native')
  fs.mkdirSync(native, { recursive: true })
  if (sconstruct) fs.writeFileSync(path.join(native, 'SConstruct'), '# fixture\n', 'utf8')
  if (gdext) fs.writeFileSync(path.join(native, 'probe.gdextension'), '[configuration]\n', 'utf8')
  return path.join(ROOT, name)
}

const table = engines(PLUGIN_ROOT)
const cpp = table['cpp-gdextension']

console.log('[1] engine registry')
ok(!!cpp, 'cpp-gdextension is registered', Object.keys(table).join(', '))
ok(!!cpp && cpp.extensions.includes('.cpp') && cpp.extensions.includes('.h'), 'it owns C++ extensions', JSON.stringify(cpp && cpp.extensions))
ok(!!cpp && Array.isArray(cpp.evidence) && cpp.evidence.length === 2, 'its evidence set survives the descriptor', JSON.stringify(cpp && cpp.evidence))
ok(cpp && cpp.marker === '*.gdextension', 'its marker is the .gdextension glob', cpp && cpp.marker)
ok(markers(table).includes('*.gdextension'), 'the marker joins project discovery', markers(table).join(', '))
// Glob markers must not turn plain SCons projects into projects of this engine.
fs.mkdirSync(path.join(ROOT, 'plain-scons'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'plain-scons', 'SConstruct'), '# plain\n', 'utf8')
ok(!markerHit(path.join(ROOT, 'plain-scons'), cpp.marker), 'a plain SCons directory does not match the marker')
const markerRoot = path.join(ROOT, 'marker-root')
fs.mkdirSync(path.join(markerRoot, 'addons', 'x'), { recursive: true })
fs.writeFileSync(path.join(markerRoot, 'addons', 'x', 'probe.gdextension'), '[configuration]\n', 'utf8')
ok(!markerHit(markerRoot, cpp.marker), 'the marker is a same-directory probe, not a recursive one')
ok(markerHit(path.join(markerRoot, 'addons', 'x'), '*.gdextension'), 'the glob matches inside the directory that owns it')
ok(!table.typescript.evidence, 'an engine without evidence stays unaffected', JSON.stringify(table.typescript))
const fallbacks = Object.values(table).filter((e) => e.fallback).map((e) => e.id)
ok(fallbacks.length === 1 && fallbacks[0] === 'godot-lsp', 'exactly one engine declares itself the markerless fallback', JSON.stringify(fallbacks))
// A Godot project may keep its GDExtension at the project root: both markers hit,
// so the seed must bind both engines (binding only the first stops checking .gd).
const rootLayout = path.join(ROOT, 'root-layout')
fs.mkdirSync(rootLayout, { recursive: true })
fs.writeFileSync(path.join(rootLayout, 'project.godot'), 'config_version=5\n', 'utf8')
fs.writeFileSync(path.join(rootLayout, 'probe.gdextension'), '[configuration]\n', 'utf8')
const hits = markers(table).filter((m) => markerHit(rootLayout, m))
ok(hits.length === 2, 'a root-level .gdextension makes two markers hit at once', JSON.stringify(hits))

console.log('\n[2] evidence binding')
const deep = project('deep', { depth: 4 })
const shallow = project('shallow', { depth: 1 })
const noGdext = project('nogdext', { gdext: false })
const noScons = project('noscons', { sconstruct: false })
ok(evidenceEngines(deep, table).includes('cpp-gdextension'), 'binds a project whose build entry sits deep below the root')
ok(evidenceEngines(shallow, table).includes('cpp-gdextension'), 'binds a shallow one too')
ok(!evidenceEngines(noGdext, table).includes('cpp-gdextension'), 'SConstruct without a .gdextension does not bind (all patterns required)')
ok(!evidenceEngines(noScons, table).includes('cpp-gdextension'), 'a .gdextension without an SConstruct does not bind')
fs.mkdirSync(path.join(ROOT, 'empty'), { recursive: true })
ok(!hasEvidence(path.join(ROOT, 'empty'), ['SConstruct', '*.gdextension']), 'an empty project has no evidence')
fs.mkdirSync(path.join(ROOT, 'unrelated2'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'unrelated2', 'SConstruct'), '# x\n', 'utf8')
ok(!hasEvidence(path.join(ROOT, 'unrelated2'), ['SConstruct', '*.gdextension']), 'a plain SCons project stays unbound (no C++ engine on unrelated builds)')

const real = flag('--project')
if (real) {
  console.log(`\n[3] real project: ${real}`)
  ok(fs.existsSync(real), 'the project path exists')
  if (fs.existsSync(real)) {
    const ids = evidenceEngines(real, table)
    ok(ids.includes('cpp-gdextension'), 'evidence binds cpp-gdextension to it', JSON.stringify(ids))
    const t0 = Date.now()
    evidenceEngines(real, table)
    console.log(`  walk took ${Date.now() - t0}ms`)
  }
} else {
  console.log('\n[3] real project skipped (pass --project <dir>)')
}

console.log('\n[4] snapshot merge and scope')
{
  process.env.DSH_HOME = path.join(ROOT, 'dsh-home')
  fs.mkdirSync(process.env.DSH_HOME, { recursive: true })
  const { writeSnapshot, diagnosticsPath } = await import('../../../lib/manager.js')
  const { engineScope } = await import('../../../lib/scope.js')
  const proj = path.join(ROOT, 'merge-proj')
  fs.mkdirSync(proj, { recursive: true })
  const gdExts = ['.gd']
  const both = [...cpp.extensions, ...gdExts]
  const blank = () => ({ checked_at: 'probe', diagnostics: [], errors: 0, warnings: 0 })
  const cppPayload = (withLink) => ({
    tool: 'cpp-gdextension',
    version: 1,
    project: proj,
    server: 'build.ps1',
    files: withLink
      ? { 'native/src/a.cpp': blank(), '<link>': { checked_at: 'probe', diagnostics: [{ severity: 1, message: 'ld returned 1 exit status' }], errors: 1, warnings: 0 } }
      : { 'native/src/a.cpp': blank() },
    syntheticKeys: ['<link>'],
  })
  const read = () => JSON.parse(fs.readFileSync(diagnosticsPath(proj), 'utf8'))
  await writeSnapshot(proj, cppPayload(true), cpp.extensions, both)
  ok(read().files['<link>'] && read().files['<link>'].errors === 1, 'the cpp write stores its synthetic key', Object.keys(read().files).join(', '))
  await writeSnapshot(proj, { tool: 'godot-lsp', version: 1, project: proj, files: { 'main.gd': blank() } }, gdExts, both)
  const merged = read()
  ok(!!merged.files['<link>'], 'another engine\'s write does not evict it', Object.keys(merged.files).join(', '))
  ok(!!merged.files['native/src/a.cpp'] && !!merged.files['main.gd'], 'both engines\' keyspaces survive', Object.keys(merged.files).join(', '))
  await writeSnapshot(proj, cppPayload(false), cpp.extensions, both)
  ok(!read().files['<link>'], 'the next cpp write replaces it (a clean build clears the key)', Object.keys(read().files).join(', '))
  const scoped = engineScope({ files: { 'native/src/a.cpp': blank(), '<link>': { errors: 1, warnings: 0 } } }, cpp.extensions, cpp.syntheticKeys)
  ok(!!scoped.files['<link>'] && scoped.summary.errors === 1, 'the owning engine scope keeps it, so its round can report it', JSON.stringify(scoped))
  ok(!engineScope({ files: { 'main.gd': blank() } }, cpp.extensions, cpp.syntheticKeys).files['main.gd'], 'the scope still drops other engines\' files')
  ok(!engineScope({ files: { '<link>': { errors: 1 } } }, ['.gd'], undefined).files['<link>'],
    'another engine\'s round does not inherit it')
  ok(!!cpp.syntheticKeys && cpp.syntheticKeys.includes('<link>'), 'the engine declares its synthetic key in engine.json', JSON.stringify(cpp.syntheticKeys))
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${checks - failures}/${checks} checks`)
if (!ARGS.includes('--keep')) {
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* windows lock */ }
} else {
  console.log(`kept: ${ROOT}`)
}
process.exit(failures ? 1 : 0)
