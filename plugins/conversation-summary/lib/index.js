/**
 * conversation-summary — flexible conversation summarization/compaction.
 *
 * v0 scope (built-in checkpoint template, no engine swap):
 *   - budget measured on CONVERSATION content only: compaction checkpoints
 *     ("各总结") + the still-uncompressed history ("未总结的内容"); system
 *     prompt and dynamically injected plugin messages (time readings,
 *     reminders, …) are excluded by default (`budgetScope: conversation`);
 *   - compression is scoped by SCENARIO — over-budget, plan-mode exit, and
 *     free-form finalization — and by one authorization MODE applied to every
 *     scenario: `hint` (ask the user first) or `auto` (compress, no asking);
 *   - `mode: auto` compacts at the next step boundary whenever a
 *     plugin-detectable scenario is due (over budget, or plan-mode exit:
 *     `plan/mode` true→false — approval and abandonment log the same flip);
 *   - `mode: hint` instead injects one durable ask-the-user reminder per epoch
 *     for whichever plugin-detectable scenario is due first;
 *   - free-form finalization has no product event; when that scenario is
 *     enabled the resident policy and `compact_conversation` tool carry the
 *     mode's authorization (auto: compress when the discussion converged;
 *     hint: ask the user first). The agent never judges authorization itself.
 *
 * All actual history reduction is delegated to the session's built-in
 * compaction engine (`ctx.compaction`, reached host-side through
 * `agentPresets.serviceFor(agent, 'compaction')`), so the durable
 * checkpoint / shadow / tail-retention / locking machinery is the native one.
 *
 * @dsh-user/conversation-summary
 */

import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isCompactCheckpointSource, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name used by loader diagnostics and event attribution. */
export const name = 'conversation-summary'

/** Keep in sync with package.json version; reported by the config HTTP helper. */
const PLUGIN_VERSION = '0.1.0'

/** Host-plane services this row consumes. */
export const inject = ['tools', 'agentPresets', 'tokenMeter', 'sessionProjections', 'agents', 'systemPrompt', 'webServer']

/** JSON response headers shared by the config/policy HTTP helpers. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/** Default absolute context budget; crossing it activates the over-budget scenario. */
const DEFAULT_BUDGET_TOKENS = 200_000

/** Default recent tail retained verbatim by a compaction, in tokens. */
const DEFAULT_RETAIN_TOKENS = 30_000

/** Editable agent-facing copies (empty or omitted → default). Only scenarios in
 *  which the agent participates carry a copy. In mode=hint the ①② copies are
 *  injected verbatim when the plugin detects the scenario so the agent asks the
 *  user; the ③ (free-form) copies are the agent's standing instructions for
 *  sensing the moment (ask vs. auto). In mode=auto the engine compacts ①②
 *  directly and emits its own checkpoint text — those two carry no agent copy. */
const DEFAULT_ASK_OVER_BUDGET =
  '【压缩提醒·等待你确认】当前对话内容已超过预算。处理步骤：'
  + '1) 把下面这句话转述给用户并等待明确答复："早期对话占用已超预算，是否把它们压缩成 checkpoint'
  + '（保留最近一段与既有 checkpoint，不丢失成果）？"'
  + '2) 用户同意 → 立即执行 compact_conversation(mode=auto)；用户拒绝 → 告知用户本次跳过压缩并继续当前任务。'
  + '这是需要你处理的实时提醒，不是普通系统说明：不要忽略，也不要自行决定压缩。'

const DEFAULT_ASK_PLAN_EXIT =
  '【plan 模式结束·压缩确认】此前的计划/设计讨论已告一段落。处理步骤：'
  + '1) 向用户询问是否把此前的计划/设计讨论压缩成 checkpoint；'
  + '2) 用户同意 → 执行 compact_conversation(mode=auto)；用户拒绝 → 告知用户已跳过并继续。'
  + '这是实时提醒，请立即处理，不要当作普通系统说明忽略。'

const DEFAULT_ASK_FREEFORM =
  '【自由讨论收尾·请先确认】讨论已收敛、即将给出可实施方案，且对话量未超预算。此时请：'
  + '1) 向用户询问是否把此前的讨论压缩成 checkpoint（可先 mode=estimate 展示能省多少）；'
  + '2) 用户同意 → 执行 compact_conversation(mode=auto)；用户拒绝 → 继续给出方案。'

const DEFAULT_AUTO_FREEFORM =
  '【自由讨论收尾·已授权压缩】讨论已收敛、即将给出可实施方案，且对话量未超预算。已授权直接压缩：'
  + '请把此前的讨论执行 compact_conversation(mode=auto) 压成 checkpoint，无需询问用户，然后继续给出方案。'

/** Default ordering of the resident policy context contribution. */
const DEFAULT_POLICY_ORDER = 9000

/**
 * Compose the resident policy. Only agent-participating cases get copy:
 *  - mode=hint: the ①② ask copies (agent asks the user when the plugin
 *    detects the scenario) plus ③ when free-form is enabled;
 *  - mode=auto: one fixed factual line that ①② are engine-compacted (no agent
 *    copy exists — the engine emits its own checkpoint text), plus the ③
 *    auto copy when free-form is enabled.
 */
function buildPolicyText(resolved) {
  const parts = []
  parts.push('会话压缩策略（conversation-summary）：压缩会把早期对话折成 checkpoint 摘要以降低每步请求开销，'
    + `保留最近约 ${resolved.retain.toLocaleString('en-US')} tokens 的对话与既有 checkpoint，不丢失成果。`)
  if (resolved.mode === 'auto') {
    parts.push('对话内容超过预算、plan 模式结束时，插件会在下一步开始前自动压缩（无需你询问用户或手动操作）。')
    if (resolved.freeform && resolved.toolEnabled) parts.push(resolved.autoFreeform)
  } else {
    parts.push(resolved.askOverBudget)
    if (resolved.planExit) parts.push(resolved.askPlanExit)
    if (resolved.freeform && resolved.toolEnabled) parts.push(resolved.askFreeform)
  }
  if (resolved.toolEnabled) {
    parts.push('工具 compact_conversation：estimate 只算账 / auto 立即压缩 / ask 先征求用户；需要时可调用。')
  }
  return parts.join('\n')
}

/** Render a custom policy template's placeholders. */
function renderPolicyPlaceholders(text, resolved) {
  return text
    .replaceAll('{budget}', resolved.budget.toLocaleString('en-US'))
    .replaceAll('{retain}', resolved.retain.toLocaleString('en-US'))
    .replaceAll('{mode}', resolved.mode)
    .replaceAll('{planExit}', resolved.planExit ? '开启' : '关闭')
    .replaceAll('{freeform}', resolved.freeform ? '开启' : '关闭')
}

/** Marker for our own durable reminder events inside the projection fold. */
const NOTICE_FORM = 'notice'

/** Fail-loud config normalization: defaults merge, every numeric field validated. */
function resolveConfig(config = {}) {
  const budget = config.absoluteBudgetTokens ?? DEFAULT_BUDGET_TOKENS
  const retain = config.retainTokens ?? DEFAULT_RETAIN_TOKENS
  const mode = config.mode ?? 'hint'
  if (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget <= 0) {
    throw new TypeError(`conversation-summary: absoluteBudgetTokens must be a positive safe integer, got ${String(budget)}`)
  }
  if (typeof retain !== 'number' || !Number.isSafeInteger(retain) || retain < 0) {
    throw new TypeError(`conversation-summary: retainTokens must be a non-negative safe integer, got ${String(retain)}`)
  }
  if (retain >= budget) {
    throw new TypeError(`conversation-summary: retainTokens (${retain}) must be smaller than absoluteBudgetTokens (${budget})`)
  }
  if (mode !== 'hint' && mode !== 'auto') {
    throw new TypeError(`conversation-summary: mode must be "hint" or "auto", got ${JSON.stringify(mode)}`)
  }
  if (config.hintEnabled !== undefined && typeof config.hintEnabled !== 'boolean') {
    throw new TypeError('conversation-summary: hintEnabled must be a boolean')
  }
  if (config.planExit !== undefined && typeof config.planExit !== 'boolean') {
    throw new TypeError('conversation-summary: planExit must be a boolean')
  }
  if (config.freeform !== undefined && typeof config.freeform !== 'boolean') {
    throw new TypeError('conversation-summary: freeform must be a boolean')
  }
  if (config.toolEnabled !== undefined && typeof config.toolEnabled !== 'boolean') {
    throw new TypeError('conversation-summary: toolEnabled must be a boolean')
  }
  if (config.logDecisions !== undefined && typeof config.logDecisions !== 'boolean') {
    throw new TypeError('conversation-summary: logDecisions must be a boolean')
  }
  const budgetScope = config.budgetScope ?? 'conversation'
  if (budgetScope !== 'conversation' && budgetScope !== 'envelope') {
    throw new TypeError(`conversation-summary: budgetScope must be "conversation" or "envelope", got ${JSON.stringify(budgetScope)}`)
  }
  if (config.promptEnabled !== undefined && typeof config.promptEnabled !== 'boolean') {
    throw new TypeError('conversation-summary: promptEnabled must be a boolean')
  }
  const promptOrder = config.promptOrder ?? DEFAULT_POLICY_ORDER
  if (typeof promptOrder !== 'number' || !Number.isSafeInteger(promptOrder)) {
    throw new TypeError(`conversation-summary: promptOrder must be a safe integer, got ${String(promptOrder)}`)
  }
  if (config.policyText !== undefined && typeof config.policyText !== 'string') {
    throw new TypeError('conversation-summary: policyText must be a string')
  }
  const COPY_DEFAULTS = {
    askOverBudget: DEFAULT_ASK_OVER_BUDGET,
    askPlanExit: DEFAULT_ASK_PLAN_EXIT,
    askFreeform: DEFAULT_ASK_FREEFORM,
    autoFreeform: DEFAULT_AUTO_FREEFORM,
  }
  const copies = {}
  for (const key of Object.keys(COPY_DEFAULTS)) {
    const value = config[key]
    if (value !== undefined && typeof value !== 'string') {
      throw new TypeError(`conversation-summary: ${key} must be a string`)
    }
    copies[key] = typeof value === 'string' && value.length > 0 ? value : COPY_DEFAULTS[key]
  }
  return {
    budget,
    retain,
    mode,
    hintEnabled: config.hintEnabled ?? true,
    planExit: config.planExit ?? false,
    freeform: config.freeform ?? false,
    toolEnabled: config.toolEnabled ?? true,
    logDecisions: config.logDecisions ?? false,
    budgetScope,
    promptEnabled: config.promptEnabled ?? true,
    promptOrder,
    policyText: config.policyText ?? '',
    ...copies,
  }
}

/**
 * Compose the durable ask message for a due scenario in mode=hint: a live
 * usage line (with current estimate) followed by the scenario's ask copy.
 */
function composeAskMessage(cellText, evaluation, resolved) {
  const label = evaluation.metric === 'envelope'
    ? '当前完整请求（含系统提示与注入）'
    : '当前对话内容（不含系统提示与动态注入）'
  const usage = `${label}估算 ${evaluation.totalTokens.toLocaleString('en-US')} tokens / 预算 ${resolved.budget.toLocaleString('en-US')}。`
  return `${usage}\n${renderPolicyPlaceholders(cellText, resolved)}`
}

/** Truncate text kept for UI folds (the durable message content stays whole). */
function boundText(text, max = 120) {
  if (typeof text !== 'string' || text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Resolve the full live agent behind a tool invocation or event payload.
 * Event payloads carry the full dsh agent; tool calls may carry only `{ id }`,
 * in which case the live registry supplies the rest.
 */
function liveAgent(ctx, candidate) {
  if (!candidate) return undefined
  if (candidate.session !== undefined && candidate.ctx !== undefined) return candidate
  if (candidate.id !== undefined) {
    const registered = ctx.agents.get(candidate.id)
    if (registered !== undefined) return registered
  }
  return undefined
}

/**
 * Resolve the session's own compaction engine through the official
 * agent-keyed read path. `undefined` when the agent's preset mounts none
 * (e.g. the `minimal` preset) — every feature degrades to a no-op then.
 */
function compactionEngineOf(ctx, agent) {
  if (!agent || !agent.ctx) return undefined
  return ctx.agentPresets.serviceFor(agent, 'compaction')
}

/**
 * The session's event log across product versions: current builds expose
 * `snapshotEvents()`, while older ones kept a plain `events` array. Reading the
 * wrong one throws `not iterable` on every pre-step, which silently disables
 * every scenario, so resolve it once per read.
 */
function sessionEvents(session) {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return session.events ?? []
}

/**
 * Conversation-content weights for the current surface: node tokens count only
 * for genuine conversation messages (user / assistant / tool results) and for
 * compaction checkpoints ("各总结 + 未总结的内容"). System prompt, tools, and
 * dynamically injected plugin messages (time readings, reminders, tmux notes…)
 * are deliberately excluded from the budget. The conversation total is the
 * weighted sum; `budgetScope: envelope` switches the budget metric to
 * `measurement.totalTokens` (weights still drive span/tail selection).
 */
function conversationWeights(session, measurement, budgetScope) {
  if (budgetScope === 'envelope') {
    return measurement.nodes.map((node) => ({ seq: node.seq, tokens: node.tokens }))
  }
  const messageBySeq = new Map()
  for (const event of sessionEvents(session)) {
    // Current builds project an event into its message through
    // `deriveEventMessage`; the legacy branches keep older builds working.
    const message = typeof session.deriveEventMessage === 'function'
      ? session.deriveEventMessage(event)
      : event.type === 'user/message'
        ? event.data
        : event.type === 'assistant/message' || event.type === 'tool/result'
          ? event.data.message
          : null
    if (message !== null && message !== undefined) messageBySeq.set(event.seq, message)
  }
  return measurement.nodes.map((node) => {
    const message = messageBySeq.get(node.seq)
    const conversation = message !== undefined && (
      message.source.kind === 'user'
      || message.source.kind === 'model'
      || message.source.kind === 'tool'
      || (message.source.kind === 'plugin' && isCompactCheckpointSource(message.source))
    )
    return { seq: node.seq, tokens: conversation ? node.tokens : 0 }
  })
}

/**
 * The event at one surface seq across product versions: current builds expose
 * `eventAt(seq)`, older ones kept a dense `events` array.
 */
function eventAtSeq(session, seq) {
  if (typeof session.eventAt === 'function') return session.eventAt(seq)
  return sessionEvents(session).find((event) => event.seq === seq)
}

/**
 * Select the head-anchored compactable surface span whose retained tail keeps
 * at least `retainTokens` (measured on the weighted conversation content),
 * mirroring the built-in engine's range selection (including tool-call/result
 * pairing). A `system/message` at surface node 0 is never inside the range —
 * current builds surface the system prompt as node 0, and replacing it is
 * rejected by the engine — so the range starts at the first non-system node.
 * Returns null when nothing is compactable — never an unbalanced range.
 */
function compactableSpan(session, weights, retainTokens) {
  if (!Array.isArray(weights) || weights.length === 0) return null
  const surface = session.surface.nodes
  if (surface.length !== weights.length) return null
  for (let i = 0; i < surface.length; i += 1) {
    if (surface[i] !== weights[i].seq) return null
  }
  const head = eventAtSeq(session, surface[0])
  const firstIdx = head !== undefined && head.type === 'system/message' ? 1 : 0
  if (weights.length <= firstIdx) return null
  let accumulated = 0
  let keepFromIdx = weights.length
  for (let i = weights.length - 1; i >= 0; i -= 1) {
    accumulated += weights[i].tokens
    keepFromIdx = i
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstIdx) return null
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, surface[keepFromIdx])) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null
  const shadowedTokens = weights
    .slice(firstIdx, keepFromIdx)
    .reduce((sum, node) => sum + node.tokens, 0)
  return {
    start: surface[firstIdx],
    end: surface[keepFromIdx - 1],
    shadowedTokens,
    shadowedNodes: keepFromIdx - firstIdx,
  }
}

/**
 * Whether plan mode was exited since the last compaction: some
 * `plan/mode active:true` is followed by `plan/mode active:false` after the
 * newest `compaction/end`. NOTE: the flip is logged identically on approval,
 * rejection, and `/plan off` (the event carries only `{active}`), so this is
 * "plan-mode exit", not a reliable "方案获批" signal.
 */
function planExitedSinceLastCompaction(session) {
  const events = sessionEvents(session)
  let lastEndSeq = -1
  for (const event of events) {
    if (event.type === 'compaction/end') lastEndSeq = event.seq
  }
  let sawActive = false
  for (const event of events) {
    if (event.seq <= lastEndSeq) continue
    if (event.type === 'plan/mode') {
      if (event.data.active) sawActive = true
      else if (sawActive) return true
    }
  }
  return false
}

/**
 * Build the shared estimate/metrics payload used by the tool, the auto step,
 * and the hint paths. The compaction span is normally only meaningful once the
 * budget is crossed; `allowBelowBudget` additionally permits it for the
 * plan-exit and free-form scenarios, which may fold a finished discussion
 * below the budget (still bounded by `retainTokens` and tool-pair balance).
 */
function evaluate(ctx, agent, engine, resolved, allowBelowBudget = false) {
  const session = agent.session
  const measurement = ctx.tokenMeter.measure(session)
  const weights = conversationWeights(session, measurement, resolved.budgetScope)
  // Budget metric: conversation content only (checkpoints + uncompressed tail),
  // or the full request envelope when configured. Conversation mode sums the
  // weighted node prices; envelope mode must use `measurement.totalTokens`
  // (weighted node sum alone lacks the header estimate: system + tools + request
  // framing, which is also what the built-in engine compares against).
  const scopeTokens = weights.reduce((sum, node) => sum + node.tokens, 0)
  const totalTokens = resolved.budgetScope === 'envelope'
    ? measurement.totalTokens
    : scopeTokens
  const span = (totalTokens >= resolved.budget || allowBelowBudget)
    ? compactableSpan(session, weights, resolved.retain)
    : null
  return {
    engineAvailable: engine !== undefined,
    metric: resolved.budgetScope,
    totalTokens,
    envelopeTokens: measurement.totalTokens,
    budget: resolved.budget,
    aboveBudget: totalTokens >= resolved.budget,
    retainTokens: resolved.retain,
    compactable: span !== null,
    span,
    savedTokens: span === null ? 0 : span.shadowedTokens,
    retainedNodes: span === null ? 0 : weights.length - span.shadowedNodes,
    surfaceNodes: weights.length,
  }
}

/** Human text for an evaluation result. */
function describe(evaluation, detail = '') {
  const lines = []
  if (!evaluation.engineAvailable) {
    return '当前会话未挂载压缩引擎(compaction 服务不可用)，无法执行压缩。'
  }
  const metricLabel = evaluation.metric === 'envelope'
    ? '当前完整请求(含系统提示与注入提示)'
    : '当前对话内容(checkpoint 总结 + 未总结内容, 不含系统提示与动态注入)'
  lines.push(`${metricLabel}估算: ${evaluation.totalTokens.toLocaleString('en-US')} tokens / 预算 ${evaluation.budget.toLocaleString('en-US')}`)
  if (evaluation.metric === 'conversation') {
    lines.push(`(完整请求信封约 ${evaluation.envelopeTokens.toLocaleString('en-US')} tokens, 含系统提示/工具/动态注入)`)
  }
  if (evaluation.compactable) {
    lines.push(`可压缩早期内容约 ${evaluation.savedTokens.toLocaleString('en-US')} tokens（${evaluation.span.shadowedNodes} 条表面节点，压缩后保留最近约 ${evaluation.retainTokens.toLocaleString('en-US')} tokens / ${evaluation.retainedNodes} 条）。`)
  } else if (evaluation.aboveBudget) {
    lines.push('已超预算，但当前没有可安全压缩的范围（可能全部是要保留的工具配对或尾部）。')
  } else {
    lines.push('未达预算或当前没有可压缩范围（尾部外无早期内容），无需压缩。')
  }
  if (detail) lines.push(detail)
  return lines.join('\n')
}

/** One shared compaction executor for the tool, the auto step, and the hint flow. */
async function performCompaction(ctx, agent, engine, resolved, signal, note, allowBelowBudget = false) {
  const evaluation = evaluate(ctx, agent, engine, resolved, allowBelowBudget)
  if (!evaluation.engineAvailable) {
    return { ok: false, error: 'no-compaction-engine', message: describe(evaluation) }
  }
  if (!evaluation.compactable) {
    return {
      ok: false,
      error: 'no-compactable-range',
      totalTokens: evaluation.totalTokens,
      message: describe(evaluation),
    }
  }
  let result
  try {
    result = await engine.compactRegion(evaluation.span.start, evaluation.span.end, agent, signal)
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: 'compaction-failed',
      message: `压缩执行失败：${cause}${note ? `\n(${note})` : ''}`,
    }
  }
  const summaryText = (result.summary ?? [])
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('')
  const excerpt = summaryText.length > 220 ? `${summaryText.slice(0, 220)}…` : summaryText
  return {
    ok: true,
    totalTokens: evaluation.totalTokens,
    savedTokens: result.shadowedTokenCount,
    shadowedNodes: result.shadowedSeqs.length,
    shadowedRange: result.shadowedRange,
    compactionId: String(result.compactionId),
    checkpointExcerpt: excerpt,
    message: describe(evaluation, `已压缩早期内容约 ${result.shadowedTokenCount.toLocaleString('en-US')} tokens（${result.shadowedSeqs.length} 条表面节点被遮蔽），checkpoint 已写入会话。`),
  }
}

/** Build the model tool `compact_conversation`. */
function createTool(ctx, resolved) {
  return {
    name: 'compact_conversation',
    description: '压缩(总结)当前会话的早期历史，以降低后续请求的上下文开销。'
      + 'mode=estimate 只估算，返回当前 token 用量、可压缩量，不修改会话；'
      + 'mode=auto 立即把可压缩的早期历史总结成一份 checkpoint 并遮蔽它们（保留最近尾部），适合已定稿/可舍弃的讨论；'
      + 'mode=ask 返回估算和建议文案，由你向用户确认后再用 auto 执行。'
      + '若没有可压缩范围（尾部外无早期内容），auto 会返回提示而不改动会话。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['estimate', 'auto', 'ask'],
          description: 'estimate: 仅估算; auto: 立即执行压缩; ask: 估算并给出向用户询问的建议。',
        },
        reason: {
          type: 'string',
          description: '本次压缩的原因或目标（可选，便于记录）。',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const text = (value && value.message) || '压缩调用未返回结果。'
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      try {
        const mode = args && args.mode === 'auto' ? 'auto' : (args && args.mode === 'ask' ? 'ask' : 'estimate')
        const reason = args && typeof args.reason === 'string' ? args.reason : ''
        const agent = liveAgent(ctx, exec && exec.agent)
        if (agent === undefined) {
          return { ok: false, mode, message: '无法解析当前调用方 agent，已中止。' }
        }
        const engine = compactionEngineOf(ctx, agent)
        const note = reason ? `原因：${reason}` : ''
        if (mode === 'estimate') {
          // The free-form scenario may fold a finished discussion below the
          // budget, so estimates follow that allowance when the scenario is on.
          const evaluation = evaluate(ctx, agent, engine, resolved, resolved.freeform)
          return {
            ok: true,
            mode,
            engineAvailable: evaluation.engineAvailable,
            totalTokens: evaluation.totalTokens,
            budget: resolved.budget,
            aboveBudget: evaluation.aboveBudget,
            savedTokens: evaluation.savedTokens,
            message: describe(evaluation, note),
          }
        }
        if (mode === 'ask') {
          const evaluation = evaluate(ctx, agent, engine, resolved, resolved.freeform)
          const guidance = evaluation.compactable
            ? '请向用户确认是否压缩这段早期内容；得到同意后调用 compact_conversation(mode=auto) 执行。'
            : '当前无可压缩范围，无需询问。'
          return {
            ok: true,
            mode,
            engineAvailable: evaluation.engineAvailable,
            totalTokens: evaluation.totalTokens,
            savedTokens: evaluation.savedTokens,
            message: `${describe(evaluation)}\n${note ? `${note}\n` : ''}${guidance}`,
          }
        }
        // mode === 'auto'
        const outcome = await performCompaction(ctx, agent, engine, resolved, exec.signal, note, resolved.freeform)
        return { ok: outcome.ok, mode, ...outcome }
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          mode: args && args.mode === 'auto' ? 'auto' : (args && args.mode === 'ask' ? 'ask' : 'estimate'),
          error: 'unexpected',
          message: `compact_conversation 执行出错：${cause}`,
        }
      }
    },
  }
}

/** Session-scoped projection state: whether the current epoch was reminded (any scenario). */
function createProjectionRegistration() {
  return {
    key: 'conversationSummary',
    stateVersion: 1,
    stateSchema: z.object({ reminded: z.boolean() }),
    init: () => ({ reminded: false }),
    apply: (state, event) => {
      if (event.type === 'compaction/end') {
        return state.reminded ? { ...state, reminded: false } : state
      }
      if (event.type === 'user/message') {
        const source = event.data && event.data.source
        const injectedByUs = source && source.kind === 'plugin'
          && source.plugin === name && source.form === NOTICE_FORM
        if (injectedByUs && !state.reminded) return { ...state, reminded: true }
      }
      return state
    },
  }
}

/** Merge an untrusted GUI draft over the live resolved config (coerce, never throw). */
function draftResolved(draft, base) {
  const next = { ...base }
  if (draft && typeof draft === 'object') {
    if (Number.isSafeInteger(draft.budget) && draft.budget > 0) next.budget = draft.budget
    if (Number.isSafeInteger(draft.retain) && draft.retain >= 0) next.retain = draft.retain
    if (draft.mode === 'auto' || draft.mode === 'hint') next.mode = draft.mode
    if (typeof draft.hintEnabled === 'boolean') next.hintEnabled = draft.hintEnabled
    if (typeof draft.planExit === 'boolean') next.planExit = draft.planExit
    if (typeof draft.freeform === 'boolean') next.freeform = draft.freeform
    if (typeof draft.toolEnabled === 'boolean') next.toolEnabled = draft.toolEnabled
    if (typeof draft.logDecisions === 'boolean') next.logDecisions = draft.logDecisions
    if (typeof draft.promptEnabled === 'boolean') next.promptEnabled = draft.promptEnabled
    if (Number.isSafeInteger(draft.promptOrder)) next.promptOrder = draft.promptOrder
    if (typeof draft.policyText === 'string') next.policyText = draft.policyText
    for (const key of ['askOverBudget', 'askPlanExit', 'askFreeform', 'autoFreeform']) {
      if (typeof draft[key] === 'string' && draft[key].length > 0) next[key] = draft[key]
    }
  }
  return next
}

/** Render the resident policy text a GUI draft would produce (single copy source). */
function renderPolicyForDraft(draft, base) {
  const merged = draftResolved(draft, base)
  const source = merged.policyText.trim().length > 0
    ? merged.policyText
    : buildPolicyText(merged)
  return renderPolicyPlaceholders(source, merged)
}

/** Read a bounded JSON request body (fail closed on overflow/garbage). */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** JSON HTTP answer with a stable status. */
function respondJson(res, status, payload) {
  if (res.headersSent) return
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(payload))
}

/** Resolved-property -> patch YAML key mapping (the cockpit's persisted keys). */
const PERSIST_MAP = [
  ['budget', 'absoluteBudgetTokens'],
  ['retain', 'retainTokens'],
  ['budgetScope', 'budgetScope'],
  ['mode', 'mode'],
  ['hintEnabled', 'hintEnabled'],
  ['planExit', 'planExit'],
  ['freeform', 'freeform'],
  ['toolEnabled', 'toolEnabled'],
  ['logDecisions', 'logDecisions'],
  ['promptEnabled', 'promptEnabled'],
  ['promptOrder', 'promptOrder'],
  ['policyText', 'policyText'],
  ['askOverBudget', 'askOverBudget'],
  ['askPlanExit', 'askPlanExit'],
  ['askFreeform', 'askFreeform'],
  ['autoFreeform', 'autoFreeform'],
]

/** Serialize one config value as a YAML scalar (strings are quoted). */
function yamlScalar(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

/** The patch overlay file that hot-applies on change (host-side launcher patch). */
function patchFilePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : homedir()
  return join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml')
}

/**
 * Rewrite this plugin's profile-layer patch entry in `cordis.patch.yml`.
 *
 * The profile patch layer (`- id: X` with an optional `config:`) overrides the
 * row that this package's own bundle patch inserts; because the bundle already
 * inserts the row, this function must never append a competing `- insert:`. An
 * insert-shaped entry left by the pre-bundle installer is rewritten in place.
 *
 * Only config keys that differ from the plugin's code defaults are written, so
 * reverting a toggle to its default removes the line instead of leaving a stale
 * value behind.
 * @param patchPath - absolute path of the profile's cordis.patch.yml.
 * @param next - fully resolved config (draft merged over defaults).
 * @returns whether the file content changed.
 */
export function persistPatchRow(patchPath, next) {
  const defaults = resolveConfig({})
  const keys = PERSIST_MAP
    .filter(([property]) => next[property] !== defaults[property])
    .map(([property, yamlKey]) => [yamlKey, yamlScalar(next[property])])
  const flatHead = ['- id: conversation-summary']
  const insertHead = [
    '    - id: conversation-summary',
    "      name: '@dsh-user/conversation-summary'",
  ]
  const buildEntry = (head, configIndent, keyIndent) => (keys.length === 0
    ? head
    : [...head, `${configIndent}config:`, ...keys.map(([key, value]) => `${keyIndent}${key}: ${value}`)])
  const original = readFileSync(patchPath, 'utf8')
  const lines = original.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === flatHead[0] || lines[index] === insertHead[0]) { start = index; break }
  }
  let text
  if (start === -1) {
    text = `${lines.join('\n')}\n\n${buildEntry(flatHead, '  ', '    ').join('\n')}\n`
  } else {
    const flat = lines[start] === flatHead[0]
    const entry = buildEntry(
      flat ? flatHead : insertHead,
      flat ? '  ' : '      ',
      flat ? '    ' : '        ',
    )
    let end = start + 1
    while (end < lines.length) {
      const line = lines[end]
      // Stop at a blank separator, the next top-level operation, or the next
      // item of an enclosing `- insert:` list.
      if (line.trim() === '' || line.startsWith('- ') || line.startsWith('    - ')) break
      end += 1
    }
    text = `${[...lines.slice(0, start), ...entry, ...lines.slice(end)].join('\n')}\n`
  }
  if (text === original) return false
  writeFileSync(patchPath, text, 'utf8')
  return true
}

/**
 * Plugin entry. Registers:
 *  - `agent/pre-step`: in `mode: auto`, compacts at the next step boundary when
 *    a plugin-detectable scenario is due — conversation over budget, or plan
 *    mode exited (`plan/mode` true→false since the last compaction) with the
 *    plan-exit scenario enabled. In `mode: hint`, injects one durable
 *    ask-the-user reminder per epoch for whichever scenario is due first.
 *  - the `compact_conversation` model tool (estimate / auto / ask);
 *  - the resident policy prompt (enabled scenarios × single mode authorization).
 */
export function apply(ctx, rawConfig) {
  const resolved = resolveConfig(rawConfig)

  ctx.effect(() => ctx.sessionProjections.register(createProjectionRegistration()))

  // One console notice per (session, reason) so an over-budget session that
  // cannot compact is visible in the host log instead of failing silently.
  // `logDecisions` gates both notice families: the durable answer is the
  // `/conversation-summary/diagnostics` snapshot, so the console stays quiet by
  // default and only real failures warn unconditionally.
  const autoSkipNotices = new Map()
  const noteAutoSkip = (sessionId, reason) => {
    if (!resolved.logDecisions) return
    if (autoSkipNotices.get(sessionId) === reason) return
    if (autoSkipNotices.size > 200) autoSkipNotices.clear()
    autoSkipNotices.set(sessionId, reason)
    console.warn(`conversation-summary: auto compaction skipped for ${sessionId}: ${reason}`)
  }
  // Failures warn once per (session, cause) even with logging off: silence is
  // how an API drift disabled every compaction for days.
  const failureNotices = new Map()
  const noteFailure = (key, message) => {
    if (failureNotices.get(key) === message) return
    if (failureNotices.size > 200) failureNotices.clear()
    failureNotices.set(key, message)
    console.warn(message)
  }
  // Last measured decision per session, queryable at
  // GET /conversation-summary/diagnostics: `conversation=` there is this
  // plugin's budget metric (conversation body), while the GUI number is the
  // full request envelope, so the two answers together say whether a session
  // was skipped for metric, engine, range, or call reasons.
  const decisionLog = new Map()
  const recordDecision = (sessionKey, entry) => {
    decisionLog.set(sessionKey, { time: new Date().toISOString(), ...entry })
    if (decisionLog.size > 50) decisionLog.delete(decisionLog.keys().next().value)
  }
  const decisionNotices = new Map()
  const noteDecision = (sessionKey, evaluation, agent, planExited, engine, action) => {
    const entry = {
      mode: resolved.mode,
      action,
      engine: engine !== undefined,
      conversation: evaluation.totalTokens,
      envelope: evaluation.envelopeTokens,
      budget: resolved.budget,
      aboveBudget: evaluation.aboveBudget,
      compactable: evaluation.compactable,
      span: evaluation.span === null ? null : [evaluation.span.start, evaluation.span.end],
      surfaceNodes: agent.session?.surface?.nodes?.length ?? -1,
      weightedNodes: evaluation.surfaceNodes,
      retain: resolved.retain,
      planExited,
    }
    recordDecision(sessionKey, entry)
    if (!resolved.logDecisions) return
    if (evaluation.totalTokens < Math.floor(evaluation.budget / 2) && !evaluation.aboveBudget) return
    const bucket = Math.round(evaluation.totalTokens / 5000)
    if (decisionNotices.get(sessionKey) === bucket) return
    if (decisionNotices.size > 300) decisionNotices.clear()
    decisionNotices.set(sessionKey, bucket)
    console.log(`conversation-summary: decision ${sessionKey} mode=${resolved.mode} engine=${engine !== undefined} `
      + `conversation=${evaluation.totalTokens} envelope=${evaluation.envelopeTokens} budget=${resolved.budget} `
      + `aboveBudget=${evaluation.aboveBudget} compactable=${evaluation.compactable} `
      + `span=${evaluation.span === null ? 'none' : `${evaluation.span.start}-${evaluation.span.end}`} `
      + `surfaceNodes=${entry.surfaceNodes} weightedNodes=${entry.weightedNodes} `
      + `retain=${resolved.retain} planExited=${planExited} action=${action}`)
  }

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ) => {
    if (!agent || signal.aborted) return next()
    const engine = compactionEngineOf(ctx, agent)
    // Auto mode: the plugin compacts at the next step boundary whenever a
    // plugin-detectable scenario is due — over budget (①) or plan mode exited
    // (②, only when the plan-exit scenario is enabled). Free-form finalization
    // (③) is agent-sensed and handled by the tool/policy, not here. A due
    // scenario that cannot compact logs why: the previous silent skip made an
    // over-budget session look like the plugin was not running at all.
    const planExited = resolved.planExit && planExitedSinceLastCompaction(agent.session)
    if (resolved.mode === 'auto') {
      const sessionKey = agent.session?.id ?? String(agent.id)
      try {
        const evaluation = evaluate(ctx, agent, engine, resolved, planExited)
        const due = evaluation.aboveBudget || planExited
        let action = due ? 'due' : 'below-budget'
        if (due && engine === undefined) {
          action = 'skip:engine-unavailable'
          noteAutoSkip(sessionKey,
            `engine unavailable (preset mounts no ctx.compaction); ${evaluation.totalTokens} tokens >= budget ${resolved.budget}`)
        } else if (due && !evaluation.compactable) {
          action = 'skip:no-compactable-range'
          noteAutoSkip(sessionKey,
            `over budget (${evaluation.totalTokens} >= ${resolved.budget}) but no compactable range `
            + `(surface ${agent.session?.surface?.nodes?.length ?? '?'} / weighted ${evaluation.surfaceNodes} nodes, retain ${resolved.retain})`)
        } else if (due && engine !== undefined) {
          const result = await engine.compactRegion(evaluation.span.start, evaluation.span.end, agent, signal)
          autoSkipNotices.delete(sessionKey)
          action = `compacted:${result.shadowedTokenCount}`
          console.log(`conversation-summary: auto-compacted ${result.shadowedTokenCount} tokens `
            + `(${result.shadowedSeqs.length} nodes) for ${sessionKey}; surface was ${evaluation.totalTokens} >= budget ${resolved.budget}`)
        }
        noteDecision(sessionKey, evaluation, agent, planExited, engine, action)
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error)
        recordDecision(sessionKey, { mode: resolved.mode, action: `failed:${cause}`, turn, step })
        noteFailure(sessionKey, `conversation-summary: step auto-compaction failed (turn ${turn}, step ${step}): ${cause}`)
      }
    }
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    // Hint mode: one durable ask-the-user reminder per epoch for whichever
    // plugin-detectable scenario is due first (the plan-exit copy wins over the
    // over-budget copy when both are due — the two prompts never stack).
    if (engine === undefined || resolved.mode !== 'hint' || !resolved.hintEnabled) return decision
    try {
      const planExitNow = resolved.planExit && planExitedSinceLastCompaction(agent.session)
      const evaluation = evaluate(ctx, agent, engine, resolved, planExitNow)
      noteDecision(agent.session?.id ?? String(agent.id), evaluation, agent, planExitNow, engine,
        `hint:${evaluation.compactable && (evaluation.aboveBudget || planExitNow) ? 'due' : 'idle'}`)
      if (!evaluation.compactable || !(evaluation.aboveBudget || planExitNow)) return decision
      const state = ctx.sessionProjections.stateOf(agent.session, 'conversationSummary')
      if (state && state.reminded) return decision
      const text = composeAskMessage(
        planExitNow ? resolved.askPlanExit : resolved.askOverBudget,
        evaluation,
        resolved,
      )
      const reminder = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: name, form: NOTICE_FORM, summary: boundText(text) },
      })
      return {
        ...decision,
        messages: [...decision.messages, reminder],
      }
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error)
      const sessionKey = agent.session?.id ?? String(agent.id)
      recordDecision(sessionKey, { mode: resolved.mode, action: `failed:${cause}`, turn, step })
      noteFailure(`hint:${sessionKey}`, `conversation-summary: scenario reminder skipped (turn ${turn}): ${cause}`)
      return decision
    }
  })

  // Resident policy prompt: states the enabled compression scenarios and the
  // single mode authorization (hint = ask the user first, auto = compress), so
  // the agent never has to judge its own authorization. Registers nothing when
  // every feature is off.
  if (resolved.promptEnabled) {
    const source = resolved.policyText.trim().length > 0
      ? resolved.policyText
      : buildPolicyText(resolved)
    const policyText = renderPolicyPlaceholders(source, resolved)
    if (policyText.trim().length > 0) {
      ctx.effect(() => ctx.systemPrompt.context({
        name: 'conversation-summary:policy',
        order: resolved.promptOrder,
        text: policyText,
      }))
    }
  }

  if (resolved.toolEnabled) {
    ctx.effect(() => ctx.tools.register(createTool(ctx, resolved)))
  }

  // GUI backends: current effective config for the settings page, and a policy
  // text renderer so the page preview always matches the injected copy.
  ctx.effect(() => {
    const configHandler = async (req, res) => {
      const method = (req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        respondJson(res, 200, {
          ok: true,
          effective: {
            budget: resolved.budget,
            retain: resolved.retain,
            budgetScope: resolved.budgetScope,
            mode: resolved.mode,
            hintEnabled: resolved.hintEnabled,
            planExit: resolved.planExit,
            freeform: resolved.freeform,
            toolEnabled: resolved.toolEnabled,
            promptEnabled: resolved.promptEnabled,
            promptOrder: resolved.promptOrder,
            policyText: resolved.policyText,
            askOverBudget: resolved.askOverBudget,
            askPlanExit: resolved.askPlanExit,
            askFreeform: resolved.askFreeform,
            autoFreeform: resolved.autoFreeform,
          },
          meta: {
            plugin: name,
            version: PLUGIN_VERSION,
            global: true,
            hotApply: true,
            // Host config changes hot-apply on save; only new client UI surfaces
            // (and host code upgrades) need a restart / page refresh.
            restartRequired: false,
          },
        })
        return
      }
      if (method !== 'POST') {
        respondJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const defaults = resolveConfig({})
        const next = draftResolved(body, defaults)
        if (body && typeof body === 'object'
          && (body.budgetScope === 'conversation' || body.budgetScope === 'envelope')) {
          next.budgetScope = body.budgetScope
        }
        let saved = false
        try {
          saved = persistPatchRow(patchFilePath(), next)
        } catch (error) {
          const cause = error instanceof Error ? error.message : String(error)
          respondJson(res, 500, { ok: false, error: `写 cordis.patch.yml 失败：${cause}` })
          return
        }
        respondJson(res, 200, {
          ok: true,
          saved,
          effective: {
            budget: next.budget,
            retain: next.retain,
            budgetScope: next.budgetScope,
            mode: next.mode,
            hintEnabled: next.hintEnabled,
            planExit: next.planExit,
            freeform: next.freeform,
            toolEnabled: next.toolEnabled,
            promptEnabled: next.promptEnabled,
            promptOrder: next.promptOrder,
            policyText: next.policyText,
            askOverBudget: next.askOverBudget,
            askPlanExit: next.askPlanExit,
            askFreeform: next.askFreeform,
            autoFreeform: next.autoFreeform,
          },
          note: saved ? 'written' : 'unchanged',
        })
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error)
        respondJson(res, 400, { ok: false, error: cause })
      }
    }
    const policyHandler = async (req, res) => {
      if ((req.method || 'POST').toUpperCase() !== 'POST') {
        respondJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const draft = await readJsonBody(req)
        respondJson(res, 200, { ok: true, text: renderPolicyForDraft(draft, resolved) })
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error)
        respondJson(res, 400, { ok: false, error: cause })
      }
    }
    const diagnosticsHandler = (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'GET') {
        respondJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      respondJson(res, 200, {
        ok: true,
        mode: resolved.mode,
        budget: resolved.budget,
        retain: resolved.retain,
        budgetScope: resolved.budgetScope,
        decisions: [...decisionLog.entries()].map(([session, entry]) => ({ session, ...entry })),
      })
    }
    const disposeConfig = ctx.webServer.register({
      kind: 'exact',
      path: '/conversation-summary/config',
      handler: configHandler,
    })
    const disposePolicy = ctx.webServer.register({
      kind: 'exact',
      path: '/conversation-summary/policy',
      handler: policyHandler,
    })
    const disposeDiagnostics = ctx.webServer.register({
      kind: 'exact',
      path: '/conversation-summary/diagnostics',
      handler: diagnosticsHandler,
    })
    return () => {
      disposeConfig()
      disposePolicy()
      disposeDiagnostics()
    }
  })
}


