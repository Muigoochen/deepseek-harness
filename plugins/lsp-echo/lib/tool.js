// tool.js — model-facing `lsp_echo` tool: explicit management + checking.
import { defineTool } from '@deepseek-ai/dsh-tools'

export const ACTIONS = ['host', 'stop', 'status', 'check', 'projects', 'scan', 'baseline']

/** Render a bridge diagnostics payload as concise text for the model. */
export function renderDiagnostics(payload, cap = 14) {
  const s = payload && payload.summary
  if (!s) return 'lsp-echo: no check result available'
  const rows = []
  for (const rel of Object.keys(payload.files || {})) {
    for (const d of payload.files[rel].diagnostics || []) {
      if (d.severity === 1 || d.severity === 2) {
        rows.push(`${rel}:${d.line}:${d.column}: [${d.severityName}] ${d.message}`)
      }
    }
  }
  const lines = [`checked ${s.files_checked} file(s): ${s.errors} error(s), ${s.warnings} warning(s)`]
  lines.push(...rows.slice(0, cap))
  if (rows.length > cap) lines.push(`… and ${rows.length - cap} more`)
  return lines.join('\n')
}

/**
 * Register the `lsp_echo` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} deps resolver/manager closures supplied by index.js
 */
export function registerTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'lsp_echo',
    description:
      'Manage bundled language-diagnostics engines and compile-check files. action: host (ensure running), stop, status, check (files), baseline (full-project diagnostic sweep now), projects (list registered Godot projects), or scan (one-shot scan of a workspace root for Godot projects). The bundled godot-lsp engine serves .gd/.gdshader; project is auto-detected from the session workspace or the files when not given.',
    parameters: {
      action: { type: 'string', required: true, enum: ACTIONS, description: 'host | stop | status | check | baseline | projects | scan' },
      engine: { type: 'string', description: "engine id; default 'godot-lsp'" },
      project: { type: 'string', description: 'absolute project or workspace root; auto-detected when omitted' },
      files: { type: 'array', items: { type: 'string' }, description: 'files to check (absolute or project-relative); required for check' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: 300_000,
    async execute(args, exec) {
      try {
        const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header ? exec.agent.session.header.cwd : undefined
        const files = (args.files || []).filter(Boolean)
        if (args.action === 'projects') {
          const rows = deps.projectsList()
          return rows.length ? `已注册项目 (source<TAB>engine<TAB>path):\n${rows.join('\n')}` : '尚未注册任何项目(可运行 action=scan 或检查文件时自动解析)'
        }
        if (args.action === 'scan') {
          const root = args.project || cwd
          if (!root) return 'scan 需要一个工作区根路径(project 参数)'
          const n = await deps.scanWorkspace(root)
          return `已扫描 ${root}:发现 ${n} 个 Godot 项目并注册`
        }
        const action = args.action
        const engineId = args.engine || 'godot-lsp'
        const eng = deps.engine(engineId)
        if (!eng) return `unknown engine '${engineId}'; available: ${deps.enginesList().join(', ')}`
        const found = deps.resolveProject(args.project, cwd, files)
        if (!found) {
          return `no Godot project resolved: pass project (absolute), or run in a project workspace. files given: ${files.join(', ') || '(none)'}`
        }
        const { project, bridge } = found
        if (action === 'host') {
          const r = await deps.ensure(bridge, project)
          if (r.fatal) return `host failed:\n${r.stderr || r.stdout}`
          const st = await deps.status(bridge, project)
          return `host ensured for ${project}${st.stdout ? ` — ${st.stdout.trim()}` : ''}`
        }
        if (action === 'stop') {
          const r = await deps.stop(bridge, project)
          if (deps.stopClient) deps.stopClient(bridge, project)
          return `host stopped for ${project}${r.stderr ? ` (${r.stderr.trim()})` : ''}`
        }
        if (action === 'status') {
          const r = await deps.status(bridge, project)
          return r.fatal ? `status failed:\n${r.stderr}` : r.stdout.trim() || `stopped: no live host for ${project}`
        }
        if (action === 'check') {
          if (!files.length) return 'check needs files (absolute or project-relative paths)'
          const absFiles = files.map((f) => deps.abs(f, project))
          const payload = await deps.check(bridge, project, absFiles)
          return renderDiagnostics(payload)
        }
        if (action === 'baseline') {
          if (typeof deps.baseline !== 'function') return 'baseline 暂不可用'
          return await deps.baseline(bridge, project)
        }
        return `unknown action '${action}' (${ACTIONS.join('|')})`
      } catch (error) {
        return `lsp_echo failed: ${(error && error.message) || error}`
      }
    },
  }))
}
