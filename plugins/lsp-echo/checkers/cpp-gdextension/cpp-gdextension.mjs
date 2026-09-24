// cpp-gdextension.mjs — C++ compile diagnostics for a Godot GDExtension.
//
// There is no language server behind this engine: the project's own build IS
// the checker. One check compiles the project's changed translation units (the
// build is incremental) and parses the compiler's output, so the diagnostics
// are exactly the errors a real build would hit — including link errors, which
// no per-file syntax check can see.
//
// Contract with lib/manager.js (shared by every checkers/<engine>/ bridge):
//   node <bridge> host|status|stop [--project <dir>]
//   node <bridge> check <file...> --project <dir> [--sweep] [--out <json>]
//   node <bridge> clientd --project <dir>   (persistent: JSON-lines on stdin,
//        each line { id, files, sweep } -> reply { id, ok, payload })
// Extra flags: --dir <dir> pins the build directory, --toolchain auto|msvc|mingw
// overrides the toolchain detected from the project's artifacts,
// --build-timeout-ms <n> overrides the 110s/190s budget.
// Payload files keyed by project-relative path; each value
//   { checked_at, errors, warnings, diagnostics: [{ severity, severityName,
//     message, source, code, line, column, file }] } — same shape as the godot
//     and typescript bridges. Link/build-system failures land under the
//     extensionless key `<link>` (declared in engine.json `syntheticKeys` and in
//     the payload's `syntheticKeys`, so only this engine replaces it).
// Exit codes: 0 = no errors, 1 = errors found, 2 = failure to check.
//
// Which build: <dir>/build.ps1 when the GDExtension ships one (it owns the
// `py -m SCons` invocation, the API version and any MinGW setup), otherwise
// `py -m SCons platform=<os> target=template_debug|template_release`.
// Per-check target: debug only. A sweep (--sweep) also builds release, because
// release-only failures are real (different macros — DEV_ENABLED is off — and
// full optimization).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

const log = (...a) => console.log('[cpp]', ...a)
const errl = (...a) => console.error('[cpp]', ...a)
const NOW = () => new Date().toISOString()

// Directories that never hold a GDExtension's own build entry, so descending
// into them only costs time (`godot-cpp` is the dependency checkout every
// extension has; `bin`/`obj`/`build` are outputs).
const SKIP_DIRS = new Set([
  '.git', '.godot', '.dsh-build', '.cache', 'node_modules', '.venv', 'venv',
  'dist', 'build', 'bin', 'obj', '__pycache__', 'godot-cpp',
])
// Extension layouts put the native directory a few levels below the project
// root (addons/<plugin>/platform/native is depth 4); deeper than this is not a
// layout this bridge can drive.
const MAX_BUILD_DIR_DEPTH = 6
// The plugin gives one check 120s (main) / 200s (baseline) before it retires
// the request; answering just inside that budget keeps the failure message
// ours ("build did not finish") instead of a bare clientd timeout.
const MAIN_TIMEOUT_MS = 110_000
const SWEEP_TIMEOUT_MS = 190_000

function parseArgs(argv) {
  const flags = {}
  const files = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
      if (eq > 0) flags[key] = a.slice(eq + 1)
      else flags[key] = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true
    } else files.push(a)
  }
  return { flags, files }
}

function relOf(project, abs) {
  return path.relative(project, abs).split(path.sep).join('/')
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  try { fs.renameSync(tmp, file) } catch {
    try { fs.unlinkSync(tmp) } catch { /* best effort */ }
    throw new Error(`cannot write ${file}`)
  }
}

// ---------- build discovery ----------
function gdextensionFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.gdextension'))
      .map((e) => path.join(dir, e.name))
  } catch { return [] }
}

/** The project's build entry inside `dir`, or undefined when there is none. */
function entryOf(dir) {
  for (const name of ['build.ps1', 'SConstruct']) {
    const file = path.join(dir, name)
    if (fs.existsSync(file)) return { kind: name === 'build.ps1' ? 'ps1' : 'scons', file }
  }
  return undefined
}

/**
 * API version the extension declares, for the bare-scons path (godot-cpp takes
 * it from `SConscript(..., {api_version})`; the environment variable is the way
 * to override it from outside the project).
 * @param {string[]} gdexts .gdextension files of the build dir
 * @returns {string|undefined}
 */
function apiVersionOf(gdexts) {
  for (const file of gdexts) {
    try {
      const m = /compatibility_minimum\s*=\s*"([^"]+)"/.exec(fs.readFileSync(file, 'utf8'))
      if (m) return m[1]
    } catch { /* unreadable: fall back to the project default */ }
  }
  return undefined
}

/**
 * True when `child` is `root` or sits below it (case-insensitive: Windows paths
 * are).
 */
function isUnder(root, child) {
  const r = path.resolve(root).toLowerCase()
  const c = path.resolve(child).toLowerCase()
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/**
 * Locate the directory that holds this project's GDExtension build. The files
 * a check was asked about decide first: their nearest ancestor carrying a build
 * entry owns them, so a project with two GDExtensions builds the right one
 * instead of reporting the other extension's files clean. Without usable
 * requested files the walk prefers a directory carrying a `.gdextension` next to
 * its build entry, then any build entry, so a project that keeps the
 * `.gdextension` elsewhere still builds.
 * @param {string} project project root
 * @param {object} flags parsed CLI flags (`--dir` overrides the walk)
 * @param {string[]} [requestedAbs] absolute files this check was asked about
 * @returns {{dir: string, kind: string, file: string, gdexts: string[], apiVersion?: string}}
 */
function findBuildDir(project, flags, requestedAbs = []) {
  if (flags.dir) {
    const dir = path.resolve(String(flags.dir))
    const entry = entryOf(dir)
    if (!entry) throw new Error(`--dir has no build.ps1 or SConstruct: ${dir}`)
    const gdexts = gdextensionFiles(dir)
    return { dir, ...entry, gdexts, apiVersion: apiVersionOf(gdexts) }
  }
  const root = path.resolve(project)
  for (const abs of requestedAbs) {
    let dir = path.dirname(path.resolve(abs))
    for (;;) {
      if (!isUnder(root, dir)) break
      const entry = entryOf(dir)
      if (entry) {
        const gdexts = gdextensionFiles(dir)
        return { dir, ...entry, gdexts, apiVersion: apiVersionOf(gdexts) }
      }
      if (dir === root) break
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  let fallback
  const walk = (dir, depth) => {
    const entry = entryOf(dir)
    if (entry) {
      const gdexts = gdextensionFiles(dir)
      const hit = { dir, ...entry, gdexts, apiVersion: apiVersionOf(gdexts) }
      if (gdexts.length) return hit
      if (!fallback) fallback = hit
    }
    if (depth >= MAX_BUILD_DIR_DEPTH) return undefined
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return undefined }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
      const hit = walk(path.join(dir, e.name), depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  const hit = walk(root, 0) || fallback
  if (!hit) {
    throw new Error(`no build.ps1/SConstruct within ${MAX_BUILD_DIR_DEPTH} levels of ${root} — is this a GDExtension project?`)
  }
  return hit
}

// ---------- build invocation ----------
function sconsPlatform() {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  return 'linux'
}

/**
 * Which toolchain last built this project, read from its own artifacts:
 * godot-cpp names its static library `libgodot-cpp…a` under MinGW and
 * `godot-cpp…lib` under MSVC, and an extension's import library follows suit.
 * Only toolchain-specific extensions count (`.a` = mingw, `.lib`/`.obj` = msvc);
 * `.o` and `.dll` are produced by both. The newest artifact wins, so a project
 * that switched toolchains is followed instead of being stuck on the old one.
 * @returns {'msvc'|'mingw'|undefined} undefined when there is nothing to go by
 */
function detectToolchain(hit, project) {
  const found = []
  const scan = (dir, exts) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isFile()) continue
      const ext = path.extname(e.name).toLowerCase()
      if (!exts.includes(ext)) continue
      try { found.push({ ext, at: fs.statSync(path.join(dir, e.name)).mtimeMs }) } catch { /* vanished */ }
    }
  }
  scan(path.join(hit.dir, 'bin'), ['.a', '.lib'])
  scan(path.join(hit.dir, 'src'), ['.obj', '.lib'])
  scan(path.join(path.resolve(project), 'godot-cpp', 'bin'), ['.a', '.lib'])
  const newest = found.sort((a, b) => b.at - a.at)[0]
  if (!newest) return undefined
  return newest.ext === '.a' ? 'mingw' : 'msvc'
}

/**
 * Toolchain for this check: `--toolchain` wins, otherwise the project's own
 * artifacts decide, otherwise the build entry's default (MSVC).
 * @param {{dir: string}} hit build directory
 * @param {string} project project root
 * @param {object} flags parsed CLI flags
 * @returns {'msvc'|'mingw'}
 */
function resolveToolchain(hit, project, flags) {
  if (flags.toolchain === true) throw new Error('--toolchain needs a value: auto, msvc or mingw')
  const want = typeof flags.toolchain === 'string' ? flags.toolchain.toLowerCase() : 'auto'
  if (want === 'msvc' || want === 'mingw') return want
  if (want !== 'auto') throw new Error(`--toolchain must be auto, msvc or mingw (got ${flags.toolchain})`)
  return detectToolchain(hit, project) || 'msvc'
}

/**
 * Environment for a build child. SCons is Python: with its stdout on a pipe it
 * encodes using the machine's ANSI code page, and a compiler message holding a
 * character that code page cannot represent aborts the report with
 * `UnicodeEncodeError` — which then reads as "the object failed" for reasons the
 * log never shows. UTF-8 for Python removes that whole class of noise.
 */
function buildEnv(extra) {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(extra || {}) }
}

/** One build command, as argv (never a shell string). */
function commandFor(hit, target, flags, toolchain) {
  if (hit.kind === 'ps1') {
    const psm = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
    // `-Target both|debug|release` is the script's own vocabulary; `-MinGW` is
    // its switch, so MinGW path discovery and the GCC workarounds stay in the
    // project. `-Command` (not `-File`) is what lets the console output encoding
    // be raised to UTF-8 first: Windows PowerShell 5.1 otherwise decodes the
    // child's output with the ANSI code page and mangles non-ASCII diagnostics.
    // The script path travels in the environment, so a directory name can never
    // be parsed as PowerShell code.
    const inner = [
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false',
      '$OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false',
      `& $env:DSH_CPP_BUILD_SCRIPT -Target ${flags.both ? 'both' : target}${toolchain === 'mingw' ? ' -MinGW' : ''}`,
      'exit $LASTEXITCODE',
    ].join('; ')
    return {
      exe: psm,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', inner],
      env: buildEnv({ DSH_CPP_BUILD_SCRIPT: hit.file }),
    }
  }
  const scons = process.platform === 'win32' ? 'py' : 'python3'
  const jobs = Math.max(1, os.cpus().length - 1)
  const env = buildEnv(hit.apiVersion ? { GODOT_API_VERSION: hit.apiVersion } : undefined)
  const args = ['-m', 'SCons', `platform=${sconsPlatform()}`, `target=template_${target}`, `-j${jobs}`]
  if (toolchain === 'mingw') args.push('use_mingw=yes')
  return { exe: scons, args, env }
}

/**
 * Stop a build and everything it started. On Windows killing the shell leaves
 * SCons and the compiler writing into the same build directory, so a follow-up
 * check would race the build that was supposed to be over.
 * @param {import('node:child_process').ChildProcess} child killed child
 */
function killTree(child) {
  if (!child || !child.pid) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* the process is already gone */ }
}

/**
 * Run one build command, capturing stdout and stderr together (both carry
 * diagnostics: MSVC writes them to stdout, the linker and PowerScript's `throw`
 * to stderr).
 * @returns {Promise<{code: number|undefined, out: string, timedOut: boolean, text: string}>}
 */
function runOnce(hit, target, timeoutMs, flags, toolchain, record) {
  const cmd = commandFor(hit, target, flags, toolchain)
  const text = `${path.basename(cmd.exe)} ${cmd.args.join(' ')}`
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd.exe, cmd.args, { cwd: hit.dir, windowsHide: true, env: cmd.env })
    } catch (error) {
      resolve({ code: undefined, out: `spawn failed: ${(error && error.message) || error}`, timedOut: false, text })
      return
    }
    // The build child outlives a killed checker, so the lock records it: a waiter
    // must see this build as still running even after our process is gone.
    if (record && child.pid) record(child.pid)
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    const onData = (d) => { out += d }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => { out += `\nspawn error: ${(error && error.message) || error}\n` })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, timedOut, text })
    })
  })
}

/**
 * A build directory may be reached by more than one checker process: the host
 * retries a one-shot `check` after a clientd timeout, and a second DSH instance
 * can check the same project. Two concurrent SCons runs in one directory fight
 * over the same object files and the same DLL, so every build takes a lock in
 * the plugin runtime dir (never in the project tree).
 */
const LOCK_DIR = () => path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'lsp-echo-runtime')
// A lock file that exists but cannot be parsed is a writer's half-finished
// create (the create is atomic, the write is not): treat it as held until it is
// older than this, so a waiter cannot steal it inside that window.
const LOCK_UNREADABLE_GRACE_MS = 5_000

function lockPath(hit) {
  const key = crypto.createHash('sha1').update(path.resolve(hit.dir).toLowerCase()).digest('hex').slice(0, 12)
  return path.join(LOCK_DIR(), `cpp-build-${key}.lock`)
}

/** True while `pid` exists (`EPERM` means it exists but is not ours). */
function pidAlive(pid) {
  if (!Number.isFinite(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
}

/**
 * A lock is stale only when nobody behind it can still be building. Killing the
 * checker does not kill the compiler it started (the manager kills the bridge,
 * not its build tree), so the record names both: while either the taker or the
 * build child is alive the lock is held, and the retry waits or reports instead
 * of starting a second SCons in the same directory. A record that cannot be read
 * is trusted for a grace window rather than stolen on sight.
 */
function lockIsStale(file, held) {
  if (!held) {
    try { return Date.now() - fs.statSync(file).mtimeMs > LOCK_UNREADABLE_GRACE_MS } catch { return true }
  }
  if (pidAlive(Number(held.pid))) return false
  if (held.childPid && pidAlive(Number(held.childPid))) return false
  return true
}

/**
 * Remove a stale lock. The rename is what makes it safe: exactly one waiter wins
 * it, and the winner verifies it really took the stale record (a fresh locker may
 * have replaced it between the read and the rename) before letting go of it.
 */
function takeOverStaleLock(file, held) {
  const taken = `${file}.stale-${process.pid}-${Date.now()}`
  try {
    fs.renameSync(file, taken)
  } catch {
    return // another waiter got there first
  }
  const content = readLock(taken)
  const same = !held || !content || (Number(content.pid) === Number(held.pid) && Number(content.at || 0) === Number(held.at || 0))
  if (same) {
    try { fs.unlinkSync(taken) } catch { /* best effort */ }
    log('taking over a stale build lock')
    return
  }
  // We raced a fresh locker: put its lock back (unless a third one already
  // created another file, in which case ours is the odd one out).
  try { fs.renameSync(taken, file) } catch { try { fs.unlinkSync(taken) } catch { /* best effort */ } }
}

/**
 * Wait for the build lock, then run `fn(record)`. `record(childPid)` is how the
 * build child becomes part of the lock (see lockIsStale). Waiting never exceeds
 * the caller's own budget: it fails with what is actually happening instead of
 * starting a second build or answering past its deadline.
 * Failure to *take* the lock is reported; a failure from `fn` propagates.
 * @param {{dir: string}} hit build directory
 * @param {number} budgetMs the caller's own time budget
 * @param {(record: (childPid: number) => void) => Promise<any>} fn the build
 * @returns {Promise<{ok: true, value: any} | {ok: false, error: string}>}
 */
async function withBuildLock(hit, budgetMs, fn) {
  const file = lockPath(hit)
  const deadline = Date.now() + Math.max(1_000, budgetMs)
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR(), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), dir: hit.dir }), { flag: 'wx' })
      break
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        return { ok: false, error: `cannot take the build lock ${file}: ${(error && error.message) || error}` }
      }
      const held = readLock(file)
      if (lockIsStale(file, held)) {
        takeOverStaleLock(file, held)
        continue
      }
      if (Date.now() + 1_000 >= deadline) {
        const who = held && held.childPid ? `pid ${held.pid}, build pid ${held.childPid}` : `pid ${held && held.pid}`
        return { ok: false, error: `another check is already building ${hit.dir} (${who}); try again when it finishes` }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  const record = (childPid) => {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, childPid, at: Date.now(), dir: hit.dir }))
    } catch { /* the lock keeps the taker pid, which still guards it */ }
  }
  try {
    return { ok: true, value: await fn(record) }
  } finally {
    try { fs.unlinkSync(file) } catch { /* already released */ }
  }
}

/**
 * Build the requested targets. A sweep builds debug and release (release-only
 * failures are real); the two share one time budget, and the whole run holds the
 * build-directory lock.
 */
async function runBuild(hit, sweep, flags, toolchain) {
  const budget = Number(flags['build-timeout-ms']) > 0
    ? Number(flags['build-timeout-ms'])
    : (sweep ? SWEEP_TIMEOUT_MS : MAIN_TIMEOUT_MS)
  const locked = await withBuildLock(hit, budget, async (record) => {
    const deadline = Date.now() + budget
    // build.ps1 takes `-Target both`; the bare SCons path runs twice.
    const targets = hit.kind === 'ps1' ? ['debug'] : (sweep ? ['debug', 'release'] : ['debug'])
    let out = ''
    const commands = []
    for (const target of targets) {
      const left = deadline - Date.now()
      if (left <= 1000) return { timedOut: true, out, commands, budgetMs: budget, timedOutOn: target }
      const r = await runOnce(hit, target, left, { both: sweep && hit.kind === 'ps1' }, toolchain, record)
      out += `${r.out}\n`
      commands.push(`${r.text} -> exit ${r.code}${r.timedOut ? ' (killed)' : ''}`)
      if (r.timedOut) return { timedOut: true, out, commands, budgetMs: budget, timedOutOn: target }
    }
    return { out, commands, budgetMs: budget }
  })
  if (!locked.ok) return { lockError: locked.error, out: '', commands: [], budgetMs: budget }
  return locked.value
}

// ---------- diagnostics parsing ----------
const SEV_NAME = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }
const SEV_OF = { 'fatal error': 1, error: 1, warning: 2, note: 3 }

// MSVC: `src\a.cpp(12): error C2065: 'x': undeclared identifier`
//       `src\a.cpp(12,5): error C2143: ...`
const MSVC_RE = /^\s*(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(fatal error|error|warning|note)\s*([A-Za-z]{1,4}\d+)?\s*:\s*(.*)$/
// gcc/clang: `src/a.cpp:12:5: error: 'x' was not declared in this scope`
const GNU_RE = /^\s*(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note)\s*:\s*(.*)$/
// Linker / build-system failures carry no source position: keep them attached to
// one synthetic entry so they can never read as "nothing to report".
const LINK_RE = /^\s*(.*?)\s*:\s*(fatal error|error)\s+(LNK\d+|LNK)\s*:\s*(.*)$/
const LINKY_RE = /(undefined reference to|ld returned \d+ exit status|unresolved external symbol|cannot open file|scons: \*\*\*)/i
const LINK_KEY = '<link>'

/**
 * Map one reported file path to the payload key. Paths the compiler prints are
 * relative to the build directory (SCons runs the tool there); a path outside
 * the project keeps its `../`-relative form rather than being dropped — an
 * error in a header the project uses is still an error the user must see.
 */
function keyFor(raw, project, buildDir) {
  const cleaned = raw.trim().replace(/^["']|["']$/g, '')
  if (!cleaned || /^(LINK|cl|cl\.exe|ld|collect2|scons)$/i.test(cleaned)) return LINK_KEY
  let abs = path.resolve(buildDir, cleaned)
  if (!fs.existsSync(abs)) {
    const alt = path.resolve(project, cleaned)
    if (fs.existsSync(alt)) abs = alt
  }
  return relOf(project, abs)
}

/**
 * Parse compiler/linker output into `key -> diagnostics`.
 * @param {string} text combined stdout+stderr of the build
 * @param {string} project project root (payload keys are relative to it)
 * @param {string} buildDir directory the build ran in (relative paths resolve here)
 * @returns {Map<string, object[]>}
 */
function parseDiagnostics(text, project, buildDir) {
  const byKey = new Map()
  const push = (key, diag) => {
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(diag)
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let m = MSVC_RE.exec(line)
    if (m && !/^\s*(LINK|scons)\b/i.test(m[1])) {
      const sev = SEV_OF[m[4]] || 3
      const key = keyFor(m[1], project, buildDir)
      push(key, {
        severity: sev, severityName: SEV_NAME[sev], message: m[6].trim(),
        source: 'msvc', code: m[5] || undefined, line: Number(m[2]),
        column: m[3] ? Number(m[3]) : undefined, file: key,
      })
      continue
    }
    m = GNU_RE.exec(line)
    if (m && !/^\s*(LINK|scons|collect2)\b/i.test(m[1])) {
      const sev = SEV_OF[m[4]] || 3
      const key = keyFor(m[1], project, buildDir)
      push(key, {
        severity: sev, severityName: SEV_NAME[sev], message: m[5].trim(),
        source: 'gcc', code: undefined, line: Number(m[2]),
        column: m[3] ? Number(m[3]) : undefined, file: key,
      })
      continue
    }
    m = LINK_RE.exec(line)
    if (m) {
      const sev = SEV_OF[m[2]] || 1
      push(LINK_KEY, {
        severity: sev, severityName: SEV_NAME[sev], message: `${m[3]}: ${m[4]}`.trim(),
        source: 'link', code: m[3], line: 0, column: 0, file: LINK_KEY,
      })
      continue
    }
    if (LINKY_RE.test(line)) {
      push(LINK_KEY, {
        severity: 1, severityName: 'error', message: line.trim(),
        source: /scons: \*\*\*/.test(line) ? 'scons' : 'link',
        code: undefined, line: 0, column: 0, file: LINK_KEY,
      })
    }
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => (a.line || 0) - (b.line || 0) || (a.column || 0) - (b.column || 0))
  }
  return byKey
}

/**
 * Payload for one check: every requested file appears (clean files with an
 * empty list, so the caller can count what it asked for), plus everything the
 * build reported.
 */
function payloadFor(project, requestedAbs, byKey, hit) {
  const files = {}
  const now = NOW()
  const blank = () => ({ checked_at: now, diagnostics: [], errors: 0, warnings: 0 })
  for (const abs of requestedAbs) {
    if (!fs.existsSync(abs)) continue
    const key = relOf(project, abs)
    if (!files[key]) files[key] = blank()
  }
  for (const [key, list] of byKey) {
    if (!files[key]) files[key] = blank()
    for (const d of list) files[key].diagnostics.push(d)
  }
  let errors = 0
  let warnings = 0
  for (const key of Object.keys(files)) {
    const rec = files[key]
    rec.errors = rec.diagnostics.filter((d) => d.severity === 1).length
    rec.warnings = rec.diagnostics.filter((d) => d.severity === 2).length
    errors += rec.errors
    warnings += rec.warnings
  }
  return {
    tool: 'cpp-gdextension',
    version: 1,
    project,
    server: hit.kind === 'ps1' ? 'build.ps1' : 'scons',
    updated_at: now,
    files,
    // Link/build failures land under a key with no extension; the host replaces
    // exactly these keys on the next write and lets no other engine evict them.
    syntheticKeys: [LINK_KEY],
    summary: {
      // The synthetic bucket is not a checked file, and it is not a file with
      // errors either: its errors are counted, but no caller may see it as an
      // extra entry in the file totals.
      files_checked: Object.keys(files).filter((k) => k !== LINK_KEY).length,
      errors,
      warnings,
      files_with_errors: Object.keys(files).filter((k) => k !== LINK_KEY && files[k].errors > 0),
    },
  }
}

/**
 * One check: build the project, parse what the toolchain said.
 * A failure to check is reported as such (`ok: false`) and never as a clean
 * result — a build that could not run has not verified anything.
 * @returns {Promise<{ok: true, payload: object} | {ok: false, error: string, out?: string}>}
 */
async function checkOnce(project, requestedAbs, sweep, flags) {
  let hit
  try {
    hit = findBuildDir(project, flags, requestedAbs)
  } catch (error) {
    return { ok: false, error: (error && error.message) || String(error) }
  }
  let toolchain
  try {
    toolchain = resolveToolchain(hit, project, flags)
  } catch (error) {
    return { ok: false, error: (error && error.message) || String(error) }
  }
  const built = await runBuild(hit, sweep, flags, toolchain)
  if (built.lockError) return { ok: false, error: built.lockError }
  if (built.timedOut) {
    const secs = (built.budgetMs / 1000).toFixed(1)
    return {
      ok: false, out: built.out,
      error: `build did not finish within ${secs}s (${built.timedOutOn} target); run it manually to see the full log`,
    }
  }
  const byKey = parseDiagnostics(built.out, project, hit.dir)
  const parsedErrors = [...byKey.values()].reduce((n, l) => n + l.filter((d) => d.severity === 1).length, 0)
  const exitBad = built.commands.some((c) => /-> exit (?!0\b)/.test(c))
  if (exitBad && !parsedErrors) {
    // The build failed for a reason the parser cannot attribute to a file
    // (missing toolchain, a locked output, a build-script error): say so
    // instead of reporting a clean project.
    const tail = built.out.trim().split(/\r?\n/).slice(-6).join('\n')
    return { ok: false, out: built.out, error: `build failed without a source diagnostic:\n${tail}` }
  }
  // Only files this build actually covers may be stamped as checked: claiming
  // "0 errors" for a file that lives under a different GDExtension (or outside
  // the build directory) would be a clean result nothing verified.
  const covered = requestedAbs.filter((abs) => isUnder(hit.dir, abs))
  const payload = payloadFor(project, covered, byKey, hit)
  payload.build = { dir: hit.dir, entry: path.basename(hit.file), toolchain, commands: built.commands }
  const skipped = requestedAbs.length - covered.length
  if (skipped) {
    payload.engine_note = `${skipped} requested file(s) are outside ${hit.dir} and were not compiled by this check`
  }
  return { ok: true, payload }
}

// ---------- commands ----------
async function cmdCheck(project, files, outPath, sweep, flags) {
  const absFiles = files.map((f) => path.resolve(project, f))
  const r = await checkOnce(project, absFiles, sweep, flags)
  if (!r.ok) {
    errl(r.error)
    if (outPath) { try { fs.unlinkSync(path.resolve(outPath)) } catch { /* never written */ } }
    return 2
  }
  if (outPath) atomicWriteJson(path.resolve(outPath), r.payload)
  const s = r.payload.summary
  // The build commands belong in the log: the trace is where a user finds out
  // which target and which entry the check actually used.
  for (const c of (r.payload.build && r.payload.build.commands) || []) log(c)
  log(`checked ${s.files_checked} file(s): ${s.errors} error(s), ${s.warnings} warning(s)`)
  for (const rel of Object.keys(r.payload.files)) {
    for (const d of r.payload.files[rel].diagnostics) {
      if (d.severity === 1 || d.severity === 2) console.log(`  ${rel}:${d.line}:${d.column || 0}: [${d.severityName}] ${d.message}`)
    }
  }
  if (outPath) console.log(`json: ${path.resolve(outPath)}`)
  return s.errors > 0 ? 1 : 0
}

function cmdClientd(project, flags) {
  const reply = (id, obj) => {
    try { process.stdout.write(JSON.stringify({ id, ...obj }) + '\n') } catch { /* closed */ }
  }
  // One build at a time per project: two concurrent SCons runs in one build
  // directory fight over the same object files and DLLs.
  const queue = []
  let draining = false
  const drain = async () => {
    if (draining) return
    draining = true
    while (queue.length) {
      const { id, files, sweep } = queue.shift()
      try {
        const r = await checkOnce(project, (files || []).map((f) => path.resolve(project, f)), !!sweep, flags)
        if (r.ok) reply(id, { ok: true, payload: r.payload })
        else reply(id, { ok: false, error: r.error })
      } catch (error) {
        reply(id, { ok: false, error: (error && error.message) || String(error) })
      }
    }
    draining = false
  }
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      let req
      try { req = JSON.parse(line) } catch { continue }
      queue.push({ id: req && req.id, files: req.files, sweep: req.sweep })
      void drain()
    }
  })
  const bye = () => process.exit(0)
  process.stdin.on('end', bye)
  process.on('SIGTERM', bye)
}

/** Resolve the build for `host`/`status` without building anything. */
function describe(project, flags) {
  const hit = findBuildDir(project, flags)
  const toolchain = resolveToolchain(hit, project, flags)
  const target = (file) => {
    try { return `${Math.round(fs.statSync(file).size / 1024)}KB ${fs.statSync(file).mtime.toISOString()}` } catch { return 'missing' }
  }
  const binaries = new Map()
  try {
    for (const name of fs.readdirSync(path.join(hit.dir, 'bin'))) binaries.set(name, target(path.join(hit.dir, 'bin', name)))
  } catch { /* no bin/ yet: a project that has never been built */ }
  const artifacts = [...binaries].map(([name, info]) => `${name} (${info})`)
  return { hit, artifacts, toolchain }
}

const USAGE = `cpp-gdextension.mjs — C++ compile diagnostics for a Godot GDExtension

  node cpp-gdextension.mjs check <file...> --project <dir> [--sweep] [--out <json>]
  node cpp-gdextension.mjs clientd --project <dir>   (persistent JSON-lines client)
  node cpp-gdextension.mjs host|status|stop [--project <dir>]

The project's own build is the checker: <build dir>/build.ps1 when present,
otherwise \`py -m SCons platform=<os> target=template_<debug|release>\`.
--sweep builds the release target too; a plain check builds debug only.
--dir <dir> pins the build directory (default: the changed files decide, else a
walk); --toolchain auto|msvc|mingw overrides the toolchain detected from the
project's artifacts; --build-timeout-ms <n> overrides the 110s/190s budget.
exit codes: 0 = no errors, 1 = errors found, 2 = failure to check
`

async function main() {
  const argv = process.argv.slice(2)
  if (!argv.length || argv[0] === 'help' || argv[0] === '--help') { console.log(USAGE); return }
  const cmd = argv[0]
  const { flags, files } = parseArgs(argv.slice(1))
  const project = flags.project ? path.resolve(String(flags.project)) : process.cwd()
  if (cmd === 'host' || cmd === 'status' || cmd === 'stop') {
    // No persistent process: every check runs the project's build itself.
    if (cmd === 'stop') { log('nothing to stop (no persistent cpp host)'); return }
    const { hit, artifacts, toolchain } = describe(project, flags)
    if (cmd === 'status') {
      log(`${hit.kind === 'ps1' ? 'build.ps1' : 'SConstruct'}: ${hit.file}`)
      log(`build dir: ${hit.dir}`)
      log(`toolchain: ${toolchain}${detectToolchain(hit, project) ? ' (detected from this project\'s artifacts)' : ' (nothing built yet; pass --toolchain to override)'}`)
      for (const a of artifacts) log(`artifact: ${a}`)
      console.log(`running (cpp-gdextension, ${hit.kind === 'ps1' ? 'build.ps1' : 'scons'} builds per check)`)
      return
    }
    log(`build ok: ${hit.file} (${toolchain}; no persistent host, each check runs the build)`)
    return
  }
  if (cmd === 'check') {
    if (!files.length) throw new Error('usage: cpp-gdextension.mjs check <file...> --project <dir> [--sweep] [--out <json>]')
    const outPath = flags.out ? String(flags.out) : undefined
    process.exitCode = await cmdCheck(project, files, outPath, flags.sweep === true || flags.sweep === '1', flags)
    return
  }
  if (cmd === 'clientd') {
    log(`clientd ready for project ${project}`)
    cmdClientd(project, flags)
    return
  }
  throw new Error(`unknown command ${cmd}`)
}

main().catch((e) => { errl((e && e.message) || e); process.exit(2) })
