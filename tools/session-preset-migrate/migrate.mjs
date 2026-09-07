#!/usr/bin/env node
/**
 * session-preset-migrate — point an EXISTING session at a different agent
 * preset by rewriting exactly two single fields, file-only (never whole
 * directories).
 *
 *   node migrate.mjs list                         # show sessions + their preset
 *   node migrate.mjs inject <id> <preset> [--dry-run]
 *   node migrate.mjs verify <id>
 *   node migrate.mjs restore <backupDir>          # copy the two files back
 *
 * What it rewrites (single field each, nothing else touched):
 *   1. <dshHome>/sessions/<workspace>/<id>/session.jsonl.zstd
 *        frame 0 (the header frame) only: `agentPreset`.
 *        All later frames stay byte-for-byte untouched; frame 0 is
 *        re-compressed with the same checksummed zstd options the product uses.
 *   2. <dshHome>/storages/session_projcache/sessions/<id>.json (when present)
 *        the `agentPreset` projection entry: `val` only.
 *
 * Backups are the two FILES ONLY (session log + cache, when it exists),
 * copied under <dshHome>/_session-preset-backup/<stamp>--<id>/.
 * No directory is ever copied. Requires Node ^22.19 || >=24 (node:zlib zstd).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'

// Fail fast with a clear message instead of a later cryptic zlib error if the
// running Node predates node:zlib's zstd APIs (landed in v22.15; engines ^22.19).
if (typeof zstdCompress !== 'function' || typeof zstdDecompress !== 'function' || constants.ZSTD_c_checksumFlag === undefined) {
  console.error('此 Node 版本缺少 node:zlib 的 zstd 压缩 API（需要 Node ^22.19 或 >=24）。')
  process.exit(1)
}

const compress = promisify(zstdCompress)
const decompress = promisify(zstdDecompress)
const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const ZSTD_MAGIC = 0xfd2fb528
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,80}$/
const PRESET_RE = /^[a-z0-9][a-z0-9._-]*$/i

function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.length > 0 ? env : join(homedir(), '.dsh')
}

/* ---- zstd frame scan (port of dsh-session-persistence-jsonl scanZstdFrames) ---- */
function frameRanges(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error(`corrupt zstd log: truncated magic at ${offset}`)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt zstd log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) throw new Error(`corrupt zstd log: empty frame at ${start}`)
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`corrupt zstd log: reserved frame-header bit at ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) throw new Error(`corrupt zstd log: truncated header at ${start}`)
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`corrupt zstd log: truncated block header at ${offset}`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`corrupt zstd log: reserved block type at ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) throw new Error(`corrupt zstd log: truncated block payload at ${offset}`)
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error(`corrupt zstd log: truncated checksum at ${offset}`)
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

async function decodeFrame(frame, buffer) {
  const plain = await decompress(buffer.subarray(frame.start, frame.end))
  return plain.toString('utf8')
}

/** True when any logged event is a blank-window preset switch (agent-preset/selected). */
async function hasPresetSelectionEvent(buffer, frames) {
  for (const frame of frames.slice(1)) {
    const text = await decodeFrame(frame, buffer)
    if (text.includes('"agent-preset/selected"')) return true
  }
  return false
}

async function encodeFrame(text) {
  return compress(text, CHECKSUM)
}

/* ---- paths ---- */
function sessionDirs(home) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const out = []
  for (const ws of readdirSync(root)) {
    const wsDir = join(root, ws)
    if (!statSync(wsDir).isDirectory()) continue
    for (const id of readdirSync(wsDir)) {
      const file = join(wsDir, id, 'session.jsonl.zstd')
      if (existsSync(file)) out.push({ id, workspace: ws, file })
    }
  }
  return out
}

function cachePath(home, id) {
  return join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)
}

async function readHeader(file) {
  const buffer = readFileSync(file)
  const frames = frameRanges(buffer)
  if (frames.length === 0) throw new Error(`no complete zstd frame in ${file}`)
  const plaintext = await decodeFrame(frames[0], buffer)
  const line = plaintext.split('\n', 1)[0]
  const header = JSON.parse(line)
  if (header === null || typeof header !== 'object' || header.type !== 'session') {
    throw new Error(`frame 0 of ${file} is not a session header (type=${header && header.type})`)
  }
  return { header, frames, buffer }
}

async function readCache(id) {
  const file = cachePath(dshHome(), id)
  if (!existsSync(file)) return null
  return { file, json: JSON.parse(readFileSync(file, 'utf8')) }
}

/* Top-level entry named `agentPreset` holding { ver, seq, val } in the cache. */
function findPresetEntry(node) {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    const direct = node.agentPreset
    if (direct !== null && typeof direct === 'object'
      && !Array.isArray(direct) && typeof direct.val === 'string') {
      return direct
    }
    for (const key of Object.keys(node)) {
      const found = findPresetEntry(node[key])
      if (found !== undefined) return found
    }
  }
  return undefined
}

function backupBase() {
  return join(dshHome(), '_session-preset-backup')
}

/** Human-readable session title from the projection cache; '' when absent. */
async function titleOf(id) {
  try {
    const cache = await readCache(id)
    if (cache === null) return ''
    const root = cache.json
    if (root === null || typeof root !== 'object') return ''
    const rows = root.record && typeof root.record === 'object'
      ? root.record.rows
      : (root.rows && typeof root.rows === 'object' ? root.rows : root)
    if (rows === null || typeof rows !== 'object') return ''
    const entry = rows.title
    const val = entry !== null && typeof entry === 'object' ? entry.val : entry
    return typeof val === 'string' ? val.replace(/\s+/g, ' ').trim() : ''
  } catch {
    return ''
  }
}

/* Backup exactly the two files we may touch; returns backup dir or null. */
function backupFiles(id, files) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(backupBase(), `${stamp}--${id}`)
  mkdirSync(dir, { recursive: true })
  const manifest = { id, stamp, files: [] }
  for (const { path, role } of files) {
    const name = `${role}-${basename(path)}`
    const target = join(dir, name)
    if (existsSync(path)) copyFileSync(path, target)
    manifest.files.push({ role, name, source: path })
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return dir
}

/** JSON list with titles — machine + GUI friendly (UTF-8, no parsing hacks). */
async function listJSON() {
  const rows = []
  for (const s of sessionDirs(dshHome())) {
    try {
      const { header } = await readHeader(s.file)
      const cache = await readCache(s.id)
      rows.push({
        id: s.id,
        workspace: s.workspace,
        title: await titleOf(s.id),
        preset: header.agentPreset ?? null,
        cache: cache !== null ? (findPresetEntry(cache.json)?.val ?? null) : null,
        bytes: statSync(s.file).size,
        subagent: typeof header.parentSession === 'string' && header.parentSession.length > 0,
      })
    } catch (error) {
      rows.push({
        id: s.id,
        workspace: s.workspace,
        title: '',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return rows
}

async function listSessions() {
  for (const s of sessionDirs(dshHome())) {
    try {
      const { header } = await readHeader(s.file)
      const st = statSync(s.file)
      const preset = header.agentPreset ?? '(none)'
      const cache = await readCache(s.id)
      const cacheVal = cache !== null
        ? (findPresetEntry(cache.json)?.val ?? '(no agentPreset entry)')
        : '(no cache file)'
      console.log(`${s.id}  preset=${preset}  cache=${cacheVal}  bytes=${st.size}  ws=${s.workspace}`)
    } catch (error) {
      console.log(`${s.id}  ERROR: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function inject(id, newPreset, dryRun) {
  if (!ID_RE.test(id)) throw new Error(`invalid session id: ${id}`)
  if (!PRESET_RE.test(newPreset)) throw new Error(`invalid preset id: ${newPreset}`)
  const home = dshHome()
  const found = sessionDirs(home).filter((s) => s.id === id)
  if (found.length === 0) throw new Error(`no session ${id} under ${join(home, 'sessions')}`)
  if (found.length > 1) throw new Error(`session id ${id} exists in multiple workspaces: ${found.map((f) => f.workspace).join(', ')}`)

  const session = found[0]
  const { header, frames, buffer } = await readHeader(session.file)
  const oldPreset = header.agentPreset
  if (oldPreset === undefined) throw new Error(`header of ${id} has no agentPreset`)
  if (oldPreset === newPreset) throw new Error(`session ${id} already runs preset ${newPreset} (no-op)`)
  if (await hasPresetSelectionEvent(buffer, frames)) {
    throw new Error(`session ${id} changed preset while blank (agent-preset/selected in log); ` +
      `replay would override a header rewrite — refuse to migrate this session`)
  }

  const cache = await readCache(id)
  const cacheEntry = cache === null ? undefined : findPresetEntry(cache.json)
  if (cache !== null && cacheEntry === undefined) {
    throw new Error(`cache ${cache.file} exists but has no agentPreset entry; aborting (do not guess)`)
  }

  console.log(`session ${id} (workspace ${session.workspace})`)
  console.log(`  header  agentPreset: ${oldPreset} -> ${newPreset}`)
  console.log(`  frames: ${frames.length}, log bytes: ${buffer.length}`)
  console.log(`  cache   agentPreset: ${cacheEntry ? `${cacheEntry.val} -> ${newPreset}` : '(no cache file)'}`)

  if (dryRun) {
    console.log('DRY-RUN: no file was written. Backing up: session log file + cache file (if any).')
    return
  }

  const touched = []
  const sessionFile = session.file
  const cacheFile = cache === null ? null : cache.file
  if (cacheFile !== null) touched.push({ path: cacheFile, role: 'cache' })
  touched.push({ path: sessionFile, role: 'session' })
  const backupDir = backupFiles(id, touched)
  console.log(`backup -> ${backupDir}`)

  // Write the lower-risk cache side first, then the session log. If either
  // write fails the two files would disagree on the preset, so roll both back
  // to their backups before re-raising.
  try {
    if (cache !== null) {
      cacheEntry.val = newPreset
      const tmpCache = cacheFile + '.migrate-tmp'
      writeFileSync(tmpCache, JSON.stringify(cache.json))
      renameSync(tmpCache, cacheFile)
    }
    const headerPlain = await decodeFrame(frames[0], buffer)
    const newline = headerPlain.endsWith('\n') ? '\n' : ''
    const newHeader = JSON.stringify({ ...header, agentPreset: newPreset })
    const newFrame0 = await encodeFrame(newHeader + newline)
    const rewritten = Buffer.concat([newFrame0, buffer.subarray(frames[0].end)])
    const tmp = sessionFile + '.migrate-tmp'
    writeFileSync(tmp, rewritten)
    renameSync(tmp, sessionFile)
  } catch (error) {
    await restore(backupDir).catch(() => {})
    throw error
  }

  await verify(id, home)
  console.log(`inject OK (backup: ${backupDir}) — restart dsh web for the session to remount.`)
}

async function verify(id, home = dshHome()) {
  const found = sessionDirs(home).filter((s) => s.id === id)
  if (found.length === 0) throw new Error(`no session ${id}`)
  if (found.length > 1) throw new Error(`verify: session ${id} exists in multiple workspaces`)
  const { header } = await readHeader(found[0].file)
  const cache = await readCache(id)
  const entry = cache === null ? undefined : findPresetEntry(cache.json)
  console.log(`verify ${id}: header.agentPreset=${header.agentPreset} cache=${entry ? entry.val : '(none)'}`)
  if (header.agentPreset === undefined) throw new Error('verify failed: header has no agentPreset')
  if (cache !== null && entry === undefined) throw new Error('verify failed: cache entry missing')
  return header.agentPreset
}

async function restore(backupDir) {
  const manifestFile = join(backupDir, 'manifest.json')
  if (!existsSync(manifestFile)) throw new Error(`not a backup dir: ${backupDir} (no manifest.json)`)
  const home = dshHome()
  const backupRoot = resolve(join(home, '_session-preset-backup'))
  const resolvedDir = resolve(backupDir)
  if (dirname(resolvedDir) !== backupRoot) {
    throw new Error(`restore: backup dir must be a direct child of ${backupRoot}`)
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const id = manifest.id
  if (!ID_RE.test(id)) throw new Error(`restore: invalid session id in manifest`)
  // Re-derive the only two targets from the id — never from manifest.source — so
  // a forged or hand-edited manifest cannot write to an arbitrary path.
  const found = sessionDirs(home).filter((s) => s.id === id)
  if (found.length !== 1) throw new Error(`restore: session ${id} not uniquely found (${found.length} workspaces)`)
  const roleTarget = { session: found[0].file, cache: cachePath(home, id) }
  for (const file of manifest.files) {
    const role = file.role
    if (role !== 'session' && role !== 'cache') throw new Error(`restore: unknown role ${role}`)
    const name = file.name
    if (typeof name !== 'string' || name.includes('..') || basename(name) !== name) {
      throw new Error(`restore: unsafe backup file name ${name}`)
    }
    const backup = join(backupDir, name)
    if (!existsSync(backup)) throw new Error(`restore: backup file missing: ${backup}`)
    const target = roleTarget[role]
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(backup, target)
    console.log(`restored ${role} -> ${target}`)
  }
  console.log(`restore OK from ${backupDir}`)
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === 'list-json') {
    console.log(JSON.stringify(await listJSON()))
    return
  }
  if (cmd === 'list') {
    await listSessions()
    return
  }
  if (cmd === 'inject') {
    if (!a || !b) throw new Error('usage: inject <sessionId> <presetId> [--dry-run]')
    await inject(a, b, process.argv.includes('--dry-run'))
    return
  }
  if (cmd === 'verify') {
    if (!a) throw new Error('usage: verify <sessionId>')
    await verify(a)
    return
  }
  if (cmd === 'restore') {
    if (!a) throw new Error('usage: restore <backupDir>')
    await restore(a)
    return
  }
  throw new Error(`usage: node migrate.mjs list|inject|verify|restore`)
}

const isEntry = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isEntry) {
  main().catch((error) => {
    console.error(`migrate: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}

export {
  dshHome, sessionDirs, cachePath, readHeader, readCache,
  findPresetEntry, titleOf, listJSON, verify, inject, restore,
}
