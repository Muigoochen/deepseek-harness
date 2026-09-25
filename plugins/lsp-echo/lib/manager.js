// manager.js — invoke the bundled bridge engines (`node <bridge> …`) and own
// the plugin-local runtime output dir. Async: never blocks the host loop while
// a headless Godot engine boots for the first time.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extOf } from './scope.js'

/** Runtime artifacts live under the DSH home so they never dirty the plugin tree. */
export function runtimeRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'lsp-echo-runtime')
}

function safeName(project) {
  return (path.basename(project) || 'project').replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Output JSON path used by every check of one project.
 * Multi-engine result files share this path: writes are serialized per project
 * and merge engine keyspaces (file paths, which engines own disjoint
 * extensions), so concurrent main/baseline/multi-engine checks never clobber
 * each other. GUI reads one file.
 */
export function diagnosticsPath(project) {
  return path.join(runtimeRoot(), `lsp_diagnostics-${safeName(project)}.json`)
}

// ---- per-project serialized snapshot writer (v2, RFC §8) -----------------
// All writes to one project's diagnostics JSON go through a per-project
// in-process queue: read current file, drop keys owned by THIS engine's
// extensions (they are about to be replaced by this payload), keep keys of
// other engines (their keyspaces are orthogonal), merge this payload, recompute
// summary from the merged file set, then atomic temp+rename. queueTail keeps
// ordering even when callers race (baseline vs pre-step vs tool vs GUI).
const writeTails = new Map() // lowercased project -> Promise tail

function atomicWriteJson(file, obj) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`)
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (renameError) {
    // Windows: a transient lock (antivirus/handle) can fail the rename; retry
    // once after a short synchronous pause, then surface the error to the caller.
    try {
      // Atomics.wait is the only sync sleep in Node; setTimeout does not block.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      fs.renameSync(tmp, file)
    } catch (second) {
      try { fs.unlinkSync(tmp) } catch { /* best effort */ }
      throw second
    }
  }
}

/**
 * Summary over a merged keyspace. Declared synthetic keys (`synthetic_keys`)
 * contribute their errors and warnings but are not files: counting them would
 * report one more checked file than the engine that produced them did.
 */
function recomputeSummary(files, syntheticKeys) {
  const synth = new Set(Array.isArray(syntheticKeys) ? syntheticKeys : [])
  let errors = 0
  let warnings = 0
  const filesWithErrors = []
  for (const rel of Object.keys(files)) {
    const rec = files[rel]
    errors += rec && rec.errors ? rec.errors : 0
    warnings += rec && rec.warnings ? rec.warnings : 0
    if (rec && rec.errors > 0 && !synth.has(rel)) filesWithErrors.push(rel)
  }
  return {
    files_checked: Object.keys(files).filter((rel) => !synth.has(rel)).length,
    errors,
    warnings,
    files_with_errors: filesWithErrors,
  }
}

/**
 * Serialize one snapshot write for a project (RFC §8). Merges into the
 * existing file: the keys this payload carries are replaced, the keys it does
 * not carry survive (another engine's keyspace, and this engine's own records
 * for files this round did not look at), and the summary is recomputed from the
 * merged set.
 *
 * A round is not the whole project: the cpp engine's syntax stage checks only the
 * files that changed, and an engine that replaces its entire extension keyspace
 * would erase the records of every file it did not look at — including the build
 * stage's `<link>` record, whose absence reads as "no link errors". The one
 * exception is a key the payload declares as its own `syntheticKeys`: declaring it
 * means owning it, so not producing it removes it (a clean build clears `<link>`).
 *
 * `keepExts` (optional) carries the extensions still bound to this project in
 * the live config. Old keys whose extension is NOT in keepExts are evicted — the
 * owning engine was removed from the project, so its stale diagnostics must not
 * survive (RFC §8: eviction keys off lsp config changes only). A record whose
 * file no longer exists is evicted too: nothing can fix it.
 * @param {string} project project root
 * @param {object} payload bridge payload ({project, files, summary, ...})
 * @param {string[]} [ownedExts] extensions owned by the writing engine
 *        (when omitted, the whole file is replaced — v1 behavior)
 * @param {string[]} [keepExts] extensions still bound to the project in the
 *        current config; old keys outside it are evicted
 * @returns {Promise<object>} the merged, persisted payload
 */
export function writeSnapshot(project, payload, ownedExts, keepExts) {
  const key = path.resolve(project).toLowerCase()
  const run = async () => {
    const out = diagnosticsPath(project)
    let existing = { files: {} }
    try {
      const raw = fs.readFileSync(out, 'utf8')
      existing = JSON.parse(raw)
    } catch { /* no prior snapshot yet */ }
    const files = {}
    const oldFiles = existing.files && typeof existing.files === 'object' ? existing.files : {}
    const keepSet = keepExts && keepExts.length ? new Set(keepExts) : null
    const ownSet = ownedExts && ownedExts.length ? new Set(ownedExts) : null
    const written = new Set(Object.keys(payload.files || {}))
    // The keys this write declares as its own without a file behind them (`<link>`).
    // Declaring one means "this key is mine", so a round that produced no such record
    // — a build with no link errors — must remove the previous one; without that, a
    // fixed link error outlives every later check that keeps passing.
    const synthSet = new Set(Array.isArray(payload.syntheticKeys) ? payload.syntheticKeys : [])
    if (!ownSet && !keepSet) {
      // v1 replace semantics (single engine without extension table)
      Object.assign(files, payload.files || {})
    } else {
      for (const rel of Object.keys(oldFiles)) {
        if (written.has(rel)) continue // replaced by this write
        if (synthSet.has(rel)) continue // this write owns the key and produced no record
        const ext = extOf(rel)
        if (!ext) { files[rel] = oldFiles[rel]; continue } // another engine's synthetic key
        if (keepSet && !keepSet.has(ext)) continue // engine removed from project → evict
        if (!fs.existsSync(path.join(project, rel))) continue // the file is gone → nothing left to fix
        files[rel] = oldFiles[rel]
      }
      for (const rel of written) files[rel] = payload.files[rel]
    }
    // Declared synthetic keys of this write, sticky so that a later writer that
    // declares none does not erase the declaration a kept key still needs.
    const synthKeys = Array.isArray(payload.syntheticKeys) && payload.syntheticKeys.length
      ? payload.syntheticKeys
      : existing.synthetic_keys
    // A round that carried no record at all must not refresh what the snapshot says
    // about the last check: its note, stage and timestamp would describe a check
    // that never happened.
    const wrote = written.size > 0
    const merged = {
      tool: payload.tool,
      version: payload.version,
      project: payload.project || project,
      server: wrote ? payload.server : existing.server,
      port: wrote ? payload.port : existing.port,
      engine_note: wrote ? payload.engine_note : existing.engine_note,
      stage: wrote ? payload.stage : existing.stage,
      synthetic_keys: synthKeys,
      updated_at: wrote ? new Date().toISOString() : existing.updated_at,
      files,
      summary: recomputeSummary(files, synthKeys),
    }
    atomicWriteJson(out, merged)
    return merged
  }
  const prev = writeTails.get(key) || Promise.resolve()
  const next = prev.then(run, run) // run even if the previous write failed
  writeTails.set(key, next)
  return next
}

/**
 * Evict every stale keyspace from a project's snapshot after an lsp config
 * change (RFC §8). Only keys whose extension is still bound to the project
 * survive, plus the extensionless keys a still-bound engine declares
 * (`keepSynthetic`); when nothing survives the whole snapshot file is deleted so
 * the GUI stops showing stale error counts.
 * Serialized through the same per-project queue as writeSnapshot.
 * @param {string} project project root
 * @param {string[]} keepExts extensions still bound in the current config
 * @param {string[]} [keepSynthetic] extensionless keys of the still-bound engines
 * @returns {Promise<boolean>} true when the snapshot was changed or removed
 */
export function pruneSnapshot(project, keepExts, keepSynthetic) {
  const key = path.resolve(project).toLowerCase()
  const run = async () => {
    const out = diagnosticsPath(project)
    let existing
    try {
      existing = JSON.parse(fs.readFileSync(out, 'utf8'))
    } catch { return false } // no snapshot to prune
    const keepSet = keepExts && keepExts.length ? new Set(keepExts) : null
    const keepSynth = new Set(keepSynthetic || [])
    const oldFiles = existing.files && typeof existing.files === 'object' ? existing.files : {}
    const files = {}
    if (keepSet) {
      for (const rel of Object.keys(oldFiles)) {
        const ext = extOf(rel)
        if (ext ? keepSet.has(ext) : keepSynth.has(rel)) files[rel] = oldFiles[rel]
      }
    }
    const nextSynthetic = keepSynthetic && keepSynthetic.length ? keepSynthetic : undefined
    // The declaration is part of what a prune rewrites, so it takes part in the
    // decision to write: it can go away while every file key stays.
    const changed = Object.keys(files).length !== Object.keys(oldFiles).length
      || JSON.stringify(existing.synthetic_keys || []) !== JSON.stringify(nextSynthetic || [])
    if (!changed) return false
    if (!Object.keys(files).length) {
      // nothing left bound → drop the file entirely (GUI reads absence as
      // "no snapshot yet", never as a green 0-error state)
      try { fs.unlinkSync(out) } catch { /* best effort */ }
      return true
    }
    atomicWriteJson(out, {
      tool: existing.tool,
      version: existing.version,
      project: existing.project || project,
      server: existing.server,
      port: existing.port,
      engine_note: existing.engine_note,
      // Recomputed from the still-bound engines, not copied: the declaration must
      // not outlive the engine that owns it.
      synthetic_keys: nextSynthetic,
      updated_at: new Date().toISOString(),
      files,
      summary: recomputeSummary(files, keepSynthetic),
    })
    return true
  }
  const prev = writeTails.get(key) || Promise.resolve()
  const next = prev.then(run, run)
  writeTails.set(key, next)
  return next
}

function runBridge(bridge, args, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [bridge, ...args],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !error.killed) {
          // ECONN/ENOENT style spawn failures and non-zero exits both land here.
          const status = error.code && typeof error.code === 'number' ? error.code : 2
          resolve({ ok: status === 0 || status === 1, fatal: status === 2, status, stdout: String(stdout || ''), stderr: String(stderr || error.message) })
          return
        }
        const status = error && error.killed ? 2 : 0
        resolve({ ok: status === 0 || status === 1, fatal: status === 2, status, stdout: String(stdout || ''), stderr: String(stderr || '') })
      },
    )
  })
}

// ---------- persistent LSP client (bridge `clientd`) ----------
// One long-lived bridge process keeps a single LSP client connected to the
// engine host, so checks skip the per-call handshake and push files in
// batched parallel. Protocol: request/reply JSON lines over stdio.
const liveClients = new Map() // bridge -> Map(projectLower -> state)

// Ports this profile reserves for the user's own editor LSP (every enginePorts
// entry in the settings store, across projects and engines). Forwarded to the
// checker so an engine it spawns never binds one of them. Godot opens its DAP
// listener on every `--editor` instance — default 6006, independently of
// `--lsp-port` — which is how one of our own headless engines once squatted the
// port a user had reserved for their editor.
let reservedPorts = []
/** Replace the reserved-port set (called whenever the settings store reloads). */
export function setReservedPorts(ports) {
  reservedPorts = Array.isArray(ports) ? [...new Set(ports.filter((n) => Number.isInteger(n) && n > 0 && n <= 65535))] : []
}
/** Current reserved-port set (diagnostics/tests). */
export function getReservedPorts() {
  return [...reservedPorts]
}
function reserveArgs() {
  return reservedPorts.length ? ['--reserve-ports', reservedPorts.join(',')] : []
}

function ensureClientd(bridge, project, role = 'main', editorPort) {
  const byProject = liveClients.get(bridge) || new Map()
  liveClients.set(bridge, byProject)
  const projLower = path.resolve(project).toLowerCase()
  // One bridge process per project+attach-port, regardless of role. The Godot
  // editor LSP is a single-session server (a second client logs "Connection
  // Taken" and kicks the first), so baseline and main checks MUST share one
  // clientd; `role` only selects the sweep request inside clientdRequest.
  const portKey = editorPort ? `:p${editorPort}` : ':auto'
  const key = `${projLower}::${portKey}`
  const existing = byProject.get(key)
  if (existing && existing.child.exitCode === null && existing.child.stdin && existing.child.stdin.writable) return existing
  if (existing) {
    try { existing.child.kill() } catch { /* gone */ }
    byProject.delete(key)
  }
  // A port/override change supersedes every older clientd for this project:
  // retire stale ones so only one engine session (and at most one editor
  // attach) lives per project.
  for (const [oldKey, old] of [...byProject]) {
    if (oldKey !== key && oldKey.startsWith(`${projLower}::`)) {
      byProject.delete(oldKey)
      for (const [, entry] of old.pending) {
        clearTimeout(entry.timer)
        try { entry.reject(new Error('clientd superseded by editor-port change')) } catch { /* settled */ }
      }
      try { if (old.child.stdin) old.child.stdin.end() } catch { /* closed */ }
      try { old.child.kill() } catch { /* gone */ }
    }
  }
  const args = [bridge, 'clientd', '--project', project]
  if (editorPort) args.push('--editor-port', String(editorPort))
  args.push(...reserveArgs())
  const child = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const state = { child, nextId: 1, pending: new Map(), buf: '' }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    state.buf += d
    for (;;) {
      const nl = state.buf.indexOf('\n')
      if (nl < 0) break
      const line = state.buf.slice(0, nl).trim()
      state.buf = state.buf.slice(nl + 1)
      let msg
      try { msg = JSON.parse(line) } catch { continue } // tolerate [gd-lsp] chatter
      if (msg && typeof msg.id === 'number') {
        const entry = state.pending.get(msg.id)
        if (entry) {
          state.pending.delete(msg.id)
          clearTimeout(entry.timer)
          entry.resolve(msg)
        }
      }
    }
  })
  child.stderr.on('data', () => {})
  if (child.stdin) child.stdin.on('error', () => {})
  child.on('exit', () => {
    for (const [, entry] of state.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('clientd exited'))
    }
    // Identity guard: a port change may have already replaced this key with a
    // newer clientd; only drop the map entry when it still points at us.
    if (byProject.get(key) === state) byProject.delete(key)
  })
  byProject.set(key, state)
  return state
}

function clientdRequest(bridge, project, files, timeoutMs, role = 'main', editorPort, reloadFiles, buildBudgetMs, noWait, stage) {
  return new Promise((resolve, reject) => {
    let state
    try { state = ensureClientd(bridge, project, role, editorPort) } catch (e) { reject(e); return }
    const id = state.nextId++
    const timer = setTimeout(() => {
      if (state.pending.delete(id)) reject(new Error(`clientd request timed out (${timeoutMs}ms)`))
    }, timeoutMs)
    state.pending.set(id, { resolve, reject, timer })
    // Full-project baselines (role 'baseline') use the bridge's bulk sweep
    // path: one didOpen for every file, no per-chunk settle tax.
    const sweep = role === 'baseline'
    // `didsave` asks clientd to reload these scripts through the language server
    // before it reads diagnostics; omit the field entirely when there is none.
    const request = { id, files, sweep }
    if (Array.isArray(reloadFiles) && reloadFiles.length) request.didsave = reloadFiles
    // A build-backed engine may cap its own build and refuse to wait for a busy
    // build directory; the bridge honours both per request.
    if (buildBudgetMs > 0) request.budgetMs = buildBudgetMs
    if (noWait) request.noWait = true
    // Which of the engine's stages answers this request. Omitted means the
    // engine's own default (the cpp bridge builds), which keeps a request that
    // does not care about stages — a baseline sweep, an unknown engine — on the
    // path it has always taken.
    if (stage) request.stage = stage
    try { state.child.stdin.write(JSON.stringify(request) + '\n') } catch (e) { reject(e) }
  })
}

/** Stop every persistent LSP client (all roles) for a project (engine host is untouched). */
export function stopClientd(bridge, project) {
  const byProject = liveClients.get(bridge)
  if (!byProject) return
  const prefix = `${path.resolve(project).toLowerCase()}::`
  for (const [key, state] of [...byProject]) {
    if (!key.startsWith(prefix)) continue
    byProject.delete(key)
    for (const [, entry] of state.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('clientd stopped'))
    }
    try { if (state.child.stdin) state.child.stdin.end() } catch { /* closed */ }
    // Only the clientd process: a bridge may reach the user's own editor engine
    // (attach mode) through it, and killing the tree would reach that engine too.
    // A build a bridge started is torn down by the bridge's own timeout path,
    // and its build-directory lock keeps the retry from building concurrently.
    try { state.child.kill() } catch { /* gone */ }
  }
}

/** Ensure a host is running for a project (bridge `host`); reuses a live host. */
export function ensureHost(bridge, project, editorPort) {
  const args = ['host', '--project', project]
  if (editorPort) args.push('--editor-port', String(editorPort))
  args.push(...reserveArgs())
  return runBridge(bridge, args)
}

export function stopHost(bridge, project) {
  return runBridge(bridge, ['stop', '--project', project], 30_000)
}

/**
 * Ask the bridge for one project's host state. The editor port override travels with
 * the call because it decides which port this bridge would probe/attach on, and the
 * GUI status report repeats that number to the user.
 * @param {string} bridge absolute bridge script path
 * @param {string} project project root
 * @param {number} [editorPort] editor LSP port override (settings page)
 * @returns {Promise<{ ok: boolean, fatal: boolean, stdout: string, stderr: string }>}
 */
export function status(bridge, project, editorPort) {
  const args = ['status', '--project', project]
  if (editorPort) args.push('--editor-port', String(editorPort))
  return runBridge(bridge, args, 30_000)
}

/**
 * Ask the editor-bridge addon (dsh_echo_bridge) inside the running engine to
 * rescan the project filesystem, which is what registers newly created
 * `class_name` scripts. A running engine never rescans by itself, so without
 * this a file referencing a brand-new class is reported as an unknown type.
 * @param {string} bridge absolute bridge script path
 * @param {string} project project root
 * @param {number} [port] addon control port; the bridge defaults to 6089
 * @returns {Promise<{ ok: boolean, fatal: boolean, stdout: string, stderr: string }>}
 */
export function rescanEngine(bridge, project, port) {
  const args = ['rescan', '--project', project]
  if (port) args.push('--bridge-port', String(port))
  return runBridge(bridge, args, 20_000)
}

/**
 * Check files and return the parsed diagnostics payload.
 * Preferred path: one persistent LSP client (`clientd`) — no per-call
 * handshake and batched-parallel file pushes. Falls back to the legacy
 * one-shot `check` subprocess on any clientd failure. Either path persists
 * through the per-project serialized writer (RFC §8): engine keyspaces are
 * merged and the summary recomputed, so concurrent main/baseline/multi-engine
 * checks never clobber each other's snapshot.
 * Throws when the bridge reports a fatal (usage/config/runtime) failure.
 * @param {string[]} [ownedExts] extensions owned by the calling engine
 * @param {string[]} [keepExts] extensions still bound to the project in the
 *        current config; stale keys outside it are evicted on write (RFC §8)
 * @param {string[]} [reloadFiles] scripts whose disk content changed; the
 *        persistent clientd path reloads them before reading diagnostics. The
 *        legacy one-shot fallback does not carry them.
 * @param {number} [buildBudgetMs] cap on one build-backed check, passed through to
 *        the bridge (0/absent means the bridge's interactive budget)
 * @param {boolean} [noWait] report a busy build directory at once instead of
 *        waiting for the build already running there
 * @param {string} [stage] which stage of a build-backed engine answers: the cpp
 *        bridge's `syntax` is the fast compiler-only check, `build` the
 *        authoritative one (link and build-script failures) and `auto` prefers
 *        syntax, falling back to the build when it cannot run here. Omitted means
 *        the engine's default.
 */
export async function checkFiles(bridge, project, files, timeoutMs = 120_000, role = 'main', ownedExts, keepExts, editorPort, reloadFiles, buildBudgetMs, noWait, stage) {
  try {
    const reply = await clientdRequest(bridge, project, files, timeoutMs, role, editorPort, reloadFiles, buildBudgetMs, noWait, stage)
    if (reply && reply.ok && reply.payload) {
      return writeSnapshot(project, reply.payload, ownedExts, keepExts)
    }
    // The bridge answered with a verdict (`{ ok: false, error }`): the check
    // itself failed — a build that overran its budget, a missing toolchain. That
    // is a result, not a broken channel, and retrying it as a one-shot `check`
    // would start a second build right after this one was killed.
    if (reply && reply.ok === false) {
      const verdict = new Error(reply.error || 'the engine reported a failed check')
      verdict.engineVerdict = true
      throw verdict
    }
    throw new Error('clientd returned a failed reply')
  } catch (clientError) {
    if (clientError && clientError.engineVerdict) throw clientError
    // The engine host is a single-session LSP server. When the clientd call
    // itself failed (timeout / exit / superseded), retire any still-alive
    // clientd BEFORE the legacy one-shot `check` opens its own session —
    // leaving it alive would let the two sessions kick each other
    // ("Connection Taken") and fail every in-flight request. Ordinary
    // engine-reported errors keep the healthy session.
    const failMsg = String((clientError && clientError.message) || clientError)
    if (/timed out|exited|superseded/i.test(failMsg)) stopClientd(bridge, project)
    // Legacy one-shot path: bridge writes the payload to a temp file (atomic
    // inside the bridge), we read it back and persist through the same writer.
    const tmpOut = path.join(runtimeRoot(), `.tmp-check-${safeName(project)}-${role}-${process.pid}-${Date.now()}.json`)
    const sweepArgs = role === 'baseline' ? ['--sweep'] : []
    const portArgs = editorPort ? ['--editor-port', String(editorPort)] : []
    // The one-shot path must carry the same limits the clientd request did, or a
    // retry would build with the bridge's interactive default instead.
    const budgetArgs = buildBudgetMs > 0 ? ['--build-timeout-ms', String(buildBudgetMs)] : []
    const waitArgs = noWait ? ['--no-wait'] : []
    // The one-shot fallback must ask for the same stage, or a request that wanted
    // the fast compiler-only check would silently start a full build instead.
    const stageArgs = stage ? ['--stage', stage] : []
    // The files come first: a valueless flag followed by a path would otherwise
    // eat the file it precedes (the bridge's parser gives a flag the next token).
    const r = await runBridge(bridge, ['check', ...files, ...sweepArgs, ...portArgs, ...budgetArgs, ...waitArgs, ...stageArgs, ...reserveArgs(), '--project', project, '--out', tmpOut], timeoutMs)
    if (r.fatal) {
      try { fs.unlinkSync(tmpOut) } catch { /* best effort */ }
      throw new Error(r.stderr.trim() || r.stdout.trim() || 'bridge check failed')
    }
    try {
      const payload = JSON.parse(fs.readFileSync(tmpOut, 'utf8'))
      try { fs.unlinkSync(tmpOut) } catch { /* best effort */ }
      return writeSnapshot(project, payload, ownedExts, keepExts)
    } catch (parseError) {
      try { fs.unlinkSync(tmpOut) } catch { /* best effort */ }
      // A payload that cannot be read back is not a result. Answering with an empty
      // "no errors" one would turn "nothing was checked" into "nothing is wrong",
      // which is the one thing a check must never do.
      throw new Error(`bridge wrote no readable payload: ${(parseError && parseError.message) || parseError}`)
    }
  }
}
