// repeat-stream-guard — Host 半（无浏览器半）。拦截模型流式输出陷入周期性复读。
//
// 背景：模型流式生成时会卡进机械复读（思维链里尤其常见：同一个短句重复几百遍），
// 而 harness 会一直读到 max_tokens 才收手，白白烧掉大量 token。
//
// 做法：监听 waterfall 事件 `llm/stream`，把 provider 的异步流包一层，对增量文本实时
// 做尾部周期性检测。确认复读后停止产出并跳出循环，于是：
//   1. 生成器提前 return，provider adapter 的 finally 会 abort 自己的 HTTP 消费者
//      （见 packages/llm/llm-deepseek/src/adapter.ts 的 streamWithConnection）——
//      是真的掐断请求、立即停止计费，而不是把剩余内容读完再丢掉；
//   2. 流里没有 finish chunk 时 BlockAssembler 兜底为 {kind:'stop'}——本次 turn 正常
//      结束，已生成的内容保留，不报错、不留下半个工具调用。
//
// 纯插件守则：不修改仓库任何产品/底层源码；检测状态只存在于当前进程的当前流上。

import z from '@deepseek-ai/schemastery'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'repeat-stream-guard'

// 默认值集中在这里，schema 与运行时兜底读同一份常量，避免两处各写一遍。
const DEFAULT_MAX_PERIOD = 64
const DEFAULT_MIN_COPIES = 5
const DEFAULT_MIN_PERIODIC_CHARS = 120
const DEFAULT_CHECK_EVERY_CHARS = 32
const DEFAULT_RETAIN_CHARS = 4000

/**
 * 配置。全部是部署可调项：改 cordis.patch.yml 里这一行的 config 即可生效。
 * 注意本仓库 schemastery fork 没有 `.optional()`：字段默认可选，`.default()` 给默认值。
 */
export const Config = z.object({
  /** 允许的最长重复单元（字符）。超出这个长度的"重复"不再判定为复读。 */
  maxPeriod: z.number().default(DEFAULT_MAX_PERIOD),
  /** 判定为复读所需的最少重复遍数。 */
  minCopies: z.number().default(DEFAULT_MIN_COPIES),
  /** 判定为复读所需的周期性字符数下限；调小会更早切断，但更容易误伤正常的长重复结构。 */
  minPeriodicChars: z.number().default(DEFAULT_MIN_PERIODIC_CHARS),
  /** 每新增多少字符才做一次检查（控制检测开销）。 */
  checkEveryChars: z.number().default(DEFAULT_CHECK_EVERY_CHARS),
  /** 检测窗口保留的原始字符数。 */
  retainChars: z.number().default(DEFAULT_RETAIN_CHARS),
  /** 是否把思维链（reasoning delta）也纳入检测。 */
  watchReasoning: z.boolean().default(true),
  /** 命中时是否用 toast 插件给用户一条悬浮提示（toast 未装载时自动跳过）。 */
  notify: z.boolean().default(true),
})

/**
 * 校验配置：非法值在装载时就抛错（fail-loud），不做静默兜底。
 * @param {object} config 已由 schema 校验并填过默认值的配置
 */
function validateConfig(config) {
  const positiveInts = [
    ['maxPeriod', config.maxPeriod ?? DEFAULT_MAX_PERIOD],
    ['minCopies', config.minCopies ?? DEFAULT_MIN_COPIES],
    ['minPeriodicChars', config.minPeriodicChars ?? DEFAULT_MIN_PERIODIC_CHARS],
    ['checkEveryChars', config.checkEveryChars ?? DEFAULT_CHECK_EVERY_CHARS],
    ['retainChars', config.retainChars ?? DEFAULT_RETAIN_CHARS],
  ]
  for (const [field, value] of positiveInts) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`repeat-stream-guard: \`${field}\` 必须是 >= 1 的整数，收到 ${String(value)}`)
    }
  }
}

/**
 * 找最小的周期 p，使 `text` 尾部至少 `max(minCopies * p, minPeriodicChars)` 个字符满足
 * p-周期性。判定方式是位移比较：把尾部窗口与"往前挪 p 个字符"的同长度窗口整体比对，
 * 相等即说明这段区间严格周期。
 * @param {string} text 去掉空白后的输出文本
 * @param {{maxPeriod:number,minCopies:number,minPeriodicChars:number}} limits 检测阈值
 * @returns {{period:number,span:number}|null} 命中时返回周期与周期性区间长度，否则 null
 */
function findRepeat(text, limits) {
  const length = text.length
  for (let period = 1; period <= limits.maxPeriod; period += 1) {
    let span = period * limits.minCopies
    if (span < limits.minPeriodicChars) span = limits.minPeriodicChars
    if (length < span + period) continue
    const tail = text.slice(length - span)
    const earlier = text.slice(length - span - period, length - period)
    if (tail === earlier) return { period, span }
  }
  return null
}

/**
 * 装载入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文；监听器随 fiber 一起销毁
 * @param {object} [config] 见 {@link Config}
 */
export function apply(ctx, config = {}) {
  validateConfig(config)
  const limits = {
    maxPeriod: config.maxPeriod ?? DEFAULT_MAX_PERIOD,
    minCopies: config.minCopies ?? DEFAULT_MIN_COPIES,
    minPeriodicChars: config.minPeriodicChars ?? DEFAULT_MIN_PERIODIC_CHARS,
  }
  const checkEveryChars = config.checkEveryChars ?? DEFAULT_CHECK_EVERY_CHARS
  const retainChars = config.retainChars ?? DEFAULT_RETAIN_CHARS
  const watchReasoning = config.watchReasoning ?? true
  const notifyEnabled = config.notify ?? true
  const logger = ctx.logger

  /** 本进程累计切断次数，仅用于日志与提示文案。 */
  let cuts = 0

  /** 通过可选的 toast 服务给用户一条可见提示；toast 没装载就安静跳过。 */
  function notifyUser(text) {
    if (!notifyEnabled) return
    const toast = ctx.get('toast')
    if (toast === undefined || typeof toast.show !== 'function') return
    try {
      toast.show({ kind: 'warning', title: '已中断模型重复输出', body: text, durationMs: 8000 })
    } catch (error) {
      console.warn(`[repeat-stream-guard] toast.show failed: ${(error && error.message) || error}`)
    }
  }

  /**
   * 包装一条 provider 流：逐块转发，同时盯着文本增量有没有变成机械复读。
   * @param {AsyncIterable<object>} upstream provider 侧的分块流
   * @returns {AsyncIterable<object>} 原样转发（可能提前结束）的流
   */
  function guard(upstream) {
    return (async function* guarded() {
      let raw = ''
      let sinceCheck = 0
      let toolCallSeen = false
      let stopped = false

      for await (const chunk of upstream) {
        if (!stopped && chunk !== null && typeof chunk === 'object') {
          // 一旦开始流式输出工具参数就收手：此刻截断会让 assembler 拿到半截 JSON，
          // 反过来生成一次残缺的工具调用。工具层面的复读交给 repeat-tool-reminder。
          if (chunk.type === 'tool-call-delta') {
            toolCallSeen = true
          } else if (chunk.type === 'text-delta' || (watchReasoning && chunk.type === 'reasoning-delta')) {
            if (typeof chunk.text === 'string' && chunk.text.length > 0) {
              raw += chunk.text
              if (raw.length > retainChars) raw = raw.slice(raw.length - retainChars)
              sinceCheck += chunk.text.length
            }
          }
        }

        let cut = false
        if (!stopped && !toolCallSeen && sinceCheck >= checkEveryChars) {
          sinceCheck = 0
          // 空白不参与比较：换行/缩进怎么切分都不影响"这段在复读"的判断。
          const repeat = findRepeat(raw.replace(/\s+/g, ''), limits)
          if (repeat !== null) {
            stopped = true
            cut = true
            cuts += 1
            const copies = Math.floor(repeat.span / repeat.period)
            logger.info(
              '[repeat-stream-guard] 中断复读输出：周期 %d 字符，尾部已重复约 %d 次（累计 %d 次）',
              repeat.period,
              copies,
              cuts,
            )
            notifyUser(`检测到周期 ${repeat.period} 字符的重复段（约 ${copies} 次），已提前结束本次生成。`)
          }
        }

        yield chunk
        if (cut) break
      }
    })()
  }

  // waterfall：先向下游要真正的 provider 流，再把包装后的流交回去。
  ctx.on('llm/stream', (_options, next) => guard(next()))
}
