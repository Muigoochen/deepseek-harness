// lsp-echo — host function plugin.
// Manages bundled diagnostics engines (checkers/*) and auto-echoes compile
// errors into agent context after project files change.
//
// Project judgment policy (per product requirement):
//   1. plugin enable  -> one smart scan over EXISTING harness workspaces;
//   2. workspace added -> one smart scan of that workspace;
//   3. anything else is user-configured (manual layer; future GUI).
// Scans are never periodic.
//
// Persistence lives in the HARNESS settings namespace `lsp-echo`
// (settings.yaml mechanism), not a plugin-owned file: discovered entries are
// keyed by workspace id, so workspace lifecycle stays in sync and pruning is a
// plain id-diff at the next scan trigger. NOTE: settings.register expects a
// SCHEMASTERY schema (see research/harness-plugin-dev-findings.md).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { engines, markers, matchExtension } from './checkers.js'
import { ensureHost, stopHost, status, checkFiles, runtimeRoot, stopClientd, diagnosticsPath, pruneSnapshot, rescanEngine } from './manager.js'
import { ADDON_ID, discoverBridgePort, installAddonInto, probeEngineBridge, rescanPortOf } from './addon.js'
import { dependentsOf } from './dependents.js'
import { ProjectWatcher, scanFiles } from './watcher.js'
import { registerTool } from './tool.js'
import { scanProjectRoots } from './registry.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'lsp-echo'

/** Services required by this plugin. `toast` provides the floating UI cues. */
export const inject = ['tools', 'settings', 'toast']

/** Harness settings namespace owning the discovery/manual registry. */
export const REGISTRY_NAMESPACE = 'lsp-echo'

// Arrays (not records) keep the schemastery schema portable. The `manual`
// entries are dual-shape compatible: v1 wrote { path, engine, autoInject },
// v2 writes { path, lsp: [{ engine }], autoInject? }. Both resolve here;
// readStore() normalizes v1 into v2 (a lone v1 engine becomes lsp:[{engine}]
// only when no lsp entries are present) so the rest of the plugin only ever
// sees lsp arrays. NOTE: this schemastery fork has NO .optional() — fields
// are optional unless .required(), and z.array implies default [].
const PROJECT_ENTRY = z.object({
  path: z.string().required(),
  engine: z.string(), // v1 legacy single-engine field
  lsp: z.array(z.object({
    engine: z.string(),
  })), // v2 multiple-LSP field (array implies default [])
  autoInject: z.boolean(), // explicit exemption; absent = follow global
})
const REGISTRY_SCHEMA = z.object({
  discovered: z.array(z.object({
    key: z.string(),
    path: z.string(),
    title: z.string(),
    scannedAt: z.number(),
    projects: z.array(z.string()),
  })).default([]),
  manual: z.array(PROJECT_ENTRY).default([]),
  // Global auto-inject switch (RFC §7): persisted here so the settings GUI can
  // toggle it at runtime; absent = fall back to Config.autoInject (default true).
  autoInjectGlobal: z.boolean(),
  // Engine-level editor-attach port overrides: engineId -> editor LSP port the
  // bridge probes when attaching to a user's running Godot editor. Absent =
  // engine default (Godot editor LSP default 6005). Stored as an array to keep
  // the schemastery schema portable. GUI: 设置页「引擎(LSP)」卡.
  enginePorts: z.array(z.object({
    engine: z.string(),
    port: z.number(),
  })).default([]),
})

const DEFAULT_SKIP = ['node_modules', '.git', '.godot', 'addons']

export const Config = z.object({
  projects: z.array(PROJECT_ENTRY).default([]),
  // Global auto-inject default (seed). "项目第一次加入 DSH 时自动智能配置 LSP
  // 并开始把编译错误注入 AI 上下文"; runtime toggling persists to the settings
  // store's autoInjectGlobal (absent there = this Config value applies).
  autoInject: z.boolean().default(true),
  autoDiscover: z.boolean().default(true),
  // Debug/trace mode: when false, automatic full-baseline scans are skipped
  // (only traced as "would-start"); the explicit lsp_echo baseline action still works.
  autoBaseline: z.boolean().default(true),
  pollIntervalMs: z.number().default(1500),
  watchSkip: z.array(z.string()).default(DEFAULT_SKIP),
})

/**
 * Normalize one project entry (v1 {engine} or v2 {lsp[]}) to the v2 shape.
 * Engine order: explicit lsp entries win; a lone v1 engine is appended when
 * no lsp entries are present (deduped).
 * @param {object} entry raw entry from store/config
 * @returns {{ path: string, lsp: Array<{engine: string}>, autoInject?: boolean } | undefined}
 */
function normalizeProjectEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path) return undefined
  const lsp = []
  if (Array.isArray(entry.lsp)) {
    for (const x of entry.lsp) {
      if (x && typeof x.engine === 'string' && x.engine && !lsp.some((e) => e.engine === x.engine)) {
        lsp.push({ engine: x.engine })
      }
    }
  }
  if (!lsp.length && typeof entry.engine === 'string' && entry.engine) lsp.push({ engine: entry.engine })
  const out = { path: entry.path, lsp }
  if (typeof entry.autoInject === 'boolean') out.autoInject = entry.autoInject
  return out
}

/**
 * Effective engine ids of a project entry (normalized v2 shape).
 * @param {{ lsp?: Array<{engine: string}> }} entry
 * @returns {string[]}
 */
function entryEngineIds(entry) {
  const out = []
  for (const e of (entry && entry.lsp) || []) {
    if (e && typeof e.engine === 'string' && e.engine && !out.includes(e.engine)) out.push(e.engine)
  }
  return out
}

/** First (primary) engine id of a known record, if any. */
function primaryEngine(rec) {
  return rec && Array.isArray(rec.lsp) && rec.lsp.length ? rec.lsp[0].engine : undefined
}

function projectRootOf(dir, markersList) {
  let d = path.resolve(dir)
  for (;;) {
    if (markersList.some((m) => fs.existsSync(path.join(d, m)))) return d
    const parent = path.dirname(d)
    if (parent === d) return undefined
    d = parent
  }
}

function buildEchoText(engineId, payload, cap = 10) {
  const s = payload && payload.summary
  if (!s) return undefined
  const rows = []
  for (const rel of Object.keys(payload.files || {})) {
    for (const d of payload.files[rel].diagnostics || []) {
      if (d.severity === 1 || d.severity === 2) {
        const msg = String(d.message || '').slice(0, 140)
        rows.push(`${rel}:${d.line}:${d.column}: [${d.severityName}] ${msg}`)
      }
    }
  }
  if (!rows.length) return undefined
  const head = `[lsp-echo] ${engineId} 检测到 ${s.errors} 个编译错误(${s.files_with_errors.length} 个文件),来自最近的编辑:`
  const lines = rows.slice(0, cap)
  if (rows.length > cap) lines.push(`… 还有 ${rows.length - cap} 条`)
  return [head, ...lines].join('\n')
}

/**
 * Engine-scoped view of one merged snapshot: keep only the files whose
 * extension belongs to `extList`, recompute the summary over that subset, and
 * return a payload-shaped object ({files, summary}). Consumers that report per
 * engine (pre-step echo, baselines, tools) must read THIS — the merged
 * snapshot on disk holds every engine's keyspace, so summing its full summary
 * per engine double-counts when a project carries more than one engine.
 */
function engineScope(payload, extList) {
  const files = payload && payload.files && typeof payload.files === 'object' ? payload.files : {}
  const own = new Set((extList || []).map((e) => String(e).toLowerCase()))
  const out = {}
  let errors = 0
  let warnings = 0
  const filesWithErrors = []
  for (const rel of Object.keys(files)) {
    if (!own.has(extOf(rel))) continue
    const rec = files[rel]
    out[rel] = rec
    errors += (rec && rec.errors) || 0
    warnings += (rec && rec.warnings) || 0
    if (rec && rec.errors > 0) filesWithErrors.push(rel)
  }
  return {
    files: out,
    summary: { files_checked: Object.keys(out).length, errors, warnings, files_with_errors: filesWithErrors },
  }
}

function extOf(rel) {
  const dot = rel.lastIndexOf('.')
  return dot >= 0 ? rel.slice(dot).toLowerCase() : ''
}

/**
 * Activate the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  const pluginRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..')
  const engineTable = engines(pluginRoot)
  const engine = (id) => engineTable[id] || undefined
  const enginesList = () => Object.keys(engineTable)
  const markerList = () => markers(engineTable)
  const engineByBridge = (bridge) => Object.values(engineTable).find((e) => e.bridge === bridge)
  const absPath = (p, project) => (path.isAbsolute(p) ? path.resolve(p) : path.resolve(project, p))

  // Smart engine detection: first registered engine whose marker file exists
  // at the project root wins; no marker hit falls back to the first engine.
  const detectEngine = (root) => {
    const ids = enginesList()
    if (!ids.length) return undefined
    for (const id of ids) {
      const eng = engine(id)
      if (eng && eng.marker && fs.existsSync(path.join(path.resolve(root), eng.marker))) return id
    }
    return ids[0]
  }

  // Suggest LSP engines for a project (RFC §4.2): marker hit at the root is the
  // strongest signal (godot-lsp for project.godot); shallow extension evidence
  // adds more engines, guarding against node_modules/.git/vendor pollution.
  const suggestLsp = (root) => {
    const absRoot = path.resolve(root)
    const skipDirs = (config.watchSkip || []).slice()
    for (const s of ['node_modules', '.git', '.venv', 'dist', 'build', 'vendor', 'addons', '.dsh-build']) {
      if (!skipDirs.includes(s)) skipDirs.push(s)
    }
    const suggested = []
    // 1) marker-based: an engine whose marker sits at the project root
    for (const id of enginesList()) {
      const eng = engine(id)
      if (eng && eng.marker && fs.existsSync(path.join(absRoot, eng.marker))) {
        if (!suggested.includes(id)) suggested.push(id)
      }
    }
    // 2) shallow extension evidence (depth <= 3), skip dirs excluded
    const hits = {} // engineId -> count
    const walk = (dir, depth) => {
      if (depth > 3) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (skipDirs.includes(e.name)) continue
          walk(full, depth + 1)
        } else if (e.isFile()) {
          for (const id of enginesList()) {
            const eng = engine(id)
            if (eng && matchExtension(eng, e.name) && !suggested.includes(id)) {
              hits[id] = (hits[id] || 0) + 1
            }
          }
        }
      }
    }
    walk(absRoot, 0)
    for (const id of enginesList()) {
      if (hits[id] >= 1 && !suggested.includes(id)) suggested.push(id)
    }
    return suggested.length ? suggested : (detectEngine(absRoot) ? [detectEngine(absRoot)] : [])
  }

  // ---- floating UI cues via the toast plugin (guard: never break the flow) --
  const showToast = (kind, title, body, id, durationMs) => {
    try {
      if (ctx.toast && typeof ctx.toast.show === 'function') {
        ctx.toast.show({
          kind, title, body,
          ...(id ? { id } : {}),
          durationMs: durationMs === undefined ? 4000 : durationMs,
        })
      }
    } catch (error) {
      console.warn(`[lsp-echo] toast.show failed: ${(error && error.message) || error}`)
    }
  }
  const dismissToast = (id) => {
    try { if (ctx.toast && typeof ctx.toast.dismiss === 'function' && id) ctx.toast.dismiss(id) } catch { /* ignore */ }
  }

  // ---- engine host-state warnings → GUI toast ---------------------------
  // The godot bridge writes { warn: { ports, at } } into its runtime
  // host-<project>.json when an editor LSP port accepts TCP but never answers
  // LSP initialize (dead/fake LSP peer). Surface that once per occurrence so
  // the user learns why their editor attach silently fell back to headless.
  const engineWarnShown = new Set() // `${engineId}:${ports}:${at}` seen keys
  const engineHostWarn = (eng, project) => {
    try {
      const safe = (path.basename(path.resolve(project)) || 'project').replace(/[^A-Za-z0-9._-]/g, '_')
      // The bridge keeps host state under the DSH home, one directory per engine
      // (runtimeRoot()/<engine>/); the engine-local .runtime/ path is the
      // pre-move location and stays a read fallback so an upgrade keeps
      // reporting warnings.
      for (const file of [
        path.join(runtimeRoot(), eng.id, `host-${safe}.json`),
        path.join(path.dirname(eng.bridge), '.runtime', `host-${safe}.json`),
      ]) {
        try {
          const s = JSON.parse(fs.readFileSync(file, 'utf8'))
          // A record for another project must not resurface: its warning is about
          // an engine this project never used. Compare the way the bridge does,
          // since the same project path can differ only in letter case.
          const same = typeof s.project === 'string' && path.resolve(s.project).toLowerCase() === path.resolve(project).toLowerCase()
          if (same && s.warn && Array.isArray(s.warn.ports) && s.warn.ports.length && typeof s.warn.at === 'number') return s.warn
        } catch { /* not this location */ }
      }
    } catch { /* no host state yet */ }
    return undefined
  }
  const maybeToastEngineWarn = (eng, project) => {
    if (!eng) return
    const warn = engineHostWarn(eng, project)
    if (!warn) return
    const key = `${eng.id}:${warn.ports.join(',')}:${warn.at}`
    if (engineWarnShown.has(key)) return
    engineWarnShown.add(key)
    if (engineWarnShown.size > 64) engineWarnShown.clear() // bounded: never grows unbounded across sessions
    showToast(
      'warning',
      `${eng.name} 编辑器 LSP 端口异常`,
      warn.reason === 'wrong-project'
        ? `端口 ${warn.ports.join(', ')} 上的语言服务器服务的是别的项目(不是你当前检查的项目),不能用来诊断本项目——否则它返回的空诊断会伪装成"0 错误"。已自动改用独立引擎;把编辑器切回本项目后,该端口会在 5 分钟黑名单到期后重新尝试。`
        : `端口 ${warn.ports.join(', ')} 可连接但不响应 LSP 请求(占用它的进程不是该语言的编辑器 LSP,或编辑器 LSP 已卡死)。已自动改用独立引擎,请检查该端口。`,
      `lsp-echo-engwarn:${key}`,
      8000,
    )
  }

  // ---- settings namespace = durable store for discovered/manual -----------
  const settings = ctx.get('settings')
  let scope
  if (settings && typeof settings.register === 'function') {
    try {
      scope = settings.register(REGISTRY_NAMESPACE, REGISTRY_SCHEMA)
    } catch (error) {
      console.warn(`[lsp-echo] settings.register failed: ${(error && error.message) || error}`)
    }
  } else {
    console.warn('[lsp-echo] settings service unavailable; discovery/manual registry disabled')
  }
  const readStore = () => {
    const v = scope ? scope.get() : {}
    const rawD = v && Array.isArray(v.discovered) ? v.discovered : []
    const rawM = v && Array.isArray(v.manual) ? v.manual : []
    // Normalize v1 {path, engine} entries to v2 {path, lsp:[{engine}]} here, so
    // every consumer below only sees lsp arrays (dual-shape compatibility).
    const manual = rawM.map(normalizeProjectEntry).filter(Boolean)
    return {
      discovered: [...rawD],
      manual,
      autoInjectGlobal: v && typeof v.autoInjectGlobal === 'boolean' ? v.autoInjectGlobal : undefined,
      enginePorts: v && Array.isArray(v.enginePorts) ? v.enginePorts : [],
    }
  }
  let store = readStore()
  const persist = async () => {
    if (!scope) return
    const out = { discovered: store.discovered, manual: store.manual, enginePorts: store.enginePorts }
    if (typeof store.autoInjectGlobal === 'boolean') out.autoInjectGlobal = store.autoInjectGlobal
    await scope.replace(out)
    store = readStore() // refresh local snapshot after the durable commit
  }
  /** Editor-attach port configured for an engine id (undefined = engine default). */
  const enginePortOf = (engineId) => {
    const list = store.enginePorts || []
    for (const e of list) {
      const p = e && e.port
      if (e && e.engine === engineId && typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535) return p
    }
    return undefined
  }
  /** Editor-attach port for a bridge path (resolve its owning engine id). */
  const portForBridge = (bridge) => {
    const eng = engineByBridge(bridge)
    return eng ? enginePortOf(eng.id) : undefined
  }
  /** Global auto-inject: settings toggle when set, else the Config seed (default true). */
  const globalAutoInject = () => (typeof store.autoInjectGlobal === 'boolean' ? store.autoInjectGlobal : config.autoInject !== false)

  // ---- running-engine rescan (new class_name scripts) ---------------------
  // Godot registers global class names only while scanning the project
  // filesystem, and a running engine never rescans on its own (the editor does
  // it when its window regains focus; a headless engine never does). A
  // class_name script created after the engine started is therefore reported as
  // an unknown type until the engine rescans. Engines declaring `rescan` ship an
  // in-project addon (engine.json `addon`) listening on `rescanPort`; asking it
  // to rescan is the only way to refresh a running engine without restarting it.
  const RESCAN_FAIL_COOLDOWN_MS = 120_000
  const RESCAN_WARN_INTERVAL_MS = 600_000
  const RESCAN_OK_INTERVAL_MS = 3_000
  const RESCAN_STATE_CAP = 64
  /** Writing this header is the user's browser asking, not a cross-site page. */
  const TRUST_HEADER = 'x-dsh-lsp-echo'
  const rescanFailedAt = new Map() // `${engineId}:${projectLower}` -> last failure
  const rescanOkAt = new Map()
  const rescanWarnedAt = new Map()
  const capState = (map, cap) => { if (map.size > cap) map.clear() }
  /**
   * Ask rescan-capable engines of a project to rescan its filesystem.
   * @param {{ id: string, name: string, bridge: string, rescan?: boolean, rescanPort?: number }} eng
   * @param {string} project project root
   * @param {string} why short reason, for the trace log only
   * @param {{ fresh?: boolean }} [opts] fresh=true skips the success interval,
   *   for a rescan that must land on the round that saw the file change
   * @returns {Promise<boolean>} true when the engine acknowledged the rescan
   */
  const tryEngineRescan = async (eng, project, why, opts = {}) => {
    if (!eng || !eng.rescan) return false
    const key = `${eng.id}:${project.toLowerCase()}`
    if (Date.now() - (rescanFailedAt.get(key) || 0) < RESCAN_FAIL_COOLDOWN_MS) return false
    if (!opts.fresh && Date.now() - (rescanOkAt.get(key) || 0) < RESCAN_OK_INTERVAL_MS) return false
    // A running engine publishes the port it actually bound; the declared
    // engine default is only the fallback when nothing published one.
    const port = discoverBridgePort(project) ?? rescanPortOf(eng)
    try {
      // runBridge resolves for every exit code, so the receipt must be checked:
      // otherwise a failed rescan looks successful and the warning path below
      // is dead code.
      const r = await rescanEngine(eng.bridge, project, port)
      if (!r || !r.ok) {
        const detail = String((r && (r.stderr || r.stdout)) || '').trim() || `rescan exited ${r && r.status}`
        throw new Error(detail)
      }
      rescanFailedAt.delete(key)
      rescanOkAt.set(key, Date.now())
      capState(rescanOkAt, RESCAN_STATE_CAP)
      trace('rescan', eng.id, `ok on port ${port} (${why})`)
      return true
    } catch (error) {
      rescanFailedAt.set(key, Date.now())
      capState(rescanFailedAt, RESCAN_STATE_CAP)
      if (Date.now() - (rescanWarnedAt.get(key) || 0) > RESCAN_WARN_INTERVAL_MS) {
        rescanWarnedAt.set(key, Date.now())
        capState(rescanWarnedAt, RESCAN_STATE_CAP)
        showToast(
          'warning',
          `${eng.name} 引擎未刷新`,
          `${path.basename(project)}:运行中的引擎不会发现新建脚本的 class_name。在设置页点「安装引擎桥」并在 Godot 里启用后,插件即可自动让引擎重扫。`,
          `lsp-echo-rescan:${key}`,
          9000,
        )
      }
      trace('rescan', eng.id, `failed: ${(error && error.message) || error}`)
      return false
    }
  }
  const MISSING_TYPE_RE = /Could not find type "([^"]+)"/i
  /**
   * Unknown-type names reported for the files of THIS check (deduped). The
   * payload is a merged project snapshot carrying files this check never
   * touched; only checked files may drive a rescan, or one stale snapshot entry
   * would re-trigger a rescan on every single check.
   * @param {object} payload merged diagnostics payload of one engine
   * @param {string} project project root
   * @param {string[]} files absolute paths checked in this call
   * @returns {string[]} unknown type names worth a rescan
   */
  const missingTypeNames = (payload, project, files) => {
    const names = []
    const rels = new Set((files || []).map((f) => path.relative(project, f).split(path.sep).join('/').toLowerCase()))
    for (const rel of Object.keys((payload && payload.files) || {})) {
      if (!rels.has(rel.toLowerCase())) continue
      for (const d of payload.files[rel].diagnostics || []) {
        const m = MISSING_TYPE_RE.exec(String(d.message || ''))
        if (m && !names.includes(m[1])) names.push(m[1])
      }
    }
    return names
  }
  const CLASS_NAME_RE = /^[ \t]*class_name[ \t]+([A-Za-z_][A-Za-z0-9_]*)/
  const CLASS_INDEX_CAP = 32
  const classIndex = new Map() // projectLower -> { mtimes: Map<abs, mtime>, names: Map<name, abs> }
  const readHead = (file, bytes = 8192) => {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      return buf.subarray(0, n).toString('utf8')
    } finally { fs.closeSync(fd) }
  }
  /**
   * `class_name` declarations present in the project. The index is re-diffed
   * against file mtimes on every call, so a class created moments ago is
   * visible at once — a TTL cache would hide exactly the new scripts this heal
   * exists for.
   * @param {string} project project root
   * @returns {Set<string>} declared class names
   */
  const projectClassNames = (project) => {
    const key = project.toLowerCase()
    let entry = classIndex.get(key)
    if (!entry) {
      if (classIndex.size >= CLASS_INDEX_CAP) classIndex.clear()
      entry = { mtimes: new Map(), names: new Map() }
      classIndex.set(key, entry)
    }
    let current = new Map()
    // Godot registers global class names for the whole res:// tree, addons/
    // included, so the index must not inherit the watcher's skip list.
    const indexSkip = (config.watchSkip || DEFAULT_SKIP).filter((dir) => dir !== 'addons')
    try { current = scanFiles(project, indexSkip, ['.gd']) } catch { /* unreadable: keep the last index */ }
    for (const [name, file] of [...entry.names]) if (!current.has(file)) entry.names.delete(name)
    for (const [file, mtime] of current) {
      if (entry.mtimes.get(file) === mtime) continue
      let head = ''
      try { head = readHead(file) } catch { continue /* locked or vanished: retry on the next call */ }
      // Record the mtime only after a successful read: recording it first would
      // freeze this file as "already indexed" and drop its class names until the
      // file changes again.
      entry.mtimes.set(file, mtime)
      for (const [name, owner] of [...entry.names]) if (owner === file) entry.names.delete(name)
      for (const line of head.split(/\r?\n/)) {
        const m = CLASS_NAME_RE.exec(line)
        if (m) entry.names.set(m[1], file)
      }
    }
    for (const file of [...entry.mtimes.keys()]) if (!current.has(file)) entry.mtimes.delete(file)
    return new Set(entry.names.keys())
  }
  /**
   * Check files through one engine, healing the new-script false positive: when
   * the engine reports an unknown type that the project really declares, rescan
   * the engine and check the same files once more.
   * @param {object} eng engine record from checkers.engines()
   * @param {string} project project root
   * @param {string[]} files absolute file paths
   * @param {number} timeoutMs bridge timeout
   * @param {string} role check role ('main' | 'baseline')
   * @param {string[]|undefined} ownExts extensions this engine owns in the snapshot
   * @param {string[]|undefined} keepExts extensions the snapshot must keep
   * @returns {Promise<object>} diagnostics payload
   */
  const checkWithHeal = async (eng, project, files, timeoutMs, role, ownExts, keepExts) => {
    const port = enginePortOf(eng.id)
    const payload = await checkFiles(eng.bridge, project, files, timeoutMs, role, ownExts, keepExts, port)
    if (!eng.rescan) return payload
    const missing = missingTypeNames(payload, project, files)
    if (!missing.length) return payload
    const declared = projectClassNames(project)
    const stale = missing.filter((n) => declared.has(n))
    if (!stale.length) return payload
    // fresh: the pre-check rescan just ran, and its 3 s success interval would
    // otherwise make this self-heal a no-op exactly when a stale payload is what
    // needs correcting.
    if (!(await tryEngineRescan(eng, project, `unknown types: ${stale.join(', ')}`, { fresh: true }))) return payload
    trace('rescan', eng.id, `re-checking ${files.length} file(s) after rescan`)
    try {
      // The post-rescan answer is the better one, but a failing re-check must
      // leave the first result in place instead of reporting "no diagnostics".
      // The smaller budget keeps the doubled cost off the pre-step path.
      const retryBudgetMs = Math.min(timeoutMs, 45_000)
      const healed = await checkFiles(eng.bridge, project, files, retryBudgetMs, role, ownExts, keepExts, port)
      if (missingTypeNames(healed, project, files).length) {
        trace('rescan', eng.id, 're-check still reports unknown types; the engine may not have re-published diagnostics yet')
      }
      return healed
    } catch (error) {
      trace('rescan', eng.id, `re-check failed, keeping the pre-rescan result: ${(error && error.message) || error}`)
      return payload
    }
  }
  /** Ping status of the in-project bridge addon (shared by the GUI action). */

  // ---- effective project map (discovered/config seed, manual overrides) ----
  // known value: { path, source, lsp: [{engine}], autoInject } (autoInject =
  // exemption; explicit false anywhere config/manual disables injection).
  const known = new Map() // lowercased root -> record
  const addKnown = (root, lsp, autoInject, source) => {
    if (!root || !fs.existsSync(root)) return
    const abs = path.resolve(root)
    const key = abs.toLowerCase()
    if (!known.has(key)) {
      known.set(key, { path: abs, source, lsp: lsp || [], autoInject: autoInject !== false })
    }
  }
  const setKnown = (root, lsp, autoInject, source) => {
    if (!root) return
    const abs = path.resolve(root)
    const key = abs.toLowerCase()
    const prev = known.get(key)
    // manual override adopts its lsp array verbatim (an explicit empty array
    // means "no engines — do not inject"), falling back to prev only when no
    // lsp argument was passed at all.
    const effectiveLsp = Array.isArray(lsp) ? lsp : prev && prev.lsp ? prev.lsp : []
    known.set(key, {
      path: abs,
      source: source || (prev && prev.source) || 'manual',
      lsp: effectiveLsp,
      autoInject: autoInject === undefined ? (prev ? prev.autoInject : true) : autoInject !== false,
    })
  }
  const seedKnown = () => {
    known.clear()
    // Order: config seeds first, then discovered (addKnown, first-wins so config
    // beats discovered on the same path), manual last via setKnown upsert
    // (manual overrides both config and discovered for that path).
    for (const p of config.projects || []) {
      const e = normalizeProjectEntry(p)
      if (!e) continue
      let lsp = entryEngineIds(e).map((engine) => ({ engine }))
      if (!lsp.length) {
        const d = detectEngine(e.path)
        if (d) lsp = [{ engine: d }]
      }
      addKnown(e.path, lsp, e.autoInject, 'config')
    }
    for (const ws of store.discovered) {
      if (!ws) continue
      for (const root of ws.projects || []) addKnown(root, [{ engine: detectEngine(root) || 'godot-lsp' }], true, 'workspace')
    }
    for (const m of store.manual) {
      if (!m || !m.path) continue
      setKnown(m.path, entryEngineIds(m).map((engine) => ({ engine })), m.autoInject, 'manual')
    }
  }
  seedKnown()
  if (known.size) {
    showToast('info', 'lsp-echo 已就绪', `已登记 ${known.size} 个 Godot 项目(引擎:${enginesList().join(', ')})`, 'lsp-echo-ready', 4000)
  }

  // lazy watchers over the effective set. Mode B: no background polling; the
  // baseline is refreshed by watcher.tick() at each pre-step (see below).
  const watchers = new Map()
  const projectExtensions = (rec) => {
    const exts = []
    for (const e of rec.lsp || []) {
      const eng = engine(e.engine)
      if (eng) for (const x of eng.extensions) if (!exts.includes(x)) exts.push(x)
    }
    return exts.length ? exts : ['.gd', '.gdshader']
  }
  // Extensions of the engines CURRENTLY bound to the project (no default
  // fallback): the eviction ground truth for pruneSnapshot / writeSnapshot
  // keepExts. Empty means "project carries no engine" → drop its snapshot.
  const boundExtensions = (rec) => {
    const exts = []
    for (const e of rec.lsp || []) {
      const eng = engine(e.engine)
      if (eng) for (const x of eng.extensions) if (!exts.includes(x)) exts.push(x)
    }
    return exts
  }
  const pruneProjectSnapshot = async (absRoot) => {
    const rec = known.get(path.resolve(absRoot).toLowerCase())
    await pruneSnapshot(absRoot, rec ? boundExtensions(rec) : [])
  }
  const ensureWatcher = (rec) => {
    const key = rec.path.toLowerCase()
    let w = watchers.get(key)
    const wantExts = projectExtensions(rec)
    if (w && w.extensionsKey === wantExts.join(',')) return w
    if (w) w.tick() // flush edits since the last tick into dirty before rebuild
    const fresh = new ProjectWatcher(rec.path, config.watchSkip || DEFAULT_SKIP, wantExts)
    fresh.extensionsKey = wantExts.join(',')
    if (w) fresh.adopt(w) // rebuild without losing pending dirty files
    watchers.set(key, fresh)
    return fresh
  }

  // ---- one-shot workspace scans (enable + newly entered workspace) --------
  let syncing = false
  const syncWorkspaces = async () => {
    if (syncing || config.autoDiscover === false) return
    const svc = ctx.get('workspaceRegistry')
    if (!svc || typeof svc.list !== 'function') return
    let wsList = []
    try {
      wsList = await svc.list()
    } catch (error) {
      console.warn(`[lsp-echo] workspaceRegistry.list failed: ${(error && error.message) || error}`)
      return
    }
    syncing = true
    try {
      const currentKeys = new Set(
        wsList
          .map((w) => (w && w.id) || (w && w.path ? `path:${path.resolve(w.path)}` : undefined))
          .filter(Boolean),
      )
      const beforeKeys = new Set(store.discovered.map((d) => d.key))
      let changed = store.discovered.length !== currentKeys.size
      const nextDiscovered = []
      for (const w of wsList) {
        const wsPath = w && w.path
        if (!wsPath) continue
        const wsKey = w.id ? String(w.id) : `path:${path.resolve(wsPath)}`
        const prev = store.discovered.find((d) => d.key === wsKey)
        if (prev && path.resolve(prev.path) === path.resolve(wsPath)) {
          nextDiscovered.push(prev)
          continue
        }
        let roots = []
        try {
          roots = scanProjectRoots(wsPath, { markers: markerList() })
        } catch (error) {
          console.warn(`[lsp-echo] scan of workspace ${wsPath} failed: ${(error && error.message) || error}`)
        }
        nextDiscovered.push({ key: wsKey, path: path.resolve(wsPath), title: w.title || '', scannedAt: Date.now(), projects: roots })
        changed = true
      }
      if (changed) {
        store.discovered = nextDiscovered
        await persist()
        seedKnown()
        const newly = nextDiscovered.filter((d) => !beforeKeys.has(d.key) && d.projects.length)
        if (newly.length) {
          showToast('success', 'lsp-echo 自动发现', `新增 Godot 项目:\n${newly.map((d) => d.title || d.path).join('\n')}`, 'lsp-echo-discover', 6000)
        }
      }
    } finally {
      syncing = false
    }
  }
  if (config.autoDiscover !== false) syncWorkspaces() // fire and forget at enable
  ctx.on('agent/session-start', () => syncWorkspaces())

  // ---- tool surface -------------------------------------------------------
  // Full-project baseline across EVERY engine bound to the project: each
  // engine sweeps only its own extensions and writes through the shared
  // writer (keyspaces merge, summary recomputed). Returns one row per engine.
  // Unknown project (not in `known`) can't route by extension — the caller
  // falls back to its single resolved bridge.
  const sweepAllEngines = async (rec, timeoutMs = 200_000) => {
    const rows = []
    const bound = []
    for (const x of rec.lsp || []) {
      const eng = engine(x.engine)
      if (eng) bound.push(eng)
    }
    if (!bound.length) return { rows, scanned: 0, errs: 0, bound: 0 }
    const keepExts = boundExtensions(rec)
    await Promise.all(bound.map(async (eng) => {
      let files = []
      try { files = [...scanFiles(rec.path, config.watchSkip || DEFAULT_SKIP, eng.extensions).keys()] } catch { /* keep [] */ }
      if (!files.length) { rows.push({ eng: eng.id, empty: true }); return }
      try {
        const payload = await checkWithHeal(eng, rec.path, files, timeoutMs, 'baseline', eng.extensions, keepExts)
        // merged snapshot holds every engine's keyspace; per-engine view only
        const scope = engineScope(payload, eng.extensions)
        rows.push({ eng: eng.id, payload, scope: scope.summary, files: scope.files })
      } catch (e) {
        rows.push({ eng: eng.id, error: (e && e.message) || String(e) })
      }
    }))
    let scanned = 0
    let errs = 0
    let warns = 0
    const errFiles = []
    for (const r of rows) {
      if (r.scope) {
        scanned += r.scope.files_checked || 0
        errs += r.scope.errors || 0
        warns += r.scope.warnings || 0
        for (const f of r.scope.files_with_errors || []) if (!errFiles.includes(f)) errFiles.push(f)
      }
    }
    return { rows, scanned, errs, warns, errFiles, bound: bound.length }
  }
  registerTool(ctx, {
    engine,
    enginesList,
    resolveProject: (provided, cwd, files) => {
      const mks = markerList()
      let root
      if (provided) {
        root = projectRootOf(provided, mks)
      } else {
        for (const f of files || []) {
          const p = path.resolve(f)
          if (fs.existsSync(p)) {
            root = projectRootOf(p, mks)
            if (root) break
          }
        }
        if (!root && cwd) root = projectRootOf(cwd, mks)
      }
      if (!root) return undefined
      const rec = known.get(root.toLowerCase())
      const engineId = (rec && primaryEngine(rec)) || detectEngine(root) || 'godot-lsp'
      const eng = engine(engineId)
      if (!eng) throw new Error(`lsp-echo: engine '${engineId}' not bundled under checkers/`)
      return { project: root, engineId, bridge: eng.bridge }
    },
    abs: absPath,
    ensure: (bridge, project) => ensureHost(bridge, project, portForBridge(bridge)),
    stop: stopHost,
    stopClient: stopClientd,
    status,
    // Model-facing `check` must write through the same keyspace-merge writer as
    // every other engine check. Resolve the project's engine from `known` (the
    // tool resolves a bridge already, but its extensions are what matter for
    // ownedExts/keepExts); unknown projects fall back to bare checkFiles.
    check: async (bridge, project, files, timeoutMs) => {
      const rec = known.get(path.resolve(project).toLowerCase())
      if (!rec) return checkFiles(bridge, project, files, timeoutMs, 'main', undefined, undefined, portForBridge(bridge))
      const keepExts = boundExtensions(rec)
      const ownExts = engineByBridge(bridge) ? engineByBridge(bridge).extensions : boundExtensions(rec)
      const eng = engineByBridge(bridge)
      if (eng) return checkWithHeal(eng, project, files, timeoutMs || 120_000, 'main', ownExts, keepExts)
      return checkFiles(bridge, project, files, timeoutMs || 120_000, 'main', ownExts, keepExts, portForBridge(bridge))
    },
    projectsList: () => [...known.values()].map((r) => `${r.source}\t${primaryEngine(r) || '?'}\t${r.path}`),
    scanWorkspace: async (root) => {
      // user-initiated scan -> judgment result lands in the MANUAL layer
      const found = scanProjectRoots(root, { markers: markerList() })
      const manual = [...store.manual]
      for (const p of found) {
        const abs = path.resolve(p)
        if (manual.some((m) => m.path && path.resolve(m.path) === abs)) continue
        // inherit an existing config/workspace exemption, do not unmute
        const prevRec = known.get(abs.toLowerCase())
        const inherit = prevRec && prevRec.autoInject === false
        manual.push(normalizeProjectEntry({ path: abs, lsp: [{ engine: detectEngine(abs) || 'godot-lsp' }], autoInject: inherit ? false : undefined }))
      }
      if (manual.length !== store.manual.length) {
        store.manual = manual
        await persist()
        seedKnown()
      }
      return found
    },
    baseline: async (bridge, project) => {
      // explicit full-project baseline (tool action), independent of session starts
      const rec = known.get(path.resolve(project).toLowerCase())
      if (rec) {
        // Multi-engine routing: sweep every bound engine over its own files.
        const { rows, scanned, errs, bound } = await sweepAllEngines(rec)
        if (!bound) return '[lsp-echo] 该项目没有绑定任何引擎(先配置 LSP)'
        if (!scanned && !errs && rows.every((r) => r.empty)) return '[lsp-echo] 项目里没有可检查的文件'
        const parts = [`[lsp-echo] 全量诊断完成：${errs} 个编译错误(${scanned} 个文件):`]
        for (const r of rows) {
          if (r.scope) parts.push(`[${r.eng}] 扫描 ${r.scope.files_checked || 0} 文件，${r.scope.errors || 0} 错误`)
          else if (r.empty) parts.push(`[${r.eng}] 无此语言文件`)
          else parts.push(`[${r.eng}] 失败: ${r.error}`)
        }
        return parts.join('\n')
      }
      // Unknown project: legacy single-engine path (resolved bridge only).
      const ownExts = engineByBridge(bridge) ? engineByBridge(bridge).extensions : undefined
      let all = []
      try { all = [...scanFiles(project, config.watchSkip || DEFAULT_SKIP).keys()] } catch { /* ignore */ }
      if (!all.length) return '[lsp-echo] 项目里没有可检查的文件'
      const payload = await checkFiles(bridge, project, all, 200_000, 'baseline', ownExts, undefined, portForBridge(bridge))
      const scanned = payload && payload.summary ? payload.summary.files_checked : all.length
      return baselineDoneText(payload, scanned)
    },
  })

  // ---- GUI API hooks (for the future separate-window client plugin) -------
  // GET /lsp-echo/api?action=projects|status|host|stop|baseline&project=<abs>
  // Same host-route pattern as toast's /toast/events. The future GUI window
  // fetches here to manage engines and reads project bindings from the
  // `lsp-echo` settings namespace and diagnostics from $DSH_HOME runtime JSON.
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    const json = (res, code, body) => {
      if (res.writableEnded) return
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    /** Guard for actions that mutate state or our engine processes. */
    const requireTrust = (req, res) => {
      if (req.headers[TRUST_HEADER] === '1') return true
      json(res, 403, { ok: false, error: `${TRUST_HEADER}: 1 header required` })
      return false
    }
    // A cross-site page can reach a plain GET, so every action with a side
    // effect asks for the header only our own bundle sends. Read-only actions
    // (projects/engines/diagnostics/status/addCandidates/bridgeStatus) stay open.
    const MUTATING_ACTIONS = new Set(['installAddon', 'smart', 'setProject', 'addLsp', 'delLsp', 'resetProject', 'delProject', 'baseline', 'host', 'stop'])
    const apiHandler = async (req, res) => {
      try {
        if ((req.method || 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        const url = new URL(req.url || '/', 'http://lsp-echo.local')
        const action = url.searchParams.get('action')
        const project = url.searchParams.get('project')
        // config/enginePort are read-only without their parameter and writes with it.
        const mutatingQuery = (action === 'config' && url.searchParams.has('autoInject'))
          || (action === 'enginePort' && url.searchParams.has('port'))
        if ((MUTATING_ACTIONS.has(action) || mutatingQuery) && !requireTrust(req, res)) return
        if (action === 'projects') {
          return json(res, 200, {
            ok: true,
            projects: [...known.values()].map((r) => ({
              source: r.source,
              // primary engine is the lsp[0] — GUI consumes it as `engine`
              engine: primaryEngine(r),
              lsp: (r.lsp || []).map((x) => x.engine),
              path: r.path,
              autoInject: r.autoInject,
            })),
          })
        }
        // ---- settings-page management actions (no engine host required) ----
        if (action === 'engines') {
          const detail = Object.values(engineTable).map((e) => ({ id: e.id, name: e.name, marker: e.marker, extensions: e.extensions, rescan: !!e.rescan, addon: e.addon || null }))
          return json(res, 200, { ok: true, engines: detail })
        }
        // In-project engine bridge addon: copy it into the project and register
        // it in project.godot, so a running engine can be asked to rescan.
        if (action === 'installAddon') {
          const abs = project ? path.resolve(project) : undefined
          if (!abs) return json(res, 400, { ok: false, error: 'installAddon requires project=<abs>' })
          const rec = known.get(abs.toLowerCase())
          const eng = rec ? (rec.lsp || []).map((x) => engine(x.engine)).find((e) => e && e.rescan && e.addon) : undefined
          if (!eng) return json(res, 400, { ok: false, error: '该项目的引擎不支持引擎桥(engine.json 未声明 rescan/addon)' })
          const r = installAddonInto(abs, eng)
          // Our own headless engine loads editor plugins only at startup, so stop
          // it: the next check starts a fresh engine that loads the addon. A
          // user's editor is never touched (its addon loads when it restarts).
          let stoppedForRestart = false
          if (r.ok && r.enabled) {
            try {
              const st = await status(eng.bridge, abs)
              // Anchor on the bridge's own status line: the report also carries
              // the project path, which may itself contain "headless".
              if (/^running \(headless\)/m.test(String((st && st.stdout) || ''))) {
                stopClientd(eng.bridge, abs)
                await stopHost(eng.bridge, abs)
                stoppedForRestart = true
              }
            } catch (error) {
              trace('addon', `stopping the headless engine after install failed: ${(error && error.message) || error}`)
            }
          }
          return json(res, r.ok ? 200 : 500, { ...r, stoppedForRestart })
        }
        if (action === 'bridgeStatus') {
          const abs = project ? path.resolve(project) : undefined
          const rec = abs ? known.get(abs.toLowerCase()) : undefined
          const eng = rec ? (rec.lsp || []).map((x) => engine(x.engine)).find((e) => e && e.rescan) : undefined
          // A running addon publishes the port it actually bound; fall back to
          // the engine default only when nothing is running yet.
          const published = abs ? discoverBridgePort(abs) : undefined
          const port = published ?? (eng ? rescanPortOf(eng) : undefined)
          const installed = abs ? fs.existsSync(path.join(abs, 'addons', ADDON_ID, 'plugin.gd')) : false
          const probe = eng ? await probeEngineBridge(port) : { online: false, error: '该项目没有声明 rescan 能力的引擎' }
          return json(res, 200, { ok: true, project: abs || null, port: port ?? 0, declared: !!eng, installed, online: !!probe.online, error: probe.error })
        }
        // Global auto-inject switch (RFC §7): GET returns effective value,
        // GET with autoInject=0|1 persists the toggle to the settings store.
        if (action === 'config') {
          const ai = url.searchParams.get('autoInject')
          if (ai === '0' || ai === '1') {
            store.autoInjectGlobal = ai === '1'
            await persist()
            seedKnown()
            return json(res, 200, { ok: true, autoInject: store.autoInjectGlobal, enginePorts: store.enginePorts })
          }
          return json(res, 200, { ok: true, autoInject: globalAutoInject(), enginePorts: store.enginePorts })
        }
        // Engine editor-attach port override (编辑器 LSP 端口). GET engine=<id>
        // with port=<n> persists; an empty/missing port clears the override.
        // No project required — the port belongs to the engine on this machine.
        if (action === 'enginePort') {
          const eng = url.searchParams.get('engine')
          if (!eng || !engine(eng)) return json(res, 400, { ok: false, error: `enginePort requires engine=<id>; available: ${enginesList().join(', ')}` })
          let port = 0
          if (url.searchParams.has('port')) {
            const raw = url.searchParams.get('port')
            if (raw !== '') {
              port = Number(raw)
              if (!Number.isInteger(port) || port <= 0 || port > 65535) {
                return json(res, 400, { ok: false, error: 'port must be an integer 1..65535 (empty or missing clears the override)' })
              }
            }
          }
          const list = (store.enginePorts || []).filter((x) => x.engine !== eng)
          if (port > 0) list.push({ engine: eng, port })
          store.enginePorts = list
          await persist()
          return json(res, 200, { ok: true, engine: eng, port, enginePorts: store.enginePorts })
        }
        // DSH workspace projects the settings board can still register. Every
        // workspace root is a candidate (a project outside a workspace cannot
        // host a conversation; the board must not second-guess the user about
        // which DSH project matters), plus engine-marker hits nested under it.
        if (action === 'addCandidates') {
          const svc = ctx.get('workspaceRegistry')
          const out = []
          const push = (root, title) => {
            const ap = path.resolve(root)
            if (!out.some((c) => c.path === ap)) out.push({ path: ap, title: title || path.basename(ap), registered: known.has(ap.toLowerCase()) })
          }
          if (svc && typeof svc.list === 'function') {
            try {
              const wsList = await svc.list()
              for (const w of wsList || []) {
                const wsPath = w && w.path
                if (!wsPath || typeof wsPath !== 'string') continue
                const title = (w && w.title) || ''
                push(wsPath, title) // the workspace root itself
                let roots = []
                try {
                  roots = scanProjectRoots(path.resolve(wsPath), { markers: markerList() })
                } catch { /* unreadable workspace, skip */ }
                for (const r of roots) push(r, title)
              }
              out.sort((a, b) => (a.registered === b.registered ? 0 : a.registered ? 1 : -1))
            } catch { /* candidates are best effort */ }
          }
          return json(res, 200, { ok: true, candidates: out })
        }
        // Diagnostics is a pure read of the latest snapshot and must not depend
        // on engine resolution: a registered project with no engines bound (an
        // empty manual shell) still polls its header badge every 3 s — refusing
        // it with 400 there spams the browser console on every tick.
        if (action === 'diagnostics') {
          let abs
          if (project) abs = path.resolve(project)
          else {
            const first = [...known.values()][0]
            abs = first && first.path
          }
          if (!abs) return json(res, 400, { ok: false, error: 'diagnostics requires project=<abs> (none registered)' })
          try {
            const raw = fs.readFileSync(diagnosticsPath(abs), 'utf8')
            const parsed = JSON.parse(raw)
            return json(res, 200, {
              ok: true,
              project: abs,
              updated_at: parsed.updated_at || null,
              summary: parsed.summary || null,
              files: parsed.files || {},
            })
          } catch {
            return json(res, 200, {
              ok: true,
              project: abs,
              updated_at: null,
              summary: null,
              files: {},
              empty: true,
            })
          }
        }

        // Helpers shared by the project-edit actions below.
        const requireProject = (p) => {
          if (!p) return { error: `${action} requires project=<abs>` }
          return { abs: path.resolve(p) }
        }
        const manualIndex = (abs) => store.manual.findIndex((m) => path.resolve(m.path).toLowerCase() === abs.toLowerCase())
        const persistManual = async (manual) => {
          store.manual = manual
          await persist()
          seedKnown()
        }
        const knownLspOf = (abs) => {
          const rec = known.get(abs.toLowerCase())
          return rec ? (rec.lsp || []).map((x) => x.engine) : []
        }
        const knownAutoInjectOf = (abs) => {
          const rec = known.get(abs.toLowerCase())
          return rec ? rec.autoInject : true
        }
        // Replace or add the manual entry for `abs` with exactly `engineIds`.
        const setManualLsp = async (abs, engineIds, autoInject) => {
          const manual = store.manual.slice()
          const i = manualIndex(abs)
          const entry = normalizeProjectEntry({ path: abs, lsp: engineIds.map((e) => ({ engine: e })), autoInject })
          if (i >= 0) manual[i] = entry
          else manual.push(entry)
          await persistManual(manual)
        }

        // Smart configure: probe the project (marker + shallow extension
        // evidence) and ADD only engines the project does not already carry
        // (supplement, never overwrite). Skips projects the user configured by
        // hand (manual record exists). Returns {applied, engine, added, reason}.
        if (action === 'smart') {
          const p = url.searchParams.get('project')
          const req = requireProject(p)
          if (req.error) return json(res, 400, { ok: false, error: req.error })
          const abs = req.abs
          const suggested = suggestLsp(abs)
          if (manualIndex(abs) >= 0) {
            return json(res, 200, {
              ok: true, applied: false, project: abs,
              suggested,
              reason: 'user-configured; not overwritten', manual: store.manual.length,
            })
          }
          const current = knownLspOf(abs)
          const added = suggested.filter((id) => !current.includes(id))
          if (!added.length) {
            return json(res, 200, {
              ok: true, applied: false, project: abs, suggested,
              reason: 'project already carries the suggested engines', manual: store.manual.length,
            })
          }
          // Supplement: keep current engines (config/discovered seed), add the
          // missing suggested ones. Only now do we write a manual override
          // (that freezes config for this path — documented supplement cost).
          const next = [...current]
          for (const id of added) if (!next.includes(id)) next.push(id)
          await setManualLsp(abs, next, knownAutoInjectOf(abs))
          return json(res, 200, {
            ok: true, applied: true, project: abs, engine: next, added, suggested,
            reason: 'supplemented missing engines', manual: store.manual.length,
          })
        }
        // Manual add: bind exactly one engine (v1-style single-engine replace).
        if (action === 'setProject') {
          const p = url.searchParams.get('project')
          const eng = url.searchParams.get('engine') || 'godot-lsp'
          const ai = url.searchParams.get('autoInject')
          const req = requireProject(p)
          if (req.error) return json(res, 400, { ok: false, error: req.error })
          if (!engine(eng)) return json(res, 400, { ok: false, error: `unknown engine ${eng}; available: ${enginesList().join(', ')}` })
          await setManualLsp(req.abs, [eng], ai === '0' ? false : ai === '1' ? true : undefined)
          await pruneProjectSnapshot(req.abs) // drop keyspaces of engines no longer bound
          return json(res, 200, { ok: true, project: req.abs, engine: eng, manual: store.manual.length })
        }
        // Incremental add of one LSP to a project (RFC §5): keeps current
        // effective engines and appends; idempotent when already present.
        if (action === 'addLsp') {
          const p = url.searchParams.get('project')
          const eng = url.searchParams.get('engine')
          const req = requireProject(p)
          if (req.error) return json(res, 400, { ok: false, error: req.error })
          if (!eng || !engine(eng)) return json(res, 400, { ok: false, error: `unknown engine ${eng}; available: ${enginesList().join(', ')}` })
          const current = knownLspOf(req.abs)
          if (current.includes(eng)) return json(res, 200, { ok: true, added: false, project: req.abs, lsp: current })
          const next = [...current, eng]
          await setManualLsp(req.abs, next, knownAutoInjectOf(req.abs))
          return json(res, 200, { ok: true, added: true, project: req.abs, lsp: next })
        }
        // Incremental removal of one LSP from a project. Removing the last
        // engine yields an explicit empty list (do not inject); removing from
        // a config/discovered project writes a manual override that keeps the
        // remaining engines.
        if (action === 'delLsp') {
          const p = url.searchParams.get('project')
          const eng = url.searchParams.get('engine')
          const req = requireProject(p)
          if (req.error) return json(res, 400, { ok: false, error: req.error })
          if (!eng) return json(res, 400, { ok: false, error: 'delLsp requires engine=<id>' })
          const current = knownLspOf(req.abs)
          const next = current.filter((id) => id !== eng)
          if (next.length === current.length) return json(res, 200, { ok: true, removed: false, project: req.abs, lsp: current })
          await setManualLsp(req.abs, next, knownAutoInjectOf(req.abs))
          await pruneProjectSnapshot(req.abs) // engine removed → evict its stale keyspace
          return json(res, 200, { ok: true, removed: true, project: req.abs, lsp: next })
        }
        // Restore a config-seeded project: drop the manual override so the
        // config/discovered seed applies again. Only meaningful when a config
        // or discovered seed exists for the path.
        if (action === 'resetProject') {
          const p = url.searchParams.get('project')
          const req = requireProject(p)
          if (req.error) return json(res, 400, { ok: false, error: req.error })
          const i = manualIndex(req.abs)
          if (i < 0) return json(res, 200, { ok: true, reset: false, project: req.abs, reason: 'no manual override present' })
          const manual = store.manual.slice()
          manual.splice(i, 1)
          await persistManual(manual)
          await pruneProjectSnapshot(req.abs) // back to config/discovered seed → drop manual-only keyspaces
          return json(res, 200, { ok: true, reset: true, project: req.abs })
        }
        if (action === 'delProject') {
          const p = url.searchParams.get('project')
          const req = requireProject(p)
          if (req.error) return json(res, 400, { ok: false, error: req.error })
          const i = manualIndex(req.abs)
          if (i < 0) return json(res, 200, { ok: true, removed: false, project: req.abs })
          const manual = store.manual.slice()
          manual.splice(i, 1)
          await persistManual(manual)
          await pruneProjectSnapshot(req.abs) // project may leave the effective set → drop snapshot
          return json(res, 200, { ok: true, removed: true, project: req.abs })
        }
        const resolveOne = () => {
          if (project) {
            const abs = path.resolve(project)
            const rec = known.get(abs.toLowerCase())
            if (!rec) return undefined
            const engineId = primaryEngine(rec)
            if (!engineId) return undefined
            const eng = engine(engineId)
            return eng ? { project: abs, engineId, bridge: eng.bridge } : undefined
          }
          const first = [...known.values()][0]
          if (!first) return undefined
          const engineId = primaryEngine(first)
          if (!engineId) return undefined
          const eng = engine(engineId)
          return eng ? { project: first.path, engineId, bridge: eng.bridge } : undefined
        }
        const found = resolveOne()
        if (!found) return json(res, 400, { ok: false, error: `no project resolved for action=${action}; pass project or register projects first` })
        const { project: proj, bridge } = found
        let r
        if (action === 'host') r = await ensureHost(bridge, proj, enginePortOf(found.engineId))
        else if (action === 'stop') r = await stopHost(bridge, proj)
        else if (action === 'status') {
          r = await status(bridge, proj)
          // Structured mode for the GUI: parse the bridge's one-line report.
          // Anchored on the report itself — the same line carries the project
          // path, which may contain words like "headless" or "editor".
          const out = r.stdout || ''
          let mode = 'off'
          if (/^running \(headless\)/m.test(out)) mode = 'headless'
          else if (/^running \(editor-attach\)/m.test(out)) mode = 'editor'
          else if (/^running\b/m.test(out)) mode = 'running'
          return json(res, 200, { ok: !r.fatal, project: proj, mode, stdout: out, stderr: r.stderr })
        } else if (action === 'baseline') {
          const rec = known.get(path.resolve(proj).toLowerCase())
          if (rec) {
            // Multi-engine routing: sweep every bound engine over its own files.
            const { rows, scanned, errs, warns, errFiles } = await sweepAllEngines(rec)
            return json(res, 200, {
              ok: true,
              project: proj,
              engines: rows.map((r) => r.eng),
              summary: { files_checked: scanned, errors: errs, warnings: warns, files_with_errors: errFiles },
            })
          }
          // Unknown project: legacy single-engine path.
          const ownExts = engineByBridge(bridge) ? engineByBridge(bridge).extensions : undefined
          let all = []
          try { all = [...scanFiles(proj, config.watchSkip || DEFAULT_SKIP).keys()] } catch { /* ignore */ }
          const payload = await checkFiles(bridge, proj, all, 200_000, 'baseline', ownExts, undefined, enginePortOf(found.engineId))
          return json(res, 200, {
            ok: true,
            project: proj,
            summary: payload && payload.summary ? payload.summary : { files_checked: 0, errors: 0, warnings: 0, files_with_errors: [] },
          })
        } else {
          return json(res, 400, { ok: false, error: `unknown action ${action}` })
        }
        return json(res, 200, { ok: !r.fatal, project: proj, stdout: r.stdout, stderr: r.stderr })
      } catch (error) {
        return json(res, 500, { ok: false, error: (error && error.message) || String(error) })
      }
    }
    ctx.effect(() => {
      const disposeRoute = webServer.register({ kind: 'exact', path: '/lsp-echo/api', handler: apiHandler })
      return disposeRoute
    })
  }

  // ---- auto-echo: inject diagnostics before the next model step ----------
  // Mode B: no background file polling. Every pre-step runs one full-tree
  // mtime diff against the last baseline (cheap, fully silent while the agent
  // is idle), then pushes only files that changed since the last step to the
  // engine. External edits (shell / native Godot / humans) are covered by the
  // same per-step diff — no periodic scan keeps running between requests.
  const traceLog = path.join(runtimeRoot(), 'lsp-echo-trace.log')
  const trace = (...parts) => {
    try { fs.appendFileSync(traceLog, `${new Date().toISOString()} ${parts.join(' ')}\n`) } catch { /* never break the step */ }
  }
  const lastInjected = new Map()
  let baselineStarter = null // assigned once startBaselineFor exists below
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject' || (signal && signal.aborted)) return decision
    const agentId = agent && agent.id
    const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
    if (!cwd) { trace('pre-step', agentId, 'skip: no session cwd'); return decision }
    const lowerCwd = path.resolve(cwd).toLowerCase()
    // Nested projects (e.g. a workspace root whose repo also registers a
    // sub-project like plugins/dsh-lsp-actions) both prefix-match the cwd;
    // pick the DEEPEST root so a parent record with no engines cannot shadow
    // the child project's bound engine.
    let rec
    let bestLen = -1
    for (const r of known.values()) {
      const root = r.path.toLowerCase()
      if ((lowerCwd === root || lowerCwd.startsWith(root + path.sep)) && root.length > bestLen) {
        rec = r
        bestLen = root.length
      }
    }
    if (!rec) { trace('pre-step', agentId, `skip: no known project under cwd ${cwd}`); return decision }
    if (!globalAutoInject()) { trace('pre-step', agentId, `skip: global auto-inject off for ${rec.path}`); return decision }
    if (rec.autoInject === false) { trace('pre-step', agentId, `skip: autoInject=false for ${rec.path}`); return decision }
    // Engines actually bound to this project (rec.lsp). Files are routed by
    // extension to their owning engine; every engine runs its own check.
    const boundEngines = []
    for (const x of rec.lsp || []) {
      const eng = engine(x.engine)
      if (eng) boundEngines.push(eng)
    }
    if (!boundEngines.length) { trace('pre-step', agentId, `skip: no engine bound to ${rec.path}`); return decision }
    // Fallback: opening an idle conversation does not start an agent, so the
    // session-start trigger may be missed. Start the one-time full baseline on
    // this project's first real step instead.
    if (typeof baselineStarter === 'function') baselineStarter(agent)
    const watcher = ensureWatcher(rec)
    watcher.tick() // full-tree diff at the step boundary (mode B)
    const structural = watcher.drainStructural()
    const dirty = watcher.drain().filter((f) => fs.existsSync(f)) // drop deleted files (routing would throw)
    const rescannedThisRound = new Set() // engine ids already rescanned in this round
    // A script created or deleted since the last step may declare a class_name
    // the running engine has not registered yet: refresh rescan-capable engines
    // BEFORE checking, or the first check of a file referencing it reports a
    // false unknown-type error.
    if (structural.created.length || structural.deleted.length) {
      const touched = [...structural.created, ...structural.deleted]
      const stale = boundEngines.filter((e) => e.rescan && touched.some((f) => matchExtension(e, f)))
      if (stale.length) {
        trace('pre-step', agentId, `structural change (${structural.created.length} created / ${structural.deleted.length} deleted) → engine rescan`)
        await Promise.all(stale.map(async (e) => {
          if (await tryEngineRescan(e, rec.path, 'structural change')) rescannedThisRound.add(e.id)
        }))
      }
    }
    // A pure delete or rename leaves `dirty` empty — the deleted file fails the
    // existsSync filter below and a rename only records `created` — yet that
    // round still has work: the callers of the removed script need rechecking.
    const structuralInScope = boundEngines.some((e) =>
      [...structural.created, ...structural.deleted].some((f) => matchExtension(e, f)),
    )
    if (!dirty.length && !structuralInScope) { trace('pre-step', agentId, `${rec.path}: ok, no changed files since last step`); return decision }
    // A changed script can break the files that reference it, and the engine
    // reports only on the file it is given: check the referencing files in the
    // same round, or a signature change reads as no change at all.
    let touched = dirty
    try {
      const changedGd = dirty.filter((f) => f.toLowerCase().endsWith('.gd'))
      // Watching skips addons/, but an addon script can reference a project
      // class, so dependencies are resolved over the same file set the
      // class_name index uses, addons included.
      const depSkip = (config.watchSkip || DEFAULT_SKIP).filter((d) => d !== 'addons')
      const candidates = changedGd.length ? scanFiles(rec.path, depSkip, ['.gd']).keys() : []
      const dependents = changedGd.length ? dependentsOf(rec.path, changedGd, candidates) : []
      if (dependents.length) {
        touched = [...dirty, ...dependents]
        trace('pre-step', agentId, `+${dependents.length} dependent file(s) of the changed script(s)`)
      }
    } catch (error) {
      trace('pre-step', agentId, `dependent scan failed: ${(error && error.message) || error}`)
    }
    // A deleted or renamed script leaves its callers holding an unknown type,
    // and the gone file cannot be read for the name they used: recheck the
    // project for that round instead of guessing which files to open.
    if ((structural.deleted || []).some((f) => f.toLowerCase().endsWith('.gd'))) {
      try {
        const all = [...scanFiles(rec.path, config.watchSkip || DEFAULT_SKIP, ['.gd']).keys()]
        touched = [...new Set([...touched, ...all])]
        trace('pre-step', agentId, `deleted script → project-wide recheck (${all.length} file(s))`)
      } catch (error) {
        trace('pre-step', agentId, `project-wide recheck scan failed: ${(error && error.message) || error}`)
      }
    }
    // Route the files this round checks to their owning engine by extension.
    const byEngine = new Map() // engineId -> [abs files]
    for (const eng of boundEngines) byEngine.set(eng.id, [])
    for (const f of touched) {
      const owner = boundEngines.find((eng) => matchExtension(eng, f))
      if (owner) byEngine.get(owner.id).push(f)
    }
    const tasks = []
    const keepExts = boundExtensions(rec)
    // The engine analyses from its own loaded copies, and an editor reloads a
    // script edited elsewhere only when its window regains focus. Rescan before
    // checking, or diagnostics describe the pre-edit file: a parent signature
    // edited here keeps surfacing as callers reporting the old signature.
    const contentStale = boundEngines.filter(
      (e) => e.rescan && !rescannedThisRound.has(e.id) && touched.some((f) => matchExtension(e, f)),
    )
    if (contentStale.length) {
      await Promise.all(
        contentStale.map((e) => tryEngineRescan(e, rec.path, `${touched.length} changed file(s)`, { fresh: true })),
      )
    }
    for (const eng of boundEngines) {
      const files = byEngine.get(eng.id) || []
      if (!files.length) continue
      tasks.push(
        checkWithHeal(eng, rec.path, files, 120_000, 'main', eng.extensions, keepExts)
          .then((payload) => ({ engineId: eng.id, eng, payload }))
          .catch((error) => {
            console.error(`[lsp-echo] check failed (${eng.id}): ${(error && error.message) || error}`)
            trace('pre-step', agentId, `check failed (${eng.id}): ${(error && error.message) || error}`)
            return { engineId: eng.id, eng, payload: undefined }
          }),
      )
    }
    const results = await Promise.all(tasks)
    const parts = []
    let totalErrors = 0
    let checked = 0
    const checkedNames = [] // rel basenames actually verified this round (0-error echo)
    // The merged snapshot on disk holds every engine's keyspace, so its summary
    // counts the whole project: count only the files this round asked for, per
    // engine, so totals and echoes never double-count nor report older results.
    const roundRel = new Set(touched.map((f) => path.relative(rec.path, f).split(path.sep).join('/')))
    for (const { engineId, eng, payload } of results) {
      // An engine that silently fell back to headless (dead editor LSP port)
      // still "succeeds"; surface its host-state warning once per occurrence.
      if (eng) maybeToastEngineWarn(eng, rec.path)
      if (!payload) continue
      const scope = engineScope(payload, eng ? eng.extensions : undefined)
      const scoped = { files: scope.files, summary: scope.summary }
      for (const rel of Object.keys(scoped.files)) {
        if (!roundRel.has(rel)) continue
        checked += 1
        totalErrors += scoped.files[rel].errors || 0
        const base = path.basename(rel)
        if (!checkedNames.includes(base)) checkedNames.push(base)
      }
      const text = buildEchoText(engineId, scoped)
      if (text) parts.push(text)
    }
    const text = parts.join('\n')
    trace('pre-step', agentId, `checked ${checked} changed file(s): ${totalErrors} error(s); inject=${!!text}`)
    if (!text) {
      lastInjected.set(rec.path, { text: '', at: Date.now() })
      // 本轮确有改动文件被引擎检查且全部通过 → 仍注入一句确认,AI 知道
      // 改动是干净的,不必自己再调工具去查。
      if (checked > 0) {
        const shown = checkedNames.slice(0, 3).join('、')
        const list = checkedNames.length > 3 ? `${shown} 等 ${checkedNames.length} 个` : shown
        const okText = `[lsp-echo] 已自动完成本轮编译诊断：\n- 检查文件（${checked} 个）：${list}\n- 结果：编译通过，0 错误\n- 本结论来自引擎实时检查，无需为这些文件再次运行 LSP/编译检查。`
        const okMsg = createUserMessage({
          content: [{ type: 'text', text: okText }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text: okText }] },
        })
        return { ...decision, messages: [...(decision.messages || []), okMsg] }
      }
      return decision
    }
    const prev = lastInjected.get(rec.path)
    if (prev && prev.text === text && Date.now() - prev.at < 3000) return decision
    lastInjected.set(rec.path, { text, at: Date.now() })
    const msg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
    })
    return { ...decision, messages: [...(decision.messages || []), msg] }
  }, { prepend: true })

  // ---- one-time per-process full-project baseline scan (user-facing) ------
  // Triggered by the first top-level session that enters a workspace
  // (agent/session-start, source startup|resume — i.e. the user opens that
  // workspace's conversation). Runs once per process run as a sweep request
  // on the project's single shared clientd (requests are serialized inside
  // the bridge). Progress + completion are announced through the pre-step
  // channel (both shown, also when the project is clean).
  const baseline = new Map() // projectLower -> state
  const baselineKey = (rec) => rec.path.toLowerCase()
  const B_START = '[lsp-echo] 正在做首次全量编译诊断，完成后我会汇报结果。'
  const baselineDoneText = (payload, scanned) => {
    const s = payload && payload.summary
    const errs = s ? s.errors : 0
    const filesErr = s && s.files_with_errors ? s.files_with_errors.length : 0
    if (!s || errs === 0) return `[lsp-echo] 首次全量诊断完成：扫描 ${scanned} 个文件，0 个编译错误`
    const head = `[lsp-echo] 首次全量诊断完成：${errs} 个编译错误(${filesErr} 个文件):`
    const lines = []
    for (const rel of Object.keys(payload.files || {})) {
      for (const d of payload.files[rel].diagnostics || []) {
        if (d.severity === 1 || d.severity === 2) {
          lines.push(`${rel}:${d.line}:${d.column}: [${d.severityName}] ${String(d.message || '').slice(0, 140)}`)
        }
      }
    }
    if (lines.length > 10) lines.splice(10, lines.length - 10, `… 还有 ${lines.length - 10} 条`)
    return [head, ...lines].join('\n')
  }
  const baselineRecFor = (cwdPath) => {
    // Deepest-prefix match: a nested child project must win over its parent
    // root (same shadowing concern as the pre-step resolution above).
    const lower = path.resolve(cwdPath).toLowerCase()
    let rec
    let bestLen = -1
    for (const r of known.values()) {
      const root = r.path.toLowerCase()
      if ((lower === root || lower.startsWith(root + path.sep)) && root.length > bestLen) {
        rec = r
        bestLen = root.length
      }
    }
    return rec
  }
  const baselineAttempts = new Map() // cwdLower -> attempt count (discovery may lag)
  const startBaselineFor = (agent) => {
    const hdr = agent && agent.session && agent.session.header
    // Fork children and resumed main conversations are all user-visible; gate
    // on the workspace cwd only, never on parentSession (a forked conversation
    // carries one and was being skipped before).
    if (!hdr || !hdr.cwd) return
    if (config.autoBaseline === false) {
      trace('baseline', '(auto off) would-start', agent && agent.id, hdr.cwd)
      return
    }
    if (!globalAutoInject()) {
      trace('baseline', '(global auto-inject off) would-start', agent && agent.id, hdr.cwd)
      return
    }
    const cwdLower = path.resolve(hdr.cwd).toLowerCase()
    const rec = baselineRecFor(cwdLower)
    if (!rec) {
      // Project discovery may still be running when a workspace session opens
      // first: retry briefly so the first session still gets its baseline run.
      const n = (baselineAttempts.get(cwdLower) || 0) + 1
      baselineAttempts.set(cwdLower, n)
      trace('baseline', 'miss-retry', agent && agent.id, `attempt ${n}`, hdr.cwd)
      if (n <= 6) setTimeout(() => startBaselineFor(agent), n * 1500)
      return
    }
    const key = baselineKey(rec)
    if (baseline.has(key)) return // once per process run
    const boundEngines = []
    for (const x of rec.lsp || []) {
      const eng = engine(x.engine)
      if (eng) boundEngines.push(eng)
    }
    if (!boundEngines.length) return
    const state = { status: 'running', startedAnnounced: false, doneAnnounced: false, doneText: undefined, scanned: 0 }
    baseline.set(key, state)
    trace('baseline', 'start', agent && agent.id, hdr.cwd, `full sweep for ${rec.path}`)
    showToast('info', '首次全量编译诊断进行中', `${rec.path} — 首次全量扫描中，完成后我会汇报`, `lsp-echo-baseline:${key}`, 0)
    const scanAll = (eng) => {
      let out = []
      try { out = [...scanFiles(rec.path, config.watchSkip || DEFAULT_SKIP, eng.extensions).keys()] } catch (e) { trace('baseline', 'scan failed', (e && e.message) || e) }
      return out
    }
    const noFilesDone = () => {
      // 项目没有任何引擎文件(空项目/误绑):自动 baseline 不往对话注入
      // 「没有可检查的文件」这类无信息量消息,只 toast 提示一次。
      state.status = 'done'
      state.doneText = ''
      trace('baseline', 'done', 'no engine files — auto baseline skipped, nothing injected')
      dismissToast(`lsp-echo-baseline:${key}`)
      showToast('info', '首次全量诊断完成', '项目中没有可检查的文件(无引擎文件,自动诊断已跳过)', `lsp-echo-baseline-done:${key}`, 4000)
    }
    // Single engine: unchanged fast path (one sweep, original report text).
    if (boundEngines.length === 1) {
      const eng = boundEngines[0]
      const all = scanAll(eng)
      if (!all.length) return noFilesDone()
      checkWithHeal(eng, rec.path, all, 200_000, 'baseline', eng.extensions, boundExtensions(rec))
        .then((payload) => {
          state.status = 'done'
          state.scanned = payload && payload.summary ? payload.summary.files_checked : all.length
          state.doneText = baselineDoneText(payload, state.scanned)
          trace('baseline', 'done', `scanned=${state.scanned}`)
          const errs = payload && payload.summary ? payload.summary.errors : 0
          dismissToast(`lsp-echo-baseline:${key}`)
          if (errs > 0) {
            showToast('warning', '首次全量诊断：发现编译错误', `${errs} 个错误，详见对话注入`, `lsp-echo-baseline-done:${key}`, 6000)
          } else {
            showToast('success', '首次全量诊断完成', `扫描 ${state.scanned} 个文件，0 个编译错误`, `lsp-echo-baseline-done:${key}`, 4000)
          }
        })
        .catch((e) => {
          state.status = 'done'
          state.doneText = `[lsp-echo] 首次全量诊断失败: ${(e && e.message) || e}`
          trace('baseline', 'failed', (e && e.message) || e)
          dismissToast(`lsp-echo-baseline:${key}`)
          showToast('error', '首次全量诊断失败', (e && e.message) || String(e), `lsp-echo-baseline-done:${key}`, 6000)
        })
      return
    }
    // Multi-engine: each engine sweeps its own extensions, results merge.
    const all = boundEngines.map((eng) => ({ eng, files: scanAll(eng) }))
    const keepExtsM = boundExtensions(rec)
    if (!all.some((a) => a.files.length)) return noFilesDone()
    Promise.all(all.map(async ({ eng, files }) => {
      if (!files.length) return { eng: eng.id, empty: true }
      try {
        const payload = await checkWithHeal(eng, rec.path, files, 200_000, 'baseline', eng.extensions, keepExtsM)
        return { eng: eng.id, payload }
      } catch (e) {
        return { eng: eng.id, error: (e && e.message) || String(e) }
      }
    })).then((results) => {
      state.status = 'done'
      const rows = []
      let scanned = 0
      let errs = 0
      for (const r of results) {
        if (r.payload) {
          const eng = boundEngines.find((e) => e.id === r.eng)
          // merged snapshot holds every engine's keyspace — scope to this engine
          const scope = engineScope(r.payload, eng ? eng.extensions : undefined).summary
          scanned += scope.files_checked || 0
          errs += scope.errors || 0
          rows.push(`[${r.eng}] 扫描 ${scope.files_checked || 0} 文件，${scope.errors || 0} 错误`)
        } else if (r.empty) {
          rows.push(`[${r.eng}] 无此语言文件`)
        } else {
          rows.push(`[${r.eng}] 失败: ${r.error}`)
        }
      }
      state.scanned = scanned
      state.doneText = `[lsp-echo] 首次全量诊断完成：${errs} 个编译错误(${scanned} 个文件):\n${rows.join('\n')}`
      trace('baseline', 'done', `scanned=${scanned} errs=${errs}`)
      dismissToast(`lsp-echo-baseline:${key}`)
      if (errs > 0) {
        showToast('warning', '首次全量诊断：发现编译错误', `${errs} 个错误，详见对话注入`, `lsp-echo-baseline-done:${key}`, 6000)
      } else {
        showToast('success', '首次全量诊断完成', `扫描 ${scanned} 个文件，0 个编译错误`, `lsp-echo-baseline-done:${key}`, 4000)
      }
    }).catch((e) => {
      state.status = 'done'
      state.doneText = `[lsp-echo] 首次全量诊断失败: ${(e && e.message) || e}`
      trace('baseline', 'failed', (e && e.message) || e)
      dismissToast(`lsp-echo-baseline:${key}`)
      showToast('error', '首次全量诊断失败', (e && e.message) || String(e), `lsp-echo-baseline-done:${key}`, 6000)
    })
  }
  ctx.on('agent/session-start', ({ agent, source }) => {
    const hdr = agent && agent.session && agent.session.header
    if (hdr && hdr.cwd) trace('session-start', agent && agent.id, String(source || '?'), hdr.cwd)
    startBaselineFor(agent)
  })
  baselineStarter = startBaselineFor
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject' || (signal && signal.aborted)) return decision
    const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
    if (!cwd) return decision
    const rec = baselineRecFor(path.resolve(cwd).toLowerCase())
    if (!rec) return decision
    const state = baseline.get(baselineKey(rec))
    if (!state) return decision
    let text
    if (state.status === 'done' && !state.doneAnnounced) {
      state.doneAnnounced = true
      text = state.doneText
    } else if (state.status === 'running' && !state.startedAnnounced) {
      state.startedAnnounced = true
      text = B_START
    }
    if (!text) return decision
    trace('baseline', agent && agent.id, `announce: ${text.slice(0, 80)}`)
    const msg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
    })
    return { ...decision, messages: [...(decision.messages || []), msg] }
  })

  // ---- stop every engine this plugin started when the plugin is unloaded --
  ctx.effect(() => {
    for (const rec of known.values()) {
      for (const x of rec.lsp || []) {
        const eng = engine(x.engine)
        if (eng) {
          stopHost(eng.bridge, rec.path).catch(() => {})
          stopClientd(eng.bridge, rec.path)
        }
      }
    }
  })

  // keep the effective set live when the manual/discovered layers change
  if (scope && typeof scope.watch === 'function') {
    scope.watch(() => {
      // Snapshot the pre-change bindings so settings-driven changes (external
      // edits to the manual/discovered layers, other sessions) can evict the
      // stale snapshot keyspaces of projects that lost engines or left the set.
      const prevKnown = new Map()
      for (const [k, r] of known) {
        prevKnown.set(k, { path: r.path, exts: [...boundExtensions(r)].sort().join(',') })
      }
      store = readStore()
      seedKnown()
      // drop watchers for projects that left the effective set; live ones are
      // lazily rebuilt by ensureWatcher when their extension set changes
      for (const [key, w] of [...watchers]) {
        if (!known.has(key)) watchers.delete(key)
      }
      // Evict stale diagnostics when the binding shrank or the project left.
      for (const [k, prev] of prevKnown) {
        const cur = known.get(k)
        if (!cur) { pruneProjectSnapshot(prev.path); continue }
        const curExts = [...boundExtensions(cur)].sort().join(',')
        if (curExts !== prev.exts) pruneProjectSnapshot(cur.path)
      }
    })
  }
}
