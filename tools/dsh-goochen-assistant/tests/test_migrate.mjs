// tests/test_migrate.mjs — migrate.mjs 单元/冒烟测试（Node >= 24，node:test，零依赖）。
// 用“真实磁盘/日志形状”的合成 zstd 会话 + 投影缓存，验证 list/inject/verify/restore、
// 字段保真（仅改目标字段、保留其余帧字节）与各拒绝路径。形状对齐产品：
//   header: { version, id, type:'session', createdAt, cwd, origin, delegationDepth, parentSession, agentPreset }
//   事件帧: { type:'agent-preset/selected' | 'message', ... }   （type 为判别字段）
//   缓存:   { version:4, record:{ identity, rows:{ agentPreset:{ver,seq,val}, title:{val} } } }
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompress, constants } from 'node:zlib'
import { promisify } from 'node:util'
import * as mig from '../migrate.mjs'

const compress = promisify(zstdCompress)
const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const ID = 'a1b2c3d4e5f67890'
const WS = 'default'
const CREATED = '2026-01-02T03:04:05.678Z'

function sessionFile(home, ws = WS, id = ID) {
  return join(home, 'sessions', ws, id, 'session.jsonl.zstd')
}
function cacheFile(home, id = ID) {
  return join(home, 'storages', 'session_projcache', 'sessions', id + '.json')
}

async function mkFrame(text) {
  return compress(Buffer.from(text, 'utf8'), CHECKSUM)
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dshm-'))
  process.env.DSH_HOME = home
  return home
}

function buildHeader(preset, opts = {}) {
  const h = {
    version: 2, id: ID, type: 'session', createdAt: CREATED,
    cwd: 'C:\\work', origin: 'console', delegationDepth: 0,
  }
  if (!opts.noAgentPreset) h.agentPreset = preset
  h.parentSession = ''
  return h
}

async function putSession(home, id = ID, preset = 'cordis-default', opts = {}) {
  const sessDir = join(home, 'sessions', WS, id)
  mkdirSync(sessDir, { recursive: true })
  const header = buildHeader(preset, opts)
  // two frames: header + one event (real type discriminant)
  const evt = { type: opts.selection ? 'agent-preset/selected' : 'message', text: 'hi' }
  const log = Buffer.concat([
    await mkFrame(JSON.stringify(header) + '\n'),
    await mkFrame(JSON.stringify(evt) + '\n'),
  ])
  writeFileSync(sessionFile(home, WS, id), log)
  if (!opts.noCache) {
    mkdirSync(join(cacheFile(home, id), '..'), { recursive: true })
    const cache = {
      version: 4,
      record: {
        identity: { id, kind: 'session' },
        rows: {
          agentPreset: { ver: 1, seq: 1, val: preset },
          title: { val: 'Session Title' },
        },
      },
    }
    writeFileSync(cacheFile(home, id), JSON.stringify(cache))
  }
}

async function readFramesAfterFrame0(home) {
  const { frames, buffer } = await mig.readHeader(sessionFile(home))
  return buffer.subarray(frames[0].end)
}

test('listJSON reflects real preset/cache/title', async () => {
  const home = makeHome()
  await putSession(home, ID, 'cordis-default')
  const rows = await mig.listJSON()
  const row = rows.find((r) => r.id === ID)
  assert.ok(row)
  assert.equal(row.preset, 'cordis-default')
  assert.equal(row.cache, 'cordis-default')
  assert.equal(row.title, 'Session Title')
  assert.equal(row.workspace, WS)
  rmSync(home, { recursive: true, force: true })
})

test('inject rewrites only target fields and keeps later frames', async () => {
  const home = makeHome()
  await putSession(home, ID, 'cordis-default')
  const beforeHeader = (await mig.readHeader(sessionFile(home))).header
  const laterBefore = await readFramesAfterFrame0(home)

  await mig.inject(ID, 'cordis-director')

  const after = await mig.readHeader(sessionFile(home))
  const afterHeader = after.header
  // only agentPreset changed; every other header field preserved
  assert.equal(afterHeader.agentPreset, 'cordis-director')
  assert.equal(afterHeader.id, beforeHeader.id)
  assert.equal(afterHeader.type, 'session')
  assert.equal(afterHeader.createdAt, beforeHeader.createdAt)
  assert.equal(afterHeader.cwd, beforeHeader.cwd)
  assert.equal(afterHeader.origin, beforeHeader.origin)
  assert.equal(afterHeader.delegationDepth, beforeHeader.delegationDepth)
  assert.equal(afterHeader.parentSession, beforeHeader.parentSession)
  // later frame bytes untouched
  assert.deepEqual(await readFramesAfterFrame0(home), laterBefore)
  // cache: ver/seq/identity kept, only val changed
  const cache = JSON.parse(readFileSync(cacheFile(home), 'utf8'))
  assert.equal(cache.version, 4)
  assert.deepEqual(cache.record.identity, { id: ID, kind: 'session' })
  assert.equal(cache.record.rows.agentPreset.ver, 1)
  assert.equal(cache.record.rows.agentPreset.seq, 1)
  assert.equal(cache.record.rows.agentPreset.val, 'cordis-director')
  // verify agrees
  assert.equal(await mig.verify(ID), 'cordis-director')
  rmSync(home, { recursive: true, force: true })
})

test('inject later-failure rolls both files back from backup', async () => {
  const home = makeHome()
  await putSession(home, ID, 'cordis-default')
  // make the cache path a directory so the cache write (first write) fails
  rmSync(cacheFile(home), { force: true })
  mkdirSync(cacheFile(home), { recursive: true })
  await assert.rejects(() => mig.inject(ID, 'cordis-director'))
  // header must remain the original preset; verify via readHeader
  const h = (await mig.readHeader(sessionFile(home))).header
  assert.equal(h.agentPreset, 'cordis-default')
  rmSync(home, { recursive: true, force: true })
})

test('inject succeeds when no cache file', async () => {
  const home = makeHome()
  await putSession(home, ID, 'cordis-default', { noCache: true })
  await mig.inject(ID, 'cordis-director')
  assert.equal(await mig.verify(ID), 'cordis-director')
  assert.ok(!existsSync(cacheFile(home)))
  rmSync(home, { recursive: true, force: true })
})

test('restore reverts both files and ignores forged path', async () => {
  const home = makeHome()
  await putSession(home, ID, 'cordis-default')
  await mig.inject(ID, 'cordis-director')
  const root = join(home, '_session-preset-backup')
  const dirs = readdirSync(root).filter((d) => d.endsWith('--' + ID))
  assert.ok(dirs.length >= 1)
  const dir = join(root, dirs[dirs.length - 1])
  // forge every manifest.source to an arbitrary decoy path; restore must NOT honor it
  const manifestPath = join(dir, 'manifest.json')
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const f of m.files) f.source = join(home, 'evil-' + f.role)
  writeFileSync(manifestPath, JSON.stringify(m, null, 2))
  await mig.restore(dir)
  assert.equal(await mig.verify(ID), 'cordis-default')
  assert.ok(!existsSync(join(home, 'evil-session')))
  assert.ok(!existsSync(join(home, 'evil-cache')))
  rmSync(home, { recursive: true, force: true })
})

test('restore rejects a manifest with path-traversal name', async () => {
  const home = makeHome()
  await putSession(home, ID, 'cordis-default')
  const root = join(home, '_session-preset-backup')
  const dir = join(root, '2026-01-01T00-00-00-000Z--' + ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'),
    JSON.stringify({ id: ID, stamp: 's', files: [{ role: 'session', name: '../../evil', source: join(home, 'oops') }] }))
  await assert.rejects(() => mig.restore(dir), /unsafe backup file name/)
  rmSync(home, { recursive: true, force: true })
})

test('restore rejects a dir outside the backup root', async () => {
  const home = makeHome()
  const outside = join(home, 'elsewhere')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'manifest.json'), JSON.stringify({ id: ID, files: [] }))
  await assert.rejects(() => mig.restore(outside), /direct child of/)
  rmSync(home, { recursive: true, force: true })
})

test('rejects invalid id/preset', async () => {
  const home = makeHome()
  await putSession(home, ID)
  await assert.rejects(() => mig.inject('bad id!', 'cordis-director'), /invalid session id/)
  await assert.rejects(() => mig.inject(ID, 'bad preset!'), /invalid preset/)
  rmSync(home, { recursive: true, force: true })
})

test('rejects no-op same preset', async () => {
  const home = makeHome()
  await putSession(home, ID, 'cordis-default')
  await assert.rejects(() => mig.inject(ID, 'cordis-default'), /already runs preset/)
  rmSync(home, { recursive: true, force: true })
})

test('rejects session that switched preset while blank', async () => {
  const home = makeHome()
  await putSession(home, ID, 'cordis-default', { selection: true })
  await assert.rejects(() => mig.inject(ID, 'cordis-director'), /refuse to migrate/)
  rmSync(home, { recursive: true, force: true })
})

test('rejects header without agentPreset', async () => {
  const home = makeHome()
  await putSession(home, ID, 'cordis-default', { noAgentPreset: true })
  await assert.rejects(() => mig.inject(ID, 'cordis-director'), /has no agentPreset/)
  rmSync(home, { recursive: true, force: true })
})

test('rejects cache with no agentPreset entry', async () => {
  const home = makeHome()
  await putSession(home, ID, 'cordis-default')
  // rewrite cache without an agentPreset entry
  const c = JSON.parse(readFileSync(cacheFile(home), 'utf8'))
  delete c.record.rows.agentPreset
  writeFileSync(cacheFile(home), JSON.stringify(c))
  await assert.rejects(() => mig.inject(ID, 'cordis-director'), /has no agentPreset entry/)
  rmSync(home, { recursive: true, force: true })
})

test('rejects id present in multiple workspaces', async () => {
  const home = makeHome()
  await putSession(home, ID, 'cordis-default')
  const d2 = join(home, 'sessions', 'other', ID)
  mkdirSync(d2, { recursive: true })
  const header = buildHeader('cordis-default')
  const log = Buffer.concat([
    await mkFrame(JSON.stringify(header) + '\n'),
    await mkFrame(JSON.stringify({ type: 'message', text: 'x' }) + '\n'),
  ])
  writeFileSync(sessionFile(home, 'other', ID), log)
  await assert.rejects(() => mig.inject(ID, 'cordis-director'), /exists in multiple workspaces/)
  rmSync(home, { recursive: true, force: true })
})
