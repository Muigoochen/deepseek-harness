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
import net from 'node:net'
import path from 'node:path'

/** Addon directory name under <project>/addons (and its plugin.cfg name). */
export const ADDON_ID = 'dsh_echo_bridge'

/** Control port an engine's addon listens on (falls back to the shipped default). */
export function rescanPortOf(eng) {
  const p = eng && eng.rescanPort
  return typeof p === 'number' && Number.isInteger(p) && p > 0 && p <= 65535 ? p : 6089
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
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(project, '.godot', 'dsh_echo_bridge.json'), 'utf8'))
    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
    // A file left behind by an engine that already exited would point at a port
    // nothing answers on (and hide the running instance that did publish one).
    const pid = Number(parsed.pid)
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0) } catch { return undefined }
    }
    return port
  } catch { /* no running addon published a port */ }
  return undefined
}

/** Shipped addon directory of an engine (undefined when it ships none). */
export function addonSourceOf(eng) {
  return eng && eng.addon ? path.join(path.dirname(eng.bridge), eng.addon, ADDON_ID) : undefined
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
  try { text = fs.readFileSync(cfg, 'utf8') } catch { return { ok: false, error: 'project.godot 不存在' } }
  const quoted = `"${resPath}"`
  // A commented-out entry (`;enabled=PackedStringArray(...)`) must not count as
  // already enabled, or the addon would never actually be registered.
  const activeText = text.split(/\r?\n/).filter((line) => !/^\s*;/.test(line)).join('\n')
  if (activeText.includes(quoted)) return { ok: true, changed: false }
  // A section header may also be the last line of the file, without a newline.
  const header = /^\[editor_plugins\][^\S\r\n]*(?:\r?\n|$)/m.exec(text)
  let next
  if (header) {
    const bodyStart = header.index + header[0].length
    const tail = text.slice(bodyStart)
    const nextHeaderRel = tail.search(/^\[/m)
    const bodyEnd = nextHeaderRel < 0 ? text.length : bodyStart + nextHeaderRel
    const body = text.slice(bodyStart, bodyEnd)
    const enabledStart = /^[^\S\r\n]*enabled[^\S\r\n]*=[^\S\r\n]*PackedStringArray\(/m.exec(body)
    let newBody
    if (enabledStart) {
      // Scan for the matching ")" while ignoring parentheses inside quoted
      // entries: a res:// path may legitimately contain them, and a naive
      // [^)]* match would cut the list in half and write an invalid value.
      const innerStart = enabledStart.index + enabledStart[0].length
      let cursor = innerStart
      let is_in_quote = false
      while (cursor < body.length) {
        const character = body[cursor]
        if (character === '"') is_in_quote = !is_in_quote
        else if (character === ')' && !is_in_quote) break
        cursor++
      }
      if (cursor >= body.length) return { ok: false, error: 'project.godot 的 [editor_plugins] 段无法解析(enabled 列表缺少右括号)' }
      // Append to the existing list; the trailing comma of a hand-written list
      // is dropped so the result stays a valid PackedStringArray literal.
      const inner = body.slice(innerStart, cursor).trim().replace(/,$/, '')
      const list = inner ? `${inner}, ${quoted}` : quoted
      newBody = body.slice(0, enabledStart.index) + `enabled=PackedStringArray(${list})` + body.slice(cursor + 1)
    } else {
      // The header may have matched at end-of-file without a trailing newline:
      // insert the break, or the key would be glued to the section name and the
      // section would stop parsing.
      const needsBreak = !/\r?\n$/.test(text.slice(0, bodyStart))
      newBody = `${needsBreak ? '\n' : ''}enabled=PackedStringArray(${quoted})\n\n${body.replace(/^\r?\n/, '')}`
    }
    next = text.slice(0, bodyStart) + newBody + text.slice(bodyEnd)
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
    return { ok: false, error: `写入 project.godot 失败: ${(e && e.message) || e}` }
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
  if (!src || !fs.existsSync(src)) return { ok: false, error: `引擎 ${eng ? eng.id : '?'} 未附带引擎桥 addon` }
  const dst = path.join(project, 'addons', ADDON_ID)
  try {
    fs.mkdirSync(dst, { recursive: true })
    // Recursive copy: the addon may ship subdirectories (icons, translations).
    fs.cpSync(src, dst, { recursive: true, force: true })
  } catch (e) {
    return { ok: false, error: `复制 addon 失败: ${(e && e.message) || e}` }
  }
  const en = ensureEditorPluginEnabled(project, `res://addons/${ADDON_ID}/plugin.cfg`)
  return en.ok
    ? { ok: true, addonPath: dst, enabled: true, enableChanged: !!en.changed }
    : { ok: true, addonPath: dst, enabled: false, enableChanged: false, error: en.error }
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
