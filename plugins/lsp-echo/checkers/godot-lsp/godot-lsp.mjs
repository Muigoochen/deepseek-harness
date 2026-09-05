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
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOLING_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.join(TOOLING_DIR, '.runtime');
const CONFIG_PATH = path.join(TOOLING_DIR, 'godot-lsp.config.json');
const BOOT_TIMEOUT_MS = 150_000;
const DIAG_TIMEOUT_MS = 25_000;

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
  const cfg = readJsonSafe(CONFIG_PATH);
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
  const cfg = readJsonSafe(CONFIG_PATH);
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
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}
function portOpen(port) {
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

// ---------- runtime state ----------
function statePaths(project) {
  const name = baseNameOf(project);
  return {
    name,
    host: path.join(RUNTIME_DIR, `host-${name}.json`),
    out: path.join(RUNTIME_DIR, `lsp_diagnostics-${name}.json`),
    hostLog: path.join(RUNTIME_DIR, `host-${name}.log`),
  };
}
function readHostState(project) {
  const s = readJsonSafe(statePaths(project).host);
  return s && s.project && path.resolve(s.project) === path.resolve(project) ? s : undefined;
}
// mode 'editor' = attached to a user's already-running Godot editor LSP
// (never own/kill that process). mode 'headless' = engine we spawned.
const MODE_HEADLESS = 'headless';
const MODE_EDITOR = 'editor';

// ---------- attach-to-editor probing (smart connection) ----------
// Returns the TCP port of a running Godot editor LSP, or undefined. Never
// spawns anything. Trust model mirrors the official godot-vscode-plugin: the
// editor on the configured editor LSP port IS the current project's editor
// (single-editor setups). Our own headless engines always bind free random
// ports, so a live peer on the editor port can only be the user's editor.
// Port source: bridge config `editorPort` (or legacy array `editorPorts`) >
// --editor-port flag > default 6005. Users with non-default editor ports put
// theirs in the plugin config.
const DEFAULT_EDITOR_PORTS = [6005];
const EDITOR_PROBE_TIMEOUT_MS = 2500;
function tailFile(p, n) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - n)).join('\n');
  } catch { return '(no host log)'; }
}

function editorProbePorts(flags) {
  const cfg = readJsonSafe(CONFIG_PATH);
  if (cfg) {
    if (typeof cfg.editorPort === 'number' && cfg.editorPort > 0) return [cfg.editorPort];
    if (Array.isArray(cfg.editorPorts) && cfg.editorPorts.length) return cfg.editorPorts;
  }
  if (flags.editorPort) {
    const n = Number(flags.editorPort);
    if (n > 0) return [n];
  }
  return DEFAULT_EDITOR_PORTS;
}
function findEditorLsp(project, flags) {
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
  if (st.mode === MODE_EDITOR) return !!(await portOpen(st.port)); // editor process owns its port; never kill it
  return isAlive(st.pid) && (await portOpen(st.port));
}
function writeHostState(project, state) {
  fs.writeFileSync(statePaths(project).host, JSON.stringify(state, null, 2), 'utf8');
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
  const st = readHostState(project);

  // 1) A live editor-attach wins: it is the user's own engine, zero extra RAM.
  if (await hostAlive(st) && st.mode === MODE_EDITOR) {
    log(`reusing editor attach port=${st.port} (project ${project})`);
    return { pid: st.pid, port: st.port, mode: MODE_EDITOR, reused: true };
  }

  // Serialize the "decide how to connect" step across processes. Two bridge
  // processes (baseline + main clientd) can reach here concurrently during
  // first boot; only one may probe/spawn, the rest reuse the winner's host.
  const lock = await acquireHostLock(project);
  try {
    if (lock === 'host-ready') {
      const live = readHostState(project);
      if (await hostAlive(live)) {
        log(`reusing host started by another process (mode=${live.mode} port=${live.port})`);
        return { pid: live.pid, port: live.port, mode: live.mode, reused: true };
      }
    }
    // Re-check under the lock: the state may have changed while we waited.
    const locked = readHostState(project);
    if (await hostAlive(locked) && locked.mode === MODE_EDITOR) {
      log(`reusing editor attach port=${locked.port} (project ${project})`);
      return { pid: locked.pid, port: locked.port, mode: MODE_EDITOR, reused: true };
    }

    // 2) Smart connection: prefer a running editor that already serves this
    //    project. If we still own a headless from an earlier no-editor
    //    session, stop it first so exactly one engine stays up. Skip entirely
    //    when the bridge config sets attachEditor:false (headless-only).
    const cfg = readJsonSafe(CONFIG_PATH);
    const attachEditor = cfg && cfg.attachEditor === false ? false : true;
    const editorPort = attachEditor ? await findEditorLsp(project, flags) : undefined;
    if (editorPort !== undefined) {
      if (locked && locked.mode !== MODE_EDITOR && isAlive(locked.pid)) {
        killTree(locked.pid);
        log(`stopped own headless pid=${locked.pid} in favor of editor attach`);
      }
      writeHostState(project, {
        mode: MODE_EDITOR, pid: 0, port: editorPort,
        project: path.resolve(project), godot: '(user editor)',
        startedAt: new Date().toISOString(),
      });
      log(`attached to running Godot editor LSP on port ${editorPort} (project ${project})`);
      return { pid: 0, port: editorPort, mode: MODE_EDITOR, reused: false };
    }

    // 3) No editor up: reuse our own headless when it is still alive.
    if (await hostAlive(locked)) {
      log(`reusing own headless pid=${locked.pid} port=${locked.port} (project ${project})`);
      return { pid: locked.pid, port: locked.port, mode: MODE_HEADLESS, reused: true };
    }
    if (locked && locked.mode !== MODE_EDITOR && isAlive(locked.pid)) killTree(locked.pid); // stale headless, clean up

    const port = await freePort();
    const logStream = fs.createWriteStream(paths.hostLog, { flags: 'a' });
    logStream.write(`\n=== start ${new Date().toISOString()} ${godotBin} port=${port} ===\n`);
    log(`starting headless Godot LSP: ${godotBin} --path "${project}" --editor --headless --no-window --lsp-port ${port}`);
    const child = spawn(
      godotBin,
      ['--path', project, '--editor', '--headless', '--no-window', '--lsp-port', String(port)],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
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
    writeHostState(project, {
      mode: MODE_HEADLESS, pid: child.pid, port,
      project: path.resolve(project), godot: godotBin,
      startedAt: new Date().toISOString(),
    });
    log(`host ready pid=${child.pid} port=${port} (headless)`);
    return { pid: child.pid, port, mode: MODE_HEADLESS, reused: false };
  } finally {
    if (typeof lock === 'function') lock();
  }
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
      if (got && path.resolve(got) !== this.project) {
        errl(`warning: LSP host serves ${got}, expected ${this.project}`);
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
  async handshake() {
    const root = fileUri(this.project + path.sep);
    await this.request('initialize', {
      processId: null,
      rootUri: root,
      rootPath: this.project,
      workspaceFolders: [{ uri: root, name: path.basename(this.project) }],
      capabilities: { textDocument: { synchronization: { didSave: true }, publishDiagnostics: { relatedInformation: true } }, workspace: { workspaceFolders: true } },
    }, 60_000);
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
  const h = await ensureHost(project, godotBin, flags);
  const client = new GodotLspClient(h.port, project);
  client.verbose = !!flags.verbose;
  await client.connect();
  await client.handshake();
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
  const cfg = readJsonSafe(CONFIG_PATH) || {};
  const skipDirs = cfg.watchSkip || ['.godot', 'addons'];
  const h = await ensureHost(project, godotBin, flags);
  const client = new GodotLspClient(h.port, project);
  client.verbose = !!flags.verbose;
  await client.connect();
  await client.handshake();
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
  const h = await ensureHost(project, godotBin, flags);
  const client = new GodotLspClient(h.port, project);
  client.verbose = !!flags.verbose;
  await client.connect();
  await client.handshake();
  const reply = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  log(`clientd ready (host pid=${h.pid} port=${h.port})`);

  const sock = client.sock;
  sock.on('close', () => { errl('engine socket closed; exiting'); process.exit(0); });
  sock.on('error', () => { /* socket errors surface via close */ });

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (c) => {
    buf += c;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); } catch { reply({ id: undefined, ok: false, error: 'malformed request json' }); continue; }
      try {
        const absFiles = (Array.isArray(req.files) ? req.files : []).filter(Boolean).map((f) => path.resolve(f));
        if (!absFiles.length) throw new Error('clientd: request needs a non-empty files[] array');
        const outPath = statePaths(project).out;
        // sweep=true (full-project baseline): bulk open, no settle tax.
        const { files, errors, warnings } = await collectDiagnostics(client, project, absFiles, { sweep: !!req.sweep });
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
        reply({ id: req.id, ok: true, payload });
      } catch (e) {
        reply({ id: req && req.id, ok: false, error: String((e && e.message) || e) });
      }
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

discovery: Godot  = --godot > config godotBin > env GODOT_BIN > PATH (godot/godot4)
           project = --project > config defaultProject > walk up from cwd to project.godot
out file default: <tooling>/.runtime/lsp_diagnostics-<projectName>.json  (--out to override)
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
      const h = await ensureHost(project, godot.bin, flags);
      const client = new GodotLspClient(h.port, project);
      client.verbose = !!flags.verbose;
      await client.connect();
      await client.handshake();
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
    } else {
      throw new Error(`unknown command: ${cmd}\n${USAGE}`);
    }
  } catch (e) {
    errl(String((e && e.message) || e));
    process.exit(2);
  }
}

main();
