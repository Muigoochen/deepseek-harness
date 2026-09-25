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
import { engines, markers, matchExtension, preStepLimits } from './checkers.js'
import { ensureHost, stopHost, status, checkFiles, runtimeRoot, stopClientd, diagnosticsPath, pruneSnapshot, rescanEngine, setReservedPorts } from './manager.js'
import { ADDON_ID, addonResPath, discoverBridgePortAsync, installAddonInto, isAddonCurrent, isEditorPluginEnabled, probeEngineBridge, probePortOpen, readBridgeInstances, rescanPortOf } from './addon.js'
import { dependentsOf } from './dependents.js'
import { ProjectWatcher, normalizeSkipEntry, sameSkipEntry, scanFiles } from './watcher.js'
import { registerTool } from './tool.js'
import { evidenceEngines, markerHit, scanProjectRoots } from './registry.js'
import { engineScope } from './scope.js'
import { allDictionaries, getActiveLocale, localeIds, setActiveLocale, tLine } from './i18n.js'

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
  // Project-level extra skip list, comma separated (settings GUI: 项目卡片).
  // Entries are directory names matched at any depth, or project-relative paths
  // such as `addons/dsh_echo_bridge`. A string, not an array, so "unset" stays
  // distinguishable from "explicitly empty" (`z.array` would default to []).
  // Absent = fall back to Config.watchSkip.
  skipDirs: z.string(),
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
  // Auto-install the engine bridge addon into projects that lack it; absent =
  // default on. The addon is what lets a running engine be asked to rescan (so a
  // newly created `class_name` script registers instead of reporting an unknown
  // type) and what the didSave path consults for "has unsaved changes?" before
  // reloading a script. Copying it over an existing install is an update.
  autoInstallAddon: z.boolean(),
  // Editor-attach port overrides: which editor LSP port the bridge probes when
  // attaching to a user's running Godot editor. Absent = engine default (Godot
  // editor LSP default 6005). Stored as an array to keep the schemastery schema
  // portable. GUI: 设置页「引擎(LSP)」卡.
  //
  // An entry with `project` applies to that project only and outranks an
  // engine-wide entry; without it the entry covers every project using that
  // engine. Two Godot projects served by two editors need one scoped entry each,
  // because they share one engine id and would otherwise both probe one port —
  // the second editor's LSP would then be refused as serving another project.
  //
  // Project identity is the resolved root path, compared lowercased: the same
  // key the registry, the clientd pool, the baseline state and the rescan
  // cooldowns already use, so a project cannot count as one project in one place
  // and two in another. A moved project simply stops matching, falling back to
  // the engine-wide entry and then to the default.
  enginePorts: z.array(z.object({
    engine: z.string(),
    port: z.number(),
    // Optional by omission: this schemastery fork has no .optional(), fields are
    // optional unless .required(). An entry without `project` is the engine-wide
    // fallback; one with it applies to that project only.
    project: z.string(),
  })).default([]),
})

// Directories no project may watch, whatever the configuration says: build
// machinery and VCS data, never authored source. `scanFiles` and every other
// traversal here already drop dot-directories on their own, so the two dotted
// entries are redundant for today's walkers — they stay because this list is also
// what the settings card shows as "always skipped", and it is the backstop for any
// traversal added later that matches on names alone.
const FORCED_SKIP = ['node_modules', '.git', '.godot']
// Directories skipped by default but open to per-project configuration, because
// a project may keep authored source there: a Godot addon IS the deliverable for
// some projects. Two entries stay skipped out of the box: this plugin's own
// bridge addon (copied in by the plugin, its churn is not authored work) and a
// vendored `godot-cpp` checkout (the dependency, whose own test scripts and
// sources are neither this project's code nor buildable by its SConstruct).
const DEFAULT_OPTIONAL_SKIP = [`addons/${ADDON_ID}`, 'godot-cpp']
const DEFAULT_SKIP = [...FORCED_SKIP, ...DEFAULT_OPTIONAL_SKIP]

/** `res://` path of the engine bridge addon's plugin.cfg inside a project. */
const ADDON_RES_PATH = addonResPath()

/** Editor LSP port a Godot editor serves on unless its own settings say otherwise. */
const DEFAULT_EDITOR_PORT = 6005

/**
 * Parse a comma-separated skip list from the settings GUI.
 * @param {string|undefined} raw user input, e.g. `addons, build/tmp`
 * @returns {string[]} non-empty entries, trimmed, in input order
 */
function parseSkipList(raw) {
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Skip list in force for one project: forced entries plus the project's own
 * list, falling back to the global Config.watchSkip when the project sets none.
 * @param {{ skipDirs?: string }} projectEntry normalized project entry
 * @param {string[]} globalSkip Config.watchSkip
 * @returns {string[]} directory entries for scanFiles/ProjectWatcher
 */
function effectiveSkipDirs(projectEntry, globalSkip) {
  const own = projectEntry && typeof projectEntry.skipDirs === 'string' ? projectEntry.skipDirs : undefined
  const optional = own === undefined
    ? (Array.isArray(globalSkip) && globalSkip.length ? globalSkip : DEFAULT_OPTIONAL_SKIP)
    : parseSkipList(own)
  return [...FORCED_SKIP, ...optional.filter((d) => !FORCED_SKIP.some((f) => sameSkipEntry(f, d)))]
}

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
 * @returns {{ path: string, lsp: Array<{engine: string}>, autoInject?: boolean, skipDirs?: string } | undefined}
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
  if (typeof entry.skipDirs === 'string') out.skipDirs = entry.skipDirs
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
    if (markersList.some((m) => markerHit(d, m))) return d
    const parent = path.dirname(d)
    if (parent === d) return undefined
    d = parent
  }
}

function buildEchoText(engineId, payload, cap = 10) {
  const s = payload && payload.summary
  if (!s) return undefined
  // An engine may report something the per-file numbers cannot carry (this check
  // did not compile every requested file). Say it even when there is no error.
  const note = payload.engine_note ? `[lsp-echo] ${engineId}: ${payload.engine_note}` : undefined
  const rows = []
  for (const rel of Object.keys(payload.files || {})) {
    for (const d of payload.files[rel].diagnostics || []) {
      if (d.severity === 1 || d.severity === 2) {
        const msg = String(d.message || '').slice(0, 140)
        rows.push(`${rel}:${d.line}:${d.column}: [${d.severityName}] ${msg}`)
      }
    }
  }
  if (!rows.length) return note
  const head = `[lsp-echo] ${engineId} 检测到 ${s.errors} 个编译错误(${s.files_with_errors.length ? `${s.files_with_errors.length} 个文件` : '链接/构建阶段'}),来自最近的编辑:`
  const lines = rows.slice(0, cap)
  if (rows.length > cap) lines.push(`… 还有 ${rows.length - cap} 条`)
  if (note) lines.push(note)
  return [head, ...lines].join('\n')
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

  /**
   * Engines whose marker sits at `root`, with the engine that declares itself
   * the project's default first. Marker hits decide membership; the default
   * engine decides who is `lsp[0]`, which is the engine host/stop/status act on
   * and the one the projects list calls the project's engine — a Godot project
   * that keeps a `*.gdextension` at its root must not hand that role to the C++
   * checker just because the filesystem lists it first.
   * @param {string} root project root
   * @returns {string[]} engine ids, default engine first
   */
  const markerEngines = (root) => {
    const hits = []
    for (const id of enginesList()) {
      const eng = engine(id)
      if (eng && eng.marker && markerHit(root, eng.marker)) hits.push(id)
    }
    const first = hits.find((id) => engine(id) && engine(id).fallback)
    return first ? [first, ...hits.filter((id) => id !== first)] : hits
  }
  const detectEngine = (root) => {
    const ids = enginesList()
    if (!ids.length) return undefined
    const hits = markerEngines(root)
    if (hits.length) return hits[0]
    return ids.find((id) => engine(id) && engine(id).fallback) || ids[0]
  }
  /**
   * Engines a project's own root markers prove it needs. Every hit counts:
   * `project.godot` and a `*.gdextension` can sit in the same directory (a Godot
   * project whose native extension lives at its root), and binding only the
   * first hit would silently stop checking the other language. No hit at all
   * falls back to {@link detectEngine}'s declared default.
   * @param {string} root project root
   * @returns {string[]} engine ids, default engine first
   */
  const seedEngines = (root) => {
    const hits = markerEngines(root)
    if (hits.length) return hits
    const d = detectEngine(root)
    return d ? [d] : []
  }

  // Engine evidence (registry.js) is a filesystem walk, so the answer is cached:
  // it runs for every project at seed and suggestion time.
  const EVIDENCE_CACHE_MS = 600_000
  const evidenceCache = new Map() // lowercased root -> { at, ids }
  /**
   * Engine ids whose declared evidence exists under `root`, cached briefly.
   * @param {string} root project root
   * @returns {string[]}
   */
  const evidenceFor = (root, fresh = false) => {
    const key = path.resolve(root).toLowerCase()
    const hit = evidenceCache.get(key)
    if (!fresh && hit && Date.now() - hit.at < EVIDENCE_CACHE_MS) return hit.ids
    const ids = evidenceEngines(root, engineTable)
    if (evidenceCache.size >= 64) evidenceCache.clear()
    evidenceCache.set(key, { at: Date.now(), ids })
    return ids
  }

  // Suggest LSP engines for a project (RFC §4.2): marker hit at the root is the
  // strongest signal (godot-lsp for project.godot); shallow extension evidence
  // adds more engines, guarding against node_modules/.git/vendor pollution.
  const suggestLsp = (root, fresh = false) => {
    const absRoot = path.resolve(root)
    // Engine evidence comes from project sources, so build/VCS noise is skipped;
    // `addons` is NOT skipped here either — a plugin-style project keeps its
    // GDScript there.
    const skipDirs = (config.watchSkip || []).slice()
    for (const s of ['node_modules', '.git', '.venv', 'dist', 'build', 'vendor', '.dsh-build']) {
      if (!skipDirs.includes(s)) skipDirs.push(s)
    }
    const suggested = []
    // 1) marker-based: an engine whose marker sits at the project root
    for (const id of enginesList()) {
      const eng = engine(id)
      if (eng && eng.marker && markerHit(absRoot, eng.marker)) {
        if (!suggested.includes(id)) suggested.push(id)
      }
    }
    // 1b) evidence-based: an engine whose declared build layout exists deeper
    // down (a GDExtension's SConstruct + .gdextension under addons/<plugin>/…)
    for (const id of evidenceFor(absRoot, fresh)) if (!suggested.includes(id)) suggested.push(id)
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
      tLine('toast.enginePort.title', { name: eng.name }),
      warn.reason === 'wrong-project'
        ? tLine('toast.enginePort.wrongProject', { ports: warn.ports.join(', ') })
        : warn.reason === 'own-engine-port-conflict'
          ? tLine('toast.enginePort.ownConflict', { ports: warn.ports.join(', ') })
          : warn.reason === 'engine-took-reserved-port'
            ? tLine('toast.enginePort.engineHoldsPort', { ports: warn.ports.join(', ') })
            : tLine('toast.enginePort.noReply', { ports: warn.ports.join(', ') }),
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
      autoInstallAddon: v && typeof v.autoInstallAddon === 'boolean' ? v.autoInstallAddon : undefined,
      enginePorts: v && Array.isArray(v.enginePorts) ? v.enginePorts : [],
    }
  }
  /**
   * Tell the manager which editor ports this profile reserves, so a headless
   * engine it starts never binds one. Every configured port counts, not just this
   * project's: Godot opens the DAP default (6006) on any `--editor` instance, and
   * another project's reserved port must not be squatted either.
   */
  const syncReservedPorts = () => {
    setReservedPorts((store.enginePorts || []).map((x) => Number(x && x.port)))
  }
  let store = readStore()
  syncReservedPorts()
  const persist = async () => {
    if (!scope) return
    const out = { discovered: store.discovered, manual: store.manual, enginePorts: store.enginePorts }
    if (typeof store.autoInjectGlobal === 'boolean') out.autoInjectGlobal = store.autoInjectGlobal
    if (typeof store.autoInstallAddon === 'boolean') out.autoInstallAddon = store.autoInstallAddon
    await scope.replace(out)
    store = readStore() // refresh local snapshot after the durable commit
    syncReservedPorts()
  }
  /** Auto-install the engine bridge addon: settings toggle when set, else on. */
  const globalAutoAddon = () => (typeof store.autoInstallAddon === 'boolean' ? store.autoInstallAddon : true)
  /** How long a failed bridge install/enable is left alone before it is retried. */
  const ADDON_REPAIR_COOLDOWN_MS = 5 * 60_000
  const addonRepairFailures = new Map() // projectLower -> last failure time
  const addonRepairs = new Map() // projectLower -> in-flight repair
  /**
   * Install or enable the engine bridge addon of a project that needs it.
   *
   * Without the addon a running engine cannot be asked to rescan, so the first
   * check of a newly created `class_name` script reports an unknown type, and
   * the didSave path loses the "has unsaved changes?" guard that keeps it from
   * overwriting an editor buffer. Installing is idempotent — the directory is
   * copied over — so a manual install doubles as an update.
   *
   * A project whose addon files exist but whose project.godot never enabled them is
   * repaired here too: that half-state leaves a running editor invisible to this
   * plugin (it cannot report its LSP port), and an existence check alone finds
   * nothing to do. A repair that only re-writes the enable entry leaves the project's
   * running engine alone; only a freshly copied addon stops it, because that engine
   * cannot load an addon that did not exist when it started. A failure is retried only
   * after ADDON_REPAIR_COOLDOWN_MS, so an unwritable or malformed project.godot cannot
   * make every check re-copy, re-toast and restart the engine. Overlapping triggers (a
   * conversation opening while a check runs) share one attempt per project: the copy
   * writes a fixed temp path, so two interleaved attempts would race the rename and
   * report a spurious failure.
   * @param {{ path: string, lsp?: Array<{ engine: string }> }} rec project record
   * @returns {Promise<boolean>} true when the addon was installed or enabled this call
   */
  const ensureEngineBridge = (rec) => {
    const key = rec.path.toLowerCase()
    const running = addonRepairs.get(key)
    if (running !== undefined) return running
    const attempt = repairEngineBridge(rec, key).finally(() => { addonRepairs.delete(key) })
    addonRepairs.set(key, attempt)
    return attempt
  }
  /** One repair attempt; {@link ensureEngineBridge} owns single-flight and caching. */
  const repairEngineBridge = async (rec, key) => {
    if (!globalAutoAddon()) return false
    const eng = (rec.lsp || []).map((x) => engine(x.engine)).find((e) => e && e.rescan && e.addon)
    if (!eng) return false
    const installed = fs.existsSync(path.join(rec.path, 'addons', ADDON_ID, 'plugin.gd'))
    const enabled = installed && isEditorPluginEnabled(rec.path, ADDON_RES_PATH)
    // A copied addon is otherwise never refreshed, so a project that has one keeps the
    // version it was given: compare it against the shipped files and re-install on any
    // difference. The addon runs inside a Godot instance, which loads editor plugins at
    // startup, so an old copy also means old behavior until that instance restarts.
    if (enabled && isAddonCurrent(rec.path, eng)) {
      // Nothing to fix — the half-state is gone (fixed here earlier or outside the
      // plugin): stop counting it so a later failure is not held back by an old cooldown.
      addonRepairFailures.delete(key)
      return false
    }
    const failedAt = addonRepairFailures.get(key)
    if (failedAt !== undefined && Date.now() - failedAt < ADDON_REPAIR_COOLDOWN_MS) return false
    const what = !installed ? 'install' : (enabled ? 'update' : 'enable repair')
    try {
      const r = installAddonInto(rec.path, eng)
      if (!r.ok || r.enabled !== true) {
        addonRepairFailures.set(key, Date.now())
        trace('addon', `${rec.path}: engine bridge ${what} failed (enabled=${r.enabled}): ${r.error || 'unknown'}`)
        showToast('error', tLine('toast.addon.failed.title'), tLine('toast.addon.failed.body', { path: rec.path, reason: r.error || '' }), 'lsp-echo-addon', 9000)
        return false
      }
      addonRepairFailures.delete(key)
      trace('addon', `${rec.path}: engine bridge ${what === 'install' ? 'installed' : what === 'update' ? 'updated' : 'enablement repaired'} (enabled=true)`)
      if (what === 'install') {
        showToast('success', tLine('toast.addon.title'), tLine('toast.addon.body', { path: rec.path }), 'lsp-echo-addon', 9000)
      } else if (what === 'update') {
        showToast('warning', tLine('toast.addon.updated.title'), tLine('toast.addon.updated.body', { path: rec.path }), 'lsp-echo-addon', 9000)
      } else {
        showToast('warning', tLine('toast.addon.enabled.title'), tLine('toast.addon.enabled.body', { path: rec.path }), 'lsp-echo-addon', 9000)
      }
      // Only a freshly copied addon requires the engine restart: a headless engine that
      // started before the addon existed cannot load it, and the trigger that installed
      // it is a check path which starts a new engine right after (the baseline) or needs
      // one for the check that follows. A project that merely lost its project.godot
      // entry — a running Godot editor rewrites the file from the copy it loaded before
      // the entry existed — must NOT have its engine stopped here: nothing is guaranteed
      // to start it again (the badge would read "stopped"), and the next natural start
      // loads the addon anyway.
      if (!installed) {
        await stopHost(eng.bridge, rec.path).catch(() => {})
        stopClientd(eng.bridge, rec.path)
      }
      return true
    } catch (error) {
      trace('addon', `${rec.path}: auto install threw: ${(error && error.message) || error}`)
      return false
    }
  }
  /**
   * Editor-attach port configured for an engine, scoped to a project when given.
   * A project-scoped entry wins over an engine-wide one; neither present means
   * "use the engine default" (undefined).
   * @param {string} engineId engine id, e.g. 'godot-lsp'
   * @param {string} [project] project root; omitted = engine-wide lookup only
   * @returns {number|undefined} configured port
   */
  const enginePortOf = (engineId, project) => {
    const list = store.enginePorts || []
    const wanted = project ? path.resolve(project).toLowerCase() : undefined
    let engineWide
    for (const e of list) {
      if (!e || e.engine !== engineId) continue
      const p = e.port
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) continue
      if (!e.project) {
        if (engineWide === undefined) engineWide = p
        continue
      }
      if (wanted && path.resolve(e.project).toLowerCase() === wanted) return p
    }
    return engineWide
  }
  /** Editor-attach port for a bridge path (resolve its owning engine id). */
  const portForBridge = (bridge, project) => {
    const eng = engineByBridge(bridge)
    return eng ? enginePortOf(eng.id, project) : undefined
  }
  /**
   * Normalized identity of one project's port row, shared with the browser's
   * `portRowKey`. Forward slashes and lower case keep the same project spelled
   * one way on Windows and Linux; a trailing separator must not create a second
   * identity for the same directory.
   * @param {string} project project root
   * @returns {string} normalized absolute path
   */
  const portKeyOf = (project) => String(path.resolve(project)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  /**
   * Response form of the port overrides, one entry per stored row.
   *
   * `key` is the scoped identity the settings board keys its inputs by. It is
   * computed here rather than in the browser because only this side can resolve
   * and normalize a project path the same way the lookup does; two normalized
   * spellings of one project would make a saved value appear under two inputs.
   *
   * The browser builds the same string when it saves, so the two must agree
   * exactly. Resolving a Windows path keeps backslashes, and emitting them
   * verbatim made a saved value land under a key the board never asked for: the
   * port looked like it had reverted on reopening. Slashes are normalized to the
   * browser's spelling, and trailing separators are dropped.
   */
  const portEntries = () => (store.enginePorts || []).map((e) => ({
    engine: e.engine,
    port: e.port,
    ...(e.project ? { project: e.project } : {}),
    key: e.project ? `${e.engine}::${portKeyOf(e.project)}` : e.engine,
  }))
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
  // Finding an addon's port may require probing its whole scan range, and the
  // pre-step rescan runs on every step, so an answer is reused for a short
  // window. Only a found port is cached: a miss must be retried, or an engine
  // that starts later would never be picked up.
  const BRIDGE_PORT_TTL_MS = 30_000
  const bridgePortCache = new Map() // projectLower -> { port, at }
  /**
   * Control port of the project's engine addon, cached briefly.
   * @param {string} project project root
   * @param {{ rescanPort?: number }} eng engine record supplying the probe base
   * @returns {Promise<number|undefined>} the port, or undefined when none answers
   */
  const bridgePortOf = async (project, eng) => {
    const key = path.resolve(project).toLowerCase()
    const hit = bridgePortCache.get(key)
    if (hit && Date.now() - hit.at < BRIDGE_PORT_TTL_MS) return hit.port
    const port = await discoverBridgePortAsync(project, eng)
    if (port !== undefined) {
      bridgePortCache.set(key, { port, at: Date.now() })
      capState(bridgePortCache, RESCAN_STATE_CAP)
    }
    return port
  }
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
    // A running engine publishes the port it actually bound; when that record is
    // gone (another instance overwrote or removed it) the range is probed, and
    // the declared engine default is the last resort.
    const port = (await bridgePortOf(project, eng)) ?? rescanPortOf(eng)
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
          tLine('toast.rescan.title', { engine: eng.name }),
          tLine('toast.rescan.body', { project: path.basename(project) }),
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
    // included, so the index must not inherit the watcher's addons skip — but
    // every other configured skip still bounds the walk.
    const indexSkip = wideScanSkip(project)
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
   * @param {string[]} [reloadFiles] scripts whose disk content changed, for the
   *   engine to reload through the language server before it answers
   * @param {{budgetMs?: number, noWait?: boolean, stage?: string}} [limits] build-backed engines:
   *   cap the check, refuse to wait for a busy build directory, and pick the stage
   *   that answers (declared by the engine, see engine.json `preStepStage`)
   * @returns {Promise<object>} diagnostics payload
   */
  const checkWithHeal = async (eng, project, files, timeoutMs, role, ownExts, keepExts, reloadFiles, limits) => {
    const port = enginePortOf(eng.id, project)
    const payload = await checkFiles(eng.bridge, project, files, timeoutMs, role, ownExts, keepExts, port, reloadFiles,
      limits && limits.budgetMs, limits && limits.noWait, limits && limits.stage)
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
      const healed = await checkFiles(eng.bridge, project, files, retryBudgetMs, role, ownExts, keepExts, port, reloadFiles,
        limits && limits.budgetMs, limits && limits.noWait, limits && limits.stage)
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
  // known value: { path, source, lsp: [{engine}], autoInject, skipDirs } — with
  // autoInject an exemption (explicit false anywhere config/manual disables
  // injection) and skipDirs the project's own comma-separated skip list
  // (undefined = follow Config.watchSkip).
  const known = new Map() // lowercased root -> record
  const addKnown = (root, lsp, autoInject, source, skipDirs) => {
    if (!root || !fs.existsSync(root)) return
    const abs = path.resolve(root)
    const key = abs.toLowerCase()
    if (!known.has(key)) {
      known.set(key, { path: abs, source, lsp: lsp || [], autoInject: autoInject !== false, skipDirs })
    }
  }
  const setKnown = (root, lsp, autoInject, source, skipDirs) => {
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
      skipDirs: skipDirs === undefined ? (prev ? prev.skipDirs : undefined) : skipDirs,
    })
  }
  /** Seed engine list plus every engine whose declared evidence this project carries. */
  const withEvidence = (root, lsp) => {
    const out = lsp.slice()
    for (const id of evidenceFor(root)) if (!out.some((x) => x.engine === id)) out.push({ engine: id })
    return out
  }
  const seedKnown = () => {
    known.clear()
    // Order: config seeds first, then discovered (addKnown, first-wins so config
    // beats discovered on the same path), manual last via setKnown upsert
    // (manual overrides both config and discovered for that path).
    for (const p of config.projects || []) {
      const e = normalizeProjectEntry(p)
      if (!e) continue
      let lsp = entryEngineIds(e).map((id) => ({ engine: id }))
      if (!lsp.length) lsp = seedEngines(e.path).map((id) => ({ engine: id }))
      addKnown(e.path, withEvidence(e.path, lsp), e.autoInject, 'config', e.skipDirs)
    }
    for (const ws of store.discovered) {
      if (!ws) continue
      for (const root of ws.projects || []) {
        addKnown(root, withEvidence(root, seedEngines(root).map((id) => ({ engine: id }))), true, 'workspace')
      }
    }
    // The manual layer is the user's own binding and is adopted verbatim: an
    // explicit empty list means "no engines", and an engine removed by hand must
    // not reappear. The settings page supplements it on request (`?action=smart`),
    // which is where a by-hand binding gains an evidence engine.
    for (const m of store.manual) {
      if (!m || !m.path) continue
      setKnown(m.path, entryEngineIds(m).map((engine) => ({ engine })), m.autoInject, 'manual', m.skipDirs)
    }
  }
  /** Project's own skip list in force, resolved through the effective record. */
  const skipDirsOf = (absRoot) => {
    const rec = known.get(path.resolve(absRoot).toLowerCase())
    return effectiveSkipDirs(rec, config.watchSkip)
  }
  /**
   * Skip list for the two scans whose scope must exceed the watcher's: the
   * `class_name` index and the dependent-file candidates. Godot registers global
   * class names for the whole `res://` tree and an addon script may reference a
   * project class, so anything naming an `addons` directory is released here even
   * when the watcher skips it. Every other configured entry still applies, so a
   * user's `vendor`/`build` keeps bounding the walk. Releasing the whole `addons`
   * subtree (not just the directory itself) is the deliberate cost of that
   * correctness: on a project with a huge vendored addon these two walks cover it
   * once per changed script.
   */
  const wideScanSkip = (absRoot) => skipDirsOf(absRoot).filter((d) => {
    const n = normalizeSkipEntry(d).toLowerCase()
    return n !== 'addons' && !n.startsWith('addons/')
  })
  seedKnown()
  if (known.size) {
    showToast('info', tLine('toast.ready.title'), tLine('toast.ready.body', { count: known.size, engines: enginesList().join(', ') }), 'lsp-echo-ready', 4000)
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
  // Extensionless snapshot keys (an engine's `<link>`-style buckets) of the
  // engines still bound: prune must keep them for the same reason the write path
  // refuses to evict them — no extension table can see them.
  const boundSynthetic = (rec) => {
    const keys = []
    for (const e of rec.lsp || []) {
      const eng = engine(e.engine)
      for (const k of (eng && eng.syntheticKeys) || []) if (!keys.includes(k)) keys.push(k)
    }
    return keys
  }
  const pruneProjectSnapshot = async (absRoot) => {
    const rec = known.get(path.resolve(absRoot).toLowerCase())
    await pruneSnapshot(absRoot, rec ? boundExtensions(rec) : [], rec ? boundSynthetic(rec) : [])
  }
  const ensureWatcher = (rec) => {
    const key = rec.path.toLowerCase()
    let w = watchers.get(key)
    const wantExts = projectExtensions(rec)
    const wantSkips = skipDirsOf(rec.path)
    // The skip list is a construction argument and can change behind this
    // process (another session, or a hand edit of the settings file), so it
    // belongs in the cache key alongside the extensions.
    const wantKey = `${wantExts.join(',')}|${wantSkips.join(',')}`
    if (w && w.cacheKey === wantKey) return w
    if (w) w.tick() // flush edits since the last tick into dirty before rebuild
    const fresh = new ProjectWatcher(rec.path, wantSkips, wantExts)
    fresh.cacheKey = wantKey
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
    // Single-flight: claimed before the first await so the enable-time call and
    // an agent/created call cannot both scan and persist the same set. A trigger
    // arriving while a sync is in flight is dropped, not queued; the next
    // agent/created retries it.
    syncing = true
    try {
      let wsList = []
      try {
        wsList = await svc.list()
      } catch (error) {
        console.warn(`[lsp-echo] workspaceRegistry.list failed: ${(error && error.message) || error}`)
        return
      }
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
        const previousDiscovered = store.discovered
        store.discovered = nextDiscovered
        try {
          await persist()
        } catch (error) {
          // Best effort, not a guarantee: a settings write that started while this
          // one was in flight already carries nextDiscovered and commits it after
          // this failure. Restoring still keeps memory and disk agreeing in the
          // ordinary case (persist() refreshes the local snapshot only after the
          // durable write).
          store.discovered = previousDiscovered
          throw error
        }
        seedKnown()
        const newly = nextDiscovered.filter((d) => !beforeKeys.has(d.key) && d.projects.length)
        if (newly.length) {
          showToast('success', tLine('toast.discovered.title'), `${tLine('toast.discovered.body')}\n${newly.map((d) => d.title || d.path).join('\n')}`, 'lsp-echo-discover', 6000)
        }
      }
    } catch (error) {
      // Both callers are fire-and-forget (the enable-time call and the `void` in
      // the agent/created listener), so a failure must be reported here instead
      // of surfacing as an unhandled rejection, which stops the process.
      console.warn(`[lsp-echo] workspace sync failed: ${(error && error.message) || error}`)
    } finally {
      syncing = false
    }
  }
  if (config.autoDiscover !== false) void syncWorkspaces() // fire and forget at enable
  // A workspace entering DSH is judged once (design §5). The listener stays off
  // the serial creation dispatch: `void` keeps discovery from holding it.
  ctx.on('agent/created', () => { void syncWorkspaces() })

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
      try { files = [...scanFiles(rec.path, skipDirsOf(rec.path), eng.extensions).keys()] } catch { /* keep [] */ }
      if (!files.length) { rows.push({ eng: eng.id, empty: true }); return }
      try {
        const payload = await checkWithHeal(eng, rec.path, files, timeoutMs, 'baseline', eng.extensions, keepExts)
        // merged snapshot holds every engine's keyspace; per-engine view only
        const scope = engineScope(payload, eng.extensions, eng.syntheticKeys)
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
      // A marker found inside a registered project (a GDExtension's SConstruct,
      // for example) resolves to that inner directory, while the project the user
      // configured is the outer one. Prefer the deepest known record containing
      // the resolved root, so the tool and the pre-step report into one keyspace.
      let rec = known.get(root.toLowerCase())
      if (!rec) {
        const lower = root.toLowerCase()
        for (const r of known.values()) {
          const rp = r.path.toLowerCase()
          if (rp !== lower && !lower.startsWith(rp + path.sep)) continue
          if (!rec || r.path.length > rec.path.length) rec = r
        }
      }
      // Route by the extension of a file that exists: one project can carry
      // several engines, and its primary engine may not own this file.
      const picked = (files || []).find((f) => fs.existsSync(path.resolve(f)))
      const byFile = rec && picked
        ? (rec.lsp || []).map((x) => engine(x.engine)).find((e) => e && matchExtension(e, picked))
        : undefined
      const engineId = (byFile && byFile.id) || (rec && primaryEngine(rec)) || detectEngine(root) || 'godot-lsp'
      const eng = engine(engineId)
      if (!eng) throw new Error(`lsp-echo: engine '${engineId}' not bundled under checkers/`)
      return { project: rec ? rec.path : root, engineId, bridge: eng.bridge }
    },
    abs: absPath,
    ensure: (bridge, project) => ensureHost(bridge, project, portForBridge(bridge, project)),
    stop: stopHost,
    stopClient: stopClientd,
    status,
    // Model-facing `check` must write through the same keyspace-merge writer as
    // every other engine check. Resolve the project's engine from `known` (the
    // tool resolves a bridge already, but its extensions are what matter for
    // ownedExts/keepExts); unknown projects fall back to bare checkFiles.
    check: async (bridge, project, files, timeoutMs) => {
      const rec = known.get(path.resolve(project).toLowerCase())
      if (!rec) return checkFiles(bridge, project, files, timeoutMs, 'main', undefined, undefined, portForBridge(bridge, project))
      const keepExts = boundExtensions(rec)
      const ownExts = engineByBridge(bridge) ? engineByBridge(bridge).extensions : boundExtensions(rec)
      const eng = engineByBridge(bridge)
      if (eng) return checkWithHeal(eng, project, files, timeoutMs || 120_000, 'main', ownExts, keepExts)
      return checkFiles(bridge, project, files, timeoutMs || 120_000, 'main', ownExts, keepExts, portForBridge(bridge, project))
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
        manual.push(normalizeProjectEntry({ path: abs, lsp: seedEngines(abs).map((id) => ({ engine: id })), autoInject: inherit ? false : undefined }))
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
          if (r.scope) {
            parts.push(`[${r.eng}] 扫描 ${r.scope.files_checked || 0} 文件，${r.scope.errors || 0} 错误`)
            // What the engine did not get to check belongs next to its counts.
            if (r.payload && r.payload.engine_note) parts.push(`[${r.eng}] ${r.payload.engine_note}`)
          } else if (r.empty) parts.push(`[${r.eng}] 无此语言文件`)
          else parts.push(`[${r.eng}] 失败: ${r.error}`)
        }
        return parts.join('\n')
      }
      // Unknown project: legacy single-engine path (resolved bridge only).
      const ownExts = engineByBridge(bridge) ? engineByBridge(bridge).extensions : undefined
      let all = []
      try { all = [...scanFiles(project, skipDirsOf(project)).keys()] } catch { /* ignore */ }
      if (!all.length) return '[lsp-echo] 项目里没有可检查的文件'
      const payload = await checkFiles(bridge, project, all, 200_000, 'baseline', ownExts, undefined, portForBridge(bridge, project))
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
    // (projects/engines/diagnostics/status/addCandidates/bridgeStatus/locales)
    // stay open.
    const MUTATING_ACTIONS = new Set(['installAddon', 'smart', 'setProject', 'addLsp', 'delLsp', 'setSkipDirs', 'resetProject', 'delProject', 'baseline', 'host', 'stop'])
    const apiHandler = async (req, res) => {
      try {
        if ((req.method || 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        const url = new URL(req.url || '/', 'http://lsp-echo.local')
        const action = url.searchParams.get('action')
        const project = url.searchParams.get('project')
        // config/enginePort are read-only without their parameter and writes with
        // it; setLocale records the browser's language as a write for the same
        // reason — it changes the language Host-side text is rendered in.
        const mutatingQuery = (action === 'config' && url.searchParams.has('autoInject'))
          || (action === 'enginePort' && url.searchParams.has('port'))
          || (action === 'setLocale' && url.searchParams.has('locale'))
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
              // The project's own optional skip list (undefined = following the
              // global Config.watchSkip) and what it resolves to right now.
              skipDirs: typeof r.skipDirs === 'string' ? r.skipDirs : undefined,
              effectiveSkip: effectiveSkipDirs(r, config.watchSkip),
              forcedSkip: FORCED_SKIP,
            })),
          })
        }
        // ---- settings-page management actions (no engine host required) ----
        if (action === 'engines') {
          const detail = Object.values(engineTable).map((e) => ({ id: e.id, name: e.name, marker: e.marker, extensions: e.extensions, rescan: !!e.rescan, addon: e.addon || null, evidence: e.evidence || null }))
          return json(res, 200, { ok: true, engines: detail })
        }
        // In-project engine bridge addon: copy it into the project and register
        // it in project.godot, so a running engine can be asked to rescan.
        if (action === 'installAddon') {
          const abs = project ? path.resolve(project) : undefined
          if (!abs) return json(res, 400, { ok: false, error: 'installAddon requires project=<abs>' })
          const rec = known.get(abs.toLowerCase())
          const eng = rec ? (rec.lsp || []).map((x) => engine(x.engine)).find((e) => e && e.rescan && e.addon) : undefined
          if (!eng) return json(res, 400, { ok: false, error: tLine('settings.bridge.err.unsupported') })
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
          // A running addon publishes the port it actually bound; when that
          // record is missing the range is probed, and the engine default is the
          // last resort.
          const published = abs ? await bridgePortOf(abs, eng) : undefined
          const port = published ?? (eng ? rescanPortOf(eng) : undefined)
          const installed = abs ? fs.existsSync(path.join(abs, 'addons', ADDON_ID, 'plugin.gd')) : false
          const probe = eng ? await probeEngineBridge(port) : { online: false, error: tLine('settings.bridge.err.noRescan') }
          return json(res, 200, { ok: true, project: abs || null, port: port ?? 0, declared: !!eng, installed, online: !!probe.online, error: probe.error })
        }
        // The plugin's own text, one dictionary per language. The browser half is
        // a zero-build module that cannot import JSON, so it fetches them here and
        // registers them with the Client's `locale` service.
        if (action === 'locales') {
          return json(res, 200, { ok: true, locales: allDictionaries(), active: getActiveLocale(), ids: localeIds() })
        }
        // Only the browser knows which language the user picked, and Host-side
        // text (toasts) has to match the GUI the user is reading.
        if (action === 'setLocale') {
          return json(res, 200, { ok: true, active: setActiveLocale(url.searchParams.get('locale') || '') })
        }
        // Global switches (RFC §7): GET returns the effective values; GET with
        // autoInject=0|1 or autoAddon=0|1 persists that toggle to the settings
        // store. autoAddon is the engine-bridge auto-install switch.
        if (action === 'config') {
          const ai = url.searchParams.get('autoInject')
          const aa = url.searchParams.get('autoAddon')
          const writesInject = ai === '0' || ai === '1'
          const writesAddon = aa === '0' || aa === '1'
          if (writesInject) store.autoInjectGlobal = ai === '1'
          if (writesAddon) store.autoInstallAddon = aa === '1'
          if (writesInject || writesAddon) {
            await persist()
            seedKnown()
          }
          return json(res, 200, { ok: true, autoInject: globalAutoInject(), autoAddon: globalAutoAddon(), enginePorts: portEntries() })
        }
        // Engine editor-attach port override (编辑器 LSP 端口). GET engine=<id>
        // with port=<n> persists; an empty/missing port clears the override.
        // No project required — the port belongs to the engine on this machine.
        if (action === 'enginePort') {
          const eng = url.searchParams.get('engine')
          if (!eng || !engine(eng)) return json(res, 400, { ok: false, error: `enginePort requires engine=<id>; available: ${enginesList().join(', ')}` })
          // Omitting `project` writes the engine-wide entry; passing it scopes the
          // override to that project, which is what two editors need.
          const projectRaw = url.searchParams.get('project')
          const project = projectRaw ? path.resolve(projectRaw) : undefined
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
          const list = (store.enginePorts || []).filter((x) => x.engine !== eng || (x.project ? path.resolve(x.project).toLowerCase() !== (project ? project.toLowerCase() : '') : Boolean(project)))
          if (port > 0) list.push(project ? { engine: eng, project, port } : { engine: eng, port })
          store.enginePorts = list
          await persist()
          return json(res, 200, { ok: true, engine: eng, port, project: project || null, enginePorts: portEntries() })
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
              // The GUI renders both: the engine's own note, and which snapshot
              // keys are synthetic buckets rather than file paths.
              engine_note: parsed.engine_note || null,
              synthetic_keys: Array.isArray(parsed.synthetic_keys) ? parsed.synthetic_keys : [],
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
        // The project's own skip list, so an engine edit does not erase it: the
        // manual entry is the only place a project-level list lives, and every
        // caller of setManualLsp rewrites that whole entry.
        const knownSkipOf = (abs) => {
          const rec = known.get(abs.toLowerCase())
          return rec && typeof rec.skipDirs === 'string' ? rec.skipDirs : undefined
        }
        // Replace or add the manual entry for `abs` with exactly `engineIds`.
        const setManualLsp = async (abs, engineIds, autoInject) => {
          const manual = store.manual.slice()
          const i = manualIndex(abs)
          const entry = normalizeProjectEntry({ path: abs, lsp: engineIds.map((e) => ({ engine: e })), autoInject, skipDirs: knownSkipOf(abs) })
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
          const suggested = suggestLsp(abs, true)
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
        // Per-project skip list (settings GUI: 项目卡片的「跳过目录」输入框).
        // `skipDirs` is a comma-separated raw string; an empty value is an
        // explicit "skip nothing optional", not "unset" — resetProject restores
        // the global fallback. Forced entries are never stored, so they cannot
        // be removed by editing this field.
        if (action === 'setSkipDirs') {
          const p = url.searchParams.get('project')
          const req = requireProject(p)
          if (req.error) return json(res, 400, { ok: false, error: tLine('err.skip.needProject') })
          // An absent parameter is a caller bug, not "empty": only an explicit
          // empty value means "watch everything optional".
          if (!url.searchParams.has('skipDirs')) {
            return json(res, 400, { ok: false, error: tLine('err.skip.needValue') })
          }
          const raw = url.searchParams.get('skipDirs') || ''
          // A project that is not in the effective set has no engines to bind:
          // accepting it would create a phantom card from a typo'd path.
          if (!known.has(req.abs.toLowerCase())) {
            return json(res, 400, { ok: false, error: tLine('err.skip.unknownProject', { path: req.abs }) })
          }
          // Forced entries are dropped through the same normalization and case
          // rule the matcher uses, so `node_modules/` or `Node_Modules` cannot be
          // stored and echoed back. Duplicates collapse too.
          const kept = []
          for (const d of parseSkipList(raw)) {
            if (FORCED_SKIP.some((f) => sameSkipEntry(f, d))) continue
            if (kept.some((k) => sameSkipEntry(k, d))) continue
            // An entry that normalizes to nothing (`/`, `//`, `./`) would be
            // stored as '' and match nothing; drop it here so the input box never
            // shows an empty or `", "` list.
            const norm = normalizeSkipEntry(d)
            if (!norm) continue
            kept.push(norm)
          }
          const value = kept.join(', ')
          const manual = store.manual.slice()
          const i = manualIndex(req.abs)
          const entry = normalizeProjectEntry({
            path: req.abs,
            lsp: knownLspOf(req.abs).map((e) => ({ engine: e })),
            autoInject: knownAutoInjectOf(req.abs),
            skipDirs: value,
          })
          if (i >= 0) manual[i] = entry
          else manual.push(entry)
          await persistManual(manual)
          // No explicit watcher eviction: the resolved skip list is part of the
          // watcher cache key, so the next ensureWatcher rebuilds it — and that
          // path adopts the pending dirty/created/deleted sets instead of
          // dropping them.
          return json(res, 200, {
            ok: true, project: req.abs, skipDirs: value,
            effective: effectiveSkipDirs(entry, config.watchSkip),
            forced: FORCED_SKIP,
          })
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
        if (action === 'host') r = await ensureHost(bridge, proj, enginePortOf(found.engineId, proj))
        else if (action === 'stop') r = await stopHost(bridge, proj)
        else if (action === 'status') {
          const rec = known.get(path.resolve(proj).toLowerCase())
          const editorPort = enginePortOf(found.engineId, proj)
          // The editor port travels with the call: the bridge reports back the port it
          // would attach on, which is the settings override, the machine config, or the
          // default — not something this side can infer.
          r = await status(bridge, proj, editorPort)
          // Structured mode for the GUI: parse the bridge's one-line report.
          // Anchored on the report itself — the same line carries the project
          // path, which may contain words like "headless" or "editor".
          const out = r.stdout || ''
          let mode = 'off'
          if (/^running \(headless\)/m.test(out)) mode = 'headless'
          else if (/^running \(editor-attach\)/m.test(out)) mode = 'editor'
          else if (/^running\b/m.test(out)) mode = 'running'
          // Anchored on the running line, like the mode checks above: a project path
          // that happens to contain "editorProbe=..." must not decide the port.
          const runningLine = /^running\b[^\n]*$/m.exec(out)
          const probeMatch = runningLine === null ? null : /\beditorProbe=(\d+)\b/.exec(runningLine[0])
          const editorProbe = probeMatch === null ? undefined : Number(probeMatch[1])
          // Facts that let the panel explain why a project is still on our own
          // engine: is that editor port answered, has an instance published its
          // ports, and is the bridge addon installed and enabled at all. Cheap and
          // handshake-free — an editor LSP serves one session, so only a plain TCP
          // connect may be used to probe it.
          const probePort = editorProbe || editorPort || DEFAULT_EDITOR_PORT
          const instances = rec ? readBridgeInstances(rec.path) : {}
          const listening = await probePortOpen(probePort)
          return json(res, 200, {
            ok: !r.fatal,
            project: proj,
            mode,
            stdout: out,
            stderr: r.stderr,
            editor: { port: probePort, listening, instance: !!instances.editor },
            bridge: {
              installed: !!(rec && fs.existsSync(path.join(rec.path, 'addons', ADDON_ID, 'plugin.gd'))),
              enabled: !!(rec && isEditorPluginEnabled(rec.path, ADDON_RES_PATH)),
            },
          })
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
          try { all = [...scanFiles(proj, skipDirsOf(proj)).keys()] } catch { /* ignore */ }
          const payload = await checkFiles(bridge, proj, all, 200_000, 'baseline', ownExts, undefined, enginePortOf(found.engineId, proj))
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
  // Failure notices (per project + engine + failure class): a check that could not
  // run is reported once, then at most once per cooldown while it keeps failing.
  const failNotice = new Map()
  const FAIL_NOTICE_COOLDOWN_MS = 180_000
  const MAX_NOTICE_ENTRIES = 200
  // A failed check hands its files back to the watcher, but only a bounded number
  // of times per edit: a build slower than the pre-step budget must not cost that
  // budget on every step, and the injected note must never promise a retry that
  // will not happen. The allowance belongs to one content of the file, so an edit
  // (a moved mtime) starts it over.
  const buildRetries = new Map() // lowercased abs path -> { count, mtimeMs, at }
  const MAX_BUILD_RETRIES = 2
  const MAX_RETRY_ENTRIES = 500
  /** Keep a bounded map small by dropping its oldest entries. */
  const capMap = (map, max) => {
    if (map.size <= max) return
    const stale = [...map.entries()]
      .sort((a, b) => ((a[1] && a[1].at) || 0) - ((b[1] && b[1].at) || 0))
      .slice(0, map.size - max)
    for (const [key] of stale) map.delete(key)
  }
  /**
   * Stable class of a failed check: its message embeds a budget and a build pid,
   * so keying a cooldown on the raw text would mint a fresh key every attempt.
   * @param {string} message engine failure message
   * @returns {'timeout'|'busy'|'other'} class the cooldown keys on
   */
  const failureClass = (message) => (/did not finish within/.test(message) ? 'timeout'
    : /already building|does not wait/.test(message) ? 'busy' : 'other')
  /**
   * Decide which files a failed check hands back to the watcher, counting one
   * attempt per file content.
   * @param {string[]} files absolute paths the failed check was given
   * @returns {{keep: string[], attempts: number}} files to re-check, and the highest attempt count
   */
  const planRetry = (files) => {
    const keep = []
    let attempts = 0
    for (const file of files) {
      let mtimeMs
      try { mtimeMs = fs.statSync(file).mtimeMs } catch { mtimeMs = undefined }
      const key = file.toLowerCase()
      const prev = buildRetries.get(key)
      const count = prev && prev.mtimeMs === mtimeMs ? prev.count + 1 : 1
      attempts = Math.max(attempts, count)
      buildRetries.set(key, { count, mtimeMs, at: Date.now() })
      if (count <= MAX_BUILD_RETRIES) keep.push(file)
    }
    capMap(buildRetries, MAX_RETRY_ENTRIES)
    return { keep, attempts }
  }
  let baselineStarter = null // assigned the guarded startBaseline below
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
    // Before any watcher work: a project missing the engine bridge addon cannot
    // be asked to rescan, and its didSave path has no unsaved-changes guard. This
    // runs before the baseline below, which may start an engine — repairing the
    // addon stops the engine it replaces, and stopping one the baseline has just
    // started would fail that sweep.
    await ensureEngineBridge(rec)
    // Fallback: the agent/created trigger can miss (a session resumed under a
    // project whose discovery had not finished yet, or a plugin reload mid
    // session). Start the one-time full baseline on this project's first real
    // step instead.
    if (typeof baselineStarter === 'function') baselineStarter(agent)
    const watcher = ensureWatcher(rec)
    watcher.tick() // full-tree diff at the step boundary (mode B)
    const structural = watcher.drainStructural()
    const dirty = watcher.drain().filter((f) => fs.existsSync(f)) // drop deleted files (routing would throw)
    // A file created since the last step is new work for every engine that owns
    // it: without this a new script or C++ file is silently never checked (the
    // structural signal only exists to make engines rescan their project).
    const createdOwned = structural.created.filter(
      (f) => fs.existsSync(f) && boundEngines.some((e) => matchExtension(e, f)),
    )
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
    let touched = [...new Set([...dirty, ...createdOwned])]
    try {
      const changedGd = [...dirty, ...createdOwned].filter((f) => f.toLowerCase().endsWith('.gd'))
      // A changed script can break the files that reference it, and the engine
      // reports only on the file it is given: the dependent candidates come from
      // the same file set the class_name index uses, so `addons` is released
      // while every other configured skip still applies.
      const depSkip = wideScanSkip(rec.path)
      const candidates = changedGd.length ? scanFiles(rec.path, depSkip, ['.gd']).keys() : []
      const dependents = changedGd.length ? dependentsOf(rec.path, changedGd, candidates) : []
      if (dependents.length) {
        touched = [...new Set([...touched, ...dependents])]
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
        // Same scope as the dependent candidates above: a deleted class_name can
        // be referenced from an addon script, so `addons` is released here too.
        const all = [...scanFiles(rec.path, wideScanSkip(rec.path), ['.gd']).keys()]
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
    // Scripts whose disk content changed this round, handed to the engine so it
    // reloads them through the language server before it answers. A filesystem
    // rescan deliberately skips a script that is open in the script editor
    // (EditorFileSystem::_should_reload_script), which leaves the parse tree its
    // dependents read with the pre-edit members; didSave rebuilds that tree.
    const changedScripts = [...dirty, ...createdOwned].filter((f) => f.toLowerCase().endsWith('.gd'))
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
      // A build-backed engine declares a small check budget and refuses to wait
      // for a busy build directory: a step never blocks behind a cold rebuild,
      // and the files stay pending for the next step instead (see the catch).
      // It also declares which stage answers a pre-step check (see preStepLimits);
      // the self-heal re-check below inherits that stage on purpose, because it
      // re-asks the same question after a rescan.
      const limits = preStepLimits(eng)
      const hostTimeoutMs = eng.budgetMs ? eng.budgetMs + 20_000 : 120_000
      tasks.push(
        checkWithHeal(eng, rec.path, files, hostTimeoutMs, 'main', eng.extensions, keepExts,
          changedScripts.filter((f) => matchExtension(eng, f)), limits)
          .then((payload) => ({ engineId: eng.id, eng, payload, files }))
          .catch((error) => {
            const message = (error && error.message) || String(error)
            console.error(`[lsp-echo] check failed (${eng.id}): ${message}`)
            trace('pre-step', agentId, `check failed (${eng.id}): ${message}`)
            // A check that did not run verified nothing: hand its files back to
            // the watcher (bounded per file content, see planRetry) so a later
            // step retries them instead of dropping the round as if it were clean.
            const retry = planRetry(files)
            for (const f of retry.keep) watcher.dirty.add(f)
            return { engineId: eng.id, eng, payload: undefined, failure: message, files, retry }
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
    for (const { engineId, eng, payload, failure, files, retry } of results) {
      // An engine that silently fell back to headless (dead editor LSP port)
      // still "succeeds"; surface its host-state warning once per occurrence.
      if (eng) maybeToastEngineWarn(eng, rec.path)
      if (failure) {
        // Never let a check that did not run read as a clean round. Repeat the
        // same failure class at most once per cooldown, so a project whose build
        // cannot keep up does not inject the same sentence on every step.
        const key = `${rec.path.toLowerCase()}::${engineId}::${failureClass(failure)}`
        const last = failNotice.get(key)
        if (!last || Date.now() - last.at > FAIL_NOTICE_COOLDOWN_MS) {
          failNotice.set(key, { at: Date.now() })
          capMap(failNotice, MAX_NOTICE_ENTRIES)
          const tail = retry && retry.keep.length
            ? `（其中 ${retry.keep.length} 个文件已留在待检查列表，下一步会自动重试，同一内容最多重试 ${MAX_BUILD_RETRIES} 次；这不等于没有问题。）`
            : `（已尝试 ${retry ? retry.attempts : 1} 次仍未跑完，不再自动重试；需要时先手动构建一次，或显式调 lsp_echo check；这不等于没有问题。）`
          parts.push(`[lsp-echo] ${engineId} 这一轮没跑完，你刚才改的文件没有被验证：${failure}\n${tail}`)
        }
        continue
      }
      if (!payload) continue
      // The check verified these files: the next edit starts a fresh allowance.
      if (files) for (const f of files) buildRetries.delete(f.toLowerCase())
      const scope = engineScope(payload, eng ? eng.extensions : undefined, eng ? eng.syntheticKeys : undefined)
      const scoped = { files: scope.files, summary: scope.summary, engine_note: payload && payload.engine_note }
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
        const okText = `[lsp-echo] 已自动完成本轮编译诊断：\n- 检查文件（${checked} 个）：${list}\n- 结果：本次检查 0 错误\n- 本结论来自引擎实时检查，无需为这些文件再次运行 LSP/编译检查。`
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

  // ---- one-time per-mount full-project baseline scan (user-facing) --------
  // Triggered when a session's agent is announced (agent/created — the user
  // opens that workspace's conversation, before typing; common sources are
  // startup and resume, and the listener does not filter on it). Runs once per
  // plugin mount and project as a sweep request
  // on the project's single shared clientd (requests are serialized inside
  // the bridge). Progress + completion are announced through the pre-step
  // channel (both shown, also when the project is clean).
  const baseline = new Map() // projectLower -> state
  const baselineKey = (rec) => rec.path.toLowerCase()
  const B_START = '[lsp-echo] 正在做首次全量编译诊断，完成后我会汇报结果。'
  // TODO(baseline-lag): a cold engine answers "no diagnostics" before it has finished
  // its first project import, so this summary can report "0 个编译错误" while broken
  // scripts sit on disk, and report them only in a later round. Observed on the first
  // baseline after enabling: two hard syntax errors present, "扫描 29 个文件，0 个编译错误",
  // with the four errors arriving afterwards. Until this waits for the engine's first
  // scan to settle (or retries until the reported file set stops growing), the result is
  // a first signal, not a gate — a caller must not treat "0 errors" here as a pass.
  // See README「已知问题」.
  const baselineDoneText = (payload, scanned) => {
    const s = payload && payload.summary
    const errs = s ? s.errors : 0
    const filesErr = s && s.files_with_errors ? s.files_with_errors.length : 0
    if (!s || errs === 0) return `[lsp-echo] 首次全量诊断完成：扫描 ${scanned} 个文件，0 个编译错误`
    const head = `[lsp-echo] 首次全量诊断完成：${errs} 个编译错误(${filesErr ? `${filesErr} 个文件` : '链接/构建阶段'}):`
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
      if (n <= 6) setTimeout(() => startBaseline(agent), n * 1500)
      return
    }
    const key = baselineKey(rec)
    if (baseline.has(key)) return // once per mount
    const boundEngines = []
    for (const x of rec.lsp || []) {
      const eng = engine(x.engine)
      if (eng) boundEngines.push(eng)
    }
    if (!boundEngines.length) return
    const state = { status: 'running', startedAnnounced: false, doneAnnounced: false, doneText: undefined, scanned: 0 }
    baseline.set(key, state)
    trace('baseline', 'start', agent && agent.id, hdr.cwd, `full sweep for ${rec.path}`)
    showToast('info', tLine('toast.baseline.running.title'), tLine('toast.baseline.running.body', { path: rec.path }), `lsp-echo-baseline:${key}`, 0)
    const scanAll = (eng) => {
      let out = []
      try { out = [...scanFiles(rec.path, skipDirsOf(rec.path), eng.extensions).keys()] } catch (e) { trace('baseline', 'scan failed', (e && e.message) || e) }
      return out
    }
    const noFilesDone = () => {
      // 项目没有任何引擎文件(空项目/误绑):自动 baseline 不往对话注入
      // 「没有可检查的文件」这类无信息量消息,只 toast 提示一次。
      state.status = 'done'
      state.doneText = ''
      trace('baseline', 'done', 'no engine files — auto baseline skipped, nothing injected')
      dismissToast(`lsp-echo-baseline:${key}`)
      showToast('info', tLine('toast.baseline.empty.title'), tLine('toast.baseline.empty.body'), `lsp-echo-baseline-done:${key}`, 4000)
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
            showToast('warning', tLine('toast.baseline.errors.title'), tLine('toast.baseline.errors.body', { count: errs }), `lsp-echo-baseline-done:${key}`, 6000)
          } else {
            showToast('success', tLine('toast.baseline.done.title'), tLine('toast.baseline.done.body', { scanned: state.scanned }), `lsp-echo-baseline-done:${key}`, 4000)
          }
        })
        .catch((e) => {
          state.status = 'done'
          state.doneText = `[lsp-echo] 首次全量诊断失败: ${(e && e.message) || e}`
          trace('baseline', 'failed', (e && e.message) || e)
          dismissToast(`lsp-echo-baseline:${key}`)
          showToast('error', tLine('toast.baseline.failed.title'), (e && e.message) || String(e), `lsp-echo-baseline-done:${key}`, 6000)
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
          const scope = engineScope(r.payload, eng ? eng.extensions : undefined, eng ? eng.syntheticKeys : undefined).summary
          scanned += scope.files_checked || 0
          errs += scope.errors || 0
          rows.push(`[${r.eng}] 扫描 ${scope.files_checked || 0} 文件，${scope.errors || 0} 错误`)
          if (r.payload && r.payload.engine_note) rows.push(`[${r.eng}] ${r.payload.engine_note}`)
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
        showToast('warning', tLine('toast.baseline.errors.title'), tLine('toast.baseline.errors.body', { count: errs }), `lsp-echo-baseline-done:${key}`, 6000)
      } else {
        showToast('success', tLine('toast.baseline.done.title'), tLine('toast.baseline.done.body', { scanned }), `lsp-echo-baseline-done:${key}`, 4000)
      }
    }).catch((e) => {
      state.status = 'done'
      state.doneText = `[lsp-echo] 首次全量诊断失败: ${(e && e.message) || e}`
      trace('baseline', 'failed', (e && e.message) || e)
      dismissToast(`lsp-echo-baseline:${key}`)
      showToast('error', tLine('toast.baseline.failed.title'), (e && e.message) || String(e), `lsp-echo-baseline-done:${key}`, 6000)
    })
  }
  // Every call site is a timer callback or the pre-step waterfall listener, where
  // a synchronous throw would become an uncaught exception or fail the step, so
  // the trigger goes through one guard.
  const startBaseline = (agent) => {
    try {
      startBaselineFor(agent)
    } catch (error) {
      trace('baseline', 'start failed', (error && error.message) || error)
    }
  }
  // Opening a conversation announces the session's agent (source=resume for a
  // stored conversation, startup for a new one) before the first message, so
  // the full sweep overlaps the user typing. Any later re-creation (clear,
  // compact) is harmless: the sweep is once per mount and per project.
  ctx.on('agent/created', ({ agent, source }) => {
    const hdr = agent && agent.session && agent.session.header
    if (hdr && hdr.cwd) trace('created', agent && agent.id, String(source || '?'), hdr.cwd)
    // Deferred: agent/created is serial and awaited, and startBaselineFor enumerates
    // the project synchronously before its first await — on a large project that
    // would delay the creation dispatch, i.e. the conversation opening itself.
    // Starting once per mount and per project makes the deferral free.
    setTimeout(() => {
      // Repair the engine bridge before the sweep picks an engine: opening a
      // conversation is the earliest moment to notice a project whose addon files
      // were copied but never enabled, and a running editor stays invisible to this
      // plugin until that is fixed. The gates match the check path, so a project with
      // injection switched off is not touched.
      const rec = hdr && hdr.cwd ? baselineRecFor(hdr.cwd) : undefined
      const repairs = rec !== undefined && globalAutoInject() && rec.autoInject !== false
      const prepared = repairs ? ensureEngineBridge(rec) : Promise.resolve(false)
      prepared.catch(() => false).then(() => startBaseline(agent))
    }, 0)
  })
  baselineStarter = startBaseline
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
  // The loop belongs in the DISPOSER: a Cordis effect runs its callback at setup and
  // treats the return value as cleanup, so the inline form stopped the engines of
  // every known project while this plugin was being loaded — it killed a warm engine
  // another instance had started on the same DSH home (and on every restart), while
  // stopping nothing on unload.
  ctx.effect(() => async () => {
    const stops = []
    for (const rec of known.values()) {
      for (const x of rec.lsp || []) {
        const eng = engine(x.engine)
        if (eng) {
          stops.push(stopHost(eng.bridge, rec.path).catch(() => {}))
          stopClientd(eng.bridge, rec.path)
        }
      }
    }
    // Awaited so the unload really waits for the stop: a fire-and-forget stop races
    // process exit and would leave engines running.
    await Promise.allSettled(stops)
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
      syncReservedPorts()
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
