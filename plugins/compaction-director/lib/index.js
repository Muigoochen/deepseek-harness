/**
 * Engine director (总机): occupies the single `ctx.compaction` seat and
 * dispatches each call to a per-session engine.
 *
 * Mounting shape: this implementation ships in the USER plugin namespace
 * (`@dsh-user/compaction-director`, installed under `profiles/node_modules/@dsh-user`)
 * and a preset compaction group names it as its engine row. It MUST NOT be
 * manually dropped into the shared `profiles/node_modules/@deepseek-ai`
 * fallback mirror: boot self-heals that mirror into the installed dependency
 * closure (junctions / `dsh.moduleFallback` proxies) and fails loud on any
 * foreign real directory — see the 2026-09-06 incident note in README.md.
 *
 * Because this package never occupies an `@deepseek-ai` name, the official
 * engine is imported directly by its own package name
 * `@deepseek-ai/dsh-compaction-basic` (resolves to the mirror junction) — no
 * renamed copy, no self-recursion.
 *
 * Children are constructed lazily, each inside its own `ctx.isolate('compaction')`
 * child scope (distinct labels) so their `Service` registration under the same
 * name never collides with this seat or with each other. Both children run with
 * `auto: false` — trigger ownership belongs to the policy layer
 * (conversation-summary / autoOwnership policy), and neither child may register
 * its own pre-step pressure or request-error listeners.
 *
 * Selection precedence (highest first):
 *   1. live override file `$DSH_HOME/compaction-director.json` -> `engines[sessionId]` then `default`
 *   2. row config `engines[sessionId]` then `defaultEngine`
 * The JSON file is re-read on every dispatch, so editing it hot-switches the
 * engine for the next compaction without a restart.
 *
 * @module @dsh-user/compaction-director
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'

/** Static roster shown by the settings UI and used by the policy layer. */
export const PROVIDERS = [
  { id: 'basic', label: '官方摘要引擎（LLM）', package: '@deepseek-ai/dsh-compaction-basic', note: 'checkpoint 为 LLM 摘要；慢且花摘要 token' },
  { id: 'instant', label: '即时无损引擎（VCC）', package: 'dsh-compaction-instant', note: '免 LLM 编译存档 + seq 指针；毫秒级近无损' },
]

const KIND_SPECS = {
  basic: {
    package: '@deepseek-ai/dsh-compaction-basic',
    label: Symbol('director:basic'),
  },
  instant: {
    package: 'dsh-compaction-instant',
    label: Symbol('director:instant'),
  },
}

const KNOWN_KEYS = new Set(['defaultEngine', 'engines', 'debug'])

function isKind(value) {
  return value === 'basic' || value === 'instant'
}

/** Fail-loud only for director-owned keys; foreign keys (basic-engine settings
 *  a preset row may still carry under the engine seat) pass through silently. */
function resolveDirectorConfig(config = {}) {
  const defaultEngine = config.defaultEngine ?? 'basic'
  if (!isKind(defaultEngine)) {
    throw new TypeError(`compaction-director: defaultEngine must be "basic" or "instant", got ${JSON.stringify(defaultEngine)}`)
  }
  if (config.debug !== undefined && typeof config.debug !== 'boolean') {
    throw new TypeError('compaction-director: debug must be a boolean')
  }
  const engines = {}
  if (config.engines !== undefined) {
    if (typeof config.engines !== 'object' || config.engines === null || Array.isArray(config.engines)) {
      throw new TypeError('compaction-director: engines must be an object mapping sessionId -> "basic" | "instant"')
    }
    for (const [sessionId, kind] of Object.entries(config.engines)) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new TypeError('compaction-director: engines keys must be non-empty session ids')
      }
      if (!isKind(kind)) {
        throw new TypeError(`compaction-director: engines["${sessionId}"] must be "basic" or "instant", got ${JSON.stringify(kind)}`)
      }
      engines[sessionId] = kind
    }
  }
  const ignored = Object.keys(config).filter((key) => !KNOWN_KEYS.has(key))
  return Object.freeze({ defaultEngine, engines, debug: config.debug === true, ignored })
}

/** Resolve a stable session key from whatever the caller passed. */
function sessionIdOf(agentOrSession) {
  if (!agentOrSession) return ''
  if (typeof agentOrSession === 'string') return agentOrSession
  if (typeof agentOrSession.id === 'string') return agentOrSession.id
  const session = agentOrSession.session
  if (session && typeof session.id === 'string') return session.id
  return ''
}

/** The live override file (re-read on every dispatch). */
function overrideFilePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : homedir()
  return join(home, '.dsh', 'compaction-director.json')
}

const EMPTY_OVERRIDE = Object.freeze({ default: undefined, engines: {} })

/** Parse the override file; never throws, logs once on a malformed file.
 *  A missing file is the normal state, so every branch returns the same
 *  canonical shape ({ default, engines }) the caller indexes into. */
function readOverrides(path, warnOnce) {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_OVERRIDE
    const result = { default: undefined, engines: {} }
    if (isKind(parsed.default)) result.default = parsed.default
    if (parsed.engines !== null && typeof parsed.engines === 'object' && !Array.isArray(parsed.engines)) {
      for (const [sessionId, kind] of Object.entries(parsed.engines)) {
        if (isKind(kind)) result.engines[sessionId] = kind
      }
    }
    return result
  } catch (error) {
    if (error && error.code === 'ENOENT') return EMPTY_OVERRIDE
    if (!warnOnce.done) {
      warnOnce.done = true
      const cause = error instanceof Error ? error.message : String(error)
      console.warn(`[compaction-director] ignoring unreadable override file ${path}: ${cause}`)
    }
    return EMPTY_OVERRIDE
  }
}

export class DirectorCompactionEngine extends CompactionEngine {
  /**
   * @param ctx - the realm context this seat is mounted into (already isolated
   * for `compaction`/`toolResultPruner` by the preset group).
   * @param config - { defaultEngine, engines, debug }; validated strictly.
   */
  constructor(ctx, config = {}) {
    super(ctx)
    this.config = resolveDirectorConfig(config)
    /** kind -> Promise<child engine instance> (built lazily on first use). */
    this._children = new Map()
    this._overrideWarnOnce = {}
  }

  /** Engine kind for one session: live file override > row config. */
  selectKind(sessionId) {
    const file = readOverrides(overrideFilePath(), this._overrideWarnOnce)
    const fileEngines = file.engines ?? {}
    if (sessionId !== '' && fileEngines[sessionId] !== undefined) return fileEngines[sessionId]
    if (this.config.engines[sessionId] !== undefined) return this.config.engines[sessionId]
    if (file.default !== undefined) return file.default
    return this.config.defaultEngine
  }

  _log(...args) {
    if (this.config.debug) console.warn('[compaction-director]', ...args)
  }

  /** Lazy-load + construct one child engine under its own isolated scope. */
  _loadEngine(kind) {
    const spec = KIND_SPECS[kind]
    this._log(`loading child engine "${kind}" from ${spec.package}`)
    return import(spec.package).then((mod) => {
      const Ctor = mod.default
      if (typeof Ctor !== 'function') {
        throw new Error(`compaction-director: ${spec.package} default export is not a constructor`)
      }
      const child = this.ctx.isolate('compaction', spec.label)
      // auto:false — trigger ownership stays with the policy layer. The
      // isolated child scope also keeps the instant engine's settings
      // namespace from ever re-arming its auto listeners here.
      const engine = new Ctor(child, { auto: false })
      this._log(`child engine "${kind}" constructed`)
      return engine
    }).catch((error) => {
      this._children.delete(kind)
      const cause = error instanceof Error ? error.message : String(error)
      throw new Error(`compaction-director: cannot construct engine "${kind}" (${spec.package}): ${cause}`)
    })
  }

  /** Re-throw with a director-labeled full stack so a child failure can be
   *  traced from the terminal even when the GUI shows only the message. */
  async _dispatch(method, agentOrSession, args) {
    const sessionId = sessionIdOf(agentOrSession)
    try {
      const { kind, engine } = await this._engineFor(agentOrSession)
      this._log(`${method} -> ${engine.constructor?.name ?? 'engine'} (session ${sessionId})`)
      return await engine[method](...args)
    } catch (error) {
      const stack = error instanceof Error && error.stack
        ? error.stack.split('\n').slice(0, 12).join('\n  ')
        : String(error)
      console.error(`[compaction-director] ${method} failed for session ${sessionId}:\n  ${stack}`)
      throw error
    }
  }

  /** Resolve the target child engine (and its kind) for one session. */
  async _engineFor(agentOrSession) {
    const sessionId = sessionIdOf(agentOrSession)
    const kind = this.selectKind(sessionId)
    let pending = this._children.get(kind)
    if (pending === undefined) {
      pending = this._loadEngine(kind)
      this._children.set(kind, pending)
    }
    const engine = await pending
    return { kind, engine }
  }

  /**
   * Engine identity for the policy layer/GUI: resolved kind plus the static
   * provider roster (for display), never serializing any live engine object.
   * @param agentOrSession - agent/session to resolve, or a session id string.
   */
  async getEngineInfo(agentOrSession) {
    const sessionId = sessionIdOf(agentOrSession)
    const kind = this.selectKind(sessionId)
    return {
      engineId: kind,
      sessionId: sessionId === '' ? null : sessionId,
      providers: PROVIDERS.map((provider) => ({ ...provider })),
    }
  }

  async compactIfNeeded(agent, trigger, signal) {
    return this._dispatch('compactIfNeeded', agent, [agent, trigger, signal])
  }

  async compactNow(agent, signal, sourceCommandId) {
    return this._dispatch('compactNow', agent, [agent, signal, sourceCommandId])
  }

  async compactRegion(start, end, agent, signal) {
    return this._dispatch('compactRegion', agent, [start, end, agent, signal])
  }
}

export default DirectorCompactionEngine
