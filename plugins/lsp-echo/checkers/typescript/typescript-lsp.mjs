// typescript-lsp.mjs — zero-additional-dependency TypeScript/JavaScript
// diagnostics bridge for lsp-echo. Drives the `tsserver` shipped with a
// `typescript` install (--ts-server > typescript.config.json tsServer >
// project node_modules/typescript/lib/tsserver.js > TSSERVER_PATH env, and exit
// 2 when none exists) over its stdio protocol. No editor attach (TS has no
// GUI-embeddable host here), so every command owns a short-lived or
// request-scoped tsserver session.
//
// Contract with lib/manager.js (shared by every checkers/<engine>/ bridge):
//   node <bridge> host|status|stop [--project <dir>] [--ts-server <file>]
//   node <bridge> check <file...> --project <dir> [--out <json>]
//   node <bridge> clientd --project <dir>   (persistent: JSON-lines on stdin,
//        each line { id, files, sweep } -> reply { id, ok, payload })
// Payload files keyed by project-relative path; each value
//   { errors, warnings, diagnostics: [{ severity, severityName, message,
//     source, code, line, column, file }] } — same shape as the godot bridge.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TOOLING_DIR = path.dirname(fileURLToPath(import.meta.url))

const CONFIG_PATH = path.join(TOOLING_DIR, 'typescript.config.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[ts-lsp]', ...a)
const errl = (...a) => console.error('[ts-lsp]', ...a)
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return undefined }
}
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
function findProject(flags, extraHint) {
  const explicit = flags.project
  if (explicit) {
    const abs = path.resolve(explicit)
    if (fs.existsSync(path.join(abs, 'tsconfig.json')) || fs.existsSync(path.join(abs, 'package.json')) || fs.existsSync(abs)) return abs
    throw new Error(`project not found: ${abs}`)
  }
  const hint = (extraHint && path.resolve(extraHint)) || process.cwd()
  let dir = path.resolve(hint)
  for (;;) {
    if (fs.existsSync(dir)) {
      // a TS/JS project root: tsconfig.json or any source file here / up-walk stops at fs root
      const probe = path.join(dir, 'tsconfig.json')
      if (fs.existsSync(probe) || dir === path.parse(dir).root) return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) return dir
    dir = parent
  }
}
function relOf(project, abs) {
  return path.relative(project, abs).split(path.sep).join('/')
}

// ---------- tsserver resolution ----------
function machineConfig() {
  return readJsonSafe(CONFIG_PATH) || {}
}
function resolveTsserver(flags, project) {
  if (flags['ts-server']) {
    const p = path.resolve(String(flags['ts-server']))
    if (fs.existsSync(p)) return p
    throw new Error(`configured ts-server not found: ${p}`)
  }
  const cfg = machineConfig()
  if (cfg.tsServer) {
    const p = path.resolve(cfg.tsServer)
    if (fs.existsSync(p)) return p
  }
  // Project-local typescript install is the common case (tsconfig projects
  // almost always carry typescript as a devDependency).
  if (project) {
    for (let dir = path.resolve(project); ; dir = path.dirname(dir)) {
      const cand = path.join(dir, 'node_modules', 'typescript', 'lib', 'tsserver.js')
      if (fs.existsSync(cand)) return cand
      const parent = path.dirname(dir)
      if (parent === dir) break
    }
  }
  const envPath = process.env.TSSERVER_PATH
  if (envPath && fs.existsSync(envPath)) return envPath
  throw new Error(
    'typescript tsserver not found. Add "tsServer" to ' + CONFIG_PATH + ', set TSSERVER_PATH, or run inside a project with typescript installed (node_modules/typescript/lib/tsserver.js).'
  )
}

// ---------- tsserver stdio client ----------
// Input protocol: one JSON object per line. Output protocol: Content-Length
// framed JSON (TypeScript 5+/6 readline input, framed output).
class TsServer {
  constructor(serverPath) {
    this.serverPath = serverPath
    this.seq = 0
    this.pending = new Map()
    this.buf = ''
    this.child = null
  }
  async start() {
    this.child = spawn(process.execPath, [this.serverPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (d) => this._onData(d))
    this.child.stderr.on('data', (d) => { /* tsserver logs to stderr; ignore */ })
    // Settle every in-flight request when tsserver dies (mirrors the godot
    // clientd behavior); otherwise they hang until their own 120s timeouts.
    this.child.on('error', () => {}) // 'exit' below settles pending
    this.child.on('exit', () => {
      const err = new Error('tsserver exited unexpectedly')
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })
    await sleep(400) // let it boot (typingsInstallerPid arrives async)
    this.notify('configure', { preferences: { includePackageJsonAutoImports: 'off' } }).catch(() => {})
  }
  _onData(d) {
    this.buf += d
    for (;;) {
      const he = this.buf.indexOf('\r\n\r\n')
      if (he < 0) return
      const head = this.buf.slice(0, he)
      const m = /Content-Length: (\d+)/i.exec(head)
      if (!m) { this.buf = this.buf.slice(he + 4); continue }
      const len = Number(m[1])
      if (this.buf.length < he + 4 + len) return
      let msg
      try { msg = JSON.parse(this.buf.slice(he + 4, he + 4 + len)) } catch { this.buf = this.buf.slice(he + 4 + len); continue }
      this.buf = this.buf.slice(he + 4 + len)
      if (msg.type === 'response') {
        const p = this.pending.get(msg.request_seq)
        if (p) { this.pending.delete(msg.request_seq); p.resolve(msg) }
      }
    }
  }
  async request(command, args, timeoutMs = 120_000) {
    const s = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(s)) reject(new Error(`tsserver ${command} timed out`)) }, timeoutMs)
      this.pending.set(s, { resolve: (m) => { clearTimeout(timer); if (!m.success) reject(new Error(`${command}: ${m.message || 'failed'}`)); else resolve(m.body) }, reject })
      const body = JSON.stringify({ seq: s, type: 'request', command, arguments: args || {} })
      try { this.child.stdin.write(body + '\n') } catch (e) { clearTimeout(timer); this.pending.delete(s); reject(e) }
    })
  }
  notify(command, args) {
    const s = ++this.seq
    const body = JSON.stringify({ seq: s, type: 'request', command, arguments: args || {} })
    return new Promise((resolve) => { try { this.child.stdin.write(body + '\n') } catch { /* ignore */ } resolve() })
  }
  async stop() {
    try { this.child.stdin.end() } catch { /* gone */ }
    try { this.child.kill() } catch { /* gone */ }
  }
}

const CATEGORY_SEV = { error: 1, warning: 2, suggestion: 4, message: 3 }
const SEV_NAME = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

/**
 * Diagnose the given absolute files through one tsserver session.
 * @param {string} project project root
 * @param {string[]} absFiles absolute source files
 * @returns {Promise<object>} bridge payload
 */
async function diagnose(project, absFiles, flags) {
  const serverPath = resolveTsserver(flags || {}, project)
  const ts = new TsServer(serverPath)
  await ts.start()
  const files = {}
  let checked = 0
  try {
    for (const abs of absFiles) {
      if (!fs.existsSync(abs)) continue
      const text = fs.readFileSync(abs, 'utf8')
      const file = abs // tsserver accepts native paths
      await ts.request('open', { file, fileContent: text })
      checked++
      const diagnostics = []
      for (const cmd of ['syntacticDiagnosticsSync', 'semanticDiagnosticsSync']) {
        let body
        try { body = await ts.request(cmd, { file }) } catch { body = [] }
        for (const d of Array.isArray(body) ? body : []) {
          const sev = CATEGORY_SEV[String(d.category)] || 3
          diagnostics.push({
            severity: sev,
            severityName: SEV_NAME[sev],
            message: String(d.text || ''),
            source: 'typescript',
            code: typeof d.code === 'number' ? d.code : undefined,
            line: d.start ? d.start.line : 0,
            column: d.start ? d.start.offset : 0,
            file: relOf(project, abs),
          })
        }
      }
      files[relOf(project, abs)] = {
        errors: diagnostics.filter((d) => d.severity === 1).length,
        warnings: diagnostics.filter((d) => d.severity === 2).length,
        diagnostics,
      }
      await ts.request('close', { file }).catch(() => {})
    }
  } finally {
    await ts.stop().catch(() => {})
  }
  return {
    tool: 'typescript',
    version: 1,
    project,
    server: 'tsserver',
    files,
    summary: {
      files_checked: checked,
      errors: Object.values(files).reduce((n, f) => n + f.errors, 0),
      warnings: Object.values(files).reduce((n, f) => n + f.warnings, 0),
      files_with_errors: Object.keys(files).filter((k) => files[k].errors > 0),
    },
  }
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

// ---------- commands ----------
async function cmdCheck(project, files, outPath, flags) {
  const absFiles = files.map((f) => path.resolve(f))
  const payload = await diagnose(project, absFiles, flags)
  if (outPath) atomicWriteJson(path.resolve(outPath), payload)
  const s = payload.summary
  log(`checked ${s.files_checked} file(s): ${s.errors} error(s), ${s.warnings} warning(s)`)
  return s.errors > 0 ? 1 : 0
}

function cmdClientd(project, flags) {
  const serverPath = resolveTsserver(flags || {}, project)
  let ts = null
  const reply = (id, obj) => {
    try { process.stdout.write(JSON.stringify({ id, ...obj }) + '\n') } catch { /* closed */ }
  }
  const ensureServer = async () => {
    if (ts && ts.child && ts.child.exitCode === null) return ts
    ts = new TsServer(serverPath)
    await ts.start()
    return ts
  }
  // Requests run one at a time: one tsserver session, and each request is a
  // serial open → diagnose → close sequence over that session.
  const queue = []
  let draining = false
  const drain = async () => {
    if (draining) return
    draining = true
    while (queue.length) {
      const item = queue.shift()
      const { id, files } = item
      try {
        const srv = await ensureServer()
        const collected = {}
        let checked = 0
        for (const rel of (files || [])) {
          const abs = path.resolve(project, rel)
          if (!fs.existsSync(abs)) continue
          const text = fs.readFileSync(abs, 'utf8')
          await srv.request('open', { file: abs, fileContent: text })
          checked++
          const diagnostics = []
          for (const cmd of ['syntacticDiagnosticsSync', 'semanticDiagnosticsSync']) {
            let body = []
            try { body = await srv.request(cmd, { file: abs }) } catch { /* skip */ }
            for (const di of Array.isArray(body) ? body : []) {
              const sev = CATEGORY_SEV[String(di.category)] || 3
              diagnostics.push({
                severity: sev,
                severityName: SEV_NAME[sev],
                message: String(di.text || ''),
                source: 'typescript',
                code: typeof di.code === 'number' ? di.code : undefined,
                line: di.start ? di.start.line : 0,
                column: di.start ? di.start.offset : 0,
                file: relOf(project, abs),
              })
            }
          }
          collected[relOf(project, abs)] = {
            errors: diagnostics.filter((x) => x.severity === 1).length,
            warnings: diagnostics.filter((x) => x.severity === 2).length,
            diagnostics,
          }
          await srv.request('close', { file: abs }).catch(() => {})
        }
        reply(id, {
          ok: true,
          payload: {
            tool: 'typescript',
            version: 1,
            project,
            server: 'tsserver',
            files: collected,
            summary: {
              files_checked: checked,
              errors: Object.values(collected).reduce((n, f) => n + f.errors, 0),
              warnings: Object.values(collected).reduce((n, f) => n + f.warnings, 0),
              files_with_errors: Object.keys(collected).filter((k) => collected[k].errors > 0),
            },
          },
        })
      } catch (e) {
        reply(id, { ok: false, error: String((e && e.message) || e) })
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
      queue.push({ id: req && req.id, files: req.files })
      drain()
    }
  })
  process.stdin.on('end', async () => {
    if (ts) await ts.stop().catch(() => {})
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    if (ts) await ts.stop().catch(() => {})
    process.exit(0)
  })
}

// ---------- main ----------
const USAGE = `typescript-lsp.mjs — TypeScript/JavaScript diagnostics bridge

  node typescript-lsp.mjs check <file...> --project <dir> [--out <json>]
  node typescript-lsp.mjs clientd --project <dir>   (persistent JSON-lines client)
  node typescript-lsp.mjs host|status|stop [--project <dir>]

tsserver resolution: --ts-server <file> > typescript.config.json tsServer >
  project node_modules/typescript/lib/tsserver.js > TSSERVER_PATH env
exit codes: 0 = no errors, 1 = errors found, 2 = failure
`

async function main() {
  const argv = process.argv.slice(2)
  if (!argv.length || argv[0] === 'help' || argv[0] === '--help') { console.log(USAGE); return }
  const cmd = argv[0]
  const { flags, files } = parseArgs(argv.slice(1))
  if (cmd === 'host' || cmd === 'status' || cmd === 'stop') {
    // No persistent engine host for tsserver: sessions are per clientd/check.
    // host validates the resolver quickly, status reports the resolver source.
    const project = flags.project ? path.resolve(String(flags.project)) : process.cwd()
    if (cmd === 'status') {
      const serverPath = resolveTsserver(flags, project)
      log(`typescript tsserver available: ${serverPath}`)
      console.log('running (typescript, lazy tsserver sessions per check)')
      return
    }
    if (cmd === 'host') {
      const serverPath = resolveTsserver(flags, project)
      log(`tsserver ok: ${serverPath} (no persistent host; sessions spawn per clientd/check)`)
      return
    }
    if (cmd === 'stop') {
      log('nothing to stop (no persistent tsserver host)')
      return
    }
  }
  if (cmd === 'check') {
    if (!files.length) throw new Error(`usage: typescript-lsp.mjs check <file...> --project <dir>`)
    const project = findProject(flags, files[0])
    const outPath = flags.out ? String(flags.out) : undefined
    process.exitCode = await cmdCheck(project, files, outPath, flags)
    return
  }
  if (cmd === 'clientd') {
    const project = findProject(flags)
    log(`clientd ready for project ${project}`)
    cmdClientd(project, flags)
    return
  }
  throw new Error(`unknown command ${cmd}`)
}

main().catch((e) => { errl((e && e.message) || e); process.exit(2) })
