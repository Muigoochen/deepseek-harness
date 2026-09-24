// probe.mjs — self-contained checks for the cpp-gdextension bridge.
//
//   node reference/probe.mjs [--real-msvc] [--keep]
//
// It builds throwaway GDExtension-shaped projects in the temp dir, points the
// bridge at them, and asserts the observable contract: build-directory
// discovery (a native dir nested below addons/), payload keys relative to the
// project root, severity/code mapping, link errors kept under a synthetic key,
// the `clientd` JSON-lines protocol, and — most importantly — that a build which
// did not run is reported as a failure instead of a clean project.
//
// The MSVC/GNU text in the fixtures is the output of real toolchains (MSVC
// 14.44 / GCC 14) for a broken file; `--real-msvc` re-runs the genuine toolchain
// through the bridge end to end so the parser never drifts from the format.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(HERE, '..', 'cpp-gdextension.mjs')
const ARGS = process.argv.slice(2)
const REAL_MSVC = ARGS.includes('--real-msvc')
const KEEP = ARGS.includes('--keep')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cpp-probe-'))
let checks = 0
let failures = 0
function ok(cond, label, detail) {
  checks++
  if (cond) { console.log(`  ok   ${label}`); return true }
  failures++
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  return false
}
function write(rel, content) {
  const file = path.join(ROOT, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return file
}
function run(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, ...args], { cwd: opts.cwd || ROOT, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => resolve({ code, out, err }))
  })
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
}

/** A project whose native directory mimics the real layout (deep below addons/). */
function project(name, buildScript, sources = {}) {
  const native = path.join(ROOT, name, 'addons', 'probe_ext', 'platform', 'native')
  fs.mkdirSync(path.join(native, 'src'), { recursive: true })
  fs.writeFileSync(path.join(native, 'SConstruct'), '# fixture\n', 'utf8')
  fs.writeFileSync(path.join(native, 'probe.gdextension'),
    '[configuration]\nentry_symbol = "probe_library_init"\ncompatibility_minimum = "4.7"\n', 'utf8')
  fs.writeFileSync(path.join(native, 'build.ps1'), buildScript, 'utf8')
  for (const [rel, text] of Object.entries(sources)) fs.writeFileSync(path.join(native, rel), text, 'utf8')
  return { project: path.join(ROOT, name), native }
}

const MSVC_OUT = String.raw`param([string]$Target = 'both')
Write-Host "target=$Target"
Write-Host "src\hello.cpp"
Write-Host "src\hello.cpp(3): error C2065: 'x': undeclared identifier"
Write-Host "src\hello.cpp(9,5): warning C4101: 'y': unreferenced local variable"
Write-Host "src\other.cpp(2): fatal error C1083: Cannot open include file: 'nope.h': No such file or directory"
exit 1
`
const GNU_OUT = String.raw`param([string]$Target = 'both')
Write-Host "target=$Target"
Write-Host "src/hello.cpp:3:5: error: 'x' was not declared in this scope"
Write-Host "src/hello.cpp:9:1: warning: unused variable 'y' [-Wunused-variable]"
Write-Host "C:/mingw/bin/ld.exe: src/hello.o: in function 'probe_init':"
Write-Host "src/hello.cpp:5: undefined reference to 'missing_fn()'"
Write-Host "collect2.exe: error: ld returned 1 exit status"
exit 1
`
const CLEAN_OUT = String.raw`param([string]$Target = 'both')
Write-Host "target=$Target"
Write-Host "scons: done building targets."
exit 0
`
const THROW_OUT = String.raw`$ErrorActionPreference = 'Continue'
Write-Host "calling scons"
throw "scons failed (exit code 1)"
`
const SLOW_OUT = String.raw`param([string]$Target = 'both')
Start-Sleep -Seconds 20
Write-Host "done"
`

async function main() {
  console.log(`temp root: ${ROOT}`)
  const source = { 'src/hello.cpp': 'int main() { return 0; }\n' }

  // ---- 1. discovery + MSVC payload ---------------------------------------
  console.log('\n[1] deep build-dir discovery, MSVC diagnostics')
  const msvc = project('msvc', MSVC_OUT, source)
  const msvcFile = path.join(msvc.native, 'src', 'hello.cpp')
  const msvcOut = path.join(ROOT, 'msvc.json')
  const r1 = await run(['check', msvcFile, '--project', msvc.project, '--out', msvcOut])
  const p1 = readJson(msvcOut)
  ok(r1.code === 1, 'exit code 1 (errors found)', `got ${r1.code}: ${r1.err.trim()}`)
  ok(!!p1, 'payload written', r1.err.trim())
  if (p1) {
    const key = 'addons/probe_ext/platform/native/src/hello.cpp'
    ok(!!p1.files[key], `payload key is project-relative (${key})`, Object.keys(p1.files).join(', '))
    const rec = p1.files[key] || { diagnostics: [] }
    const err = rec.diagnostics.find((d) => d.severity === 1)
    const warn = rec.diagnostics.find((d) => d.severity === 2)
    ok(err && err.code === 'C2065' && err.line === 3, 'error keeps code + line', JSON.stringify(err))
    ok(warn && warn.severityName === 'warning', 'warning kept as severity 2', JSON.stringify(warn))
    ok(p1.summary.errors === 2 && p1.summary.warnings === 1, `summary counts all errors (${p1.summary.errors}/${p1.summary.warnings})`, JSON.stringify(p1.summary))
    ok(p1.files['addons/probe_ext/platform/native/src/other.cpp'] !== undefined, 'an error in a file this check never asked for is still reported')
    ok(p1.server === 'build.ps1', 'server names the build entry', p1.server)
    ok(p1.build && /-Target debug\b/.test(p1.build.commands.join(' ')), 'a plain check builds the debug target only', JSON.stringify(p1.build))
    ok(p1.build && p1.build.dir === msvc.native, 'payload names the build dir it used', JSON.stringify(p1.build))
  }

  // ---- 2. sweep target ---------------------------------------------------
  console.log('\n[2] --sweep builds both targets')
  const sweepOut = path.join(ROOT, 'msvc-sweep.json')
  const r2 = await run(['check', msvcFile, '--project', msvc.project, '--sweep', '--out', sweepOut])
  const p2 = readJson(sweepOut)
  ok(r2.code === 1 && p2 && /-Target both\b/.test((p2.build.commands || []).join(' ')), 'sweep passes -Target both', JSON.stringify(p2 && p2.build) || r2.err.trim())

  // ---- 3. GNU + link errors ---------------------------------------------
  console.log('\n[3] gcc diagnostics and link errors')
  const gnu = project('gnu', GNU_OUT, source)
  const gnuOut = path.join(ROOT, 'gnu.json')
  const r3 = await run(['check', path.join(gnu.native, 'src', 'hello.cpp'), '--project', gnu.project, '--out', gnuOut])
  const p3 = readJson(gnuOut)
  ok(r3.code === 1, 'exit code 1', `got ${r3.code}`)
  if (p3) {
    const key = 'addons/probe_ext/platform/native/src/hello.cpp'
    const rec = p3.files[key] || { diagnostics: [] }
    ok(rec.diagnostics.some((d) => d.source === 'gcc' && d.column === 5), 'gcc line:column parsed', JSON.stringify(rec.diagnostics[0]))
    ok(!!p3.files['<link>'], 'link failures kept under <link>', Object.keys(p3.files).join(', '))
    const link = p3.files['<link>'] ? p3.files['<link>'].diagnostics : []
    ok(link.some((d) => /undefined reference to/.test(d.message)), 'undefined reference reported', JSON.stringify(link))
    ok(link.some((d) => /ld returned/.test(d.message)), 'collect2 failure reported', JSON.stringify(link))
    ok(p3.summary.errors >= 3, `link errors count toward the summary (${p3.summary.errors})`)
    ok(p3.summary.files_checked === 1, 'the synthetic bucket is not counted as a checked file', JSON.stringify(p3.summary))
    ok(!p3.summary.files_with_errors.includes('<link>'), 'nor listed as a file with errors', JSON.stringify(p3.summary.files_with_errors))
  }

  // ---- 4. clean build ----------------------------------------------------
  console.log('\n[4] clean build')
  const clean = project('clean', CLEAN_OUT, source)
  const cleanFile = path.join(clean.native, 'src', 'hello.cpp')
  const cleanOut = path.join(ROOT, 'clean.json')
  const r4 = await run(['check', cleanFile, '--project', clean.project, '--out', cleanOut])
  const p4 = readJson(cleanOut)
  ok(r4.code === 0, 'exit code 0', `got ${r4.code}: ${r4.err.trim()}`)
  ok(p4 && p4.summary.errors === 0 && Object.keys(p4.files).length === 1, 'requested file present with zero errors', JSON.stringify(p4 && p4.summary))

  // ---- 5. failures are never clean --------------------------------------
  console.log('\n[5] a build that did not produce diagnostics is a failure')
  const bad = project('badbuild', THROW_OUT, source)
  const badOut = path.join(ROOT, 'bad.json')
  const r5 = await run(['check', path.join(bad.native, 'src', 'hello.cpp'), '--project', bad.project, '--out', badOut])
  ok(r5.code === 2, 'exit code 2 for a failed build', `got ${r5.code}`)
  ok(!fs.existsSync(badOut), 'no payload file left behind', fs.existsSync(badOut) ? 'file exists' : '')
  ok(/without a source diagnostic/.test(r5.err), 'stderr names the failure', r5.err.trim())

  console.log('\n[6] a build that overruns the budget is a failure')
  const slow = project('slow', SLOW_OUT, source)
  const r6 = await run(['check', path.join(slow.native, 'src', 'hello.cpp'), '--project', slow.project, '--build-timeout-ms', '1500'])
  ok(r6.code === 2, 'exit code 2 on timeout', `got ${r6.code}`)
  ok(/did not finish within/.test(r6.err), 'stderr says it did not finish', r6.err.trim())

  console.log('\n[7] a project with no build entry fails loud')
  fs.mkdirSync(path.join(ROOT, 'empty'), { recursive: true })
  const r7 = await run(['check', path.join(ROOT, 'empty', 'x.cpp'), '--project', path.join(ROOT, 'empty')])
  ok(r7.code === 2 && /SConstruct/.test(r7.err), 'stderr explains what is missing', r7.err.trim())

  // ---- 8. host / status / stop ------------------------------------------
  console.log('\n[8] host, status, stop')
  const r8a = await run(['host', '--project', clean.project])
  ok(r8a.code === 0 && /build ok/.test(r8a.out), 'host validates the build entry', `${r8a.code} ${r8a.out.trim()}`)
  const r8b = await run(['status', '--project', clean.project])
  ok(r8b.code === 0 && /^running \(cpp-gdextension/m.test(r8b.out.trim().split('\n').pop()), 'status prints a running line the plugin can parse', r8b.out.trim())
  const r8c = await run(['stop', '--project', clean.project])
  ok(r8c.code === 0 && /nothing to stop/.test(r8c.out), 'stop is a no-op', r8c.out.trim())
  const r8d = await run(['host', '--project', path.join(ROOT, 'empty')])
  ok(r8d.code === 2, 'host fails loud when there is no build entry', `got ${r8d.code}`)

  // ---- 9. clientd protocol ----------------------------------------------
  console.log('\n[9] clientd JSON-lines protocol')
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, 'clientd', '--project', msvc.project], { cwd: ROOT, windowsHide: true })
    let buf = ''
    const replies = []
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } resolve() }, 60_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue
        try { replies.push(JSON.parse(line)) } catch { /* chatter */ }
      }
      if (replies.length === 1) {
        child.stdin.write(`${JSON.stringify({ id: 2, files: [msvcFile], sweep: true })}\n`)
      } else if (replies.length >= 2) {
        clearTimeout(timer)
        try { child.kill() } catch { /* gone */ }
        const first = replies[0]
        const second = replies[1]
        ok(first.id === 1 && first.ok === true && first.payload, 'first request answered with a payload', JSON.stringify(first).slice(0, 200))
        ok(first.payload && first.payload.summary.errors === 2, 'clientd payload matches the one-shot payload', JSON.stringify(first.payload && first.payload.summary))
        ok(second.id === 2 && second.ok === true, 'second (sweep) request answered on the same process', JSON.stringify(second).slice(0, 200))
        ok(second.payload && /-Target both\b/.test(((second.payload.build || {}).commands || []).join(' ')), 'sweep request built both targets', JSON.stringify(second.payload && second.payload.build))
        resolve()
      }
    })
    child.stdin.write(`${JSON.stringify({ id: 1, files: [msvcFile], sweep: false })}\n`)
  })

  // ---- 10. the real toolchain, end to end -------------------------------
  if (REAL_MSVC) {
    console.log('\n[10] real MSVC through the bridge')
    const vcvars = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat'
    const real = project('realmsvc', String.raw`param([string]$Target = 'both')
$vc = '__VCVARS__'
$cmd = 'call "' + $vc + '" >nul 2>&1 && cl /nologo /c /Fo"' + $PSScriptRoot + '\src\broken.obj" "' + $PSScriptRoot + '\src\broken.cpp"'
cmd /c $cmd
exit $LASTEXITCODE
`.replace('__VCVARS__', vcvars), { 'src/broken.cpp': 'int main() {\n    return undefined_symbol;\n}\n' })
    const realOut = path.join(ROOT, 'real.json')
    const r10 = await run(['check', path.join(real.native, 'src', 'broken.cpp'), '--project', real.project, '--out', realOut])
    const p10 = readJson(realOut)
    ok(r10.code === 1, 'real compiler failure surfaces as exit 1', `got ${r10.code}: ${r10.err.trim()}`)
    const key = 'addons/probe_ext/platform/native/src/broken.cpp'
    const rec = p10 && p10.files ? p10.files[key] : undefined
    ok(rec && rec.errors >= 1, 'real MSVC diagnostic parsed onto the file', JSON.stringify(p10 && p10.files))
    if (rec) {
      const codes = rec.diagnostics.map((d) => d.code).filter(Boolean)
      ok(codes.includes('C2065'), `real error code kept (${codes.join(',')})`, JSON.stringify(rec.diagnostics))
      ok(rec.diagnostics.every((d) => d.line > 0), 'real diagnostics carry line numbers', JSON.stringify(rec.diagnostics))
    }
  } else {
    console.log('\n[10] real MSVC skipped (pass --real-msvc)')
  }

  // ---- 11. toolchain selection ------------------------------------------
  console.log('\n[11] toolchain selection')
  const mingwScript = String.raw`param([string]$Target = 'both', [switch]$MinGW)
Write-Host "minGW=$MinGW"
if (-not $MinGW) { Write-Host "build.ps1: default (MSVC) path refused by this fixture"; exit 2 }
Write-Host "scons: done building targets."
exit 0
`
  const mingw = project('mingw', mingwScript, source)
  fs.mkdirSync(path.join(mingw.native, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(mingw.native, 'bin', 'libprobe.windows.template_debug.x86_64.a'), 'stub', 'utf8')
  const mingwOut = path.join(ROOT, 'mingw.json')
  const r11 = await run(['check', path.join(mingw.native, 'src', 'hello.cpp'), '--project', mingw.project, '--out', mingwOut])
  const p11 = readJson(mingwOut)
  ok(r11.code === 0 && p11 && p11.build.toolchain === 'mingw' && /-MinGW\b/.test((p11.build.commands || []).join(' ')),
    'this project\'s .a artifacts select MinGW', `${r11.code} ${JSON.stringify(p11 && p11.build)} ${r11.err.trim()}`)
  const r11b = await run(['check', path.join(clean.native, 'src', 'hello.cpp'), '--project', clean.project, '--toolchain', 'msvc'])
  ok(r11b.code === 0, 'an explicit --toolchain is accepted', `${r11b.code} ${r11b.err.trim()}`)
  const r11c = await run(['check', path.join(clean.native, 'src', 'hello.cpp'), '--project', clean.project, '--toolchain', 'wat'])
  ok(r11c.code === 2 && /must be auto, msvc or mingw/.test(r11c.err), 'an unknown toolchain fails loud', r11c.err.trim())
  const r11d = await run(['status', '--project', mingw.project])
  ok(/toolchain: mingw/.test(r11d.out), 'status reports the chosen toolchain', r11d.out.trim())

  // ---- 12. the changed files decide which build runs ---------------------
  console.log('\n[12] per-file build directory')
  const two = project('two', CLEAN_OUT, source)
  const second = path.join(two.project, 'addons', 'other', 'platform', 'native')
  fs.mkdirSync(path.join(second, 'src'), { recursive: true })
  fs.writeFileSync(path.join(second, 'SConstruct'), '# fixture\n', 'utf8')
  fs.writeFileSync(path.join(second, 'other.gdextension'), '[configuration]\ncompatibility_minimum = "4.7"\n', 'utf8')
  fs.writeFileSync(path.join(second, 'build.ps1'), CLEAN_OUT, 'utf8')
  fs.writeFileSync(path.join(second, 'src', 'other.cpp'), 'int other() { return 0; }\n', 'utf8')
  const otherFile = path.join(second, 'src', 'other.cpp')
  const firstFile = path.join(two.native, 'src', 'hello.cpp')
  const out12 = path.join(ROOT, 'two.json')
  const r12 = await run(['check', otherFile, '--project', two.project, '--out', out12])
  const p12 = readJson(out12)
  ok(r12.code === 0 && p12 && path.resolve(p12.build.dir) === path.resolve(second),
    'the changed file picks its own GDExtension', `${r12.code} ${JSON.stringify(p12 && p12.build)} ${r12.err.trim()}`)
  ok(p12 && Object.keys(p12.files).length === 1 && !!p12.files['addons/other/platform/native/src/other.cpp'],
    'only the covered file is stamped as checked', JSON.stringify(p12 && Object.keys(p12.files)))
  const out12b = path.join(ROOT, 'two-b.json')
  const r12b = await run(['check', firstFile, '--project', two.project, '--out', out12b])
  const p12b = readJson(out12b)
  ok(r12b.code === 0 && p12b && path.resolve(p12b.build.dir) === path.resolve(two.native),
    'the first extension resolves to its own build too', JSON.stringify(p12b && p12b.build))
  const out12c = path.join(ROOT, 'two-c.json')
  const r12c = await run(['check', otherFile, firstFile, '--project', two.project, '--out', out12c])
  const p12c = readJson(out12c)
  ok(r12c.code === 0 && p12c && !p12c.files['addons/probe_ext/platform/native/src/hello.cpp'],
    'a file outside the chosen build is never reported clean', JSON.stringify(p12c && Object.keys(p12c.files)))
  ok(p12c && /were not compiled/.test(p12c.engine_note || ''), 'the payload names the files it did not compile', p12c && p12c.engine_note)
  ok(p12c && Array.isArray(p12c.syntheticKeys) && p12c.syntheticKeys.includes('<link>'),
    'the payload declares its synthetic key', JSON.stringify(p12c && p12c.syntheticKeys))
  const r12d = await run(['check', firstFile, '--project', clean.project, '--toolchain'])
  ok(r12d.code === 2 && /needs a value/.test(r12d.err), '--toolchain without a value fails loud', `${r12d.code} ${r12d.err.trim()}`)
  // A GDExtension whose build entry sits at the project root is the other common
  // layout: the nearest ancestor with an entry is the root itself.
  const flat = path.join(ROOT, 'flat')
  fs.mkdirSync(path.join(flat, 'src'), { recursive: true })
  fs.writeFileSync(path.join(flat, 'SConstruct'), '# fixture\n', 'utf8')
  fs.writeFileSync(path.join(flat, 'flat.gdextension'), '[configuration]\ncompatibility_minimum = "4.7"\n', 'utf8')
  fs.writeFileSync(path.join(flat, 'build.ps1'), CLEAN_OUT, 'utf8')
  fs.writeFileSync(path.join(flat, 'src', 'flat.cpp'), 'int flat() { return 0; }\n', 'utf8')
  const out12e = path.join(ROOT, 'flat.json')
  const r12e = await run(['check', path.join(flat, 'src', 'flat.cpp'), '--project', flat, '--out', out12e])
  const p12e = readJson(out12e)
  ok(r12e.code === 0 && p12e && path.resolve(p12e.build.dir) === path.resolve(flat),
    'a root-level build entry is found for its own files', JSON.stringify(p12e && p12e.build))
  ok(p12e && !!p12e.files['src/flat.cpp'], 'its file is stamped project-relative', JSON.stringify(p12e && Object.keys(p12e.files)))

  // ---- 13. one build per build directory ---------------------------------
  console.log('\n[13] concurrent builds in one directory')
  // Two checker processes can reach one build directory (the host retries a
  // one-shot check, or a second DSH instance checks the same project). Two
  // concurrent SCons runs there fight over the same object files.
  const slowTwo = project('slow-two', SLOW_OUT, source)
  const firstRun = run(['check', path.join(slowTwo.native, 'src', 'hello.cpp'), '--project', slowTwo.project,
    '--out', path.join(ROOT, 'slow1.json'), '--build-timeout-ms', '6000'])
  await new Promise((r) => setTimeout(r, 1500)) // let the first process take the lock
  const secondRun = await run(['check', path.join(slowTwo.native, 'src', 'hello.cpp'), '--project', slowTwo.project,
    '--out', path.join(ROOT, 'slow2.json'), '--build-timeout-ms', '2000'])
  ok(secondRun.code === 2 && /already building/.test(secondRun.err),
    'a second build on the same directory is refused, not raced', `${secondRun.code} ${secondRun.err.trim()}`)
  ok(!fs.existsSync(path.join(ROOT, 'slow2.json')), 'the refused check wrote no payload')
  const firstResult = await firstRun
  ok(firstResult.code === 2 && /did not finish within/.test(firstResult.err),
    'the first build still answers with its own verdict', `${firstResult.code} ${firstResult.err.trim()}`)
  // Killing the checker does not kill the compiler it started, so a lock must
  // read as held while either pid lives — otherwise the retry would build
  // concurrently with the orphan.
  const lockDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'lsp-echo-runtime')
  const lockKey = crypto.createHash('sha1').update(path.resolve(slowTwo.native).toLowerCase()).digest('hex').slice(0, 12)
  const lockFile = path.join(lockDir, `cpp-build-${lockKey}.lock`)
  fs.mkdirSync(lockDir, { recursive: true })
  const locked = (extra) => fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999999, at: Date.now(), dir: slowTwo.native, ...extra }))
  locked({ childPid: process.pid }) // taker gone, its build child (this probe) alive
  const orphanRun = await run(['check', path.join(slowTwo.native, 'src', 'hello.cpp'), '--project', slowTwo.project,
    '--out', path.join(ROOT, 'slow3.json'), '--build-timeout-ms', '2000'])
  ok(orphanRun.code === 2 && /already building/.test(orphanRun.err),
    'a lock whose build child is still alive is not stolen', `${orphanRun.code} ${orphanRun.err.trim()}`)
  locked({}) // taker and build child both gone
  const takeoverRun = await run(['check', path.join(slowTwo.native, 'src', 'hello.cpp'), '--project', slowTwo.project,
    '--out', path.join(ROOT, 'slow4.json'), '--build-timeout-ms', '2500'])
  ok(takeoverRun.code === 2 && /did not finish within/.test(takeoverRun.err),
    'a lock whose taker and build child are both gone is taken over', `${takeoverRun.code} ${takeoverRun.err.trim()}`)
  ok(!fs.existsSync(lockFile), 'the taken-over lock is released again')
  ok(/already building .*\(lock: .*cpp-build-/.test(orphanRun.err), 'the refusal names the lock file to clear', orphanRun.err.trim())
  // Waiting comes out of the same budget as the build: with a 25s budget and a 6s
  // wait the build gets ~19s, so the whole check answers inside its budget.
  const waitSlow = project('wait-slow', SLOW_OUT, source)
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'ignore' })
  const lockFor = (dir) => path.join(lockDir, `cpp-build-${crypto.createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 12)}.lock`)
  const holderLock = lockFor(waitSlow.native)
  fs.writeFileSync(holderLock, JSON.stringify({ pid: 999999999, childPid: holder.pid, at: Date.now(), dir: waitSlow.native }))
  const waitStart = Date.now()
  const waitRun = await run(['check', path.join(waitSlow.native, 'src', 'hello.cpp'), '--project', waitSlow.project,
    '--out', path.join(ROOT, 'wait.json'), '--build-timeout-ms', '25000'])
  const waitElapsed = Date.now() - waitStart
  ok(waitRun.code === 2 && /did not finish within/.test(waitRun.err) && waitElapsed < 28_000,
    'a check that waits builds inside the same budget, not a second one', `${waitRun.code} ${waitElapsed}ms ${waitRun.err.trim()}`)
  ok(/after waiting .*s for another check/.test(waitRun.err), 'and says that it had to wait', waitRun.err.trim())
  ok(!fs.existsSync(holderLock), 'the waited-out lock is released again')
  // A short remaining window still gets a build attempt: refusing would trade a
  // possible result for a certain failure, and the bridge answers its own timeout
  // before the host's timer, so there is nothing dangerous to start.
  const holder2 = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'ignore' })
  fs.writeFileSync(holderLock, JSON.stringify({ pid: 999999999, childPid: holder2.pid, at: Date.now(), dir: waitSlow.native }))
  const nearRun = await run(['check', path.join(waitSlow.native, 'src', 'hello.cpp'), '--project', waitSlow.project,
    '--out', path.join(ROOT, 'near.json'), '--build-timeout-ms', '12000'])
  ok(nearRun.code === 2 && /did not finish within/.test(nearRun.err) && !/already building/.test(nearRun.err),
    'a small remaining window still gets a build attempt, not a refusal', `${nearRun.code} ${nearRun.err.trim()}`)
  // A record no build can still be behind is cleared, so a recycled pid cannot
  // wedge the directory for good.
  const waitClean = project('wait-clean', CLEAN_OUT, source)
  const agedLock = lockFor(waitClean.native)
  fs.writeFileSync(agedLock, JSON.stringify({ pid: process.pid, at: Date.now() - 25 * 60 * 60_000, dir: waitClean.native }))
  const agedRun = await run(['check', path.join(waitClean.native, 'src', 'hello.cpp'), '--project', waitClean.project,
    '--out', path.join(ROOT, 'aged.json'), '--build-timeout-ms', '20000'])
  ok(agedRun.code === 0, 'an aged record with a live pid is cleared, not waited on', `${agedRun.code} ${agedRun.err.trim()}`)

  console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${checks - failures}/${checks} checks`)
  if (!KEEP) {
    try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* windows lock: leave the temp dir */ }
  } else {
    console.log(`kept: ${ROOT}`)
  }
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
