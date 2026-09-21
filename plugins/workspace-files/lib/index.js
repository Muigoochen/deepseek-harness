// workspace-files — Host half. 工作区文件树插件的“逻辑脚本”。
//
// 职责:
//  1. 向浏览器半提供每工作区目录列举的请求-应答通道(纯 HTTP GET 路由,自建
//     transport,不改仓库):
//       GET /workspace-files/list?ws=<workspaceId>&path=<posix-rel|空>
//     应答 200 JSON: { path, rel, entries:[{name,type,size?}] }
//     entries 为该层直接子项;type ∈ file|directory|other(目录优先由客户端排)。
//  2. 安全:只允许列举该工作区根目录(workspaceRegistry.get(ws).path)内部的路径,
//     越界/未知工作区一律 4xx,不落地任何磁盘状态。
//
// 依赖服务:webServer(路由载体)、workspaceRegistry(工作区根路径)、fs(列举)。
// 纯插件守则:不修改仓库任何产品/底层源码;无持久状态。

import { join, resolve, sep } from 'node:path'

export const name = 'workspace-files'

/** 本半区需要的宿主服务。 */
export const inject = ['webServer', 'workspaceRegistry', 'fs']

const ROUTE_PATH = '/workspace-files/list'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/** 写一条 JSON 响应(若尚未开始写)。 */
function writeJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(payload))
}

/** 把客户端传来的 posix 相对路径规整成“根内相对路径”(''|'.'|'/'→空)。 */
function normalizeRel(raw) {
  if (raw === null || raw === undefined) return ''
  let rel = String(raw).replace(/\\/g, '/').replace(/^\/+/, '')
  if (rel === '' || rel === '.') return ''
  const parts = []
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return null // 越界:拒绝整请求
    parts.push(part)
  }
  return parts.join('/')
}

/**
 * 装载入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  /** 单层目录列举处理器。 */
  const handler = async (req, res) => {
    try {
      if ((req.method || 'GET').toUpperCase() !== 'GET') {
        writeJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      const url = new URL(req.url || '/', 'http://workspace-files.local')
      const wsId = url.searchParams.get('ws')
      if (typeof wsId !== 'string' || wsId === '') {
        writeJson(res, 400, { error: 'missing-ws' })
        return
      }
      const rel = normalizeRel(url.searchParams.get('path'))
      if (rel === null) {
        writeJson(res, 400, { error: 'path-outside-root' })
        return
      }

      const workspace = await ctx.workspaceRegistry.get(wsId)
      if (!workspace) {
        writeJson(res, 404, { error: 'workspace-not-found', ws: wsId })
        return
      }
      const root = workspace.path

      // 目标 = 根 + 相对路径;resolve/join 后必须仍落在根内(大小写不敏感比较兜底)。
      const full = rel === '' ? resolve(root) : resolve(join(root, ...rel.split('/')))
      const rootNorm = resolve(root)
      const sameRoot = full === rootNorm
      const inside =
        process.platform === 'win32'
          ? full.toLowerCase().startsWith(rootNorm.toLowerCase() + sep.toLowerCase())
          : full.startsWith(rootNorm + sep)
      if (!sameRoot && !inside) {
        writeJson(res, 403, { error: 'path-outside-root', full })
        return
      }

      const target = await ctx.fs.resolve(full)
      let entries
      try {
        entries = await ctx.fs.listDir(target)
      } catch (error) {
        const code = (error && error.code) || 'list-failed'
        writeJson(res, code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 500, {
          error: 'list-failed',
          code,
          message: String((error && error.message) || error),
        })
        return
      }

      const out = entries.map((entry) => {
        const item = {
          name: String(entry.name ?? ''),
          type: entry.type === 'file' || entry.type === 'directory' ? entry.type : 'other',
        }
        if (entry.type === 'file' && typeof entry.size === 'number') item.size = entry.size
        return item
      })
      out.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      })
      writeJson(res, 200, { path: full, rel, root: rootNorm, entries: out })
    } catch (error) {
      console.error(`[workspace-files] list handler failed: ${(error && error.stack) || error}`)
      writeJson(res, 500, { error: 'internal', message: String((error && error.message) || error) })
    }
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler })
    return () => disposeRoute()
  })
}
