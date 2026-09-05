// Godot 4 headless LSP probe: connects to a running Godot editor language
// server over TCP, opens one .gd file (original + injected parse error),
// and records every textDocument/publishDiagnostics it receives.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number(process.argv[2]);
const FILE = process.argv[3]; // native path to the .gd to open
const OUT = process.argv[4]; // where to write the JSON summary
if (!PORT || !FILE || !OUT) {
  console.error('usage: node probe.mjs <port> <abs .gd file> <out.json>');
  process.exit(2);
}

const uri = 'file:///' + FILE.replace(/\\/g, '/');
const project = path.dirname(path.dirname(path.dirname(FILE))); // heuristic only

const events = [];
const log = (...a) => { const s = a.join(' '); console.log(`[probe] ${s}`); events.push({ t: new Date().toISOString(), log: s }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const socket = net.connect({ host: HOST, port: PORT });
await new Promise((res, rej) => { socket.once('connect', res); socket.once('error', rej); });
log(`connected to ${HOST}:${PORT}`);

let buf = Buffer.alloc(0);
let seq = 0;
const pending = new Map();
let diagByUri = new Map(); // lowercase uri -> latest diagnostics array
let serverProject = null;
let bootMsgs = 0;

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}
function send(obj) { socket.write(frame(obj)); }
function nextId() { return ++seq; }
function request(method, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = nextId();
    pending.set(id, { resolve, reject, method });
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);
  });
}
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }

socket.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const headEnd = buf.indexOf('\r\n\r\n');
    if (headEnd < 0) break;
    const head = buf.subarray(0, headEnd).toString('ascii');
    const m = /Content-Length: (\d+)/i.exec(head);
    if (!m) { buf = buf.subarray(headEnd + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < headEnd + 4 + len) break;
    const body = buf.subarray(headEnd + 4, headEnd + 4 + len).toString('utf8');
    buf = buf.subarray(headEnd + 4 + len);
    let msg; try { msg = JSON.parse(body); } catch { continue; }
    handle(msg);
  }
});

function handle(msg) {
  if (msg.method === 'textDocument/publishDiagnostics') {
    const p = msg.params;
    diagByUri.set(String(p.uri).toLowerCase(), p.diagnostics || []);
    log(`publishDiagnostics ${p.uri} -> ${(p.diagnostics || []).length} item(s)`);
    for (const d of p.diagnostics || []) {
      log(`  diag [${d.severity}] ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.source || ''} ${d.code !== undefined ? '(' + d.code + ') ' : ''}${String(d.message).slice(0, 160)}`);
    }
    return;
  }
  if (msg.method === 'gdscript_client/changeWorkspace') {
    serverProject = msg.params && msg.params.path;
    log(`server reports project: ${serverProject}`);
    return;
  }
  if (msg.method === 'gdscript/capabilities') {
    bootMsgs++;
    log('server capabilities notification received');
    return;
  }
  if (msg.method === 'window/logMessage') {
    bootMsgs++;
    const mm = (msg.params && msg.params.message || '').toString().slice(0, 200);
    if (/^(Godot Engine|Loading|Connected|.*language server.*)/i.test(mm)) log(`server log: ${mm}`);
    return;
  }
  if (msg.method && msg.method.startsWith('$/')) return;
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method} failed: ${JSON.stringify(msg.error).slice(0, 300)}`));
    else p.resolve(msg.result);
    return;
  }
  if (msg.id === undefined && msg.method) log(`server notification: ${msg.method}`);
}

async function waitForDiagnostics(label, matchErr, timeoutMs = 20000) {
  const t0 = Date.now();
  const seen = [];
  while (Date.now() - t0 < timeoutMs) {
    const arr = diagByUri.get(uri.toLowerCase());
    if (arr) {
      const errs = arr.filter((d) => !matchErr || /parse|expected|error|indent|identifier/i.test(String(d.message)) || d.severity === 1);
      if (arr.length > 0) {
        seen.push({ at: Date.now() - t0, count: arr.length, sample: arr.slice(0, 8).map((d) => d.message) });
        if (matchErr) {
          const hits = arr.filter((d) => /parse|expected|identifier|indent/i.test(String(d.message)));
          if (hits.length > 0) return { label, waited: Date.now() - t0, arr, hits };
        } else {
          return { label, waited: Date.now() - t0, arr };
        }
      }
    }
    await sleep(300);
  }
  return { label, waited: Date.now() - t0, arr: diagByUri.get(uri.toLowerCase()) || [], timedOut: true };
}

const fsOpts = { capabilities: { textDocument: { synchronization: { didSave: true }, publishDiagnostics: { relatedInformation: true } }, workspace: { workspaceFolders: true } } };

try {
  const init = await request('initialize', { processId: null, rootUri: 'file:///' + project.replace(/\\/g, '/') + '/', rootPath: project, workspaceFolders: [{ uri: 'file:///' + project.replace(/\\/g, '/') + '/', name: 'probe' }], capabilities: fsOpts.capabilities, initializationOptions: {} }, 90000);
  log('initialize OK, server version: ' + JSON.stringify((init && init.serverInfo) || 'n/a'));
  notify('initialized', {});

  // give the server a moment to report its workspace/capabilities
  await sleep(4000);

  const original = fs.readFileSync(FILE, 'utf8');
  log(`opening ${uri} (${original.split('\n').length} lines, clean content)`);
  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'gdscript', version: 1, text: original } });
  const clean = await waitForDiagnostics('clean open');
  log(`phase CLEAN -> ${clean.timedOut ? 'NO publish within window' : clean.arr.length + ' diagnostics'}`);

  // inject a parse error right after the first line
  const firstNl = original.indexOf('\n');
  const injected = original.slice(0, firstNl + 1) + 'var __probe__ := := 3\n' + original.slice(firstNl + 1);
  log('sending didChange with injected parse error (line 2)');
  notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: injected }] });
  const broken = await waitForDiagnostics('injected error', true);
  log(`phase BROKEN -> ${broken.timedOut ? 'NO publish within window' : broken.arr.length + ' diagnostics'}`);
  if (broken.hits) {
    for (const h of broken.hits.slice(0, 5)) log(`  * err line ${h.range.start.line + 1}: ${String(h.message).slice(0, 160)}`);
  }

  // restore original buffer in the server, then close
  notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: original }] });
  await sleep(1500);
  notify('textDocument/didClose', { textDocument: { uri } });
  log('didClose sent');

  const shutdown = await request('shutdown', null, 10000).catch((e) => 'shutdown err: ' + e.message);
  log('shutdown: ' + JSON.stringify(shutdown === null ? 'null(ok)' : shutdown));

  const summary = {
    host: HOST, port: PORT, file: FILE, uri,
    serverProject,
    phases: { clean: clean.arr, broken: { diagnostics: broken.arr, hits: broken.hits } },
    events,
    connectedBootNote: bootMsgs,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2), 'utf8');
  log('wrote ' + OUT);
  const cleanErr = clean.arr.filter((d) => /identifier not found|parse|expected/i.test(String(d.message)));
  log(`RESULT: clean file had ${clean.arr.length} diagnostic(s), ${cleanErr.length} of them identifier/parse errors; injected error produced ${broken.hits ? broken.hits.length : 0} parse hit(s)`);
  process.exit(cleanErr.length === 0 && broken.hits && broken.hits.length > 0 ? 0 : 3);
} catch (e) {
  log('FAILED: ' + e.stack);
  try { fs.writeFileSync(OUT, JSON.stringify({ error: String(e.stack), events, diagSnapshot: [...diagByUri.entries()] }, null, 2), 'utf8'); } catch {}
  process.exit(4);
}
