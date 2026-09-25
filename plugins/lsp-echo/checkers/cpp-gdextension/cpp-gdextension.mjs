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
import { spawn, spawnSync } from 'node:child_process'

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
// One file, one compiler run, no build: a minute is already far past the point
// where the stage is useful, and the plugin's step budget is shorter than this.
const SYNTAX_TIMEOUT_MS = 60_000
// Which stage answers a check. `auto` prefers the syntax stage and falls back to
// the build when this project's toolchain cannot be driven without its
// environment (MSVC without vcvars64.bat), because a stage that cannot run must
// not turn into a clean answer.
const STAGES = new Set(['auto', 'syntax', 'build'])

// Flags that take no value. Without this list a valueless flag swallows the next
// argument, so `check --no-wait src/a.cpp` would both lose that file and stop
// being a boolean (`flags['no-wait']` would be the path, never `true`).
const BOOLEAN_FLAGS = new Set(['sweep', 'both', 'no-wait', 'kill-on-timeout', 'print-flags'])
// Flags that require a value. A valueless `--project` would otherwise become the
// literal `true`, and `--build-timeout-ms` would become `Number(true) === 1`, a
// one-millisecond budget that reports a timeout without ever building.
const VALUE_FLAGS = new Set(['project', 'out', 'dir', 'toolchain', 'build-timeout-ms', 'stage', 'flags'])

function parseArgs(argv) {
  const flags = {}
  const files = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
      if (eq > 0) flags[key] = a.slice(eq + 1)
      else if (BOOLEAN_FLAGS.has(key)) flags[key] = true
      else if (VALUE_FLAGS.has(key)) {
        const value = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : undefined
        if (value === undefined) throw new Error(`--${key} needs a value`)
        flags[key] = value
      } else flags[key] = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true
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
 * instead of reporting the other extension's files clean. An entry whose
 * directory has no `.gdextension` is not an extension build — that is what a
 * vendored dependency checkout (`godot-cpp/SConstruct`) looks like, and building
 * it fails on `api_version` while compiling someone else's sources — so the walk
 * keeps going and prefers the extension directory above it. Without a usable hit
 * the project-wide walk decides: a directory carrying a `.gdextension` next to
 * its build entry first, then any build entry.
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
  let nearest
  for (const abs of requestedAbs) {
    let dir = path.dirname(path.resolve(abs))
    for (;;) {
      if (!isUnder(root, dir)) break
      const entry = entryOf(dir)
      if (entry) {
        const gdexts = gdextensionFiles(dir)
        // The extension's own build directory (it ships the .gdextension).
        if (gdexts.length) return { dir, ...entry, gdexts, apiVersion: apiVersionOf(gdexts) }
        if (!nearest) nearest = { dir, ...entry, gdexts, apiVersion: undefined }
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
  const hit = walk(root, 0) || nearest || fallback
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
 * check would race the build that was supposed to be over. A kill that fails is
 * followed by the direct one: leaving the tree alive would keep the lock held
 * (its pid is recorded) and stall the next check.
 * @param {import('node:child_process').ChildProcess} child killed child
 */
function killTree(child) {
  if (!child || !child.pid) return
  try {
    if (process.platform === 'win32') {
      const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      if (killed && killed.status === 0) return
    } else {
      // The child leads its own process group (see runOnce), so the group kill
      // reaches the compilers it started.
      try { process.kill(-child.pid, 'SIGKILL'); return } catch { /* not a group leader */ }
    }
  } catch { /* taskkill missing or already gone */ }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

/**
 * Run one build command, capturing stdout and stderr together (both carry
 * diagnostics: MSVC writes them to stdout, the linker and PowerScript's `throw`
 * to stderr).
 * @returns {Promise<{code: number|undefined, out: string, timedOut: boolean, text: string}>}
 */
function runOnce(hit, target, timeoutMs, flags, toolchain, lock) {
  const cmd = commandFor(hit, target, flags, toolchain)
  const text = `${path.basename(cmd.exe)} ${cmd.args.join(' ')}`
  return new Promise((resolve) => {
    let child
    try {
      // A process group of its own on POSIX, so a timed-out build takes its
      // compilers with it (killTree); Windows keeps taskkill /T for that.
      child = spawn(cmd.exe, cmd.args, { cwd: hit.dir, windowsHide: true, env: cmd.env, detached: process.platform !== 'win32' })
    } catch (error) {
      resolve({ code: undefined, out: `spawn failed: ${(error && error.message) || error}`, timedOut: false, text })
      return
    }
    // The build child outlives a killed checker, so the lock records it: a waiter
    // must see this build as still running even after our process is gone.
    if (lock && lock.record && child.pid) lock.record(child.pid)
    let out = ''
    let timedOut = false
    let grace
    const timer = setTimeout(() => {
      timedOut = true
      if (flags.killOnTimeout) {
        killTree(child)
        // A killed tree normally closes its stdio. A grandchild that keeps the pipe
        // open would stall that forever, and the answer matters more than the log.
        // The lock then stays behind as an orphan record: the build we failed to
        // kill is still writing here, so the next check must wait, not race it.
        grace = setTimeout(() => {
          if (lock && lock.orphan && child.pid) lock.orphan(child.pid)
          resolve({ code: undefined, out, timedOut: true, text })
        }, 5_000)
        if (typeof grace.unref === 'function') grace.unref()
        return
      }
      // Killing a build throws away the work SCons already did and leaves its
      // signature database half written, so the next check rebuilds more than this
      // one did. A check that ran out of budget therefore leaves the build running,
      // hands the lock to it and answers now: the next check waits for that build
      // and finds the work already done.
      if (lock && lock.orphan && child.pid) lock.orphan(child.pid)
      // The build outlives this verdict, and its pipes would keep this process
      // alive after it: detach them so a one-shot check exits on budget instead of
      // waiting for the build (the verdict is already decided; the log is not).
      for (const stream of [child.stdout, child.stderr]) {
        try {
          stream.removeListener('data', onData)
          if (typeof stream.unref === 'function') stream.unref()
        } catch { /* already closed */ }
      }
      try { child.unref() } catch { /* gone */ }
      resolve({ code: undefined, out, timedOut: true, text })
    }, timeoutMs)
    const onData = (d) => { out += d }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => { out += `\nspawn error: ${(error && error.message) || error}\n` })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
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
// Longer than any budget a caller can set through the plugin (seconds to a few
// minutes): reaching it means the record outlived its build, so a recycled pid
// cannot wedge the directory forever.
const LOCK_MAX_AGE_MS = 24 * 60 * 60_000
// A wait that leaves less than this is not worth starting a build for: the build
// would be killed mid-way, which is the work the lock exists to prevent. Kept
// small: a build that gets a short window still answers its own verdict inside
// the budget, so refusing costs a result that may well have succeeded.
const MIN_BUILD_MS = 3_000

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
  // Self-healing against a recycled pid: no real build can hold a lock this long
  // (every budget is under four minutes), so an ancient record is a leftover.
  if (Date.now() - Number(held.at || 0) > LOCK_MAX_AGE_MS) return true
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
  // created another file, in which case ours is the odd one out). `wx` cannot
  // replace an existing lock and, unlike a hard link, works on every filesystem.
  try {
    if (content) fs.writeFileSync(file, JSON.stringify(content), { flag: 'wx' })
    fs.unlinkSync(taken)
  } catch {
    try { fs.unlinkSync(taken) } catch { /* best effort */ }
  }
}

/**
 * Wait for the build lock, then run `fn(lock, window)`. `lock.record(childPid)`
 * is how the build child becomes part of the lock (see lockIsStale), `lock.orphan`
 * keeps the lock behind when the build could not be killed, and `window` is what
 * is left of the caller's single budget — waiting and building share one deadline
 * instead of taking one each. A wait that would leave too little of the budget to
 * build refuses instead of starting a build it must kill.
 * Failure to *take* the lock is reported; a failure from `fn` propagates.
 * @param {{dir: string}} hit build directory
 * @param {number} budgetMs the caller's own time budget
 * @param {{noWait?: boolean}} opts `noWait`: report a held lock at once instead of waiting it out
 * @param {(lock: {record: (childPid: number) => void, orphan: (childPid: number) => void}, window: {leftMs: number, waitedMs: number}) => Promise<any>} fn the build
 * @returns {Promise<{ok: true, value: any} | {ok: false, error: string}>}
 */
async function withBuildLock(hit, budgetMs, opts, fn) {
  const file = lockPath(hit)
  const startedAt = Date.now()
  const deadline = startedAt + Math.max(1_000, budgetMs)
  const refuse = (held, left) => {
    const who = !held
      ? 'an unknown holder'
      : held.childPid
        ? (held.pid ? `pid ${held.pid}, build pid ${held.childPid}` : `build pid ${held.childPid} (orphan)`)
        : `pid ${held.pid}`
    const why = opts && opts.noWait
      ? 'this check does not wait for another build'
      : left > 0 ? `this check has ${(left / 1000).toFixed(0)}s of its budget left, too little to build` : 'this check ran out of its budget waiting'
    return { ok: false, error: `another check is already building ${hit.dir} (${who}); ${why} (lock: ${file})` }
  }
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
      const left = deadline - Date.now()
      if (opts && opts.noWait) return refuse(held, left)
      if (left <= MIN_BUILD_MS) return refuse(held, left)
      await new Promise((r) => setTimeout(r, Math.min(500, left)))
    }
  }
  let kept = false
  /**
   * Rewrite the lock we hold. Ownership is re-read first: a process whose lock was
   * taken over (the user deleted the file, a >24 h suspend) must not stamp its
   * record over the new owner's. The record goes through a temp file because a
   * reader that catches a half-written record treats it as held for 5 s.
   */
  const writeLock = (data) => {
    const cur = readLock(file)
    if (cur && Number(cur.pid) !== process.pid) return false
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(data))
      fs.renameSync(tmp, file)
      return true
    } catch {
      try { fs.unlinkSync(tmp) } catch { /* never created */ }
      return false
    }
  }
  const lock = {
    record: (childPid) => {
      // A failed write means the lock is no longer ours: nothing left to guard with.
      writeLock({ pid: process.pid, childPid, at: Date.now(), dir: hit.dir })
    },
    /**
     * A build we could not kill (or chose not to kill) is still writing into this
     * directory. Leave the record naming only that child (no taker pid, which is
     * this live process) so the next check waits for it instead of starting a
     * second build beside it.
     */
    orphan: (childPid) => {
      if (writeLock({ childPid, at: Date.now(), dir: hit.dir })) {
        kept = true
        lock.orphaned = true
        lock.orphanPid = childPid
      }
    },
    /** True once a build survived its budget or its kill and the lock was left for it. */
    orphaned: false,
    /** Pid of that build, for messages that must name the process still running. */
    orphanPid: undefined,
    /** The lock file, for messages that must name what to clear. */
    file,
  }
  try {
    const leftMs = Math.max(1_000, deadline - Date.now())
    return { ok: true, value: await fn(lock, { leftMs, waitedMs: Date.now() - startedAt }) }
  } finally {
    if (!kept) {
      // Only our own lock: a takeover may have replaced it while we built.
      const cur = readLock(file)
      if (!cur || Number(cur.pid) === process.pid) {
        try { fs.unlinkSync(file) } catch { /* already released */ }
      }
    }
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
  const locked = await withBuildLock(hit, budget, { noWait: flags['no-wait'] === true }, async (lock, window) => {
    // One budget for the whole call: the wait above already spent part of it.
    const deadline = Date.now() + window.leftMs
    const outcome = (extra) => ({
      ...extra,
      budgetMs: window.leftMs,
      waitedMs: window.waitedMs,
      orphaned: lock.orphaned,
      orphanPid: lock.orphanPid,
      lockFile: lock.file,
    })
    // build.ps1 takes `-Target both`; the bare SCons path runs twice.
    const targets = hit.kind === 'ps1' ? ['debug'] : (sweep ? ['debug', 'release'] : ['debug'])
    let out = ''
    const commands = []
    for (const target of targets) {
      const left = deadline - Date.now()
      if (left <= 1000) return outcome({ timedOut: true, out, commands, timedOutOn: target })
      const r = await runOnce(hit, target, left, {
        both: sweep && hit.kind === 'ps1',
        killOnTimeout: flags['kill-on-timeout'] === true,
      }, toolchain, lock)
      out += `${r.out}\n`
      commands.push(`${r.text} -> exit ${r.code}${r.timedOut ? ' (killed)' : ''}`)
      if (r.timedOut) return outcome({ timedOut: true, out, commands, timedOutOn: target })
    }
    return outcome({ out, commands })
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

// ---------- syntax stage: the project's own compiler, no build ----------
// The build is the only authority on link errors, but paying SCons's floor (and
// occasionally a full godot-cpp recompile) to answer "does this file still
// compile?" is what made a one-line edit cost minutes. `-fsyntax-only` with the
// project's own compiler, flags and working directory answers that question in
// about a second and cannot disagree with the build the way a second compiler
// can. It writes nothing into the build directory and takes no lock.

/** Stable key for runtime files that belong to a project but not to its tree. */
function projectKey(project) {
  return crypto.createHash('sha1').update(path.resolve(project).toLowerCase()).digest('hex').slice(0, 12)
}

/**
 * godot-cpp checkout this project builds against: `GODOT_CPP_DIR` when the
 * project uses it, otherwise a `godot-cpp` directory holding an `SConstruct` at
 * or above the build directory (never above the project root).
 * @returns {string|undefined}
 */
function godotCppRoot(project, hit) {
  if (process.env.GODOT_CPP_DIR) {
    const dir = path.resolve(process.env.GODOT_CPP_DIR)
    if (fs.existsSync(path.join(dir, 'SConstruct'))) return dir
  }
  const root = path.resolve(project)
  let dir = path.resolve(hit.dir)
  for (;;) {
    const candidate = path.join(dir, 'godot-cpp')
    if (fs.existsSync(path.join(candidate, 'SConstruct'))) return candidate
    if (dir === root || !isUnder(root, dir)) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Directory literals a project's build script pins (a MinGW root, a Visual Studio
 * tools directory). The script is the project's own statement of where its
 * toolchain lives, which is what a syntax check has to use: a project whose
 * compiler exists only on the script's own PATH cannot be driven by whatever
 * `g++` the harness environment happens to carry.
 * @param {{dir: string, file: string}} hit build directory
 * @returns {string[]}
 */
function binsFromBuildScript(hit) {
  const out = []
  const files = [hit.file, path.join(hit.dir, 'build.ps1'), path.join(hit.dir, 'build.sh'), path.join(hit.dir, 'CMakeLists.txt')]
  for (const file of files) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const m of text.matchAll(/["']([A-Za-z]:[\\/][^"'\r\n]{2,})["']/g)) {
      const raw = m[1].replace(/\\\\/g, '\\')
      const dir = /\.(exe|bat|cmd)$/i.test(raw) ? path.dirname(raw) : raw
      if (/bin$/i.test(dir) || /(mingw|llvm|msvc|visual studio|tools)/i.test(dir)) out.push(dir)
    }
  }
  return [...new Set(out)]
}

/**
 * The C++ compiler this project builds with, or undefined. Order: an explicit
 * choice (`CXX`, then `MINGW_BIN`), what the project's own build script names,
 * then PATH — a compiler named by the build script wins over PATH because that is
 * the one the build will use.
 * @returns {string|undefined} absolute path
 */
function findCompiler(hit, toolchain) {
  const exe = toolchain === 'msvc' ? 'cl.exe' : (process.platform === 'win32' ? 'g++.exe' : 'g++')
  const candidates = []
  // `CXX` and `MINGW_BIN` are explicit choices for the Visual-Studio-less
  // toolchain. They must not satisfy an MSVC lookup: the flags would then be
  // MSVC's while the compiler is MinGW's, and every report built from that pair
  // is junk.
  if (process.env.CXX && compilerFamily(process.env.CXX) === toolchain) {
    candidates.push(process.env.CXX)
  }
  if (process.env.MINGW_BIN && toolchain !== 'msvc') candidates.push(path.join(process.env.MINGW_BIN, exe))
  for (const dir of binsFromBuildScript(hit)) candidates.push(path.join(dir, exe))
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe))
  }
  for (const file of candidates) {
    try { if (file && fs.statSync(file).isFile()) return path.resolve(file) } catch { /* keep looking */ }
  }
  return undefined
}

/**
 * The compiler the syntax stage would run, and the toolchain whose flags it must
 * use. The project's own toolchain wins: `cl` through vcvars before a MinGW
 * compiler the project does not build with, and only when neither can run here does
 * the machine's other compiler beat no check at all. Compiler and flags always come
 * from one toolchain, or every report built from them is junk.
 * @returns {{compiler: string|undefined, effective: string}} compiler path (or the
 *          bare `cl.exe` vcvars is expected to provide) and the flag toolchain
 */
function syntaxCompiler(hit, toolchain) {
  const compiler = findCompiler(hit, toolchain)
  if (compiler || toolchain !== 'msvc') return { compiler, effective: toolchain }
  // No `cl` path was found, but the project's own build environment may still
  // provide one: that beats a MinGW compiler this project does not build with, and
  // only when neither exists is another compiler a better answer than no check.
  if (vcvarsPath()) return { compiler: 'cl.exe', effective: 'msvc' }
  const gcc = findCompiler(hit, 'mingw')
  if (gcc) {
    log(`no cl and no vcvars64.bat: the syntax stage uses ${gcc} with MinGW flags`)
    return { compiler: gcc, effective: 'mingw' }
  }
  return { compiler: undefined, effective: toolchain }
}

/**
 * `vcvars64.bat` for this machine, or undefined. MSVC cannot compile anything
 * without the environment it sets, and that environment cannot be guessed from
 * the outside.
 * @returns {string|undefined}
 */
function vcvarsPath() {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const roots = [
    process.env.VCINSTALLDIR,
    process.env.VSINSTALLDIR,
    path.join(pf86, 'Microsoft Visual Studio', '2022', 'BuildTools'),
    path.join(pf86, 'Microsoft Visual Studio', '2022', 'Community'),
    path.join(pf, 'Microsoft Visual Studio', '2022', 'Community'),
    path.join(pf86, 'Microsoft Visual Studio', '2019', 'BuildTools'),
  ]
  for (const root of roots) {
    if (!root) continue
    const file = path.join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
    try { if (fs.statSync(file).isFile()) return file } catch { /* next root */ }
  }
  return undefined
}

/** Split a compile command line into argv, honouring quotes (paths have spaces). */
function splitCommandLine(text) {
  const out = []
  let cur = ''
  let quote = ''
  for (const c of String(text)) {
    if (quote) {
      if (c === quote) quote = ''
      else cur += c
    } else if (c === '"' || c === "'") quote = c
    else if (/\s/.test(c)) { if (cur) { out.push(cur); cur = '' } }
    else cur += c
  }
  if (cur) out.push(cur)
  return out
}

/**
 * Which flag dialect a compiler speaks, from its own name. What a command line
 * means depends on this, and the compiler that will run is the fact — the
 * toolchain label inferred from build artifacts is a guess that a project which
 * has never been built cannot confirm.
 * @param {string} compiler compiler path or bare name
 * @returns {'msvc'|'mingw'}
 */
function compilerFamily(compiler) {
  return /(^|[\\/])cl(\.exe)?$/i.test(String(compiler || '')) ? 'msvc' : 'mingw'
}

/**
 * Flags of one command line that describe the translation unit (dialect,
 * includes, defines, warnings), with outputs, dependency files and link inputs
 * removed: they belong to one build invocation, not to the file. `-o x.o` in a
 * syntax-only run would make the compiler write into the build directory, which
 * this stage must never do.
 * @returns {string[]|undefined} undefined when the line compiles no such source
 */
function compileArgsOf(argv, sourceAbs, family) {
  const source = path.basename(sourceAbs).toLowerCase()
  const out = []
  let sawSource = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (path.basename(a).toLowerCase() === source) { sawSource = true; continue }
    if (family === 'msvc') {
      if (/^\/c$/i.test(a)) continue
      const outFlag = /^\/(Fo|Fd|Fp|Fa|Fe)(.*)$/i.exec(a)
      if (outFlag) {
        // `/Fo:path`, `/Fopath` and `/Fo path` all exist. Only the spaced form takes
        // the next argument, and never a source file: that is the file being
        // compiled, not an output path, and eating it would silently drop the entry.
        if (!outFlag[2] && !/\.(cpp|cc|cxx)$/i.test(argv[i + 1] || '')) i += 1
        continue
      }
      if (/^\/link$/i.test(a)) break // everything after /link is the linker's
      out.push(a) // /I, /D, /std:, /utf-8, /EHsc, /W4 … all mean the same to /Zs
      continue
    }
    if (a === '-c') continue
    if (a === '-o' || a === '-MF' || a === '-MT' || a === '-MQ' || a === '-x') { i += 1; continue }
    if (/^-(MD|MMD|MP|MM|M)$/.test(a)) continue
    if (/^-Wl,/.test(a) || /^-l/.test(a) || /^-L/.test(a) || a === '-shared' || /^-static/.test(a)) continue
    out.push(a)
  }
  return sawSource ? out : undefined
}

/**
 * Compiler arguments for one file from a `compile_commands.json` entry — the
 * authoritative source when a project (or SCons's `compilation_db` tool)
 * publishes one.
 * @returns {{args: string[], toolchain: 'msvc'|'mingw'}|undefined}
 */
function flagsFromCompileCommands(file, sourceAbs) {
  let db
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
  if (!Array.isArray(db)) return undefined
  const want = path.resolve(sourceAbs).toLowerCase()
  const base = path.basename(sourceAbs).toLowerCase()
  // A shared database may name the same basename from another directory: that entry
  // describes a different file, so only the same directory qualifies as a match.
  const entry = db.find((e) => e && typeof e.file === 'string' && path.resolve(e.file).toLowerCase() === want)
    || db.find((e) => e && typeof e.file === 'string'
      && path.basename(e.file).toLowerCase() === base
      && path.dirname(path.resolve(e.file)).toLowerCase() === path.dirname(want))
  if (!entry) return undefined
  const argv = Array.isArray(entry.arguments) && entry.arguments.length
    ? entry.arguments.slice()
    : splitCommandLine(entry.command || '')
  if (!argv.length) return undefined
  const toolchain = /(^|[\\/])cl(\.exe)?$/i.test(argv[0]) ? 'msvc' : 'mingw'
  const args = compileArgsOf(argv.slice(1), sourceAbs, toolchain)
  return args && args.length ? { args, toolchain } : undefined
}

/** Arguments from a clangd-style `compile_flags.txt` (one flag per line). */
function flagsFromCompileFlagsTxt(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return undefined }
  const args = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  return args.length ? args : undefined
}

function flagsCachePath(project) {
  return path.join(LOCK_DIR(), `cpp-flags-${projectKey(project)}.json`)
}

/**
 * Signature of the inputs that decide a project's compile flags. A record whose
 * signature no longer matches is ignored: the build entry, the flag family or
 * godot-cpp changed, so what the last build used is no longer known.
 */
function flagsSignature(project, hit, family) {
  const part = (file) => {
    try { const s = fs.statSync(file); return `${path.resolve(file)}:${s.size}:${Math.round(s.mtimeMs)}` } catch { return `${file}:missing` }
  }
  const gcp = godotCppRoot(project, hit)
  return [part(hit.file), family, part(path.join(gcp || '', 'SConstruct')), part(path.join(gcp || '', 'tools', 'godotcpp.py'))].join('|')
}

/** What the last successful build of this project compiled with, when still valid. */
function readLearnedFlags(project, hit, family) {
  try {
    const rec = JSON.parse(fs.readFileSync(flagsCachePath(project), 'utf8'))
    if (!rec || !Array.isArray(rec.args) || !rec.args.length) return undefined
    if (rec.family !== family) return undefined
    if (rec.signature !== flagsSignature(project, hit, family)) return undefined
    return { args: rec.args, compiler: rec.compiler }
  } catch { return undefined }
}

function writeLearnedFlags(project, hit, family, args, compiler) {
  try {
    fs.mkdirSync(LOCK_DIR(), { recursive: true })
    atomicWriteJson(flagsCachePath(project), {
      // The project path is what lets a reader tell whose cache this is (the file
      // name is a hash) — a probe sweeping its throwaway fixtures needs it.
      project: path.resolve(project),
      signature: flagsSignature(project, hit, family),
      family, compiler, args, learned_at: NOW(),
    })
  } catch { /* an unwritable cache only costs speed */ }
}

/**
 * Teach the syntax stage from a build that succeeded: the build echoes its own
 * compile lines, and they carry exactly the flags the project builds with —
 * including the target's defines and the API version, which no heuristic can
 * infer. Only a successful round may teach; a failed one knows nothing. Each line
 * teaches under the family of the compiler it names, so what is learned is
 * usable by the compiler the syntax stage will actually run.
 */
function learnFromBuild(out, project, hit) {
  const found = []
  for (const line of String(out).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!/(\s-c\s|\/c\s)/.test(trimmed)) continue
    const argv = splitCommandLine(trimmed)
    if (argv.length < 3) continue
    const sources = argv.filter((a) => /\.(cpp|cc|cxx)$/i.test(a))
    if (!sources.length) continue
    const family = compilerFamily(argv[0])
    const args = compileArgsOf(argv.slice(1), sources[0], family)
    if (args && args.length) found.push({ family, args, compiler: argv[0] })
  }
  if (!found.length) return
  // The richest line is the project's own source with its full flag set; short
  // lines belong to generated or dependency objects.
  found.sort((a, b) => b.args.length - a.args.length)
  writeLearnedFlags(project, hit, found[0].family, found[0].args, found[0].compiler)
}

/**
 * An explicit `--flags` path that does not exist is a misconfiguration: silently
 * falling back to the layout would answer with flags the caller did not ask for.
 * @returns {string|undefined} the failure to report, when there is one
 */
function flagsArgError(flags) {
  if (!flags.flags) return undefined
  const target = path.resolve(String(flags.flags))
  return fs.existsSync(target) ? undefined : `--flags ${flags.flags} does not exist`
}

/**
 * Flags for the syntax stage, from the most trustworthy source available: an
 * explicit database or flags file, then what the last successful build used, then
 * the GDExtension layout itself. The chosen source travels in the payload,
 * because how much a syntax-only answer can be trusted depends on it.
 * @param {string} compiler the compiler that will run: its family decides which
 *        flags mean what, and a database written for another family is ignored
 *        rather than fed to it
 * @returns {{args: string[], from: string}}
 */
function syntaxFlagsFor(project, hit, compiler, flags, sourceAbs) {
  const family = compilerFamily(compiler)
  const cdbFiles = []
  const flagFiles = []
  const consider = (target) => {
    if (!target) return
    try {
      if (fs.statSync(target).isDirectory()) {
        cdbFiles.push(path.join(target, 'compile_commands.json'))
        flagFiles.push(path.join(target, 'compile_flags.txt'))
      }
    } catch { /* missing: fall through to the next source */ }
  }
  const explicit = flags.flags ? path.resolve(String(flags.flags)) : undefined
  if (explicit) {
    if (/\.json$/i.test(explicit)) cdbFiles.push(explicit)
    else if (/\.txt$/i.test(explicit)) flagFiles.push(explicit)
    else consider(explicit)
  }
  consider(hit.dir)
  consider(path.resolve(project))
  for (const file of cdbFiles) {
    const got = flagsFromCompileCommands(file, sourceAbs)
    if (!got) continue
    if (got.toolchain !== family) {
      log(`ignoring ${file}: its entries are ${got.toolchain} flags, the compiler is ${family}`)
      continue
    }
    return { args: got.args, from: `compile_commands.json (${path.dirname(file)})` }
  }
  for (const file of flagFiles) {
    const args = flagsFromCompileFlagsTxt(file)
    if (args) return { args, from: `compile_flags.txt (${path.dirname(file)})` }
  }
  const learned = readLearnedFlags(project, hit, family)
  if (learned) return { args: learned.args, from: '上一次成功构建的编译命令行' }
  return { args: layoutArgs(project, hit, family), from: 'GDExtension 目录布局推断' }
}

/**
 * Flags for a project that has never been built and ships no compilation
 * database: the GDExtension layout (godot-cpp's include roots plus the build
 * directory). Deliberately minimal — an invented `-D` is a false error, while a
 * missing one only costs precision — and the conflict direction is stated in the
 * payload instead of guessed at.
 */
function layoutArgs(project, hit, toolchain) {
  const gcp = godotCppRoot(project, hit)
  const dirs = []
  if (gcp) dirs.push(path.join(gcp, 'include'), path.join(gcp, 'gen', 'include'), path.join(gcp, 'gdextension'))
  dirs.push(path.join(hit.dir, 'src'), hit.dir, path.resolve(project))
  const args = toolchain === 'msvc'
    ? ['/std:c++17', '/EHsc', '/utf-8', '/nologo']
    : ['-std=c++17']
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    if (toolchain === 'msvc') args.push(`/I${dir}`)
    else args.push('-I', dir)
  }
  return args
}

/** The compiler invocation for one file: same compiler, flags and cwd as the build. */
function syntaxCommandFor(toolchain, compiler, sourceAbs, args) {
  if (toolchain === 'msvc') {
    const vcvars = vcvarsPath()
    if (!vcvars) return undefined
    // vcvars' own chatter is silenced, its errors are not: a failure to set up the
    // environment must reach the parser, or it reads as "the compiler said nothing".
    const inner = `call "${vcvars}" >nul && cl /nologo /Zs ${args.join(' ')} "${sourceAbs}"`
    // `verbatim` hands cmd.exe the line as written: Node's normal argument quoting
    // escapes the inner quotes with backslashes, which cmd.exe does not understand
    // (the call then fails with an empty output and a non-zero status).
    return { exe: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', inner], env: buildEnv(), verbatim: true }
  }
  return {
    exe: compiler,
    args: ['-fsyntax-only', ...args, sourceAbs],
    // The compiler's own directory must lead PATH: MinGW's g++ exits 1 with no
    // output when it cannot find its own subprocesses, which would read as a
    // clean file. Its DLLs live there too.
    env: buildEnv({ PATH: `${path.dirname(compiler)}${path.delimiter}${process.env.PATH || ''}` }),
  }
}

/** Run the compiler on one file, capturing stdout and stderr together. */
function runSyntaxOne(hit, toolchain, compiler, sourceAbs, args, timeoutMs = SYNTAX_TIMEOUT_MS) {
  const cmd = syntaxCommandFor(toolchain, compiler, sourceAbs, args)
  if (!cmd) return Promise.resolve({ code: undefined, out: 'no vcvars64.bat: MSVC needs the environment it sets', text: 'cl /Zs (unavailable)' })
  const text = `${path.basename(cmd.exe)} ${cmd.args.join(' ')}`
  return new Promise((resolve) => {
    let child
    try {
      // A process group of its own on POSIX, so a timeout takes the compiler with
      // it (killTree); Windows keeps taskkill /T for that.
      child = spawn(cmd.exe, cmd.args, {
        cwd: hit.dir, windowsHide: true, env: cmd.env,
        windowsVerbatimArguments: cmd.verbatim === true,
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve({ code: undefined, out: `spawn failed: ${(error && error.message) || error}`, text })
      return
    }
    let out = ''
    let grace
    const settle = (code) => {
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      resolve({ code, out, text })
    }
    const timer = setTimeout(() => {
      try { killTree(child) } catch { /* gone */ }
      // A grandchild that keeps the pipe open would stall `close` forever, and the
      // verdict matters more than the last log line (the same grace a killed build
      // gets). Never leave the promise pending: the caller serializes on it.
      grace = setTimeout(() => settle(undefined), 5_000)
      if (typeof grace.unref === 'function') grace.unref()
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', (error) => {
      out += `${out ? '\n' : ''}spawn error: ${(error && error.message) || error}\n`
      settle(undefined)
    })
    child.on('close', (code) => settle(code))
  })
}

/**
 * Syntax stage: one compiler run per requested file, no build and no lock.
 * A run that could not answer (compiler missing, spawn failure, abnormal exit)
 * is reported as a failure to check, never as a clean file.
 * @returns {Promise<{ok: true, payload: object} | {ok: false, error: string, unavailable?: boolean}>}
 */
async function checkOnceSyntax(project, requestedAbs, flags, budgetMs = 0) {
  const badFlags = flagsArgError(flags)
  if (badFlags) return { ok: false, error: badFlags }
  let hit
  let toolchain
  try {
    hit = findBuildDir(project, flags, requestedAbs)
    toolchain = resolveToolchain(hit, project, flags)
  } catch (error) {
    return { ok: false, error: (error && error.message) || String(error) }
  }
  // The compiler that will run decides the flags (see syntaxCompiler).
  const { compiler, effective } = syntaxCompiler(hit, toolchain)
  // A bare `cl.exe` is a guess that vcvars64.bat will provide it; a found path is
  // a fact. A guess that does not hold means this stage is unavailable, which is
  // what lets `--stage auto` answer with the build instead of failing.
  const guessedCl = toolchain === 'msvc' && compiler === 'cl.exe'
  if (!compiler) {
    const need = toolchain === 'msvc' ? 'cl (with vcvars64.bat)' : 'g++'
    return {
      ok: false, unavailable: true,
      error: `syntax stage cannot run here: no ${need} found (set CXX or MINGW_BIN, or run one full build so the stage learns this project's compiler)`,
    }
  }
  // Only files this build directory actually owns may be stamped as checked: a
  // file that resolves to another GDExtension's build was not compiled with these
  // flags either (the build stage applies the same rule).
  const covered = requestedAbs.filter((abs) => {
    if (!fs.existsSync(abs) || !isUnder(hit.dir, abs)) return false
    let own
    try { own = findBuildDir(project, flags, [abs]) } catch { own = undefined }
    return !own || path.resolve(own.dir) === path.resolve(hit.dir)
  })
  if (!covered.length) {
    return { ok: false, error: `no requested file lives under the build directory ${hit.dir}` }
  }
  const byKey = new Map()
  const commands = []
  const sources = []
  let failure
  // The caller's budget covers the whole stage, not each file: a round of slow
  // files must fail inside it instead of running past it and being retired.
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : undefined
  for (const abs of covered) {
    const left = deadline === undefined ? SYNTAX_TIMEOUT_MS : deadline - Date.now()
    if (left <= 0) {
      failure = `the syntax check ran out of its ${Math.round(budgetMs / 1000)}s budget before checking ${relOf(project, abs)}`
      break
    }
    const resolved = syntaxFlagsFor(project, hit, compiler, flags, abs)
    sources.push(resolved.from)
    const run = await runSyntaxOne(hit, effective, compiler, abs, resolved.args, Math.min(SYNTAX_TIMEOUT_MS, left))
    commands.push(`${run.text} -> exit ${run.code}`)
    const tail = run.out.trim().split(/\r?\n/).slice(-8).join('\n')
    // No exit code at all means the compiler never finished (spawn failure, a
    // timeout kill, a signal): nothing was checked.
    if (run.code === undefined || run.code < 0) {
      failure = `${run.text}\nthe compiler did not run to completion\n${tail}`
      break
    }
    const parsed = parseDiagnostics(run.out, project, hit.dir)
    // A syntax-only run cannot have produced a link error, so a parsed `<link>`
    // would be a false record replacing the build's real one.
    parsed.delete(LINK_KEY)
    const runErrors = [...parsed.values()].reduce((n, list) => n + list.filter((d) => d.severity === 1).length, 0)
    // The compiler refused the file but said nothing this parser can attribute to
    // it (a broken toolchain, an environment failure): that is a failure to check,
    // never a clean file. cl exits 2 on errors, gcc 1 — any non-zero code is only
    // trustworthy once a diagnostic explains it.
    if (run.code !== 0 && !runErrors) {
      failure = `${run.text}\nexit ${run.code} without a source diagnostic\n${tail}`
      break
    }
    for (const [key, list] of parsed) {
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key).push(...list)
    }
  }
  if (failure) {
    if (guessedCl) {
      return {
        ok: false, unavailable: true,
        error: `syntax stage cannot run here: vcvars64.bat did not provide a working cl\n${failure}`,
      }
    }
    return { ok: false, out: failure, error: `syntax check could not run:\n${failure}` }
  }
  const payload = payloadFor(project, covered, byKey, hit)
  payload.stage = 'syntax'
  payload.server = 'syntax'
  // Link failures are the build stage's evidence: a syntax round has none, and
  // an empty declaration here is what keeps `<link>` from being replaced.
  payload.syntheticKeys = []
  // A round may take its flags from several places (one file has a compile_commands
  // entry, the next falls back to the layout): name them instead of pretending the
  // whole round used the last one.
  const distinct = [...new Set(sources)]
  const flagsFrom = distinct.length <= 1 ? (distinct[0] || '未知来源') : `${distinct[0]} 等 ${distinct.length} 种来源`
  payload.build = { dir: hit.dir, toolchain: effective, compiler, flagsFrom, commands }
  const skipped = requestedAbs.length - covered.length
  const notes = [`语法检查（未构建）：用项目自己的 ${effective === 'msvc' ? 'cl /Zs' : 'g++ -fsyntax-only'}，flags 来自 ${flagsFrom}。`]
  if (effective !== toolchain) notes.push(`本机既没有 cl 也没有 vcvars64.bat，已改用 MinGW 的编译器与 flags（项目产物判定为 ${toolchain}）。`)
  if (skipped) notes.push(`${skipped} 个请求的文件不属于这个构建目录（不在它之下，或属于另一个 GDExtension 的构建），本次没有检查。`)
  notes.push('链接错误与构建脚本/依赖库的问题不在本次范围内，需要构建（--stage build 或 lsp_echo check）。')
  payload.engine_note = notes.join('')
  return { ok: true, payload }
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
    const waited = built.waitedMs > 1_500 ? ` after waiting ${(built.waitedMs / 1000).toFixed(1)}s for another check` : ''
    const tail = built.orphanPid
      ? `; the build is still running (pid ${built.orphanPid}) and the next check waits for it — or run it manually to see the full log`
      : '; run it manually to see the full log'
    return {
      ok: false, out: built.out,
      error: `build did not finish within ${secs}s${waited} (${built.timedOutOn} target)${tail}`,
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
  const covered = requestedAbs.filter((abs) => {
    if (!isUnder(hit.dir, abs)) return false
    // One check can be handed files of two GDExtensions (the host sends every
    // changed C++ file to this engine). The build that runs is the one the first
    // resolved file chose, so a file that resolves to a different extension
    // directory was not compiled by it either.
    let own
    try { own = findBuildDir(project, flags, [abs]) } catch { own = undefined }
    return !own || path.resolve(own.dir) === path.resolve(hit.dir)
  })
  const payload = payloadFor(project, covered, byKey, hit)
  payload.stage = 'build'
  payload.build = { dir: hit.dir, entry: path.basename(hit.file), toolchain, commands: built.commands }
  // A round that ran every target to completion is the one source that knows the
  // project's real flags; the syntax stage reads them back from here.
  if (!built.commands.some((c) => /-> exit (?!0\b)/.test(c))) {
    learnFromBuild(built.out, project, hit)
  }
  const skipped = requestedAbs.length - covered.length
  if (skipped) {
    payload.engine_note = `${skipped} requested file(s) were not compiled by this check (outside ${hit.dir}, or owned by another GDExtension's build)`
  }
  return { ok: true, payload }
}

// ---------- commands ----------
/**
 * Answer one check with the stage that can answer it: the syntax stage when the
 * project's toolchain can be driven, the build otherwise. A stage that cannot run
 * falls back instead of turning the check into a clean answer.
 * @param {string} project project root
 * @param {string[]} requestedAbs absolute files this check was asked about
 * @param {boolean} sweep build stage only: also build the release target
 * @param {object} flags parsed CLI flags
 * @param {'auto'|'syntax'|'build'} [want] requested stage
 */
async function checkRequested(project, requestedAbs, sweep, flags, want, budgetMs) {
  const stage = want === undefined ? 'build' : String(want).toLowerCase()
  if (!STAGES.has(stage)) throw new Error(`--stage must be auto, syntax or build (got ${want})`)
  if (stage === 'build') return { stage: 'build', result: await checkOnce(project, requestedAbs, sweep, flags) }
  const syntax = await checkOnceSyntax(project, requestedAbs, flags, budgetMs)
  if (stage === 'syntax' || syntax.ok || !syntax.unavailable) return { stage: 'syntax', result: syntax }
  return { stage: 'build', result: await checkOnce(project, requestedAbs, sweep, flags) }
}

/** Show the flags the syntax stage would use, without compiling anything. */
async function cmdPrintFlags(project, files, flags) {
  const badFlags = flagsArgError(flags)
  if (badFlags) {
    errl(badFlags)
    return 2
  }
  let hit
  let toolchain
  try {
    hit = findBuildDir(project, flags, files.map((f) => path.resolve(project, f)))
    toolchain = resolveToolchain(hit, project, flags)
  } catch (error) {
    errl((error && error.message) || String(error))
    return 2
  }
  // Same resolver the check itself uses: this command reports what would run, so
  // it must not name a different compiler or flag toolchain than the stage will.
  const { compiler, effective } = syntaxCompiler(hit, toolchain)
  console.log(`build dir: ${hit.dir}`)
  console.log(`toolchain: ${toolchain}${effective === toolchain ? '' : ` (no cl available; using ${effective} flags)`}`)
  console.log(`compiler: ${compiler || '(not found)'}`)
  for (const f of files) {
    const abs = path.resolve(project, f)
    const resolved = syntaxFlagsFor(project, hit, compiler, flags, abs)
    console.log(`${relOf(project, abs)}: ${resolved.from}`)
    console.log(`  ${resolved.args.join(' ')}`)
  }
  // This command exists to say what would run: reporting a compiler that is not
  // there as success would make the self-check the one place that lies.
  return compiler ? 0 : 2
}

async function cmdCheck(project, files, outPath, sweep, flags) {
  const absFiles = files.map((f) => path.resolve(project, f))
  if (flags['print-flags'] === true) return cmdPrintFlags(project, files, flags)
  const { result: r } = await checkRequested(project, absFiles, sweep, flags, flags.stage,
    Number(flags['build-timeout-ms']) > 0 ? Number(flags['build-timeout-ms']) : 0)
  if (!r.ok) {
    errl(r.error)
    if (outPath) { try { fs.unlinkSync(path.resolve(outPath)) } catch { /* never written */ } }
    return 2
  }
  if (outPath) atomicWriteJson(path.resolve(outPath), r.payload)
  const s = r.payload.summary
  // The commands belong in the log: the trace is where a user finds out which
  // stage, target and entry the check actually used.
  for (const c of (r.payload.build && r.payload.build.commands) || []) log(c)
  log(`[${r.payload.stage || 'build'}] checked ${s.files_checked} file(s): ${s.errors} error(s), ${s.warnings} warning(s)`)
  if (r.payload.engine_note) log(r.payload.engine_note)
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
  let busy = false // a build is executing right now
  // A syntax check takes no lock and writes nothing into the build directory, so
  // it must not queue behind a build that can run for minutes — a step's fast
  // check would otherwise wait for a background build. Syntax checks serialize
  // among themselves instead.
  const syntaxQueue = []
  let syntaxBusy = false

  const drainSyntax = async () => {
    if (syntaxBusy) return
    syntaxBusy = true
    while (syntaxQueue.length) {
      const entry = syntaxQueue.shift()
      try {
        const perRequest = { ...flags, ...(entry.flags || {}), stage: 'syntax' }
        const r = await checkOnceSyntax(project, (entry.files || []).map((f) => path.resolve(project, f)), perRequest,
          entry.budgetMs > 0 ? entry.budgetMs : 0)
        if (r.ok) reply(entry.id, { ok: true, payload: r.payload })
        else if (r.unavailable) {
          // No compiler this stage can drive: answer with the build, the only stage
          // left — but a request that refuses to wait must be refused here too, or it
          // would queue behind a running build and time the whole channel out. That
          // is the same rule the build path applies before it queues anything, and
          // the reason the host's short pre-step timeout does not retire this clientd
          // together with the build it is running.
          if (entry.noWait === true && (busy || queue.length)) {
            reply(entry.id, { ok: false, error: `another check is already building ${project}; this check does not wait for it (wait for the running check, or run one manually)` })
          } else {
            queue.push({ ...entry, stage: 'build' })
            void drain()
          }
        } else reply(entry.id, { ok: false, error: r.error })
      } catch (error) {
        reply(entry.id, { ok: false, error: (error && error.message) || String(error) })
      }
    }
    syntaxBusy = false
  }

  const drain = async () => {
    if (draining) return
    draining = true
    while (queue.length) {
      const entry = queue.shift()
      busy = true
      try {
        // A request may carry its own build budget and waiting policy: the plugin
        // asks for a short, non-blocking check before a step and a patient one
        // when a model explicitly asks for a check.
        const perRequest = {
          ...flags,
          ...(entry.flags || {}),
          'build-timeout-ms': entry.budgetMs > 0 ? entry.budgetMs : flags['build-timeout-ms'],
          'no-wait': entry.noWait === true || flags['no-wait'] === true,
          'kill-on-timeout': entry.killOnTimeout === true,
        }
        const { result: r } = await checkRequested(project, (entry.files || []).map((f) => path.resolve(project, f)),
          entry.sweep === true || entry.sweep === '1', perRequest, entry.stage === undefined ? 'build' : entry.stage)
        if (r.ok) reply(entry.id, { ok: true, payload: r.payload })
        else reply(entry.id, { ok: false, error: r.error })
      } catch (error) {
        reply(entry.id, { ok: false, error: (error && error.message) || String(error) })
      } finally {
        busy = false
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
      const entry = {
        id: req && req.id, files: req.files, sweep: req.sweep, budgetMs: req && req.budgetMs,
        noWait: req && req.noWait, killOnTimeout: req && req.killOnTimeout, stage: req && req.stage, flags: req && req.flags,
      }
      const want = String((req && req.stage) || 'build').toLowerCase()
      if (want === 'syntax' || want === 'auto') {
        syntaxQueue.push(entry)
        void drainSyntax()
        continue
      }
      // A request that refuses to wait must not queue behind the check already
      // running: the host would time the whole channel out, retire this clientd
      // and reject the running request as well.
      if (entry.noWait === true && (busy || queue.length)) {
        reply(entry.id, { ok: false, error: `another check is already building ${project}; this check does not wait for it (wait for the running check, or run one manually)` })
        continue
      }
      queue.push(entry)
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

  node cpp-gdextension.mjs check <file...> --project <dir> [--stage auto|syntax|build] [--sweep] [--out <json>]
  node cpp-gdextension.mjs clientd --project <dir>   (persistent JSON-lines client)
  node cpp-gdextension.mjs host|status|stop [--project <dir>]

Two stages answer a check:
  syntax  the project's own compiler with the project's own flags, -fsyntax-only
          (cl /Zs) per file: about a second, no writes into the build directory,
          no lock, and no <link> record — link errors are the build's evidence.
  build   the project's own build is the checker: <build dir>/build.ps1 when
          present, otherwise \`py -m SCons platform=<os> target=template_<debug|release>\`.
          This is the only stage that sees link and build-script failures.
--stage defaults to build; \`auto\` prefers syntax and falls back to build when
the syntax stage cannot run here (an MSVC project with no vcvars64.bat and no
other compiler this machine can use).
An MSVC project whose \`cl\` is missing falls back to a g++ found on this machine,
with MinGW flags; a compile_commands.json written for the other family, and a
CXX that belongs to it, are ignored rather than mixed with these flags.
--flags <file|dir> points the syntax stage at a compile_commands.json or a
compile_flags.txt. Without it the build directory and the project root are
searched, then the flags of the last successful build, then the layout.
--print-flags prints what the syntax stage would use, without compiling.
--sweep builds the release target too; a plain check builds debug only.
--dir <dir> pins the build directory (default: the changed files decide, else a
walk); --toolchain auto|msvc|mingw overrides the toolchain detected from the
project's artifacts; --build-timeout-ms <n> overrides the 110s/190s budget;
--no-wait reports a busy build directory instead of waiting for it;
--kill-on-timeout kills the build at the budget (default: leave it running and
hand it the lock, because a killed SCons rebuilds more next time).
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
