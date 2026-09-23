#!/usr/bin/env node
// godot-lsp.mjs — zero-dependency Godot GDScript diagnostics bridge.
//
// Talks LSP over TCP to a headless Godot editor it launches itself, then
// writes machine-readable diagnostics to a JSON file and prints a summary.
// Portable: no npm deps, no hardcoded paths (auto-detect + config + flags).
//
// Subcommands:
//   check <file...>  Check one or more .gd files (disk content) and write JSON.
//   smoke <file>     Open a real file, inject a parse error in the LSP buffer,
//                    verify it is reported, restore. Writes nothing to disk.
//   watch [--dir .]  Watch project .gd files; push changes; rewrite JSON on errors.
//   host             Start the headless LSP host and keep it running (no checks).
//   stop             Stop the headless LSP host for the resolved project.
//
// Flags (any position): --project <dir>  --godot <exe>  --out <json>
//                        --port <n>       --once         --verbose
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOLING_DIR = path.dirname(fileURLToPath(import.meta.url));
// Host state and snapshots live under the DSH home, beside the files the plugin
// writes, so every copy of this bridge (repo checkout and profile install) reads
// one location. LEGACY_RUNTIME_DIR is the engine-local directory used before
// that move and stays a read fallback, so an upgrade keeps reusing the engine
// that is already running instead of starting a second one.
const HOME_DIR = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const RUNTIME_DIR = path.join(HOME_DIR, 'lsp-echo-runtime', 'godot-lsp');
const LEGACY_RUNTIME_DIR = path.join(TOOLING_DIR, '.runtime');
// Machine config (godotBin, defaultProject) is machine-local, so it lives under
// the DSH home as well. It used to sit inside the engine directory, which breaks
// once a profile installs this package as a link to the checkout: the installer
// would write this machine's absolute paths into the repository. The old
// location stays a read fallback so an existing config keeps working.
const CONFIG_PATH = path.join(HOME_DIR, 'lsp-echo', 'godot-lsp.config.json');
const LEGACY_CONFIG_PATH = path.join(TOOLING_DIR, 'godot-lsp.config.json');
const BOOT_TIMEOUT_MS = 150_000;
const DIAG_TIMEOUT_MS = 25_000;

/** Machine config, preferring the DSH home location over the legacy in-package one. */
function machineConfig() {
  return readJsonSafe(CONFIG_PATH) || readJsonSafe(LEGACY_CONFIG_PATH) || {};
}

// ---------- tiny helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[gd-lsp]', ...a);
const errl = (...a) => console.error('[gd-lsp]', ...a);
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return undefined; }
}
function fileUri(absPath) {
  const p = absPath.replace(/\\/g, '/');
  return 'file:///' + (p.startsWith('/') ? p.replace(/^\/+/, '') : p);
}
function decodeUri(uri) {
  try { return decodeURIComponent(uri); } catch { return uri; }
}
function baseNameOf(dir) {
  return (path.basename(path.resolve(dir)) || 'godot').replace(/[^A-Za-z0-9._-]/g, '_');
}
function isGdFile(name) {
  return name.endsWith('.gd') || name.endsWith('.gdshader');
}

// ---------- CLI / config ----------
function parseArgs(argv) {
  const flags = {};
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) {
        flags[key] = a.slice(eq + 1);
      } else if (key === 'once' || key === 'verbose') {
        flags[key] = true;
      } else {
        // value may be attached ('--project=dir') or next token ('--project dir')
        flags[key] = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      }
    } else {
      files.push(a);
    }
  }
  return { flags, files };
}
function configEntry(flags, key, envVar, aliases = []) {
  if (flags[key] !== undefined && flags[key] !== true && flags[key] !== '') return flags[key];
  const cfg = machineConfig();
  if (cfg) {
    for (const k of [key, ...aliases]) {
      if (cfg[k] !== undefined && cfg[k] !== '') return cfg[k];
    }
  }
  if (envVar && process.env[envVar]) return process.env[envVar];
  return undefined;
}
function findProject(flags, extraHint) {
  const explicit = configEntry(flags, 'project', undefined, ['defaultProject']);
  if (explicit) {
    const abs = path.resolve(explicit);
    if (fs.existsSync(path.join(abs, 'project.godot'))) return abs;
    throw new Error(`project not found or missing project.godot: ${abs}`);
  }
  const cfg = machineConfig();
  const hint = (extraHint || (cfg && cfg.defaultProject) || process.cwd());
  let dir = path.resolve(hint);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'project.godot'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('no project.godot found; run inside a Godot project, or set defaultProject in ' + CONFIG_PATH + ', or pass --project <dir>');
}

// ---------- Godot executable resolution ----------
function probeVersion(candidate) {
  try {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status === 0) return String(r.stdout || '').trim().split('\n')[0];
  } catch { /* keep probing */ }
  return undefined;
}
function resolveGodot(flags) {
  const fromCfg = configEntry(flags, 'godot', 'GODOT_BIN', ['godotBin']);
  if (fromCfg) {
    const abs = path.resolve(fromCfg);
    if (fs.existsSync(abs)) return { bin: abs, how: 'config' };
    throw new Error(`configured godot binary not found: ${abs} (fix godotBin in ${CONFIG_PATH} or use --godot <exe>)`);
  }
  for (const name of ['godot', 'godot4', 'godot4.7', 'godot4.6', 'godot4.5', 'godot4.4']) {
    const ver = probeVersion(name);
    if (ver) return { bin: name, how: `PATH (${name})`, version: ver };
  }
  if (process.platform === 'win32') {
    const sh = spawnSync('where', ['godot'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (sh.status === 0 && sh.stdout) {
      const first = sh.stdout.split(/\r?\n/)[0].trim();
      if (first && fs.existsSync(first)) return { bin: first, how: 'PATH(where godot)', version: probeVersion(first) };
    }
  }
  throw new Error(
    'Godot executable not found. Install Godot 4.2+, then add it to PATH,\n' +
    '  or set "godotBin" in ' + CONFIG_PATH + ', or pass --godot <exe>.'
  );
}

// ---------- ports / process tree ----------
// OS-chosen free port, retried while it lands inside `exclude`. The kernel hands
// out ephemeral ports, so colliding with a reserved low port is unlikely but not
// impossible — and a reserved port is exactly the one that must never be taken.
function freePort(exclude = []) {
  return new Promise((resolve, reject) => {
    const tryOnce = (attempt) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => {
          if (!exclude.includes(p) || attempt >= 20) resolve(p);
          else tryOnce(attempt + 1);
        });
      });
    };
    tryOnce(0);
  });
}
function portOpen(port) {
  // net.connect throws synchronously on an out-of-range port; a stale settings
  // value must not take the whole check down with an unrelated RangeError.
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(800);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    }
  } catch { /* gone */ }
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---------- editor bridge control socket (dsh_echo_bridge addon) ----------
// The addon runs inside the editor and inside `--editor --headless` engines and
// turns "rescan" into EditorFileSystem.scan_sources(). Godot only registers
// global class names while scanning the project filesystem, so a running engine
// otherwise never notices class_name scripts created after it started.
const DEFAULT_BRIDGE_PORT = 6089;

/** Ask the addon inside the running engine to rescan the project filesystem. */
function askBridgeRescan(port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let out = '';
    let settled = false;
    const done = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already closed */ }
      resolve(res);
    };
    const timer = setTimeout(() => done({ ok: false, error: `no reply within ${timeoutMs}ms` }), timeoutMs);
    sock.once('connect', () => { try { sock.write('rescan\n'); } catch { done({ ok: false, error: 'write failed' }); } });
    sock.on('data', (d) => {
      out += d;
      // Whole-line matching: some other local service answering with the word
      // "ok" inside a larger payload must not count as an acknowledgement.
      const lines = out.split(/\r?\n/).map((line) => line.trim());
      if (lines.includes('ok')) done({ ok: true });
      else if (lines.some((line) => line.startsWith('err'))) done({ ok: false, error: out.trim() });
    });
    sock.once('error', (e) => done({ ok: false, error: e.message }));
    sock.once('close', () => {
      const lines = out.split(/\r?\n/).map((line) => line.trim());
      if (!lines.includes('ok')) done({ ok: false, error: 'closed without acknowledgement' });
    });
  });
}
/** The `res://` form of an absolute path, or undefined when it is outside the project. */
function toResourcePath(project, absPath) {
  const rel = path.relative(project, absPath).split(path.sep).join('/');
  return rel.startsWith('..') ? undefined : `res://${rel}`;
}

/**
 * Ask the addon whether that script has unsaved changes in the script editor.
 * Resolves to `{ ok: false }` when no addon answers, so callers can tell
 * "no unsaved changes" apart from "could not ask".
 */
function askBridgeUnsaved(port, resourcePath, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let out = '';
    let settled = false;
    const done = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already closed */ }
      resolve(res);
    };
    const timer = setTimeout(() => done({ ok: false, error: `no reply within ${timeoutMs}ms` }), timeoutMs);
    sock.once('connect', () => {
      try { sock.write(`unsaved:${resourcePath}\n`); } catch { done({ ok: false, error: 'write failed' }); }
    });
    sock.on('data', (d) => {
      out += d;
      const lines = out.split(/\r?\n/).map((line) => line.trim());
      if (lines.includes('yes')) done({ ok: true, unsaved: true });
      else if (lines.includes('no')) done({ ok: true, unsaved: false });
      else if (lines.some((line) => line.startsWith('err'))) done({ ok: false, error: out.trim() });
    });
    sock.once('error', (e) => done({ ok: false, error: e.message }));
    sock.once('close', () => done({ ok: false, error: 'closed without an answer' }));
  });
}

/**
 * Make the language server reload the scripts whose disk content changed.
 *
 * `didSave` is the only LSP entry that rebuilds a script's parse tree:
 * `GDScriptTextDocument::didSave` calls `reload(true)`, and `reload` runs
 * `GDScriptCache::remove_parser`, which also drops the reverse-dependency
 * entries that would otherwise pin the previous tree for as long as a referring
 * script stays open. A filesystem rescan does not reach those scripts at all:
 * `EditorFileSystem::_should_reload_script()` deliberately skips a script that
 * is open in the script editor, leaving its cached members stale.
 *
 * Scripts with unsaved editor changes are skipped. The reload rewrites the
 * editor buffer from disk (`ScriptEditor::update_docs_from_script`, reached
 * through `reload_script`), and the engine itself refuses to do that without
 * asking — `ScriptEditor::_test_script_times_on_disk` sets `need_ask` whenever
 * `seb->is_unsaved()`. Asking the addon mirrors that guard; failing to reach the
 * addon still sends the notification, because the guard is a safety check rather
 * than a precondition.
 */
async function reloadChangedScripts(client, project, absFiles, bridgePort) {
  for (const abs of absFiles) {
    const resourcePath = toResourcePath(project, abs);
    if (!resourcePath) continue;
    if (bridgePort) {
      const answer = await askBridgeUnsaved(bridgePort, resourcePath);
      if (answer.ok && answer.unsaved) {
        log(`skipping didSave for ${resourcePath}: unsaved editor changes`);
        continue;
      }
      if (!answer.ok) log(`unsaved check unavailable (${answer.error}); sending didSave for ${resourcePath}`);
    }
    client.notify('textDocument/didSave', { textDocument: { uri: fileUri(abs) } });
    log(`didSave sent for ${resourcePath} (rebuilds its parse tree)`);
  }
}

/** Explicitly configured bridge port (flag > config file > environment), else undefined. */
function configuredBridgePort(flags) {
  const raw = configEntry(flags, 'bridge-port', 'DSH_ECHO_BRIDGE_PORT', ['bridgePort']);
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? n : undefined;
}
/**
 * Port published by the addon of the engine running for this project. Each
 * instance walks upward from its base port until it binds (two open projects,
 * or an editor plus a headless fallback, never share one port) and records the
 * winner in `<project>/.godot/dsh_echo_bridge.json`.
 */
function discoveredBridgePort(project) {
  const slots = readBridgeSlots(project);
  const record = slots.editor ?? slots.engine;
  return record === undefined ? undefined : record.port;
}

/** How many control ports above the base an addon instance may occupy (mirrors the addon). */
const BRIDGE_SCAN_COUNT = 16;

/** Normalized absolute path, for "does this instance serve the project I asked about?". */
function sameProjectPath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** One instance record from the published file, or undefined when it is not a live one. */
function normalizeSlot(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  const pid = Number(raw.pid);
  if (Number.isInteger(pid) && pid > 0) {
    // A record left behind by an exited engine points at a port nothing answers on.
    try { process.kill(pid, 0); } catch { return undefined; }
  }
  const lspPort = Number(raw.lspPort);
  const dapPort = Number(raw.dapPort);
  return {
    port,
    pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
    project: typeof raw.project === 'string' ? raw.project : undefined,
    lspPort: Number.isInteger(lspPort) && lspPort > 0 && lspPort <= 65535 ? lspPort : undefined,
    dapPort: Number.isInteger(dapPort) && dapPort > 0 && dapPort <= 65535 ? dapPort : undefined,
    lspFromLaunch: raw.lspFromLaunch === true,
  };
}

/**
 * Addon instances serving a project, by kind.
 *
 * The record keeps one slot per kind because the user's editor and this plugin's
 * own headless engine serve one project at the same time; instances are identified
 * by PROJECT PATH, never by port. A record written before the slots existed holds
 * one flat instance, filed under the kind its `lspFromLaunch` flag names.
 */
function readBridgeSlots(project) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(path.join(project, '.godot', 'dsh_echo_bridge.json'), 'utf8')); }
  catch { return {}; }
  if (!parsed || typeof parsed !== 'object') return {};
  const version = Number(parsed.version);
  if (Number.isInteger(version) && version >= 3) {
    const out = {};
    const editor = normalizeSlot(parsed.editor);
    if (editor) out.editor = editor;
    const engine = normalizeSlot(parsed.engine);
    if (engine) out.engine = engine;
    return out;
  }
  const flat = normalizeSlot(parsed);
  if (!flat) return {};
  return flat.lspFromLaunch ? { engine: flat } : { editor: flat };
}

/** One line answer from the addon's control socket, or undefined when none came. */
function askBridgeLine(port, request, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let out = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already closed */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    sock.once('connect', () => { try { sock.write(request); } catch { done(undefined); } });
    sock.on('data', (d) => {
      out += d;
      const newline = out.indexOf('\n');
      if (newline >= 0) done(out.slice(0, newline).trim());
    });
    sock.once('error', () => done(undefined));
    sock.once('close', () => done(out.trim() || undefined));
  });
}

/** The instance's own facts, or undefined when it cannot report them (old addon). */
async function askBridgeState(port, timeoutMs = 1500) {
  const line = await askBridgeLine(port, 'state\n', timeoutMs);
  if (line === undefined || !line.startsWith('state:')) return undefined;
  try {
    const parsed = JSON.parse(line.slice('state:'.length));
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch { return undefined; }
}

/**
 * Ask the addon to move the editor's language server to `targetPort`.
 * @param {number} port control port
 * @param {number} targetPort port to move to
 * @returns {Promise<{ ok: boolean, port?: number, error?: string }>} the port it moved to
 */
async function askBridgeRelocate(port, targetPort, timeoutMs = 20_000) {
  const line = await askBridgeLine(port, `lsp-relocate:${targetPort}\n`, timeoutMs);
  if (line === undefined) return { ok: false, error: 'no reply' };
  if (line.startsWith('ok:')) {
    const moved = Number(line.slice('ok:'.length));
    if (Number.isInteger(moved) && moved > 0 && moved <= 65535) return { ok: true, port: moved };
  }
  return { ok: false, error: line.startsWith('err:') ? line.slice('err:'.length) : line };
}

/**
 * The addon instance serving this project, asked over the control socket.
 *
 * Candidates come from the record's per-kind slots first (asking the instance is
 * what proves it serves this project and gives current facts), and the control
 * range is probed after that, for a record overwritten before the slots existed.
 * @returns {Promise<{ controlPort: number, kind: 'editor'|'engine', state: object }|undefined>}
 */
async function findProjectInstance(project, flags) {
  const slots = readBridgeSlots(project);
  const candidates = [];
  for (const record of [slots.editor, slots.engine]) if (record) candidates.push(record.port);
  const base = configuredBridgePort(flags) ?? DEFAULT_BRIDGE_PORT;
  for (let offset = 0; offset < BRIDGE_SCAN_COUNT; offset++) {
    const port = base + offset;
    if (!candidates.includes(port)) candidates.push(port);
  }
  for (const port of candidates) {
    const state = await askBridgeState(port, 700);
    if (state === undefined) continue;
    const owner = typeof state.project === 'string' ? state.project : undefined;
    if (owner !== undefined && !sameProjectPath(owner, project)) continue;
    return { controlPort: port, kind: state.lspFromLaunch === true ? 'engine' : 'editor', state };
  }
  return undefined;
}

/** Wait until something listens on a port, so the caller attaches to a ready server. */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await portOpen(port)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(400);
  }
}

/**
 * Make the running editor's language server listen where this profile wants it.
 *
 * The plugin owns the port setting, so the EDITOR adapts to it rather than the
 * other way round: the addon reports where its server actually listens, and when
 * that differs the addon is asked to move it (it applies a project-level override
 * the engine re-reads on the spot, without writing the user's editor settings).
 *
 * A configured port that something else holds cannot be honoured — Godot's own
 * debug adapter defaults to the very port users tend to pick, and the engine never
 * yields. The server is then moved to a free substitute and the substitution is
 * recorded for the host, which owns the setting and can adopt it.
 * @param {string} project project root
 * @param {object} flags parsed CLI flags
 * @returns {Promise<number|undefined>} the port to attach to, undefined when no editor instance answers
 */
async function alignEditorTarget(project, flags) {
  const target = editorProbePorts(flags)[0];
  const instance = await findProjectInstance(project, flags);
  if (instance === undefined || instance.kind !== 'editor') {
    // No editor instance we can talk to: the editor is not running, or the copy of the
    // bridge addon inside it predates the `state` command and cannot report its ports.
    // Fall back to plain reachability on the configured port — without facts that is
    // all a caller can know, and refusing to attach would strand every editor whose
    // addon has not been updated yet.
    return probeEditorPort(project, flags);
  }
  const actual = Number(instance.state.lspPort);
  if (Number.isInteger(actual) && actual === target && await portOpen(target)) return target;
  let chosen = target;
  if (await portOpen(target)) {
    // Something holds the configured port. Godot's debug adapter is the usual
    // owner (its default equals the port users pick), so say which it is.
    const dapPort = Number(instance.state.dapPort);
    const owner = dapPort === target ? 'this editor\'s debug adapter' : 'another program';
    chosen = await freePort(reservedPorts(flags));
    log(`configured editor port ${target} is held by ${owner}; moving the language server to ${chosen}`);
  }
  const moved = await askBridgeRelocate(instance.controlPort, chosen);
  if (!moved.ok) {
    log(`editor language server relocation failed (${moved.error}); leaving the editor as it is`);
    return undefined;
  }
  log(`editor language server: ${actual || 'unknown'} -> ${moved.port} (configured ${target})`);
  if (!(await waitForPort(moved.port, 20_000))) {
    log(`moved language server did not open port ${moved.port}`);
    return undefined;
  }
  if (moved.port !== target) {
    // Record the substitution where the host reads it: it owns the setting, so only
    // it can adopt the new port and tell the user. Written even when no host state
    // exists yet (a cold start) — the attach path that follows carries it forward.
    try {
      writeHostState(project, {
        // `project` is what makes the record readable back: readHostState() ignores a
        // record whose project does not match, and a warning-only record without it
        // would be dropped by the attach write that follows.
        project: path.resolve(project),
        warn: { ports: [target], port: moved.port, at: Date.now(), reason: 'editor-port-relocated' },
      });
      log(`editor port substitution recorded: configured ${target} -> ${moved.port}`);
    } catch (error) {
      log(`recording the editor port substitution failed: ${(error && error.message) || error}`);
    }
  }
  return moved.port;
}

// ---------- runtime state ----------
function statePaths(project) {
  const name = baseNameOf(project);
  return {
    name,
    host: path.join(RUNTIME_DIR, `host-${name}.json`),
    legacyHost: path.join(LEGACY_RUNTIME_DIR, `host-${name}.json`),
    out: path.join(RUNTIME_DIR, `lsp_diagnostics-${name}.json`),
    hostLog: path.join(RUNTIME_DIR, `host-${name}.log`),
  };
}
function readHostState(project) {
  for (const file of [statePaths(project).host, statePaths(project).legacyHost]) {
    const s = readJsonSafe(file);
    // Case-insensitive: the same project can reach a check through a differently
    // cased path, and missing our own record there starts a second engine.
    if (s && s.project && path.resolve(s.project).toLowerCase() === path.resolve(project).toLowerCase()) return s;
  }
  return undefined;
}
// mode 'editor' = attached to a user's already-running Godot editor LSP
// (never own/kill that process). mode 'headless' = engine we spawned.
const MODE_HEADLESS = 'headless';
const MODE_EDITOR = 'editor';

// Whether a check moves a project onto the user's editor when that editor comes
// up after our own engine started. 'prefer-editor' (default) stops our headless
// engine and attaches to the editor, leaving one engine per project;
// 'cold-start' keeps whichever engine started first. Attaching opens a new
// session on a single-session server, so any other client already attached to
// that editor is evicted by the move.
function attachPolicy() {
  const cfg = machineConfig();
  return cfg && cfg.attachPolicy === 'cold-start' ? 'cold-start' : 'prefer-editor';
}

// Whether attaching to the editor is allowed at all. `attachEditor:false` means
// headless only, and it outranks the attach policy: a machine that turned
// attach off must not be moved onto the editor by a later policy default.
function attachEditorEnabled() {
  const cfg = machineConfig();
  return !(cfg && cfg.attachEditor === false);
}

// ---------- attach-to-editor probing (smart connection) ----------
// Returns the TCP port of a running Godot editor LSP, or undefined. Never
// spawns anything. Trust model mirrors the official godot-vscode-plugin: the
// editor on the configured editor LSP port IS the current project's editor
// (single-editor setups). Our own headless engines always bind free random
// ports, so a live peer on the editor port can only be the user's editor.
// Port source: explicit --editor-port flag (the GUI settings override, passed
// by the host) > bridge config `editorPort` (or legacy array `editorPorts`) >
// default 6005. Users with non-default editor ports set theirs in the plugin's
// settings page, which the host forwards as --editor-port.
const DEFAULT_EDITOR_PORTS = [6005];
function tailFile(p, n) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - n)).join('\n');
  } catch { return '(no host log)'; }
}

function editorProbePorts(flags) {
  // 1) explicit --editor-port (the host forwards the settings-page override).
  //    parseArgs keeps the dashed key verbatim ('editor-port', not editorPort).
  const dashed = flags && (flags['editor-port'] || flags.editorPort);
  if (dashed) {
    const n = Number(dashed);
    if (n > 0) return [n];
  }
  // 2) bridge config file (machine-level default when no GUI override is set)
  const cfg = machineConfig();
  if (cfg) {
    if (typeof cfg.editorPort === 'number' && cfg.editorPort > 0) return [cfg.editorPort];
    if (Array.isArray(cfg.editorPorts) && cfg.editorPorts.length) return cfg.editorPorts;
  }
  return DEFAULT_EDITOR_PORTS;
}
/** Parse a comma-separated port list coming from a CLI flag. */
function parsePortList(value) {
  return String(value == null ? '' : value)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
}
/**
 * Ports our own headless engine must never bind: every port the profile reserves
 * for a user editor (all `enginePorts` entries, forwarded by the host as
 * `--reserve-ports`) plus this project's editor probe ports. `--lsp-port` alone
 * does not cover this, because a Godot `--editor` instance independently opens
 * its DAP listener — default 6006 — which is how an engine of ours once squatted
 * the port a user had reserved for their editor LSP.
 * @param {object} flags parsed CLI flags
 * @returns {number[]} reserved ports, deduplicated
 */
function reservedPorts(flags) {
  return [...new Set([...parsePortList(flags && flags['reserve-ports']), ...editorProbePorts(flags)])];
}
// Godot editor LSP serves ONE client session. Probing it with extra LSP
// handshakes kicks the active session (the editor logs "Connection Taken" /
// "Disconnected" per probe), so an editor is selected by TCP reachability
// only. Real liveness is decided by the single session attachClient opens,
// which blacklists the port on handshake failure instead of ever re-probing.
function probeEditorPort(project, flags) {
  return new Promise(async (resolve) => {
    for (const port of editorProbePorts(flags)) {
      if (await portOpen(port)) { resolve(port); return; }
    }
    resolve(undefined);
  });
}

// ---------- headless host lifecycle / smart connection ----------
async function hostAlive(st) {
  if (!st) return false;
  // Editor LSP is single-session; never probe it with extra connections (that
  // kicks the active client, logging "Connection Taken"). TCP reachability
  // plus the attachClient handshake own the editor liveness decision.
  if (st.mode === MODE_EDITOR) return !!(await portOpen(st.port));
  return isAlive(st.pid) && (await portOpen(st.port));
}
function writeHostState(project, state) {
  // Atomic replace so concurrent readers never observe a half-written JSON.
  const p = statePaths(project).host;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  // A refusal record outlives the mode it was recorded under: starting our own
  // engine after refusing a peer replaces the state object, and dropping the
  // record there would make the next check probe that peer again.
  const previous = readHostState(project);
  const carried = {};
  if (previous) {
    // A refusal and its warning outlive the mode they were recorded under:
    // starting our own engine, or moving onto an editor, replaces the state
    // object, and dropping them there would re-probe a refused port and lose
    // the user-facing warning. Expiry is decided where they are read.
    if (state.badEditor === undefined && previous.badEditor) carried.badEditor = previous.badEditor;
    if (state.warn === undefined && previous.warn) carried.warn = previous.warn;
    // `ownPorts`/`ownPid` describe the engine we last spawned. They must survive a
    // mode switch (attaching to an editor stops that engine but the record still
    // explains who held a port), because the attach-failure path uses them to tell
    // "our own engine took this port" from "a foreign program did". They must NOT
    // survive a clear (`writeHostState(project, {})`), which would otherwise leave a
    // half-record naming an engine that no longer exists.
    const describesHost = state.mode !== undefined || state.port !== undefined;
    if (describesHost && state.ownPorts === undefined && previous.ownPorts) carried.ownPorts = previous.ownPorts;
    if (describesHost && state.ownPid === undefined && previous.ownPid) carried.ownPid = previous.ownPid;
  }
  fs.writeFileSync(tmp, JSON.stringify({ ...state, ...carried }, null, 2), 'utf8');
  try { fs.renameSync(tmp, p); } catch { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
  // Retire the pre-move copy: it is only a read fallback, and a stale record
  // left beside a live one makes `status` answer from the wrong file.
  try { fs.unlinkSync(statePaths(project).legacyHost); } catch { /* nothing to retire */ }
}

// Cross-process lock around the headless-host start decision. Two bridge
// processes can race here (baseline + main clientd roles both call ensureHost
// during first boot); without serialization each sees "no live host" in state
// and spawns its own headless — one orphan engine is leaked per race.
// mkdirSync is atomic on the target filesystems, so a lock directory is the
// mutex; the owner pid inside lets a crashed holder's stale lock be broken.
// While waiting we re-check recorded state: if the winner already brought a
// host up, we hand back immediately instead of forcing the timeout.
// Returns a release() function, or the string 'host-ready' when the other
// process finished first (caller should just reuse the recorded host).
async function acquireHostLock(project, timeoutMs = BOOT_TIMEOUT_MS + 15_000) {
  const lockPath = hostLockPath(project);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      try {
        fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
      } catch { /* owner note is best-effort */ }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* best effort */ }
      };
    } catch (mkdirError) {
      if (mkdirError.code !== 'EEXIST') throw mkdirError; // e.g. permissions: fail loudly
      // Lock held. Break it when the holder is gone (crashed process).
      let ownerPid;
      try { ownerPid = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')).pid; } catch { ownerPid = undefined; }
      if (ownerPid !== undefined && ownerPid !== process.pid && !isAlive(ownerPid)) {
        try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* raced */ }
        continue;
      }
      // While we wait, the winner may have completed: reuse their host.
      const live = readHostState(project);
      if (await hostAlive(live)) return 'host-ready';
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for host lock ${lockPath} (holder pid=${ownerPid})`);
      }
      await sleep(150);
    }
  }
}
function hostLockPath(project) {
  return `${statePaths(project).host}.lock`;
}

/**
 * Resolve a live LSP endpoint for `project`:
 *  1. reuse a live host/attach recorded in state;
 *  2. attach to a running Godot editor whose LSP serves this project;
 *  3. otherwise spawn our own headless engine.
 * Returns { pid, port, mode, reused }. mode 'editor' means we are guests on a
 * user's editor process — stop/cleanup must never kill that process.
 */
async function ensureHost(project, godotBin, flags) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const paths = statePaths(project);
  // Editor ports that accepted TCP but failed an LSP handshake are blacklisted
  // for a while so we do not keep re-selecting a dead/fake peer.
  const badActive = (s) => s && s.badEditor && Date.now() - s.badEditor.at < 5 * 60_000;

  // 0) A live headless we own is normally reused as-is. Under the default
  //    `prefer-editor` policy, first ask whether the user's editor came up after
  //    it started: moving onto the editor leaves one engine per project. The
  //    move runs under the host lock, so two bridge processes cannot both stop
  //    the engine and attach.
  const st0 = readHostState(project);
  if (await hostAlive(st0) && st0.mode === MODE_HEADLESS) {
    if (attachEditorEnabled() && attachPolicy() === 'prefer-editor' && !badActive(st0)) {
      const editorPort = await alignEditorTarget(project, flags);
      if (editorPort !== undefined) {
        const moveLock = await acquireHostLock(project);
        if (moveLock === 'host-ready') {
          // Another process completed the start decision while we waited: follow
          // the state it wrote instead of moving without holding the lock.
          const settled = readHostState(project);
          if (await hostAlive(settled) && !badActive(settled)) {
            return { pid: settled.pid, port: settled.port, mode: settled.mode, reused: true };
          }
        } else {
          try {
            const current = readHostState(project);
            if (await hostAlive(current) && current.mode === MODE_HEADLESS) {
              moveToEditorAttach(project, current, editorPort);
              return { pid: 0, port: editorPort, mode: MODE_EDITOR, reused: false };
            }
            if (await hostAlive(current) && current.mode === MODE_EDITOR) {
              log(`reusing editor attach port=${current.port} (project ${project})`);
              return { pid: current.pid, port: current.port, mode: MODE_EDITOR, reused: true };
            }
          } finally {
            moveLock();
          }
        }
      }
    }
    log(`reusing own headless pid=${st0.pid} port=${st0.port} (project ${project})`);
    return { pid: st0.pid, port: st0.port, mode: MODE_HEADLESS, reused: true };
  }
  if (await hostAlive(st0) && st0.mode === MODE_EDITOR && !badActive(st0)) {
    log(`reusing editor attach port=${st0.port} (project ${project})`);
    return { pid: st0.pid, port: st0.port, mode: MODE_EDITOR, reused: true };
  }

  // Serialize the "decide how to connect" step across processes. Two bridge
  // processes (baseline + main clientd) can reach here concurrently during
  // first boot; only one may probe/spawn, the rest reuse the winner's host.
  const lock = await acquireHostLock(project);
  try {
    if (lock === 'host-ready') {
      const live = readHostState(project);
      if (await hostAlive(live) && !badActive(live)) {
        log(`reusing host started by another process (mode=${live.mode} port=${live.port})`);
        return { pid: live.pid, port: live.port, mode: live.mode, reused: true };
      }
    }
    // Re-check under the lock: the state may have changed while we waited.
    const locked = readHostState(project);
    if (await hostAlive(locked) && locked.mode === MODE_HEADLESS) {
      log(`reusing own headless pid=${locked.pid} port=${locked.port} (project ${project})`);
      return { pid: locked.pid, port: locked.port, mode: MODE_HEADLESS, reused: true };
    }
    if (await hostAlive(locked) && locked.mode === MODE_EDITOR && !badActive(locked)) {
      log(`reusing editor attach port=${locked.port} (project ${project})`);
      return { pid: locked.pid, port: locked.port, mode: MODE_EDITOR, reused: true };
    }

    // Cold start, no live host: prefer the user's editor when reachable and
    // not blacklisted. Skip entirely when the bridge config sets
    // attachEditor:false (headless-only).
    const editorPort = attachEditorEnabled() && !badActive(locked) ? await alignEditorTarget(project, flags) : undefined;
    if (editorPort !== undefined) {
      writeHostState(project, {
        mode: MODE_EDITOR, pid: 0, port: editorPort,
        project: path.resolve(project), godot: '(user editor)',
        startedAt: new Date().toISOString(),
      });
      log(`attached to running Godot editor LSP on port ${editorPort} (project ${project})`);
      return { pid: 0, port: editorPort, mode: MODE_EDITOR, reused: false };
    }

    if (locked && locked.mode !== MODE_EDITOR && isAlive(locked.pid)) killTree(locked.pid); // stale headless, clean up

    const reserved = reservedPorts(flags);
    const port = await freePort(reserved);
    const dapPort = await freePort([...reserved, port]);
    // Which reserved ports were already busy before we started: the guard below
    // uses this to tell "our engine took it" from "it was taken all along".
    const reservedBusyBefore = new Set();
    for (const rp of reserved) if (await portOpen(rp)) reservedBusyBefore.add(rp);
    const logStream = fs.createWriteStream(paths.hostLog, { flags: 'a' });
    logStream.write(`\n=== start ${new Date().toISOString()} ${godotBin} port=${port} dap=${dapPort} ===\n`);
    log(`starting headless Godot LSP: ${godotBin} --path "${project}" --editor --headless --no-window --lsp-port ${port} --dap-port ${dapPort}`);
    const child = spawn(
      godotBin,
      ['--path', project, '--editor', '--headless', '--no-window', '--lsp-port', String(port), '--dap-port', String(dapPort)],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Godot consumes --lsp-port/--dap-port before scripts run (a probe shows the
        // addon only ever sees `--editor`/`--no-window`), so the bridge addon inside
        // this engine cannot read them from OS.get_cmdline_args(). Exporting the same
        // values lets the addon publish the port this engine actually serves, which
        // is what lets the host tell its own engine from the user's editor.
        env: { ...process.env, DSH_ECHO_LSP_PORT: String(port), DSH_ECHO_DAP_PORT: String(dapPort) },
      }
    );
    child.stdout.on('data', (d) => logStream.write(d));
    child.stderr.on('data', (d) => logStream.write(d));

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let lastLogAt = 0;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        writeHostState(project, {});
        const tail = tailFile(paths.hostLog, 30);
        throw new Error(`headless Godot exited during startup (code=${child.exitCode}); last log:\n${tail}`);
      }
      if (await portOpen(port)) break;
      const now = Date.now();
      if (now - lastLogAt > 10_000) {
        lastLogAt = now;
        log(`waiting for LSP port ${port} ... (${Math.round((Date.now() - deadline) / -1000)}s left)`);
      }
      await sleep(600);
    }
    if (!(await portOpen(port))) {
      killTree(child.pid);
      throw new Error(`LSP port ${port} never opened within ${BOOT_TIMEOUT_MS / 1000}s; see ${paths.hostLog}`);
    }
    // A reserved port that was closed before this start and is open now is most
    // likely ours (an engine build that ignores --dap-port opens the DAP default).
    // This is ADVISORY, never fatal: the same observation is produced by the user's
    // editor coming up inside this boot window, and by the in-project addon, which
    // binds a port of its own from its configured range. Killing a healthy engine
    // on that guess would cost the user all diagnostics, so the engine is kept and
    // the collision is logged and surfaced instead.
    const bridgeBase = configuredBridgePort(flags) || DEFAULT_BRIDGE_PORT;
    const bridgeRange = new Set(Array.from({ length: 16 }, (_, i) => bridgeBase + i)); // mirrors the addon's PORT_SCAN_COUNT
    const squatted = [];
    for (const rp of reserved) {
      if (bridgeRange.has(rp)) continue // the addon occupies a port here by design
      if (reservedBusyBefore.has(rp)) continue // already busy before we started: not ours
      if (await portOpen(rp)) squatted.push(rp);
    }
    writeHostState(project, {
      mode: MODE_HEADLESS, pid: child.pid, port,
      // Ports this engine was told to bind, so a later run can tell "the peer on
      // this port is our own engine" from "a foreign program took it".
      ownPorts: [port, dapPort],
      ownPid: child.pid,
      project: path.resolve(project), godot: godotBin,
      startedAt: new Date().toISOString(),
    });
    if (squatted.length) {
      log(`warning: reserved port(s) ${squatted.join(', ')} became busy while our engine started; an engine build that ignores --dap-port may be holding them`);
      try {
        const s = readHostState(project);
        if (s) writeHostState(project, { ...s, warn: { ports: squatted, at: Date.now(), reason: 'engine-took-reserved-port' } });
      } catch { /* best effort */ }
    }
    log(`host ready pid=${child.pid} port=${port} dap=${dapPort} (headless)`);
    return { pid: child.pid, port, mode: MODE_HEADLESS, reused: false };
  } finally {
    if (typeof lock === 'function') lock();
  }
}
/**
 * Move a project from our own headless engine onto the user's running editor.
 * The caller holds the host lock. Stopping our engine first keeps two engines
 * from serving one project while the new session is established; the editor
 * process itself is never touched.
 * @param {string} project project root
 * @param {{pid?: number}} headless live own-headless state being replaced
 * @param {number} editorPort editor LSP port that answered
 */
function moveToEditorAttach(project, headless, editorPort) {
  if (headless && headless.pid && headless.pid !== process.pid && isAlive(headless.pid)) killTree(headless.pid);
  writeHostState(project, {
    mode: MODE_EDITOR, pid: 0, port: editorPort,
    project: path.resolve(project), godot: '(user editor)',
    startedAt: new Date().toISOString(),
  });
  log(`moved to the running editor LSP on port ${editorPort}; stopped own headless pid=${headless ? headless.pid : 'none'}`);
}

function stopHost(project) {
  const st = readHostState(project);
  if (st && st.mode === MODE_EDITOR) {
    // Guest on the user's editor: never kill their process. Dropping state
    // simply stops reusing it; the editor keeps running untouched.
    log(`detached from editor LSP on port ${st.port} (editor process untouched)`);
  } else if (st && isAlive(st.pid)) {
    killTree(st.pid);
    log(`host stopped (pid=${st.pid})`);
  } else {
    log('no running host for this project');
  }
  writeHostState(project, {});
}

// ---------- minimal LSP client ----------
class GodotLspClient {
  constructor(port, project) {
    this.port = port;
    this.project = path.resolve(project);
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.seq = 0;
    this.pending = new Map();
    this.diags = new Map(); // decoded-lower uri -> { gotPublish, list, at }
    this.servesOtherProject = undefined; // set when the peer announces another project
    this.opened = new Map(); // decoded-lower uri -> { version, abs, uri }
    this.verbose = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port });
      sock.setNoDelay(true);
      sock.once('connect', () => resolve());
      sock.once('error', reject);
      sock.on('data', (c) => this._onData(c));
      this.sock = sock;
    });
  }
  _frame(obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
  }
  _send(obj) { this.sock.write(this._frame(obj)); }
  notify(method, params) { this._send({ jsonrpc: '2.0', method, params }); }
  request(method, params, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject, method });
      this._send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`LSP timeout ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const he = this.buf.indexOf('\r\n\r\n');
      if (he < 0) return;
      const head = this.buf.subarray(0, he).toString('ascii');
      const m = /Content-Length: (\d+)/i.exec(head);
      if (!m) { this.buf = this.buf.subarray(he + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < he + 4 + len) return;
      let msg;
      try { msg = JSON.parse(this.buf.subarray(he + 4, he + 4 + len).toString('utf8')); } catch { this.buf = this.buf.subarray(he + 4 + len); continue; }
      this.buf = this.buf.subarray(he + 4 + len);
      this._handle(msg);
    }
  }
  _handle(msg) {
    if (msg.method === 'textDocument/publishDiagnostics') {
      const p = msg.params || {};
      const uri = decodeUri(String(p.uri)).toLowerCase();
      this.diags.set(uri, { gotPublish: true, list: p.diagnostics || [], at: Date.now() });
      return;
    }
    if (msg.method === 'gdscript_client/changeWorkspace') {
      const got = msg.params && msg.params.path;
      // Compare case-insensitively: Godot reports its own normalized form of the
      // path (drive-letter case and separators differ from what we passed in),
      // and this comparison now decides whether a peer is refused.
      if (got && path.resolve(got).toLowerCase() !== this.project.toLowerCase()) {
        // The editor's LSP serves whichever project that editor has open. A
        // check sent to the wrong project comes back with empty diagnostics,
        // which reads as a clean pass, so the session is rejected by the caller
        // instead of being used.
        errl(`warning: LSP host serves ${got}, expected ${this.project}`);
        this.servesOtherProject = got;
      }
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method} failed: ${JSON.stringify(msg.error).slice(0, 300)}`));
      else p.resolve(msg.result);
      return;
    }
    if (this.verbose && msg.method && !msg.method.startsWith('$/')) {
      log(`server notification: ${msg.method}`);
    }
  }
  async handshake(timeoutMs = 60_000) {
    const root = fileUri(this.project + path.sep);
    await this.request('initialize', {
      processId: null,
      rootUri: root,
      rootPath: this.project,
      workspaceFolders: [{ uri: root, name: path.basename(this.project) }],
      capabilities: { textDocument: { synchronization: { didSave: true }, publishDiagnostics: { relatedInformation: true } }, workspace: { workspaceFolders: true } },
    }, timeoutMs);
    this.notify('initialized', {});
    await sleep(1500);
  }
  async open(absPath) {
    const uriKey = fileUri(absPath).toLowerCase();
    const text = fs.readFileSync(absPath, 'utf8');
    const existing = this.opened.get(uriKey);
    const version = existing ? existing.version + 1 : 1;
    const uri = fileUri(absPath);
    if (existing) {
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    } else {
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: absPath.endsWith('.gdshader') ? 'gdshader' : 'gdscript', version, text },
      });
    }
    this.opened.set(uriKey, { version, abs: absPath, uri });
    return uriKey;
  }
  async close(absPath) {
    const uriKey = fileUri(absPath).toLowerCase();
    const rec = this.opened.get(uriKey);
    if (rec) {
      this.notify('textDocument/didClose', { textDocument: { uri: rec.uri } });
      this.opened.delete(uriKey);
    }
  }
  async waitPublish(uriKey, timeoutMs = DIAG_TIMEOUT_MS, settleMs = 400) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const d = this.diags.get(uriKey);
      if (d && d.gotPublish) {
        if (settleMs > 0) await sleep(settleMs); // let cascading diagnostics settle (change checks only)
        return this.diags.get(uriKey);
      }
      await sleep(250);
    }
    const d = this.diags.get(uriKey);
    if (d && d.gotPublish) return d;
    throw new Error(`no publishDiagnostics within ${timeoutMs}ms for ${uriKey}`);
  }
}

// ---------- session attach with editor fallback ----------
// Opens exactly ONE LSP session (never extra probe connections): resolve the
// endpoint via ensureHost, then handshake — fast (8s) for an editor session so
// a stuck/fake peer can never stall a check for 60s. On editor handshake
// failure the port is blacklisted in host state for 5 minutes and we fall back
// to our own headless engine (whose host-state entry carries the warn record
// the host surfaces as a toast).
async function attachClient(project, godotBin, flags) {
  let h = await ensureHost(project, godotBin, flags);
  for (let attempt = 0; ; attempt++) {
    const client = new GodotLspClient(h.port, project);
    client.verbose = !!flags.verbose;
    try {
      await client.connect();
      await client.handshake(h.mode === MODE_EDITOR ? 8000 : 60_000);
      // A peer serving another project cannot answer for this one; treat it as
      // a bad editor (blacklist + fall back to our own engine) rather than
      // letting its empty diagnostics pass as a clean check.
      if (client.servesOtherProject) {
        throw new Error(`LSP host on ${h.port} serves ${client.servesOtherProject}, not ${project}`);
      }
      return { h, client };
    } catch (e) {
      try { client.sock.destroy(); } catch { /* gone */ }
      if (h.mode !== MODE_EDITOR || attempt > 0) throw e;
      const badPort = h.port;
      const prevState = readHostState(project);
      // `ownPorts`/`ownPid` record what the engine we last spawned was told to
      // bind (they survive the mode switch that wrote this editor record). The port
      // is ours only when that engine is still alive AND its own LSP port is still
      // open — otherwise the pid may have been recycled, and blaming or killing an
      // unrelated process would be worse than the misattribution being fixed.
      const ownPid = prevState && Number.isInteger(prevState.ownPid) ? prevState.ownPid : 0;
      const ownLspOpen = prevState && Number.isInteger(prevState.port) ? await portOpen(prevState.port) : false;
      const wasOurs = !!(prevState && Array.isArray(prevState.ownPorts)
        && prevState.ownPorts.includes(badPort) && ownPid && ownLspOpen && isAlive(ownPid));
      // The reason decides the user-facing warning label and whether a retry is
      // plausibly useful: a wrong-project peer, our own engine squatting the port,
      // and an unresponsive foreign peer are three different situations.
      const why = /serves .*, not /.test(String((e && e.message) || ''))
        ? 'wrong-project'
        : (wasOurs ? 'own-engine-port-conflict' : 'editor-lsp-unresponsive');
      if (wasOurs) {
        // Release the port at once instead of blacklisting the editor: the editor
        // is fine, our engine took the port the profile reserved for it. A fresh
        // engine is spawned below with an explicit --dap-port, so it cannot take
        // it again.
        log(`editor port ${badPort} is held by our own headless pid=${ownPid}; stopping it so the port is released`);
        if (ownPid) killTree(ownPid);
        writeHostState(project, {});
      } else {
        log(`editor LSP on ${badPort} rejected (${(e && e.message) || e}); blacklisting and falling back to headless`);
        writeHostState(project, {
          mode: MODE_EDITOR, pid: 0, port: badPort,
          project: path.resolve(project), godot: '(user editor)',
          badEditor: { port: badPort, at: Date.now() },
          startedAt: new Date().toISOString(),
        });
      }
      h = await ensureHost(project, godotBin, flags); // spawns/reuses our headless
      if (h.mode === MODE_HEADLESS) {
        // Surface the dead editor port to the host (toast) via host-state warn.
        try {
          const s = readHostState(project);
          if (s) writeHostState(project, { ...s, warn: { ports: [badPort], at: Date.now(), reason: why } });
        } catch { /* best effort */ }
      }
    }
  }
}

// ---------- diagnostics output ----------
const SEV = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };
function normalizeList(list, abs, project) {
  const rel = path.relative(project, abs).split(path.sep).join('/');
  return (list || []).map((d) => {
    const s = d.range && d.range.start;
    return {
      severity: d.severity || 1,
      severityName: SEV[d.severity] || String(d.severity),
      message: String(d.message || ''),
      source: d.source || 'gdscript',
      code: d.code,
      line: s ? s.line + 1 : 0,
      column: s ? s.character + 1 : 0,
      range: d.range,
      file: rel,
    };
  });
}
async function writeOutAtomically(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// ---------- check ----------
// Diagnostics collection in two flavors:
//  - default (incremental change checks): didOpen a chunk of files up-front
//    (the engine validates them in one pass) and only then wait for their
//    publishDiagnostics in parallel, with a per-file settle so cascading
//    diagnostics from a change land before we snapshot.
//  - sweep (full-project first scan): open ALL files with no inter-batch
//    barrier and no settle tax. The engine publishes every file quickly once
//    fed in bulk; waiting per 40-file chunk serialized the publish stream and
//    turned a ~3s engine pass into ~60s wall time. sweep=true also reports
//    files whose diagnostics never arrived so gaps are visible, not silent.
const BATCH_OPEN = 40;
const SWEEP_SETTLE_MS = 0;
const SWEEP_TIMEOUT_MS = 20_000;

/**
 * Push `absFiles` through one LSP client and collect per-file diagnostics.
 * Never throws per-file wait failures: a file whose diagnostics do not arrive
 * is recorded with an empty list plus a `check_error` marker so one unruly
 * script cannot abort a whole project sweep.
 * NOTE: the engine publishes LSP diagnostics for .gd only. .gdshader opens
 * never produce publishDiagnostics (verified: even a syntactically broken
 * shader yields nothing), so they are recorded immediately with an empty list
 * plus `engine_note` instead of burning the wait timeout.
 * @param {{sweep?: boolean}} opts sweep=true: full-project bulk pass (no
 *   per-chunk barrier, no settle). Defaults to the change-check path.
 * @returns {{files: Object, errors: number, warnings: number}}
 */
async function collectDiagnostics(client, project, absFiles, opts = {}) {
  const { sweep } = opts;
  const batchSize = sweep ? Math.max(BATCH_OPEN, absFiles.length) : BATCH_OPEN;
  const settleMs = sweep ? SWEEP_SETTLE_MS : 400;
  const waitMs = sweep ? SWEEP_TIMEOUT_MS : DIAG_TIMEOUT_MS;
  const files = {};
  let totalErrors = 0;
  let totalWarnings = 0;
  const opened = [];
  try {
    for (let i = 0; i < absFiles.length; i += batchSize) {
      const chunk = absFiles.slice(i, i + batchSize);
      const pairs = []; // { abs, rel, key } for files that will produce diagnostics
      for (const abs of chunk) {
        if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
        const rel = path.relative(project, abs).split(path.sep).join('/');
        if (abs.endsWith('.gdshader')) {
          files[rel] = {
            checked_at: new Date().toISOString(),
            diagnostics: [],
            errors: 0,
            warnings: 0,
            engine_note: 'engine publishes no LSP diagnostics for .gdshader',
          };
          continue;
        }
        pairs.push({ abs, rel, key: await client.open(abs) });
        opened.push(abs);
      }
      const pubs = await Promise.all(
        pairs.map(({ key }) =>
          client.waitPublish(key, waitMs, settleMs).catch((e) => ({ error: String((e && e.message) || e), at: Date.now() })),
        ),
      );
      for (let j = 0; j < pairs.length; j++) {
        const { abs, rel } = pairs[j];
        const pub = pubs[j];
        if (!pub || pub.error) {
          errl(`no diagnostics for ${rel}: ${pub ? pub.error : 'unknown'}`);
          files[rel] = {
            checked_at: new Date().toISOString(),
            diagnostics: [],
            errors: 0,
            warnings: 0,
            check_error: pub ? pub.error : 'no publishDiagnostics',
          };
          continue;
        }
        const norm = normalizeList(pub.list, abs, project);
        files[rel] = {
          checked_at: new Date(pub.at).toISOString(),
          diagnostics: norm,
          errors: norm.filter((d) => d.severity === 1).length,
          warnings: norm.filter((d) => d.severity === 2).length,
        };
        totalErrors += files[rel].errors;
        totalWarnings += files[rel].warnings;
      }
    }
  } finally {
    for (const abs of opened) await client.close(abs).catch(() => {});
  }
  return { files, errors: totalErrors, warnings: totalWarnings };
}

async function checkFiles(project, client, absFiles, outPath, opts = {}) {
  const { files, errors: totalErrors, warnings: totalWarnings } = await collectDiagnostics(client, project, absFiles, opts);
  const payload = {
    tool: 'godot-lsp',
    version: 1,
    project,
    server: 'headless-godot-lsp',
    port: client.port,
    updated_at: new Date().toISOString(),
    out_file: outPath,
    files,
    summary: {
      files_checked: Object.keys(files).length,
      errors: totalErrors,
      warnings: totalWarnings,
      files_with_errors: Object.keys(files).filter((k) => files[k].errors > 0),
    },
  };
  await writeOutAtomically(outPath, payload);
  return payload;
}
function printSummary(payload) {
  const s = payload.summary;
  log(`checked ${s.files_checked} file(s): ${s.errors} error(s), ${s.warnings} warning(s)`);
  for (const rel of Object.keys(payload.files)) {
    for (const d of payload.files[rel].diagnostics) {
      if (d.severity === 1 || d.severity === 2) {
        console.log(`  ${rel}:${d.line}:${d.column}: [${d.severityName}] ${d.message}`);
      }
    }
  }
  console.log(`json: ${payload.out_file}`);
}

// ---------- smoke ----------
async function cmdSmoke(project, godotBin, flags, fileArg) {
  const abs = path.resolve(fileArg);
  if (!fs.existsSync(abs) || !isGdFile(abs)) throw new Error('smoke needs an existing .gd/.gdshader file path argument');
  const { h, client } = await attachClient(project, godotBin, flags);
  const orig = fs.readFileSync(abs, 'utf8');
  const nl = orig.indexOf('\n');
  const injected = orig.slice(0, nl + 1) + 'var __dsh_lsp_probe__ := := 1\n' + orig.slice(nl + 1);

  const uriKey = await client.open(abs);
  const clean = await client.waitPublish(uriKey);
  const cleanErrs = normalizeList(clean.list, abs, project).filter((d) => d.severity === 1).length;

  const rec = client.opened.get(uriKey);
  client.notify('textDocument/didChange', { textDocument: { uri: rec.uri, version: rec.version + 1 }, contentChanges: [{ text: injected }] });
  client.opened.set(uriKey, { ...rec, version: rec.version + 1 });
  const broken = await client.waitPublish(uriKey);
  const brokenErrs = normalizeList(broken.list, abs, project).filter((d) => d.severity === 1).length;

  const ok = cleanErrs === 0 && brokenErrs >= 1;
  log(`smoke ${ok ? 'PASS' : 'FAIL'} — clean=${cleanErrs} error(s), injected-error phase=${brokenErrs} error(s)`);
  if (brokenErrs) {
    for (const d of normalizeList(broken.list, abs, project).filter((x) => x.severity === 1).slice(0, 5)) {
      log(`  injected diag: ${d.line}:${d.column} ${d.message}`);
    }
  }
  await client.close(abs).catch(() => {});
  if (flags.once) stopHost(project);
  process.exit(ok ? 0 : 1);
}

// ---------- watch ----------
function collectGdFiles(root, skipDirs) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || skipDirs.includes(e.name)) continue;
        stack.push(full);
      } else if (e.isFile() && isGdFile(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}
async function cmdWatch(project, godotBin, flags, outPath) {
  const cfg = machineConfig();
  const skipDirs = cfg.watchSkip || ['.godot', 'addons'];
  const { h, client } = await attachClient(project, godotBin, flags);
  const scan = () => {
    const next = new Map();
    for (const f of collectGdFiles(project, skipDirs)) {
      try { next.set(f, fs.statSync(f).mtimeMs); } catch { /* raced */ }
    }
    return next;
  };
  let mtimes = scan();
  log(`watching .gd under ${project} (skip: ${skipDirs.join(', ')}); Ctrl+C to stop`);
  let lastErrKey = '';
  const pushChanges = async () => {
    const next = scan();
    const changed = [];
    for (const [f, mt] of next) if (mtimes.get(f) !== mt) changed.push(f);
    for (const f of [...mtimes.keys()]) if (!next.has(f)) changed.push(f); // deleted
    mtimes = next;
    for (const f of changed) {
      if (!fs.existsSync(f)) { await client.close(f).catch(() => {}); continue; }
      try {
        const uriKey = await client.open(f);
        const pub = await client.waitPublish(uriKey, 15_000);
        const rel = path.relative(project, f).split(path.sep).join('/');
        const norm = normalizeList(pub.list, f, project);
        const errs = norm.filter((d) => d.severity === 1).length;
        const payload = {
          tool: 'godot-lsp', version: 1, project, server: 'headless-godot-lsp', port: client.port,
          updated_at: new Date().toISOString(), out_file: outPath,
          files: { [rel]: { checked_at: new Date().toISOString(), diagnostics: norm, errors: errs, warnings: norm.filter((d) => d.severity === 2).length } },
          summary: { files_checked: 1, errors: errs, warnings: 0, files_with_errors: errs ? [rel] : [] },
        };
        await writeOutAtomically(outPath, payload);
        const errKey = rel + (errs ? `:${errs}` : '');
        if (errKey !== lastErrKey) {
          if (errs) {
            log(`ERRORS in ${rel} (${errs})`);
            for (const d of norm) if (d.severity === 1) console.log(`  ${rel}:${d.line}:${d.column}: ${d.message}`);
          } else {
            log(`ok: ${rel}`);
          }
          lastErrKey = errKey;
        }
      } catch (e) {
        errl(`check failed for ${f}: ${e.message}`);
      }
    }
  };
  process.on('SIGINT', () => { log('watch stopped'); stopHost(project); process.exit(0); });
  process.on('SIGTERM', () => { log('watch stopped'); stopHost(project); process.exit(0); });
  setInterval(pushChanges, 1200);
  await new Promise(() => {}); // run forever
}

// ---------- clientd: persistent LSP client over stdio JSON-lines ----------
// Keeps ONE LSP client connected to the engine host for the lifetime of the
// process. stdin lines are requests:  {"id":<number>,"files":[<abs>...]}
// stdout lines are replies:          {"id":<number>,"ok":true,"payload":{...}}
//                                  or {"id":<number>,"ok":false,"error":<str>}
// Non-JSON console chatter may interleave on stdout; readers must filter by
// JSON.parse. Exits on stdin EOF / SIGINT / SIGTERM / engine socket close.
async function cmdClientd(project, godotBin, flags) {
  let { h, client } = await attachClient(project, godotBin, flags);
  const reply = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  log(`clientd ready (host pid=${h.pid} port=${h.port})`);

  const bindSocket = () => {
    client.sock.on('close', () => { errl('engine socket closed; exiting'); process.exit(0); });
    client.sock.on('error', () => { /* socket errors surface via close */ });
  };
  bindSocket();

  // The engine decision is re-made before every request, not only at startup:
  // the user's editor can open after this session was established, and the
  // attach policy then moves the project onto it and stops our headless engine.
  // A changed endpoint means a new session; the old socket is dropped without
  // exiting the process, since the reconnect below replaces it.
  const followEngineDecision = async () => {
    // `changeWorkspace` can also arrive after the handshake window: refusing the
    // peer here keeps a wrong-project session from serving requests, and the
    // record sends the reconnect to our own engine.
    if (h.mode === MODE_EDITOR && client.servesOtherProject) {
      const badPort = client.port;
      log(`peer on ${badPort} serves ${client.servesOtherProject}; refusing it and switching to our own engine`);
      const s = readHostState(project);
      writeHostState(project, {
        mode: MODE_EDITOR, pid: 0, port: badPort,
        project: path.resolve(project), godot: '(user editor)',
        badEditor: { port: badPort, at: Date.now() },
        warn: { ports: [badPort], at: Date.now(), reason: 'wrong-project' },
        startedAt: (s && s.startedAt) || new Date().toISOString(),
      });
      try { client.sock.removeAllListeners(); client.sock.destroy(); } catch { /* gone */ }
      const fallback = await attachClient(project, godotBin, flags);
      client = fallback.client;
      h = fallback.h;
      bindSocket();
      log(`clientd reconnected (host pid=${h.pid} port=${h.port})`);
      return;
    }
    const decision = await ensureHost(project, godotBin, flags);
    if (decision.port === h.port && decision.mode === h.mode) return;
    log(`engine changed to ${decision.mode} port=${decision.port}; reconnecting`);
    try { client.sock.removeAllListeners(); client.sock.destroy(); } catch { /* gone */ }
    const next = await attachClient(project, godotBin, flags);
    client = next.client;
    h = next.h;
    bindSocket();
    log(`clientd reconnected (host pid=${h.pid} port=${h.port})`);
  };

  // Requests MUST run one at a time: the LSP session is single-connection and
  // collectDiagnostics mutates shared client state (opened/diags). Buffer
  // parsed lines in a queue and drain it serially.
  const queue = [];
  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const item = queue.shift();
      try {
        const absFiles = (Array.isArray(item.files) ? item.files : []).filter(Boolean).map((f) => path.resolve(f));
        if (!absFiles.length) throw new Error('clientd: request needs a non-empty files[] array');
        // Only a request that can be served is worth moving engines for.
        await followEngineDecision();
        const outPath = statePaths(project).out;
        // Reload scripts whose disk content changed before reading diagnostics,
        // or the engine answers from a parse tree it never rebuilt.
        const changed = (Array.isArray(item.didsave) ? item.didsave : []).filter(Boolean).map((f) => path.resolve(f));
        if (changed.length) {
          const bridgePort = configuredBridgePort(flags) ?? discoveredBridgePort(project) ?? DEFAULT_BRIDGE_PORT;
          await reloadChangedScripts(client, project, changed, bridgePort);
        }
        // sweep=true (full-project baseline): bulk open, no settle tax.
        const { files, errors, warnings } = await collectDiagnostics(client, project, absFiles, { sweep: !!item.sweep });
        const payload = {
          tool: 'godot-lsp',
          version: 1,
          project,
          server: 'headless-godot-lsp',
          port: client.port,
          updated_at: new Date().toISOString(),
          out_file: outPath,
          files,
          summary: {
            files_checked: Object.keys(files).length,
            errors,
            warnings,
            files_with_errors: Object.keys(files).filter((k) => files[k].errors > 0),
          },
        };
        try { await writeOutAtomically(outPath, payload); } catch (e) { errl(`out write failed: ${e.message}`); }
        reply({ id: item.id, ok: true, payload });
      } catch (e) {
        reply({ id: item.id, ok: false, error: String((e && e.message) || e) });
      }
    }
    draining = false;
  };
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); } catch { reply({ id: undefined, ok: false, error: 'malformed request json' }); continue; }
      queue.push({ id: req && req.id, files: req.files, sweep: !!req.sweep, didsave: req.didsave });
      drain();
    }
  });
  process.stdin.on('end', () => { log('stdin closed; exiting'); process.exit(0); });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  await new Promise(() => {}); // run forever
}

// ---------- usage / main ----------
const USAGE = `godot-lsp.mjs — zero-dependency Godot GDScript diagnostics bridge

usage:
  node godot-lsp.mjs check <file...> [--project <dir>] [--godot <exe>] [--out <json>] [--once]
  node godot-lsp.mjs smoke <file>    [--project <dir>] [--godot <exe>]   (inject error in LSP buffer only)
  node godot-lsp.mjs watch           [--project <dir>] [--godot <exe>] [--out <json>]
  node godot-lsp.mjs clientd         [--project <dir>] [--godot <exe>]   (persistent LSP client; stdio JSON-lines)
  node godot-lsp.mjs host|status|stop [--project <dir>] [--godot <exe>]
  node godot-lsp.mjs rescan [--project <dir>] [--bridge-port <n>]   (needs the dsh_echo_bridge addon in the project)

discovery: Godot  = --godot > config godotBin > env GODOT_BIN > PATH (godot/godot4)
           project = --project > config defaultProject > walk up from cwd to project.godot
attach:    a running editor on config editorPort is attached instead of starting a
           headless engine (attachEditor:false disables attaching entirely and
           outranks the policy below); attachPolicy=prefer-editor (default) also
           moves a project from our own headless engine onto the editor when it
           opens later, while attachPolicy=cold-start keeps whichever engine
           started first
out file default: <DSH_HOME>/lsp-echo-runtime/godot-lsp/lsp_diagnostics-<projectName>.json  (--out to override)
exit codes: 0 = no errors, 1 = errors found, 2 = usage/config/runtime failure
`;

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    return;
  }
  const cmd = argv[0];
  const { flags, files } = parseArgs(argv.slice(1));
  try {
    if (cmd === 'check' || cmd === 'smoke') {
      if (!files.length) throw new Error(`usage: node godot-lsp.mjs ${cmd} <file...>`);
      const project = findProject(flags, files[0]);
      const godot = resolveGodot(flags);
      log(`project: ${project}`);
      log(`godot:   ${godot.how === 'PATH' ? `${godot.bin} (${godot.version || '?'})` : godot.bin}`);
      if (cmd === 'smoke') return await cmdSmoke(project, godot.bin, flags, files[0]);
      const paths = statePaths(project);
      const outPath = path.resolve(flags.out || configEntry(flags, 'out', undefined) || paths.out);
      const absFiles = files.map((f) => path.resolve(f));
      const { h, client } = await attachClient(project, godot.bin, flags);
      const payload = await checkFiles(project, client, absFiles, outPath, { sweep: !!flags.sweep });
      printSummary(payload);
      if (flags.once) stopHost(project);
      process.exit(payload.summary.errors > 0 ? 1 : 0);
    } else if (cmd === 'watch') {
      const project = findProject(flags);
      const godot = resolveGodot(flags);
      const paths = statePaths(project);
      const outPath = path.resolve(flags.out || configEntry(flags, 'out', undefined) || paths.out);
      log(`project: ${project}`);
      log(`godot:   ${godot.bin}`);
      log(`out:     ${outPath}`);
      return await cmdWatch(project, godot.bin, flags, outPath);
    } else if (cmd === 'clientd') {
      const project = findProject(flags);
      const godot = resolveGodot(flags);
      return await cmdClientd(project, godot.bin, flags);
    } else if (cmd === 'host') {
      const project = findProject(flags);
      const godot = resolveGodot(flags);
      await ensureHost(project, godot.bin, flags);
      log('host running in background; use "node godot-lsp.mjs stop" to stop');
      // The detached engine keeps the stdio pipes we hold open, so this CLI
      // would otherwise never exit and every caller (execFile / tool) times
      // out. Exit explicitly; the engine keeps running independently.
      process.exit(0);
    } else if (cmd === 'status') {
      const project = findProject(flags);
      const st = readHostState(project);
      if (st && (await hostAlive(st))) {
        const mode = st.mode === MODE_EDITOR ? 'editor-attach' : 'headless';
        console.log(`running (${mode}): port=${st.port} project=${st.project} started=${st.startedAt}`);
      } else {
        console.log(`stopped: no live host for ${project}`);
      }
    } else if (cmd === 'stop') {
      const project = findProject(flags);
      stopHost(project);
    } else if (cmd === 'rescan') {
      const project = findProject(flags);
      // An explicit port wins; otherwise use the port the running addon
      // published, and only then fall back to the shipped default.
      const port = configuredBridgePort(flags) ?? discoveredBridgePort(project) ?? DEFAULT_BRIDGE_PORT;
      const r = await askBridgeRescan(port);
      if (!r.ok) {
        throw new Error(`editor bridge rescan failed on 127.0.0.1:${port}: ${r.error} (is the dsh_echo_bridge addon installed and enabled in this project?)`);
      }
      log(`filesystem rescan acknowledged by the editor bridge on port ${port}`);
    } else {
      throw new Error(`unknown command: ${cmd}\n${USAGE}`);
    }
  } catch (e) {
    errl(String((e && e.message) || e));
    process.exit(2);
  }
}

main();
