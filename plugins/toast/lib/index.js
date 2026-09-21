// toast — Host half. 浮动提示插件的“逻辑脚本”。
//
// 职责:
//  1. 以 ctx.provide('toast', service) 提供公共 API(其它宿主插件 inject:['toast'] 即用):
//       show({kind,title,body,durationMs,closable,id}) / dismiss(id?) / list()
//  2. 维护事件队列(seq 单调递增,可幂等去重),并向浏览器半提供长询路由:
//       GET /toast/events?since=<seq>
//     队列有事件立即应答;空闲时挂起请求,事件到达或有事件时立即返回;超时(~20s)空答,
//     浏览器端随即重挂 —— 这是插件内部的可替换 transport(见 docs/design.md §5)。
//
// 纯插件守则:不修改仓库任何产品/底层源码;运行状态只存内存(进程内队列,有界)。

export const name = 'toast'

/** 本半区需要的宿主服务。 */
export const inject = ['webServer']

const ROUTE_PATH = '/toast/events'
const IDLE_HOLD_MS = 20_000 // 空闲长询最大挂起时长,到期空答让浏览器重挂
const SWEEP_MS = 5_000 // 空闲请求清扫间隔
const QUEUE_CAP = 200 // 队列有界容量(无页面期间的提示最多保留这些)
const DEFAULT_DURATION_MS = 4000
const KINDS = ['info', 'success', 'warning', 'error']

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/**
 * 装载入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  let nextSeq = 1
  /** @type {{seq:number,kind:string,title?:string,body?:string,durationMs:number,closable:boolean,id?:string}[]} */
  const events = []
  /** 幂等去重:调用方 id -> seq。 */
  const byId = new Map()
  /** 挂起的长询应答器。 */
  const pending = new Set()

  const respond = (res, payload) => {
    if (res.writableEnded) return
    res.writeHead(200, JSON_HEADERS)
    // maxSeq lets the browser side detect host restarts and drop stale replays.
    res.end(JSON.stringify({ ...payload, maxSeq: nextSeq - 1 }))
  }

  const deliver = (waiter) => {
    const out = events.filter((e) => e.seq > waiter.since)
    if (out.length === 0) return
    pending.delete(waiter)
    respond(waiter.res, { events: out })
  }

  const flush = () => {
    for (const waiter of [...pending]) deliver(waiter)
  }

  // Removals must reach clients that already acked the original seq, so they
  // travel as NEW events carrying removedSeq (not in-place tombstones).
  const emitRemoval = (seqs) => {
    events.push({ seq: nextSeq, removedSeq: seqs })
    nextSeq += 1
    flush()
  }

  /** 入队一条提示;非法/空请求返回 undefined。 */
  const push = (request) => {
    const kind = KINDS.includes(request && request.kind) ? request.kind : 'info'
    const title = typeof request.title === 'string' && request.title !== '' ? request.title : undefined
    const body = typeof request.body === 'string' && request.body !== '' ? request.body : undefined
    if (title === undefined && body === undefined) return undefined
    const id = typeof request.id === 'string' && request.id !== '' ? request.id : undefined
    const durationMs = Number.isFinite(request.durationMs) && request.durationMs >= 0
      ? Math.floor(request.durationMs)
      : DEFAULT_DURATION_MS
    const closable = request.closable !== false
    if (id !== undefined && byId.has(id)) {
      // Same-id replacement: first remove the old toast on every client
      // (including ones that already acked its seq), then push the fresh one.
      const old = byId.get(id)
      const at = events.findIndex((e) => e.seq === old)
      emitRemoval([old])
      if (at !== -1) events.splice(at, 1)
      byId.delete(id)
    }
    const entry = {
      seq: nextSeq,
      kind,
      title,
      body,
      durationMs,
      closable,
      ...(id !== undefined ? { id } : {}),
    }
    nextSeq += 1
    events.push(entry)
    if (id !== undefined) byId.set(id, entry.seq)
    while (events.length > QUEUE_CAP) {
      const dropped = events.shift()
      if (dropped.id !== undefined) byId.delete(dropped.id)
    }
    flush()
    return { ok: true, seq: entry.seq }
  }

  const service = {
    /**
     * 弹一条浮动提示(宿主侧公共 API,契约见 docs/design.md §4)。
     * @param {object} request
     * @returns {{ok:boolean,seq?:number,reason?:string}}
     */
    show(request) {
      const seq = push(request)
      if (seq === undefined) return { ok: false, reason: 'nothing-to-show' }
      return seq
    },
    /**
     * 关闭提示。缺省清空整条队列;有 id 只关那一条(以调用方 id 为准)。
     * @param {string} [id]
     * @returns {{dismissed:number}}
     */
    dismiss(id) {
      if (typeof id === 'string' && id !== '') {
        const seq = byId.get(id)
        if (seq === undefined) return { dismissed: 0 }
        const at = events.findIndex((e) => e.seq === seq)
        emitRemoval([seq])
        if (at !== -1) events.splice(at, 1)
        byId.delete(id)
        return { dismissed: 1 }
      }
      const count = events.length
      emitRemoval(events.map((e) => e.seq))
      events.length = 0
      byId.clear()
      return { dismissed: count }
    },
    /**
     * 只读查看当前队列(调试/测试用)。
     * @returns {{events:object[]}}
     */
    list() {
      return { events: events.map((e) => ({ ...e })) }
    },
  }
  ctx.provide('toast', service)

  /** 长询路由:有事件立即答,无事件挂起等 push() 冲刷或超时。 */
  const handler = async (req, res) => {
    try {
      if ((req.method || 'GET').toUpperCase() !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      const url = new URL(req.url || '/', 'http://toast.local')
      const raw = url.searchParams.get('since')
      const parsed = raw === null || raw === '' ? 0 : Number.parseInt(raw, 10)
      const since = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
      const out = events.filter((e) => e.seq > since)
      if (out.length > 0) {
        respond(res, { events: out })
        return
      }
      const waiter = { res, since, at: Date.now() }
      pending.add(waiter)
      res.on('close', () => { pending.delete(waiter) })
    } catch (error) {
      console.error(`[toast] events handler failed: ${(error && error.message) || error}`)
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end('bad request')
    }
  }

  const sweep = () => {
    const now = Date.now()
    for (const waiter of [...pending]) {
      if (now - waiter.at >= IDLE_HOLD_MS) {
        pending.delete(waiter)
        respond(waiter.res, { events: [] })
      }
    }
  }

  const sweepTimer = setInterval(sweep, SWEEP_MS)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler })
    return () => {
      disposeRoute()
      clearInterval(sweepTimer)
      for (const waiter of [...pending]) {
        try { waiter.res.destroy() } catch { /* 连接已关,忽略 */ }
      }
      pending.clear()
    }
  })
}
