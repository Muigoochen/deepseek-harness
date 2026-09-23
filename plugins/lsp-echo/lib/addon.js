// addon.js — install and talk to an engine's in-project control addon.
//
// Godot registers global class names (a script's `class_name`) only while
// scanning the project filesystem, and a running engine never rescans on its
// own: the editor does it when its window regains focus, a headless engine never
// does. An engine declaring `rescan`/`addon` in engine.json ships a small editor
// addon that turns a control-socket request into
// EditorFileSystem.scan_sources() — the same scan the editor performs on focus.
// Installing it copies the addon into <project>/addons/ and lists it in
// project.godot; a running editor picks that up after a plugin reload or editor
// restart, while the next headless engine start reads the setting directly.
import fs from 'node:fs'
// Error text travels to the GUI as JSON and is shown verbatim, so it is translated
// here rather than in the client: the active language is reported by the browser
// and kept in this module's sibling, and a Chinese sentence would otherwise appear
// inside an English page.
import { tLine } from './i18n.js'
import net from 'node:net'
import path from 'node:path'

/** Addon directory name under <project>/addons (and its plugin.cfg name). */
export const ADDON_ID = 'dsh_echo_bridge'

/** `res://` path of the addon's plugin.cfg, the string project.godot must enable. */
export function addonResPath() {
  return `res://addons/${ADDON_ID}/plugin.cfg`
}

/** Control port an engine's addon listens on (falls back to the shipped default). */
export function rescanPortOf(eng) {
  const p = eng && eng.rescanPort
  return typeof p === 'number' && Number.isInteger(p) && p > 0 && p <= 65535 ? p : 6089
}

/**
 * Version of the record format this build understands. 3 is the first format with
 * one slot per kind of instance; without a `version` the record was written by an
 * addon installed before the field existed, so its missing fields mean "that addon
 * cannot report this", not "the value is absent".
 */
export const BRIDGE_STATE_VERSION = 3

/** A port number, or undefined when the value is not one. */
function asPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

/** Normalize one instance record, from the file or from a `state` reply. */
function normalizeInstance(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const port = asPort(raw.port)
  if (port === undefined) return undefined
  const pid = Number(raw.pid)
  const livePid = Number.isInteger(pid) && pid > 0 ? pid : undefined
  // A record left behind by an engine that already exited would point at a port
  // nothing answers on (and hide the running instance that did publish one).
  if (livePid !== undefined) {
    try { process.kill(livePid, 0) } catch { return undefined }
  }
  const version = Number(raw.version)
  return {
    port,
    pid: livePid,
    version: Number.isInteger(version) && version > 0 ? version : 1,
    project: typeof raw.project === 'string' ? raw.project : undefined,
    lspPort: asPort(raw.lspPort),
    dapPort: asPort(raw.dapPort),
    // Absent before the probe existed, and before a current record's first probe:
    // both mean "unknown", not "not listening".
    lspListening: typeof raw.lspListening === 'boolean' ? raw.lspListening : undefined,
    lspFromLaunch: raw.lspFromLaunch === true,
  }
}

/**
 * The addon instances serving a project, keyed by kind (`editor` / `engine`).
 *
 * The record has one slot per kind because both serve one project at once — the
 * user's editor and the headless engine this plugin starts — and instances are
 * identified by PROJECT PATH rather than by port: ports get occupied and the two
 * sides' settings can disagree, while the directory an instance serves is
 * unambiguous.
 *
 * A record written before the slots existed (v1/v2) holds one flat instance; it is
 * filed under the kind its `lspFromLaunch` flag names, and a v1 record — which has
 * no flag — is filed as `editor`, the instance the older code used.
 * @param {string} project project root
 * @returns {{ editor?: object, engine?: object }} live instances only
 */
export function readBridgeInstances(project) {
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(path.join(project, '.godot', 'dsh_echo_bridge.json'), 'utf8')) }
  catch { return {} }
  if (!parsed || typeof parsed !== 'object') return {}
  const version = Number(parsed.version)
  if (Number.isInteger(version) && version >= BRIDGE_STATE_VERSION) {
    const out = {}
    const editor = normalizeInstance(parsed.editor)
    if (editor) out.editor = editor
    const engine = normalizeInstance(parsed.engine)
    if (engine) out.engine = engine
    return out
  }
  const flat = normalizeInstance(parsed)
  if (!flat) return {}
  return flat.lspFromLaunch ? { engine: flat } : { editor: flat }
}

/**
 * The instance a caller most likely wants: the user's editor when there is one,
 * otherwise this plugin's own engine.
 * @param {string} project project root
 * @returns {object|undefined} the record, or undefined when neither is live
 */
export function readBridgeState(project) {
  const { editor, engine } = readBridgeInstances(project)
  return editor ?? engine
}

/**
 * Ask one addon instance for its port facts over its control socket.
 *
 * Preferred over reading the published file when a control port is known: a slot in
 * that file is only as fresh as its instance's last publish, and it lags the first
 * listening probe. Asking the instance answers for that instance, and the reply also
 * refreshes the probe.
 * @param {number} port control port
 * @param {number} [timeoutMs] reply timeout
 * @returns {Promise<{ port?: number, pid?: number, version?: number, project?: string, lspPort?: number, dapPort?: number, lspListening?: boolean, lspFromLaunch?: boolean }|undefined>}
 *   the record as the instance reports it, undefined when nothing answered
 */
export function askBridgeState(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    let out = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch { /* already closed */ }
      resolve(value)
    }
    const timer = setTimeout(() => done(undefined), timeoutMs)
    sock.once('connect', () => { try { sock.write('state\n') } catch { done(undefined) } })
    sock.on('data', (d) => {
      out += d
      const line = out.split(/\r?\n/).map((raw) => raw.trim()).find((raw) => raw.startsWith('state:'))
      if (!line) return
      try {
        const parsed = JSON.parse(line.slice('state:'.length))
        // An addon older than the `state` command answers `err unknown command`
        // instead, which lands here as a parse failure and reports "no facts".
        done(parsed && typeof parsed === 'object' ? parsed : undefined)
      } catch { done(undefined) }
    })
    sock.once('error', () => done(undefined))
    sock.once('close', () => done(undefined))
  })
}

/**
 * The addon instance serving one project, with the facts it reports.
 *
 * Identity is the PROJECT PATH, not a port: ports get occupied and the two sides'
 * settings can disagree, while the directory a session serves is unambiguous. The
 * record's per-kind slots name the candidates; each candidate is then asked over its
 * own control socket, because a slot is only as fresh as that instance's last
 * publish.
 * @param {string} project project root
 * @param {{ rescanPort?: number }} [eng] engine record supplying the control-port scan base
 * @param {{ prefer?: 'editor'|'engine' }} [options] which kind to answer with when both serve the project
 * @returns {Promise<{ controlPort: number, kind: 'editor'|'engine'|'unknown', project?: string, version: number, lspPort?: number, dapPort?: number, lspListening?: boolean, lspFromLaunch: boolean, reported: boolean }|undefined>}
 *   undefined when no instance serves this project; `reported: false` marks an addon
 *   too old to answer `state`, whose ports are therefore unknown
 */
export async function resolveProjectInstance(project, eng, options = {}) {
  const prefer = options.prefer === 'engine' ? 'engine' : 'editor'
  const instances = readBridgeInstances(project)
  const order = prefer === 'engine' ? ['engine', 'editor'] : ['editor', 'engine']
  for (const kind of order) {
    const slot = instances[kind]
    if (!slot) continue
    const resolved = await describeInstance(project, slot.port, kind, slot)
    if (resolved) return resolved
  }
  // Nothing live in the record: an instance may have overwritten it before the slots
  // existed, or the file may be missing. Probing the range asks each candidate who
  // it serves, which is the same identity check.
  const probed = await discoverBridgePortAsync(project, eng)
  if (probed === undefined) return undefined
  return describeInstance(project, probed, undefined, undefined)
}

/**
 * Ask one control port for an instance's facts and normalize them.
 * @param {string} project project root the caller wants
 * @param {number} controlPort control port to ask
 * @param {'editor'|'engine'|undefined} kind kind from the record slot, when known
 * @param {object|undefined} slot the record slot, a fallback for an addon too old to answer
 * @returns {Promise<object|undefined>} undefined when it answered for another project
 */
async function describeInstance(project, controlPort, kind, slot) {
  const facts = await askBridgeState(controlPort)
  const owner = facts && typeof facts.project === 'string' ? facts.project : undefined
  if (facts && owner !== undefined && !samePath(owner, project)) return undefined
  const lspFromLaunch = facts ? facts.lspFromLaunch === true : !!(slot && slot.lspFromLaunch)
  const version = Number(facts && facts.version !== undefined ? facts.version : (slot && slot.version))
  return {
    controlPort,
    kind: kind ?? (facts ? (lspFromLaunch ? 'engine' : 'editor') : 'unknown'),
    project: owner ?? (slot && slot.project),
    version: Number.isInteger(version) && version > 0 ? version : 1,
    lspPort: asPort(facts && facts.lspPort) ?? (slot && slot.lspPort),
    dapPort: asPort(facts && facts.dapPort) ?? (slot && slot.dapPort),
    lspListening: facts && typeof facts.lspListening === 'boolean'
      ? facts.lspListening
      : (slot && slot.lspListening),
    lspFromLaunch,
    reported: facts !== undefined,
  }
}

/**
 * Port published by a running engine's addon. Each instance walks upward from
 * its base port until it binds and writes the winner to
 * `<project>/.godot/dsh_echo_bridge.json`, so two open projects (or an editor
 * plus a headless fallback) never fight over one port and the bridge needs no
 * configuration to find the instance that belongs to this project.
 * @param {string} project project root
 * @returns {number|undefined} the published port, or undefined when no addon is running
 */
export function discoverBridgePort(project) {
  const state = readBridgeState(project)
  return state === undefined ? undefined : state.port
}

/** Shipped addon directory of an engine (undefined when it ships none). */
export function addonSourceOf(eng) {
  return eng && eng.addon ? path.join(path.dirname(eng.bridge), eng.addon, ADDON_ID) : undefined
}

/** Files a shipped addon consists of; a copy is current only when all of them match.
 * Extend this list whenever the shipped directory gains a file: the installer copies
 * recursively, so nothing else would notice a file it does not compare. */
const ADDON_FILES = ['plugin.cfg', 'plugin.gd']

/** Whether a shipped addon file differs from its installed counterpart (or is missing). */
function addonFileDiffers(src, dst) {
  try {
    return !fs.readFileSync(src).equals(fs.readFileSync(dst))
  } catch {
    // Missing or unreadable on either side counts as a difference: the caller installs.
    return true
  }
}

/**
 * Whether a project's installed addon copy matches the engine's shipped one.
 *
 * An installed copy is refreshed only when something installs it, so a project that has
 * one keeps running whatever was shipped the day it was copied. The addon executes inside
 * a Godot instance, which loads editor plugins at startup, so a stale copy also keeps its
 * old behavior until that instance restarts.
 * @param {string} project project root
 * @param {{ id?: string, bridge?: string, addon?: string }} eng engine record that ships an addon
 * @returns {boolean} true when every shipped file exists in the project and is identical
 */
export function isAddonCurrent(project, eng) {
  const src = addonSourceOf(eng)
  if (!src) return false
  const dst = path.join(project, 'addons', ADDON_ID)
  return ADDON_FILES.every((name) => !addonFileDiffers(path.join(src, name), path.join(dst, name)))
}

/** How many ports above the base an addon instance may occupy (mirrors PORT_SCAN_COUNT). */
const PORT_SCAN_COUNT = 16

/** Absolute-path comparison for "is this port's addon serving the project I asked about?". */
function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * Ask a control port which project its addon serves.
 *
 * A port found by probing must be confirmed to belong to the project being
 * checked: another project's addon sits in the same scan range, and the record
 * file cannot settle it — a slot is only as fresh as its instance's last publish,
 * and a slot whose instance exited is ignored rather than removed. An addon older
 * than the `whoami` command answers `err unknown command`, which still proves
 * something is listening there; that is reported as an empty path.
 * @param {number} port control port
 * @param {number} [timeoutMs] reply timeout
 * @returns {Promise<string|undefined>} absolute project path, '' when the addon
 *   predates `whoami` but answered, undefined when nothing answered
 */
export function askBridgeProject(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    let out = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch { /* already closed */ }
      resolve(value)
    }
    const timer = setTimeout(() => done(undefined), timeoutMs)
    sock.once('connect', () => { try { sock.write('whoami\n') } catch { done(undefined) } })
    sock.on('data', (d) => {
      out += d
      const lines = out.split(/\r?\n/).map((line) => line.trim())
      const who = lines.find((line) => line.startsWith('project:'))
      if (who) done(who.slice('project:'.length))
      else if (lines.includes('err unknown command') || lines.includes('pong')) done('')
    })
    sock.once('error', () => done(undefined))
    sock.once('close', () => done(undefined))
  })
}

/**
 * Port of the addon serving this project, found without configuration.
 *
 * `discoverBridgePort` reads the published file, which names at most one instance
 * per kind: two headless engines serving one project share the `engine` slot, so
 * the second overwrites the first's record although that engine still listens, and
 * a slot whose instance exited is ignored rather than removed. Probing the range an
 * addon scans (base .. base+15) recovers an instance that is listening but not
 * named; `whoami` keeps the probe from latching onto another project's addon in the
 * same range.
 * @param {string} project project root
 * @param {{ rescanPort?: number }} [eng] engine record supplying the scan base
 * @returns {Promise<number|undefined>} the port, or undefined when no addon is running
 */
export async function discoverBridgePortAsync(project, eng) {
  const published = discoverBridgePort(project)
  if (published !== undefined) return published
  const base = rescanPortOf(eng)
  for (let offset = 0; offset < PORT_SCAN_COUNT; offset++) {
    const port = base + offset
    const who = await askBridgeProject(port)
    if (who === undefined) continue
    if (who === '' || samePath(who, project)) return port
  }
  return undefined
}

/**
 * Whether project.godot lists one editor plugin in its `[editor_plugins]` enabled list.
 *
 * Scoped to that section and to uncommented text: a commented-out entry, or the same
 * quoted path elsewhere in the file, does not count as enabled. Treating either as
 * enabled would leave the addon installed but never loaded — the state where a running
 * editor cannot report its LSP port.
 * @param {string} project project root
 * @param {string} resPath `res://` path of the addon's plugin.cfg
 * @returns {boolean} true only for an active entry in that list
 */
export function isEditorPluginEnabled(project, resPath) {
  let text
  try { text = fs.readFileSync(path.join(project, 'project.godot'), 'utf8') } catch { return false }
  const section = editorPluginsSection(text)
  if (section === undefined) return false
  // The same scan the writer uses, on the same text: a commented-out key never matches
  // (`;enabled=` does not start a line with `enabled`), and reader and writer can never
  // disagree about where the list ends.
  const span = enabledListSpan(section.body)
  return !!span && span.inner.includes(`"${resPath}"`)
}

/** Offsets of the `[editor_plugins]` section body, or undefined when the section is absent. */
function editorPluginsSection(text) {
  // A section header may also be the last line of the file, without a newline.
  const header = /^\[editor_plugins\][^\S\r\n]*(?:\r?\n|$)/m.exec(text)
  if (header === null) return undefined
  const bodyStart = header.index + header[0].length
  const tail = text.slice(bodyStart)
  const nextHeaderRel = tail.search(/^\[/m)
  const bodyEnd = nextHeaderRel < 0 ? text.length : bodyStart + nextHeaderRel
  return { bodyStart, bodyEnd, body: text.slice(bodyStart, bodyEnd) }
}

/**
 * The `enabled=PackedStringArray(...)` value inside one section body.
 *
 * The closing parenthesis is found by scanning and ignoring parentheses inside quoted
 * entries: a res:// path may legitimately contain them, and a naive `[^)]*` match would
 * cut the list in half.
 * @param {string} body section body
 * @returns {{ start: number, end: number, inner: string }|undefined|false} the span;
 *   undefined when the section declares no `enabled` key; false when that key has no
 *   closing parenthesis (a malformed list, which must fail loudly rather than be replaced)
 */
function enabledListSpan(body) {
  const key = /^[^\S\r\n]*enabled[^\S\r\n]*=[^\S\r\n]*PackedStringArray\(/m.exec(body)
  if (key === null) return undefined
  const innerStart = key.index + key[0].length
  let cursor = innerStart
  let insideQuote = false
  while (cursor < body.length) {
    const character = body[cursor]
    if (character === '"') insideQuote = !insideQuote
    else if (character === ')' && !insideQuote) break
    cursor++
  }
  if (cursor >= body.length) return false // a list without its closing parenthesis
  return { start: key.index, end: cursor, inner: body.slice(innerStart, cursor) }
}

/**
 * Register an editor plugin in project.godot, so Godot loads it on startup.
 * @param {string} project project root
 * @param {string} resPath `res://` path of the addon's plugin.cfg
 * @returns {{ ok: boolean, changed?: boolean, error?: string }} ok=false when project.godot is missing or unwritable
 */
export function ensureEditorPluginEnabled(project, resPath) {
  const cfg = path.join(project, 'project.godot')
  let text
  try { text = fs.readFileSync(cfg, 'utf8') } catch { return { ok: false, error: tLine('addon.err.noProject') } }
  const quoted = `"${resPath}"`
  // Already listed in the section: nothing to write. The check is the same one the
  // callers use, so a path in the list is never appended twice.
  if (isEditorPluginEnabled(project, resPath)) return { ok: true, changed: false }
  const section = editorPluginsSection(text)
  let next
  if (section) {
    const span = enabledListSpan(section.body)
    let newBody
    if (span === false) return { ok: false, error: tLine('addon.err.badPluginSection') }
    if (span) {
      // Append to the existing list; the trailing comma of a hand-written list
      // is dropped so the result stays a valid PackedStringArray literal.
      const inner = span.inner.trim().replace(/,$/, '')
      const list = inner ? `${inner}, ${quoted}` : quoted
      newBody = section.body.slice(0, span.start) + `enabled=PackedStringArray(${list})` + section.body.slice(span.end + 1)
    } else {
      // The header may have matched at end-of-file without a trailing newline:
      // insert the break, or the key would be glued to the section name and the
      // section would stop parsing.
      const needsBreak = !/\r?\n$/.test(text.slice(0, section.bodyStart))
      newBody = `${needsBreak ? '\n' : ''}enabled=PackedStringArray(${quoted})\n\n${section.body.replace(/^\r?\n/, '')}`
    }
    next = text.slice(0, section.bodyStart) + newBody + text.slice(section.bodyEnd)
  } else {
    next = `${text.replace(/\s*$/, '')}\n\n[editor_plugins]\n\nenabled=PackedStringArray(${quoted})\n`
  }
  // Atomic replace: project.godot is the user's file, and a half-written one
  // loses their editor settings.
  const tmp = `${cfg}.lsp-echo.tmp`
  try {
    fs.writeFileSync(tmp, next, 'utf8')
    fs.renameSync(tmp, cfg)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    return { ok: false, error: tLine('addon.err.writeFailed', { message: (e && e.message) || e }) }
  }
  return { ok: true, changed: true }
}

/**
 * Copy an engine's shipped addon into the project and enable it there.
 * @param {string} project project root
 * @param {{ id: string, bridge: string, addon?: string }} eng engine record that ships an addon
 * @returns {{ ok: boolean, addonPath?: string, enabled?: boolean, enableChanged?: boolean, error?: string }} error names the failing step
 */
export function installAddonInto(project, eng) {
  const src = addonSourceOf(eng)
  if (!src || !fs.existsSync(src)) return { ok: false, error: tLine('addon.err.noAddon', { engine: eng ? eng.id : '?' }) }
  const dst = path.join(project, 'addons', ADDON_ID)
  try {
    fs.mkdirSync(dst, { recursive: true })
    // Recursive copy: the addon may ship subdirectories (icons, translations).
    fs.cpSync(src, dst, { recursive: true, force: true })
  } catch (e) {
    return { ok: false, error: tLine('addon.err.copyFailed', { message: (e && e.message) || e }) }
  }
  const en = ensureEditorPluginEnabled(project, addonResPath())
  return en.ok
    ? { ok: true, addonPath: dst, enabled: true, enableChanged: !!en.changed }
    : { ok: true, addonPath: dst, enabled: false, enableChanged: false, error: en.error }
}

/**
 * TCP reachability of one local port, without speaking the protocol.
 *
 * Godot's editor LSP serves a single session and an extra LSP handshake kicks the
 * client already attached to it, so "is something listening?" is answered with a
 * plain connect. The GUI status report uses this to explain why a project is still
 * on the plugin's own engine.
 * @param {number} port local port
 * @param {number} [timeoutMs] connect timeout
 * @returns {Promise<boolean>} true when something accepts the connection
 */
export function probePortOpen(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    let sock
    try {
      sock = net.connect({ host: '127.0.0.1', port })
    } catch {
      // An out-of-range port throws synchronously; a caller probing a bad value
      // wants "nothing there", not a rejected promise.
      resolve(false)
      return
    }
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch { /* already closed */ }
      resolve(value)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
  })
}

/**
 * Ping an engine addon's control socket.
 * @param {number} port control port
 * @param {number} [timeoutMs] reply timeout
 * @returns {Promise<{ online: boolean, error?: string }>} online is false with the reason otherwise
 */
export function probeEngineBridge(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    let out = ''
    let settled = false
    const done = (online, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch { /* already closed */ }
      resolve({ online, error })
    }
    const timer = setTimeout(() => done(false, 'timeout'), timeoutMs)
    sock.once('connect', () => { try { sock.write('ping\n') } catch { done(false, 'write failed') } })
    sock.on('data', (d) => {
      out += d
      // Match whole lines: any local service whose reply merely contains the
      // word "pong" must not be mistaken for the bridge.
      const lines = out.split(/\r?\n/).map((line) => line.trim())
      if (lines.includes('pong')) done(true)
      else if (lines.some((line) => line.startsWith('err'))) done(false, out.trim())
    })
    sock.once('error', (e) => done(false, e.message))
    sock.once('close', () => {
      const lines = out.split(/\r?\n/).map((line) => line.trim())
      if (!lines.includes('pong')) done(false, 'closed without reply')
    })
  })
}
