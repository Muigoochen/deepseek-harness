// repeat-stream-guard — Host 半。拦截模型流式输出陷入周期性复读，并按开关决定"停"还是"续"。
//
// 背景：模型流式生成时会卡进机械复读（思维链里尤其常见：同一个短句重复几百遍），
// 而 harness 会一直读到 max_tokens 才收手，白白烧掉大量 token。
//
// 检测：监听 waterfall 事件 `llm/stream`，把 provider 的异步流包一层，对增量文本实时做
// 尾部周期性检测。确认复读后停止产出并跳出循环，于是：
//   1. 生成器提前 return，provider adapter 的 finally 会 abort 自己的 HTTP 消费者
//      （见 packages/llm/llm-deepseek/src/adapter.ts 的 streamWithConnection）——
//      是真的掐断请求、立即停止计费，而不是把剩余内容读完再丢掉；
//   2. 流里没有 finish chunk 时 BlockAssembler 兜底为 {kind:'stop'}——那一步不报错，
//      已生成的内容保留。
//
// 切断后做什么，由开关（设置 → 通用页，值存 settings 命名空间）决定：
//   stop     —— 那一步正常结束；提醒消息留到该 agent 下一次 pre-step 注入，模型下一轮
//               就知道自己是被复读打断的，不会接着复读。
//   continue —— 切断瞬间把提醒 append 进 agent 的 next-step 收件箱；agent 循环看到
//               `inbox.nextStep.length !== 0` 就不结束本轮，于是带着提醒自动再发一次请求。
//               同一 turn 内最多连续续跑 maxContinues 次，到顶即降级为 stop。
//
// 纯插件守则：不修改仓库任何产品/底层源码；每个流各自持有检测状态，只在进程内存里。

import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'repeat-stream-guard'

/** settings 命名空间，也是浏览器半读写开关用的 key（必须是小写连字符标识）。 */
const SETTINGS_NS = 'repeat-stream-guard'

// 默认值集中在这里，schema、settings base 与运行时兜底读同一份常量。
const DEFAULT_MAX_PERIOD = 64
const DEFAULT_MIN_COPIES = 5
const DEFAULT_MIN_PERIODIC_CHARS = 120
const DEFAULT_CHECK_EVERY_CHARS = 32
const DEFAULT_RETAIN_CHARS = 4000
const DEFAULT_MODE = 'stop'
const DEFAULT_MAX_CONTINUES = 2

/** 开关的两个取值。 */
const MODES = ['stop', 'continue']

/**
 * 模型面向的提醒文本：只讲"下一步该怎么做"，不提插件、流、截断这类实现词汇。
 * 想改文案只改这一处。
 */
const REMINDER_TEXT =
  'The previous response was stopped early because it began repeating the same '
  + 'content in a loop. Do not repeat any of it: continue with new content, '
  + 'state your conclusion, or finish the task.'

/**
 * 配置。全部是部署可调项：改 cordis.patch.yml 里这一行的 config 即可生效，并作为
 * settings 命名空间的 base 层（设置页里的用户选择覆盖它）。
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
  /** 切断后：`stop` 结束本轮等用户，`continue` 带着提醒自动再跑一轮。 */
  mode: z.string().default(DEFAULT_MODE),
  /** continue 模式下同一 turn 内最多连续续跑几次；`0` 表示从不续跑（等同 stop）。 */
  maxContinues: z.number().default(DEFAULT_MAX_CONTINUES),
})

/**
 * 设置命名空间的 schema。设置页那一行只写 `mode`；`maxContinues` 留给 YAML 或设置文件。
 * 这里用 string + 运行时归一化（而不是 union/const），这样即使有人手改设置文件写入非法值，
 * 也只会退回默认值并告警，不会让插件装载失败。
 */
const SettingsSchema = z.object({
  mode: z.string().default(DEFAULT_MODE),
  maxContinues: z.number().default(DEFAULT_MAX_CONTINUES),
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
  const maxContinues = config.maxContinues ?? DEFAULT_MAX_CONTINUES
  if (!Number.isInteger(maxContinues) || maxContinues < 0) {
    throw new Error(`repeat-stream-guard: \`maxContinues\` 必须是 >= 0 的整数，收到 ${String(maxContinues)}`)
  }
  const mode = config.mode ?? DEFAULT_MODE
  if (!MODES.includes(mode)) {
    throw new Error(`repeat-stream-guard: \`mode\` 只能是 ${MODES.join(' 或 ')}，收到 ${String(mode)}`)
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
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文；监听器与设置注册随 fiber 一起销毁
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

  // 运行时开关：初值来自 config（settings 的 base 层），设置页改动经 watch 热更新，
  // 不需要重启。两个服务都是可选的——没有 settings 就是纯 YAML 配置，没有 agents
  // 就只能切断、没法投递提醒。
  let mode = config.mode ?? DEFAULT_MODE
  let maxContinues = config.maxContinues ?? DEFAULT_MAX_CONTINUES
  const agents = ctx.get('agents')

  const settings = ctx.get('settings')
  if (settings !== undefined) {
    const scope = settings.register(SETTINGS_NS, SettingsSchema, {
      base: { mode: mode, maxContinues: maxContinues },
    })
    const adopt = (value) => {
      if (MODES.includes(value.mode)) mode = value.mode
      else logger.warn('[repeat-stream-guard] 未知的 mode %o，继续用 %s', value.mode, mode)
      if (Number.isInteger(value.maxContinues) && value.maxContinues >= 0) maxContinues = value.maxContinues
    }
    adopt(scope.get())
    ctx.effect(() => scope.watch(adopt), `repeat-stream-guard settings(${SETTINGS_NS})`)
  }

  /** 本进程累计切断次数，仅用于日志与提示文案。 */
  let cuts = 0
  /** agent -> 最近一次 pre-step 的 turn（判断续跑预算属于哪一轮）。 */
  const continues = new Map()
  /** agent -> 待投递的提醒消息（stop 模式，或续跑到顶时的降级）。 */
  const pending = new Map()

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

  /** 构造一条 plugin 来源的提醒消息（notice 形式，不会渲染成用户提问）。 */
  function reminderMessage(repeat) {
    const copies = Math.floor(repeat.span / repeat.period)
    return createUserMessage({
      content: [{ type: 'text', text: REMINDER_TEXT }],
      source: {
        kind: 'plugin',
        plugin: 'repeat-stream-guard',
        form: 'notice',
        summary: `repeat loop cut (${repeat.period} chars × ${copies})`,
      },
    })
  }

  /**
   * 决定这次切断之后怎么走：续跑就往 next-step 塞一条消息让本轮继续，否则留待该 agent
   * 下一次 pre-step 注入。
   * @param {object|undefined} agent 被切断的 agent（非 loop 调用可能没有）
   * @param {{period:number,span:number}} repeat 命中的周期信息
   * @returns {'continue'|'stop'} 实际采用的处置方式
   */
  function afterCut(agent, repeat) {
    const message = reminderMessage(repeat)
    if (agent === undefined) {
      // 没有 agent 就没有收件箱可投递（例如手工构造的调用）；切断本身已经生效。
      return 'stop'
    }
    const used = continues.get(agent)
    if (mode === 'continue' && used !== undefined && used.count < maxContinues) {
      // append 会持久写 agent/inbox/spliced 事件，属于"模型可见 ⟺ 已记录"的正规路径。
      // 这里必须兜住异常：抛出去会把一次干净的切断变成一次 error turn。
      try {
        agent.inbox.append('next-step', message)
        continues.set(agent, { turn: used.turn, count: used.count + 1 })
        return 'continue'
      } catch (error) {
        logger.warn('[repeat-stream-guard] 续跑入队失败，降级为停止：%o', error)
      }
    }
    pending.set(agent, message)
    return 'stop'
  }

  /**
   * 包装一条 provider 流：逐块转发，同时盯着文本增量有没有变成机械复读。
   * @param {AsyncIterable<object>} upstream provider 侧的分块流
   * @param {object} options 本次请求（loop 构造的请求带 sessionId）
   * @returns {AsyncIterable<object>} 原样转发（可能提前结束）的流
   */
  function guard(upstream, options) {
    const sessionId = options === null || typeof options !== 'object' ? undefined : options.sessionId
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
            const agent = sessionId === undefined || agents === undefined ? undefined : agents.get(sessionId)
            const action = afterCut(agent, repeat)
            logger.info(
              '[repeat-stream-guard] 中断复读输出：周期 %d 字符，尾部约 %d 次重复，处置 %s（累计 %d 次）',
              repeat.period,
              copies,
              action,
              cuts,
            )
            notifyUser(action === 'continue'
              ? `检测到周期 ${repeat.period} 字符的重复段（约 ${copies} 次），已中断并自动继续。`
              : `检测到周期 ${repeat.period} 字符的重复段（约 ${copies} 次），已提前结束本轮。`)
          }
        }

        yield chunk
        if (cut) break
      }
    })()
  }

  // 记录每个 agent 当前的 turn（供续跑预算判断），并在轮次边界清零预算；同时把 stop
  // 模式攒下的提醒投递给下一步。
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const used = continues.get(agent)
    if (used === undefined || used.turn !== turn) continues.set(agent, { turn, count: 0 })
    const decision = await next()
    const reminder = pending.get(agent)
    if (reminder === undefined || decision.kind !== 'enter') return decision
    // 只有真的进入下一步时才消费提醒；被下游 reject 掉就留到下一次。
    pending.delete(agent)
    return { ...decision, messages: [reminder, ...decision.messages] }
  })

  // waterfall：先向下游要真正的 provider 流，再把包装后的流交回去。
  ctx.on('llm/stream', (options, next) => guard(next(), options))
}
