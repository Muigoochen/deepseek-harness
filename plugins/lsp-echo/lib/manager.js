// manager.js — invoke the bundled bridge engines (`node <bridge> …`) and own
// the plugin-local runtime output dir. Async: never blocks the host loop while
// a headless Godot engine boots for the first time.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

function recomputeSummary(files) {
  let errors = 0
  let warnings = 0
  const filesWithErrors = []
  for (const rel of Object.keys(files)) {
    const rec = files[rel]
    errors += rec && rec.errors ? rec.errors : 0
    warnings += rec && rec.warnings ? rec.warnings : 0
    if (rec && rec.errors > 0) filesWithErrors.push(rel)
  }
  return { files_checked: Object.keys(files).length, errors, warnings, files_with_errors: filesWithErrors }
}

function extOf(file) {
  const i = file.lastIndexOf('.')
  return i >= 0 ? file.slice(i).toLowerCase() : ''
}

/**
 * Serialize one snapshot write for a project (RFC §8). Merges into the
 * existing file: keys whose extension belongs to `ownedExts` are dropped
 * (replaced by this payload); all other keys (other engines' keyspaces) are
 * preserved; the summary is recomputed from the merged set.
 *
 * `keepExts` (optional) carries the extensions still bound to this project in
 * the live config. Old keys whose extension is NOT in keepExts are evicted —
 * the owning engine was removed from the project, so its stale diagnostics
 * must not survive (RFC §8: eviction keys off lsp config changes only).
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
    if (!ownSet && !keepSet) {
      // v1 replace semantics (single engine without extension table)
      Object.assign(files, payload.files || {})
    } else {
      for (const rel of Object.keys(oldFiles)) {
        const ext = extOf(rel)
        if (keepSet && !keepSet.has(ext)) continue // engine removed from project → evict
        if (ownSet && ownSet.has(ext)) continue // this engine's keyspace, replaced below
        files[rel] = oldFiles[rel]
      }
      for (const rel of Object.keys(payload.files || {})) files[rel] = payload.files[rel]
    }
    const merged = {
      tool: payload.tool,
      version: payload.version,
      project: payload.project || project,
      server: payload.server,
      port: payload.port,
      engine_note: payload.engine_note,
      updated_at: new Date().toISOString(),
      files,
      summary: recomputeSummary(files),
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
 * survive; when keepExts is empty (project unbound or removed) the whole
 * snapshot file is deleted so the GUI stops showing stale error counts.
 * Serialized through the same per-project queue as writeSnapshot.
 * @param {string} project project root
 * @param {string[]} keepExts extensions still bound in the current config
 * @returns {Promise<boolean>} true when the snapshot was changed or removed
 */
export function pruneSnapshot(project, keepExts) {
  const key = path.resolve(project).toLowerCase()
  const run = async () => {
    const out = diagnosticsPath(project)
    let existing
    try {
      existing = JSON.parse(fs.readFileSync(out, 'utf8'))
    } catch { return false } // no snapshot to prune
    const keepSet = keepExts && keepExts.length ? new Set(keepExts) : null
    const oldFiles = existing.files && typeof existing.files === 'object' ? existing.files : {}
    const files = {}
    if (keepSet) {
      for (const rel of Object.keys(oldFiles)) {
        if (keepSet.has(extOf(rel))) files[rel] = oldFiles[rel]
      }
    }
    const changed = Object.keys(files).length !== Object.keys(oldFiles).length
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
      updated_at: new Date().toISOString(),
      files,
      summary: recomputeSummary(files),
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

function ensureClientd(bridge, project, role = 'main', editorPort) {
  const byProject = liveClients.get(bridge) || new Map()
  liveClients.set(bridge, byProject)
  const projLower = path.resolve(project).toLowerCase()
  const rolePrefix = `${projLower}::${role}`
  // The attach port is part of the identity: a clientd started with one port
  // must not be reused after the user changes the override (its host decision
  // already ran inside the bridge process).
  const portKey = editorPort ? `:p${editorPort}` : ':auto'
  const key = `${rolePrefix}${portKey}`
  const existing = byProject.get(key)
  if (existing && existing.child.exitCode === null && existing.child.stdin && existing.child.stdin.writable) return existing
  if (existing) {
    try { existing.child.kill() } catch { /* gone */ }
    byProject.delete(key)
  }
  // A port/override change for the same role supersedes every older clientd:
  // retire stale ones so only one engine session (and at most one editor
  // attach) lives per role.
  for (const [oldKey, old] of [...byProject]) {
    if (oldKey !== key && oldKey.startsWith(rolePrefix)) {
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

function clientdRequest(bridge, project, files, timeoutMs, role = 'main', editorPort) {
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
    try { state.child.stdin.write(JSON.stringify({ id, files, sweep }) + '\n') } catch (e) { reject(e) }
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
    try { state.child.kill() } catch { /* gone */ }
  }
}

/** Ensure a host is running for a project (bridge `host`); reuses a live host. */
export function ensureHost(bridge, project, editorPort) {
  const args = ['host', '--project', project]
  if (editorPort) args.push('--editor-port', String(editorPort))
  return runBridge(bridge, args)
}

export function stopHost(bridge, project) {
  return runBridge(bridge, ['stop', '--project', project], 30_000)
}

export function status(bridge, project) {
  return runBridge(bridge, ['status', '--project', project], 30_000)
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
 */
export async function checkFiles(bridge, project, files, timeoutMs = 120_000, role = 'main', ownedExts, keepExts, editorPort) {
  try {
    const reply = await clientdRequest(bridge, project, files, timeoutMs, role, editorPort)
    if (reply && reply.ok && reply.payload) {
      return writeSnapshot(project, reply.payload, ownedExts, keepExts)
    }
    throw new Error((reply && reply.error) || 'clientd returned a failed reply')
  } catch (clientError) {
    // Legacy one-shot path: bridge writes the payload to a temp file (atomic
    // inside the bridge), we read it back and persist through the same writer.
    const tmpOut = path.join(runtimeRoot(), `.tmp-check-${safeName(project)}-${role}-${process.pid}-${Date.now()}.json`)
    const sweepArgs = role === 'baseline' ? ['--sweep'] : []
    const portArgs = editorPort ? ['--editor-port', String(editorPort)] : []
    const r = await runBridge(bridge, ['check', ...sweepArgs, ...portArgs, ...files, '--project', project, '--out', tmpOut], timeoutMs)
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
      return {
        project,
        summary: { errors: 0, warnings: 0, files_checked: 0, files_with_errors: [] },
        files: {},
        stdout: r.stdout,
        stderr: r.stderr,
      }
    }
  }
}
