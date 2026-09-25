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
// Every assertion runs exactly once per run. A promise handler that fires twice
// (two `data` events reaching the same assertions) would otherwise hide a skipped
// assertion behind a repeated one, so the call site is recorded and a repeat is a
// failure rather than a second tick of the count.
const okSites = new Map()
function ok(cond, label, detail) {
  const site = (new Error().stack || '').split('\n')[2] || 'unknown'
  const first = okSites.get(site)
  checks++
  if (first) {
    failures++
    console.log(`  FAIL assertion ran twice: ${label} (already counted as "${first}")`)
    return false
  }
  okSites.set(site, label)
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
    const child = spawn(process.execPath, [BRIDGE, ...args], {
      cwd: opts.cwd || ROOT, windowsHide: true, env: { ...process.env, ...(opts.env || {}) },
    })
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

/**
 * A C++ compiler for the syntax-stage cases: an explicit choice first, then the
 * roots this project's own build script names, then PATH.
 */
function probeCompiler() {
  const exe = process.platform === 'win32' ? 'g++.exe' : 'g++'
  const candidates = []
  if (process.env.CXX) candidates.push(process.env.CXX)
  if (process.env.MINGW_BIN) candidates.push(path.join(process.env.MINGW_BIN, exe))
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe))
  }
  for (const dir of ['E:\\Programs\\mingw64-gcc14\\mingw64\\bin', 'E:\\Programs\\mingw64\\mingw64\\bin', 'C:\\mingw64\\bin', 'C:\\msys64\\mingw64\\bin', '/usr/bin']) {
    candidates.push(path.join(dir, exe))
  }
  for (const file of candidates) {
    try { if (file && fs.statSync(file).isFile()) return file } catch { /* next */ }
  }
  return undefined
}

/**
 * A fixture the engine can only read as MinGW: the toolchain comes from the
 * project's own artifacts, so a `.a` in `bin/` decides it. Without one every
 * fixture would be MSVC by default on a machine that has vcvars, and the
 * syntax-stage cases would test the other path than the one they name.
 */
function mingwProject(name, buildScript, sources = {}) {
  const made = project(name, buildScript, sources)
  fs.mkdirSync(path.join(made.native, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(made.native, 'bin', 'libprobe.a'), '!<arch>\n', 'utf8')
  return made
}

/** Name, size and mtime of every file under a directory: what a write would change. */
function dirFingerprint(dir) {
  const parts = []
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        try { const s = fs.statSync(p); parts.push(`${path.relative(dir, p)}:${s.size}:${Math.round(s.mtimeMs)}`) } catch { /* gone */ }
      }
    }
  }
  walk(dir)
  return parts.join('|')
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
// Raises a flag file the moment the build starts: a test can wait for the flag
// instead of guessing how long clientd needs before the build is really running.
const SLOW_FLAG_OUT = String.raw`param([string]$Target = 'both')
New-Item -ItemType File -Force -Path (Join-Path $PSScriptRoot 'build-started.flag') | Out-Null
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
  // A valueless flag must not swallow the argument after it: the one-shot retry
  // and the baseline sweep both put flags before the file list.
  const out4b = path.join(ROOT, 'clean-nowait.json')
  const r4b = await run(['check', '--no-wait', cleanFile, '--project', clean.project, '--out', out4b])
  const p4b = readJson(out4b)
  ok(r4b.code === 0 && p4b && Object.keys(p4b.files).length === 1,
    '--no-wait before the file still checks that file', `${r4b.code} ${r4b.err.trim()}`)
  const out4c = path.join(ROOT, 'clean-sweep-first.json')
  const r4c = await run(['check', '--sweep', cleanFile, '--project', clean.project, '--out', out4c])
  const p4c = readJson(out4c)
  ok(r4c.code === 0 && p4c && /-Target both\b/.test(((p4c.build || {}).commands || []).join(' ')),
    '--sweep before the file is still a boolean', `${r4c.code} ${JSON.stringify(p4c && p4c.build)} ${r4c.err.trim()}`)
  // The plugin's own call puts the files first and the flags after them (the
  // manager builds `check <files...> --no-wait --project …`), so a boolean flag
  // there must neither lose the file nor swallow the flag that follows it.
  const out4d = path.join(ROOT, 'clean-nowait-after.json')
  const r4d = await run(['check', cleanFile, '--no-wait', '--project', clean.project, '--out', out4d])
  const p4d = readJson(out4d)
  ok(r4d.code === 0 && p4d && Object.keys(p4d.files).length === 1,
    '--no-wait after the file still checks that file', `${r4d.code} ${r4d.err.trim()}`)
  // A value-taking flag with nothing after it must fail loud: `Number(true)` is 1,
  // so a valueless --build-timeout-ms used to become a one-millisecond budget that
  // reported a timeout without ever building.
  const r4e = await run(['check', cleanFile, '--project', clean.project, '--build-timeout-ms'])
  ok(r4e.code === 2 && /--build-timeout-ms needs a value/.test(r4e.err),
    'a valueless --build-timeout-ms fails loud instead of becoming a 1ms budget', `${r4e.code} ${r4e.err.trim()}`)

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
  const r6 = await run(['check', path.join(slow.native, 'src', 'hello.cpp'), '--project', slow.project, '--build-timeout-ms', '1500', '--kill-on-timeout'])
  ok(r6.code === 2, 'exit code 2 on timeout', `got ${r6.code}`)
  ok(/did not finish within/.test(r6.err), 'stderr says it did not finish', r6.err.trim())
  // The default is *not* to kill: the verdict arrives at the budget and the build
  // keeps running, so the process must not outlive its own answer (a one-shot
  // check that lingered would make the host pay its whole timeout for a verdict
  // it already had).
  const t6b = Date.now()
  const r6b = await run(['check', path.join(slow.native, 'src', 'hello.cpp'), '--project', slow.project, '--build-timeout-ms', '1500'])
  const ms6b = Date.now() - t6b
  ok(r6b.code === 2 && /still running \(pid \d+\)/.test(r6b.err),
    'without --kill-on-timeout the verdict names the build it left running', `${r6b.code} ${r6b.err.trim()}`)
  ok(ms6b < 6_000, 'and the check exits on its budget instead of waiting for that build', `${ms6b}ms`)

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
    let done = false
    // A silent timeout would skip these four assertions and still print PASSED: a
    // probe promise that gives up must report the give-up as a failure.
    const finish = (giveUp) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill() } catch { /* gone */ }
      if (giveUp) ok(false, giveUp, `replies: ${replies.map((r) => r.id).join(',') || 'none'}`)
      resolve()
    }
    const timer = setTimeout(() => finish('clientd answered both requests within 60s'), 60_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      if (done) return
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
        const first = replies[0]
        const second = replies[1]
        ok(first.id === 1 && first.ok === true && first.payload, 'first request answered with a payload', JSON.stringify(first).slice(0, 200))
        ok(first.payload && first.payload.summary.errors === 2, 'clientd payload matches the one-shot payload', JSON.stringify(first.payload && first.payload.summary))
        ok(second.id === 2 && second.ok === true, 'second (sweep) request answered on the same process', JSON.stringify(second).slice(0, 200))
        ok(second.payload && /-Target both\b/.test(((second.payload.build || {}).commands || []).join(' ')), 'sweep request built both targets', JSON.stringify(second.payload && second.payload.build))
        finish()
      }
    })
    child.stdin.write(`${JSON.stringify({ id: 1, files: [msvcFile], sweep: false })}\n`)
  })

  // A request that refuses to wait must not sit in the queue behind the check
  // already running: the host's short pre-step budget would time the whole
  // channel out and retire this clientd, rejecting the running request too. The
  // fixture raises a flag file when its build starts, so the second request is
  // sent while the first is provably running instead of after a guessed sleep.
  console.log('\n[9b] a no-wait request is refused instead of queueing')
  const flagRun = project('flag-run', SLOW_FLAG_OUT, source)
  const flagFile = path.join(flagRun.native, 'build-started.flag')
  const flagInput = path.join(flagRun.native, 'src', 'hello.cpp')
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, 'clientd', '--project', flagRun.project], { cwd: ROOT, windowsHide: true })
    let buf = ''
    const replies = []
    const started = Date.now()
    let sentSecond = false
    let done = false
    // A silent timeout would skip these assertions and still print PASSED: a
    // probe promise that gives up must report the give-up as a failure.
    const finish = (giveUp) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(poll)
      try { child.kill() } catch { /* gone */ }
      if (giveUp) {
        ok(false, giveUp, `replies: ${replies.map((x) => `${x.body.id}@${x.at}ms`).join(', ') || 'none'}`)
      }
      resolve()
    }
    const timer = setTimeout(() => finish('the no-wait refusal answered within 60s'), 60_000)
    const poll = setInterval(() => {
      if (sentSecond || !fs.existsSync(flagFile)) return
      sentSecond = true
      child.stdin.write(`${JSON.stringify({ id: 2, files: [flagInput], budgetMs: 6000, noWait: true })}\n`)
    }, 50)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      // The refusal arrives first and the running request's verdict ~6s later:
      // without this guard the second event would re-run the first two assertions.
      if (done) return
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue
        try { replies.push({ at: Date.now() - started, body: JSON.parse(line) }) } catch { /* chatter */ }
      }
      // Assert only once both replies are in: asserting on the refusal alone would
      // re-run those assertions when the running request's verdict arrives.
      const busy = replies.find((x) => x.body.id === 2)
      const first = replies.find((x) => x.body.id === 1)
      if (!busy || !first) return
      ok(busy.body.ok === false && /does not wait|already building/.test(busy.body.error || ''),
        'the no-wait request is refused, not queued', JSON.stringify(busy.body))
      ok(busy.at < 5_000, 'the refusal is immediate, not after the host timeout', `${busy.at}ms`)
      ok(busy.at < first.at, 'and it arrives before the running build finishes', `busy@${busy.at}ms first@${first.at}ms`)
      finish()
    })
    child.stdin.write(`${JSON.stringify({ id: 1, files: [flagInput], budgetMs: 6000 })}\n`)
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
    const codes = rec ? rec.diagnostics.map((d) => d.code).filter(Boolean) : []
    // Unconditional: a toolchain that cannot produce the diagnostic must fail this
    // section loudly instead of skipping its assertions (the tail guard catches a
    // count mismatch, but an explicit failure names the cause).
    ok(rec && rec.errors >= 1, 'real MSVC diagnostic parsed onto the file', JSON.stringify(p10 && p10.files) || r10.err.trim())
    ok(codes.includes('C2065'), `real error code kept (${codes.join(',') || 'none'})`, JSON.stringify(rec && rec.diagnostics) || r10.err.trim())
    ok(!!rec && rec.diagnostics.every((d) => d.line > 0), 'real diagnostics carry line numbers', JSON.stringify(rec && rec.diagnostics) || r10.err.trim())
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

  // A vendored dependency checkout inside the project carries an SConstruct too
  // (godot-cpp does), and it is not this project's build: a file there must not
  // drag the checker into building the dependency, and must never be reported clean.
  const vend = path.join(ROOT, 'vendored')
  const vendNative = path.join(vend, 'addons', 'probe_ext', 'platform', 'native')
  fs.mkdirSync(path.join(vendNative, 'src'), { recursive: true })
  fs.mkdirSync(path.join(vend, 'dep', 'src'), { recursive: true })
  fs.writeFileSync(path.join(vendNative, 'SConstruct'), '# fixture\n', 'utf8')
  fs.writeFileSync(path.join(vendNative, 'probe.gdextension'), '[configuration]\ncompatibility_minimum = "4.7"\n', 'utf8')
  fs.writeFileSync(path.join(vendNative, 'build.ps1'), CLEAN_OUT, 'utf8')
  fs.writeFileSync(path.join(vendNative, 'src', 'hello.cpp'), 'int main() { return 0; }\n', 'utf8')
  fs.writeFileSync(path.join(vend, 'dep', 'SConstruct'), '# dependency build entry\n', 'utf8')
  fs.writeFileSync(path.join(vend, 'dep', 'src', 'dep.cpp'), 'int dep() { return 0; }\n', 'utf8')
  const out12f = path.join(ROOT, 'vendored.json')
  const r12f = await run(['check', path.join(vend, 'dep', 'src', 'dep.cpp'), '--project', vend, '--out', out12f])
  const p12f = readJson(out12f)
  ok(r12f.code === 0 && p12f && path.resolve(p12f.build.dir) === path.resolve(vendNative),
    'a vendored dependency\'s SConstruct is not this project\'s build',
    `${r12f.code} ${JSON.stringify(p12f && p12f.build)} ${r12f.err.trim()}`)
  ok(p12f && !p12f.files['dep/src/dep.cpp'] && /were not compiled/.test(p12f.engine_note || ''),
    'the dependency file is never reported clean',
    JSON.stringify(p12f && { files: Object.keys(p12f.files), note: p12f.engine_note }))

  // A root-level extension plus a *nested* one: the first requested file decides
  // which build runs, and a file that resolves to the nested extension must not be
  // stamped clean merely because it sits inside the chosen directory.
  const nested = path.join(ROOT, 'nested')
  const nestedInner = path.join(nested, 'addons', 'inner', 'platform', 'native')
  fs.mkdirSync(path.join(nested, 'src'), { recursive: true })
  fs.mkdirSync(path.join(nestedInner, 'src'), { recursive: true })
  fs.writeFileSync(path.join(nested, 'SConstruct'), '# fixture\n', 'utf8')
  fs.writeFileSync(path.join(nested, 'root.gdextension'), '[configuration]\ncompatibility_minimum = "4.7"\n', 'utf8')
  fs.writeFileSync(path.join(nested, 'build.ps1'), CLEAN_OUT, 'utf8')
  fs.writeFileSync(path.join(nested, 'src', 'root.cpp'), 'int root() { return 0; }\n', 'utf8')
  fs.writeFileSync(path.join(nestedInner, 'SConstruct'), '# fixture\n', 'utf8')
  fs.writeFileSync(path.join(nestedInner, 'inner.gdextension'), '[configuration]\ncompatibility_minimum = "4.7"\n', 'utf8')
  fs.writeFileSync(path.join(nestedInner, 'build.ps1'), CLEAN_OUT, 'utf8')
  fs.writeFileSync(path.join(nestedInner, 'src', 'inner.cpp'), 'int inner() { return 0; }\n', 'utf8')
  const out12g = path.join(ROOT, 'nested.json')
  const r12g = await run(['check', path.join(nested, 'src', 'root.cpp'), path.join(nestedInner, 'src', 'inner.cpp'),
    '--project', nested, '--out', out12g])
  const p12g = readJson(out12g)
  ok(r12g.code === 0 && p12g && path.resolve(p12g.build.dir) === path.resolve(nested),
    'the first requested file decides the build directory', `${r12g.code} ${JSON.stringify(p12g && p12g.build)} ${r12g.err.trim()}`)
  ok(p12g && !!p12g.files['src/root.cpp'] && !p12g.files['addons/inner/platform/native/src/inner.cpp'],
    "the other GDExtension's file is not stamped as checked", JSON.stringify(p12g && Object.keys(p12g.files)))
  ok(p12g && /were not compiled/.test(p12g.engine_note || ''), 'and the payload names the file it did not compile', p12g && p12g.engine_note)

  // ---- 13. one build per build directory ---------------------------------
  console.log('\n[13] concurrent builds in one directory')
  // Two checker processes can reach one build directory (the host retries a
  // one-shot check, or a second DSH instance checks the same project). Two
  // concurrent SCons runs there fight over the same object files.
  const slowTwo = project('slow-two', SLOW_OUT, source)
  const lockDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'lsp-echo-runtime')
  const lockFor = (dir) => path.join(lockDir, `cpp-build-${crypto.createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 12)}.lock`)
  const lockFile = lockFor(slowTwo.native)
  fs.mkdirSync(lockDir, { recursive: true })
  const locked = (extra) => fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999999, at: Date.now(), dir: slowTwo.native, ...extra }))
  const firstRun = run(['check', path.join(slowTwo.native, 'src', 'hello.cpp'), '--project', slowTwo.project,
    '--out', path.join(ROOT, 'slow1.json'), '--build-timeout-ms', '6000'])
  // Wait for the first process to actually take the lock instead of guessing how
  // long SCons needs to start: a fixed sleep either races (too short) or wastes
  // time (too long).
  const lockDeadline = Date.now() + 15_000
  while (!fs.existsSync(lockFile) && Date.now() < lockDeadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  const secondRun = await run(['check', path.join(slowTwo.native, 'src', 'hello.cpp'), '--project', slowTwo.project,
    '--out', path.join(ROOT, 'slow2.json'), '--build-timeout-ms', '2000'])
  ok(secondRun.code === 2 && /already building/.test(secondRun.err),
    'a second build on the same directory is refused, not raced', `${secondRun.code} ${secondRun.err.trim()}`)
  ok(!fs.existsSync(path.join(ROOT, 'slow2.json')), 'the refused check wrote no payload')
  const firstResult = await firstRun
  ok(firstResult.code === 2 && /did not finish within/.test(firstResult.err),
    'the first build still answers with its own verdict', `${firstResult.code} ${firstResult.err.trim()}`)
  ok(/still running \(pid \d+\)/.test(firstResult.err),
    'and says the build it did not wait for is still running', firstResult.err.trim())
  // Killing a build throws away SCons's incremental state and makes the next check
  // rebuild more, so a check that runs out of budget leaves the build running and
  // hands it the lock instead (probe [6] opts into the kill for cleanup).
  const heldRecord = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
  ok(!heldRecord.pid && heldRecord.childPid, 'the lock is left naming only that build (orphan record)', JSON.stringify(heldRecord))
  try { fs.unlinkSync(lockFile) } catch { /* released by then */ }
  // Killing the checker does not kill the compiler it started, so a lock must
  // read as held while either pid lives — otherwise the retry would build
  // concurrently with the orphan.
  locked({ childPid: process.pid }) // taker gone, its build child (this probe) alive
  const orphanRun = await run(['check', path.join(slowTwo.native, 'src', 'hello.cpp'), '--project', slowTwo.project,
    '--out', path.join(ROOT, 'slow3.json'), '--build-timeout-ms', '2000'])
  ok(orphanRun.code === 2 && /already building/.test(orphanRun.err),
    'a lock whose build child is still alive is not stolen', `${orphanRun.code} ${orphanRun.err.trim()}`)
  // The record a failed kill leaves behind: only the build child, no taker pid
  // (that process is the live check that could not kill it).
  fs.writeFileSync(lockFile, JSON.stringify({ childPid: process.pid, at: Date.now(), dir: slowTwo.native }))
  const orphanRecord = await run(['check', path.join(slowTwo.native, 'src', 'hello.cpp'), '--project', slowTwo.project,
    '--out', path.join(ROOT, 'slow-orphan.json'), '--build-timeout-ms', '2000'])
  ok(orphanRecord.code === 2 && /build pid \d+ \(orphan\)/.test(orphanRecord.err),
    'the orphan record a failed kill leaves is honoured and named', `${orphanRecord.code} ${orphanRecord.err.trim()}`)
  locked({}) // taker and build child both gone
  const takeoverRun = await run(['check', path.join(slowTwo.native, 'src', 'hello.cpp'), '--project', slowTwo.project,
    '--out', path.join(ROOT, 'slow4.json'), '--build-timeout-ms', '2500'])
  ok(takeoverRun.code === 2 && /did not finish within/.test(takeoverRun.err),
    'a lock whose taker and build child are both gone is taken over', `${takeoverRun.code} ${takeoverRun.err.trim()}`)
  const takeoverRecord = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
  ok(!takeoverRecord.pid && takeoverRecord.childPid,
    'the taken-over lock is handed to the build that outran its budget', JSON.stringify(takeoverRecord))
  try { fs.unlinkSync(lockFile) } catch { /* released by then */ }
  ok(/already building .*\(lock: .*cpp-build-/.test(orphanRun.err), 'the refusal names the lock file to clear', orphanRun.err.trim())
  // Waiting comes out of the same budget as the build: with a 25s budget and a 6s
  // wait the build gets ~19s, so the whole check answers inside its budget.
  const waitSlow = project('wait-slow', SLOW_OUT, source)
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'ignore' })
  const holderLock = lockFor(waitSlow.native)
  fs.writeFileSync(holderLock, JSON.stringify({ pid: 999999999, childPid: holder.pid, at: Date.now(), dir: waitSlow.native }))
  const waitStart = Date.now()
  const waitRun = await run(['check', path.join(waitSlow.native, 'src', 'hello.cpp'), '--project', waitSlow.project,
    '--out', path.join(ROOT, 'wait.json'), '--build-timeout-ms', '25000'])
  const waitElapsed = Date.now() - waitStart
  ok(waitRun.code === 2 && /did not finish within/.test(waitRun.err) && waitElapsed < 28_000,
    'a check that waits builds inside the same budget, not a second one', `${waitRun.code} ${waitElapsed}ms ${waitRun.err.trim()}`)
  ok(/after waiting .*s for another check/.test(waitRun.err), 'and says that it had to wait', waitRun.err.trim())
  const waitedRecord = JSON.parse(fs.readFileSync(holderLock, 'utf8'))
  ok(!waitedRecord.pid && waitedRecord.childPid,
    'the waited-out lock is handed to the build that outran its budget', JSON.stringify(waitedRecord))
  try { fs.unlinkSync(holderLock) } catch { /* released by then */ }
  // A short remaining window still gets a build attempt: refusing would trade a
  // possible result for a certain failure, and the bridge answers its own timeout
  // before the host's timer, so there is nothing dangerous to start.
  const holder2 = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'ignore' })
  fs.writeFileSync(holderLock, JSON.stringify({ pid: 999999999, childPid: holder2.pid, at: Date.now(), dir: waitSlow.native }))
  const nearRun = await run(['check', path.join(waitSlow.native, 'src', 'hello.cpp'), '--project', waitSlow.project,
    '--out', path.join(ROOT, 'near.json'), '--build-timeout-ms', '12000', '--kill-on-timeout'])
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

  // ---- 14. syntax stage: the project's own compiler, no build --------------
  // The stage exists so a one-line edit does not cost a build; it must stay
  // honest (a run that could not happen is a failure, never a clean file), keep
  // the build's evidence intact (no <link> record), and use the flags the build
  // actually uses.
  console.log('\n[14] syntax stage (compiler only, no build)')
  const gpp = probeCompiler()
  ok(!!gpp, 'a C++ compiler is available for the syntax-stage cases', 'set CXX or MINGW_BIN to a g++')
  const syn = mingwProject('syntax', CLEAN_OUT, { 'src/ok.cpp': 'int probe_ok() { return 0; }\n' })
  const synFile = path.join(syn.native, 'src', 'ok.cpp')
  const synKey = 'addons/probe_ext/platform/native/src/ok.cpp'
  if (gpp) {
    const withGpp = { CXX: gpp }
    const r14a = await run(['check', synFile, '--project', syn.project, '--print-flags'], { env: withGpp })
    ok(r14a.code === 0 && /compiler: .*g\+\+/.test(r14a.out) && /布局/.test(r14a.out),
      '--print-flags names the compiler and the flag source without compiling', `${r14a.code} ${r14a.out.trim()}`)
    const before14 = dirFingerprint(syn.native)
    const out14b = path.join(ROOT, 'syntax-clean.json')
    const t14b = Date.now()
    const r14b = await run(['check', synFile, '--project', syn.project, '--stage', 'syntax', '--out', out14b], { env: withGpp })
    const ms14b = Date.now() - t14b
    const p14b = readJson(out14b)
    ok(r14b.code === 0 && p14b && p14b.stage === 'syntax', 'a clean file passes in the syntax stage', `${r14b.code} ${r14b.err.trim()}`)
    ok(!!(p14b && p14b.files[synKey] && p14b.files[synKey].errors === 0),
      'the checked file is recorded with zero errors', JSON.stringify(p14b && p14b.files))
    ok(!!(p14b && !p14b.files['<link>'] && (p14b.syntheticKeys || []).length === 0),
      'the stage declares no <link> record it could not have produced', JSON.stringify(p14b && p14b.syntheticKeys))
    ok(ms14b < 15_000, 'a syntax check stays far under the build budget', `${ms14b}ms`)
    ok(dirFingerprint(syn.native) === before14 && !fs.existsSync(lockFor(syn.native)),
      'and writes nothing into the build directory, nor takes a lock',
      `${before14}\n       → ${dirFingerprint(syn.native)}`)
    const bad = mingwProject('syntax-bad', CLEAN_OUT, { 'src/bad.cpp': 'int probe_bad() { return missing_symbol_xyz; }\n' })
    const out14c = path.join(ROOT, 'syntax-bad.json')
    const r14c = await run(['check', path.join(bad.native, 'src', 'bad.cpp'), '--project', bad.project, '--stage', 'syntax', '--out', out14c], { env: withGpp })
    const rec14c = (readJson(out14c) || { files: {} }).files['addons/probe_ext/platform/native/src/bad.cpp']
    ok(r14c.code === 1 && !!rec14c && rec14c.errors === 1 && /missing_symbol_xyz/.test((rec14c.diagnostics[0] || {}).message),
      "a broken file is reported by the project's own compiler", `${r14c.code} ${JSON.stringify(rec14c)}`)
    ok(!!rec14c && rec14c.diagnostics[0].line === 1 && rec14c.diagnostics[0].severityName === 'error',
      'with the position and severity the build would give', JSON.stringify(rec14c && rec14c.diagnostics))
  } else {
    ok(false, 'a clean file passes in the syntax stage', 'no compiler found: set CXX or MINGW_BIN')
    ok(false, 'the checked file is recorded with zero errors', 'no compiler found')
    ok(false, 'the stage declares no <link> record it could not have produced', 'no compiler found')
    ok(false, 'a syntax check stays far under the build budget', 'no compiler found')
    ok(false, 'and writes nothing into the build directory, nor takes a lock', 'no compiler found')
    ok(false, "a broken file is reported by the project's own compiler", 'no compiler found')
    ok(false, 'with the position and severity the build would give', 'no compiler found')
    ok(false, 'the build directory is left exactly as it was', 'no compiler found')
  }
  // A stage that cannot run must answer with the stage that can, never with a
  // clean file: the minimal PATH holds no compiler (Windows keeps PowerShell in
  // System32, so the build fallback still works).
  const winRoot = process.env.SystemRoot || 'C:\\Windows'
  const minimalPath = process.platform === 'win32'
    ? [path.join(winRoot, 'System32', 'WindowsPowerShell', 'v1.0'), path.join(winRoot, 'System32')].join(path.delimiter)
    : '/usr/bin:/bin'
  const noCompiler = { CXX: path.join(ROOT, 'no-compiler', 'g++.exe'), MINGW_BIN: path.join(ROOT, 'no-compiler'), PATH: minimalPath }
  const plain = mingwProject('syntax-none', CLEAN_OUT, { 'src/plain.cpp': 'int probe_plain() { return 0; }\n' })
  const out14d = path.join(ROOT, 'syntax-none-syntax.json')
  const plainRun = await run(['check', path.join(plain.native, 'src', 'plain.cpp'), '--project', plain.project, '--stage', 'syntax', '--out', out14d], { env: noCompiler })
  const blocked = plainRun.code === 2
  ok(blocked && !readJson(out14d),
    'a syntax stage with no compiler fails loud instead of reporting a clean file',
    `${plainRun.code} payload=${JSON.stringify(readJson(out14d))} ${plainRun.err.trim()}`)
  const out14e = path.join(ROOT, 'syntax-none.json')
  const autoRun = await run(['check', path.join(plain.native, 'src', 'plain.cpp'), '--project', plain.project, '--stage', 'auto', '--out', out14e], { env: noCompiler })
  const p14e = readJson(out14e)
  ok(autoRun.code === 0 && !!p14e && p14e.stage === (blocked ? 'build' : 'syntax'),
    'and --stage auto answers with the stage that can run', `${autoRun.code} ${JSON.stringify(p14e && p14e.stage)} ${autoRun.err.trim()}`)
  // Explicit flags win: an include that only a compile_flags.txt provides.
  const incDir = path.join(ROOT, 'syntax-inc')
  fs.mkdirSync(incDir, { recursive: true })
  fs.writeFileSync(path.join(incDir, 'only_with_flag.h'), '#define PROBE_FLAG_OK 1\n', 'utf8')
  const flagDir = path.join(ROOT, 'syntax-flagfile')
  fs.mkdirSync(flagDir, { recursive: true })
  fs.writeFileSync(path.join(flagDir, 'compile_flags.txt'), `-std=c++17\n-I\n${incDir}\n`, 'utf8')
  const needs = mingwProject('syntax-flag', CLEAN_OUT, { 'src/needs.cpp': '#include "only_with_flag.h"\nint probe_needs() { return PROBE_FLAG_OK; }\n' })
  const needsFile = path.join(needs.native, 'src', 'needs.cpp')
  const r14f = await run(['check', needsFile, '--project', needs.project, '--stage', 'syntax'], { env: gpp ? { CXX: gpp } : {} })
  ok(r14f.code === 1 && /only_with_flag\.h/.test(`${r14f.out}${r14f.err}`),
    'without the flags file that include is not found', `${r14f.code} ${`${r14f.out}${r14f.err}`.trim().split('\n').slice(-1)[0]}`)
  const r14g = await run(['check', needsFile, '--project', needs.project, '--stage', 'syntax', '--flags', flagDir], { env: gpp ? { CXX: gpp } : {} })
  ok(r14g.code === 0, 'an explicit compile_flags.txt is used by the syntax stage', `${r14g.code} ${r14g.err.trim()}`)
  // A compiler that refuses the file without a source diagnostic (here: a flag it
  // does not have) is a failure to check, never a clean file. This is the failure
  // mode that made the stage report 0 errors for a file the compiler rejected.
  const badFlagDir = path.join(ROOT, 'syntax-badflags')
  fs.mkdirSync(badFlagDir, { recursive: true })
  fs.writeFileSync(path.join(badFlagDir, 'compile_flags.txt'), '-fbogus-flag-xyz\n', 'utf8')
  const clean14 = mingwProject('syntax-clean2', CLEAN_OUT, { 'src/fine.cpp': 'int probe_fine() { return 0; }\n' })
  const out14k = path.join(ROOT, 'syntax-badflag.json')
  const r14k = await run(['check', path.join(clean14.native, 'src', 'fine.cpp'), '--project', clean14.project, '--stage', 'syntax', '--flags', badFlagDir, '--out', out14k], { env: gpp ? { CXX: gpp } : {} })
  ok(r14k.code === 2 && !readJson(out14k) && /without a source diagnostic/.test(r14k.err),
    'a compiler failure with no source diagnostic is reported as could-not-check, not as clean',
    `${r14k.code} payload=${JSON.stringify(readJson(out14k))} ${r14k.err.trim().split('\n').slice(-2).join(' ')}`)
  const out14m = path.join(ROOT, 'syntax-missingflags.json')
  const r14m = await run(['check', path.join(clean14.native, 'src', 'fine.cpp'), '--project', clean14.project,
    '--stage', 'syntax', '--flags', path.join(ROOT, 'no-such-flags-here'), '--out', out14m], { env: gpp ? { CXX: gpp } : {} })
  ok(r14m.code === 2 && !readJson(out14m) && /does not exist/.test(r14m.err),
    'an explicit --flags that does not exist is refused instead of replaced by the layout',
    `${r14m.code} payload=${JSON.stringify(readJson(out14m))} ${r14m.err.trim()}`)
  // A stage request that has to fall back to the build must obey the no-wait rule
  // while doing so: otherwise it queues behind the running build and the host's
  // pre-step timeout retires this clientd together with that build. The fixture
  // raises a flag file the moment its build starts (so the second request is sent
  // while the first provably runs), and the minimal PATH leaves the syntax stage
  // without a compiler — the exact combination that reaches the fallback.
  console.log('\n[14c] a stage request that must fall back refuses to queue')
  const queueRun = mingwProject('syntax-queue', SLOW_FLAG_OUT, { 'src/q.cpp': 'int probe_q() { return 0; }\n' })
  const queueFlag = path.join(queueRun.native, 'build-started.flag')
  const queueFile = path.join(queueRun.native, 'src', 'q.cpp')
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, 'clientd', '--project', queueRun.project],
      { cwd: ROOT, windowsHide: true, env: { ...process.env, ...noCompiler } })
    let buf = ''
    const replies = []
    const started = Date.now()
    let sentSecond = false
    let done = false
    // A silent timeout would skip these assertions and still print PASSED: a probe
    // promise that gives up must report the give-up as a failure.
    const finish = (giveUp) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(poll)
      try { child.kill() } catch { /* gone */ }
      if (giveUp) ok(false, giveUp, `replies: ${replies.map((x) => `${x.body.id}@${x.at}ms`).join(', ') || 'none'}`)
      resolve()
    }
    const timer = setTimeout(() => finish('the stage-fallback refusal answered within 60s'), 60_000)
    const poll = setInterval(() => {
      if (sentSecond || !fs.existsSync(queueFlag)) return
      sentSecond = true
      child.stdin.write(`${JSON.stringify({ id: 2, files: [queueFile], budgetMs: 6000, noWait: true, stage: 'auto' })}\n`)
    }, 50)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      if (done) return
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue
        try { replies.push({ at: Date.now() - started, body: JSON.parse(line) }) } catch { /* chatter */ }
      }
      const busy = replies.find((x) => x.body.id === 2)
      const first = replies.find((x) => x.body.id === 1)
      if (!busy || !first) return
      ok(busy.body.ok === false && /does not wait|already building/.test(busy.body.error || ''),
        'a stage request that must fall back to the build is refused while one runs',
        JSON.stringify(busy.body).slice(0, 240))
      ok(busy.at < 5_000 && busy.at < first.at, 'and the refusal is immediate, before that build finishes',
        `busy@${busy.at}ms first@${first.at}ms`)
      finish()
    })
    child.stdin.write(`${JSON.stringify({ id: 1, files: [queueFile], budgetMs: 6000 })}\n`)
  })
  // A successful build teaches the stage: the flags SCons printed are the ones
  // the project really compiles with, including defines no heuristic can guess.
  const teachOut = String.raw`param([string]$Target = 'both')
Write-Host "g++ -o bin/obj/src/hello.o -c -std=c++17 -DFROM_BUILD=1 -I src src/hello.cpp"
Write-Host "scons: done building targets."
exit 0
`
  const taught = mingwProject('syntax-learn', teachOut, { 'src/hello.cpp': 'int probe_learn() { return FROM_BUILD; }\n' })
  const taughtFile = path.join(taught.native, 'src', 'hello.cpp')
  const r14h = await run(['check', taughtFile, '--project', taught.project, '--stage', 'build', '--out', path.join(ROOT, 'learn-build.json')], { env: gpp ? { CXX: gpp } : {} })
  ok(r14h.code === 0, 'a successful build is the teacher', `${r14h.code} ${r14h.err.trim()}`)
  const r14i = await run(['check', taughtFile, '--project', taught.project, '--print-flags'], { env: gpp ? { CXX: gpp } : {} })
  ok(r14i.code === 0 && /构建/.test(r14i.out) && /-DFROM_BUILD=1/.test(r14i.out),
    'and the syntax stage reuses the flags that build used', `${r14i.code} ${r14i.out.trim()}`)
  fs.appendFileSync(path.join(taught.native, 'build.ps1'), '# changed\n', 'utf8')
  const r14j = await run(['check', taughtFile, '--project', taught.project, '--print-flags'], { env: gpp ? { CXX: gpp } : {} })
  ok(r14j.code === 0 && /布局/.test(r14j.out) && !/-DFROM_BUILD=1/.test(r14j.out),
    'editing the build entry invalidates what it taught', r14j.out.trim())
  // The MSVC path runs through cmd.exe: Node's normal argument quoting escapes the
  // inner quotes with backslashes, which cmd does not understand, so the whole stage
  // failed with an empty output. Only --real-msvc has a machine to prove it on.
  if (REAL_MSVC) {
    const msvc = project('syntax-msvc', CLEAN_OUT, { 'src/plain.cpp': 'int probe_plain() { return 0; }\n' })
    const out14n = path.join(ROOT, 'syntax-msvc.json')
    const r14n = await run(['check', path.join(msvc.native, 'src', 'plain.cpp'), '--project', msvc.project,
      '--toolchain', 'msvc', '--stage', 'syntax', '--out', out14n])
    const p14n = readJson(out14n)
    ok(r14n.code === 0 && !!p14n && p14n.stage === 'syntax' && /cl/i.test((p14n.build || {}).compiler || ''),
      'a trivial file passes in the MSVC syntax stage (cl /Zs through vcvars)',
      `${r14n.code} ${r14n.err.trim()} ${JSON.stringify(p14n && p14n.build)}`)
    const msbad = project('syntax-msvc-bad', CLEAN_OUT, { 'src/bad.cpp': 'int probe_bad() { return missing_symbol_xyz; }\n' })
    const out14o = path.join(ROOT, 'syntax-msvc-bad.json')
    const r14o = await run(['check', path.join(msbad.native, 'src', 'bad.cpp'), '--project', msbad.project,
      '--toolchain', 'msvc', '--stage', 'syntax', '--out', out14o])
    const rec14o = ((readJson(out14o) || { files: {} }).files)['addons/probe_ext/platform/native/src/bad.cpp']
    // cl exits 2 on errors (not 1): the bridge must still report errors, not "could
    // not check".
    ok(r14o.code === 1 && !!rec14o && rec14o.errors >= 1 && /missing_symbol_xyz/.test(JSON.stringify(rec14o.diagnostics)),
      'a broken file is still a diagnostic when cl exits 2', `${r14o.code} ${JSON.stringify(rec14o)} ${r14o.err.trim()}`)
    ok(!!rec14o && rec14o.diagnostics.every((d) => d.line > 0),
      'and its diagnostics carry positions', JSON.stringify(rec14o && rec14o.diagnostics))
  } else {
    console.log('  --   MSVC syntax stage skipped (pass --real-msvc)')
  }

  // Locks these fixture builds left behind (they name builds that outran their
  // budget and were not killed): every record pointing into a throwaway fixture
  // is swept, including leftovers of an earlier run whose root is long gone, the
  // `.lock.stale-<pid>-<ts>` files a stale-lock takeover renames aside, and the
  // `.lock.<pid>.<ts>.tmp` files a killed writer leaves behind.
  try {
    const tempLower = path.resolve(os.tmpdir()).toLowerCase()
    for (const name of fs.readdirSync(lockDir)) {
      if (!name.startsWith('cpp-build-') || !/\.lock(\.|$)/.test(name)) continue
      const p = path.join(lockDir, name)
      let rec
      try { rec = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { rec = undefined }
      if (!rec || typeof rec.dir !== 'string') {
        // A record that does not parse names no directory. A `.tmp` file is a
        // half-written record, so it is removable once no writer can still be
        // finishing it; anything else is left alone because its owner is unknown.
        try {
          if (/\.tmp$/.test(name) && Date.now() - fs.statSync(p).mtimeMs > 60_000) fs.unlinkSync(p)
        } catch { /* best effort */ }
        continue
      }
      const dir = path.resolve(rec.dir)
      const underTemp = dir.toLowerCase().startsWith(tempLower)
      // The recorded dir is a *subdirectory* of the throwaway root
      // (…/dsh-cpp-probe-XXXX/slow), so look for the root segment, not the basename.
      const throwaway = underTemp && dir.slice(tempLower.length).toLowerCase().includes('dsh-')
      // A temp path that no longer exists cannot be a live build directory.
      if (throwaway || (underTemp && !fs.existsSync(dir))) {
        try { fs.unlinkSync(p) } catch { /* best effort */ }
      }
    }
    // What the fixture builds taught the syntax stage: a cache record whose
    // project is a throwaway fixture is swept by the same rule as its locks. A
    // record of a real project is never touched.
    for (const name of fs.readdirSync(lockDir)) {
      if (!name.startsWith('cpp-flags-') || !name.endsWith('.json')) continue
      const p = path.join(lockDir, name)
      let rec
      try { rec = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { continue }
      if (!rec) continue
      if (typeof rec.project !== 'string') {
        // A record written before the project field existed: its signature still
        // names the build entry the flags were learned from, and every fixture
        // root this probe ever used starts with this.
        if (typeof rec.signature === 'string' && rec.signature.includes('dsh-cpp-probe-')) {
          try { fs.unlinkSync(p) } catch { /* best effort */ }
        }
        continue
      }
      const proj = path.resolve(rec.project)
      if (proj.toLowerCase().startsWith(tempLower) && proj.slice(tempLower.length).toLowerCase().includes('dsh-')) {
        try { fs.unlinkSync(p) } catch { /* best effort */ }
      }
    }
  } catch { /* no runtime dir */ }

  // Every assertion runs exactly once, so the number that ran is knowable: a
  // skipped assertion (a promise that timed out, a section that never ran) lowers
  // the count and fails here instead of printing PASSED.
  const EXPECTED_CHECKS = 97 + (REAL_MSVC ? 7 : 0)
  if (checks !== EXPECTED_CHECKS) {
    failures += 1
    console.log(`  FAIL every check ran: ${checks}/${EXPECTED_CHECKS} executed`)
  } else {
    console.log(`  ok   every declared assertion ran exactly once (${checks})`)
  }

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
