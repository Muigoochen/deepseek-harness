# Harness 插件开发：产品自带事实（开发期发现，非官方权威）

> 来源：2026-09-04 开发 `plugins/lsp-echo` 期间的源码阅读与实机验证。
> 面向：后续所有自研插件/工具开发。**随版本演进可能变化**——引用前请以当时源码为准。
> 关联实现：`plugins/lsp-echo/`（管理 Godot LSP 引擎 + 自动注入诊断 + 项目发现）。

## 1. 用户级装载通道（零产品源码改动）

- profile 组合：`$DSH_HOME/profiles/web/cordis.yml` 本体是 `[]`；真实组合 =
  按 `profiles/web/package.json` 的 `dsh.profile.bundles`(`dsh-base`、`dsh-web-app`)
  → 用户的 `cordis.patch.yml` → 命令行 `--patch` 叠加。
- host 插件行格式：
  ```yaml
  - insert:
      - id: <unique-id>
        name: '@scope/<pkg>'          # 从 profile node_modules 解析
        config: { … }                 # 会过插件的 Config(schemastery)校验
  ```
- 包体装入：`$DSH_HOME/profiles/node_modules/@scope/<pkg>/`（含 `@deepseek-ai/*`
  全套依赖可解析；免 `npm install` 时需手工建目录）。
- **热应用**：`patchReload: "live"` 时新增行对运行中实例**立即生效**
  （实测：加行后模型工具列表马上出现新工具，无需重启）。但**已装载插件代码文件变更
  需重启**才生效。
- 卸载 = 删目录 + 从 patch 撤行（幂等脚本参考 `plugins/lsp-echo/install/`）。

## 2. host 函数插件契约

- 命名导出：`name`、`inject`(服务名数组)、`Config`(schemastery `z<Config>`)、
  `apply(ctx, config)`。**不要 default export**（loader 会丢 namespace）。
- 服务：硬依赖声明进 `inject`；可选服务用 `ctx.get(name)`（不要直接 `ctx.x`）。
- 依赖服务运行时都装在你的插件所在 realm 里：如 `tools`、`settings`、
  `workspaceRegistry`（`ctx.get` 读）、`agents`、`sessionProjections` 等。

## 3. 工具注册（模型工具）

- `ctx.tools.register(defineTool({…}))`，`defineTool` 来自
  `@deepseek-ai/dsh-tools`。必填项（`packages/core/tools/src/schema.ts`）：
  `name`、`description`、`parameters`(per-property JSON schema)、
  **`output: { schema, render(args,value): ContentBlock[] }`**、`execute(args, exec)`。
- `execute` 返回的**值必须匹配 `output.schema`**；字符串工具用
  `output: { schema:{type:'string'}, render:(_a,v)=>[{type:'text',text:String(v)}] }`。
- `exec.agent.session.header.cwd` = 会话工作区（判“AI 当前在哪个项目”的关键；
  同 `packages/lsp/tool-lsp/src/session-cwd.ts`）。
- 加 `timeoutMs`(正有限数)。`tools/change` 事件在注册/注销时触发。

## 4. 自动注入范式（改完文件→下一轮模型自动看到）

- 权威样例：`packages/context/time-context/`（host 插件，patch 行已装在本机）。
- 缝：`agent/pre-step`(waterfall,可 prepend)。范式：
  ```js
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject' || signal?.aborted) return decision
    // …判断条件 + 计算注入文本 text…
    const msg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name, form: 'snapshot',
                sections: [{ name, text }] },
    })
    return { ...decision, messages: [...decision.messages, msg] }
  }, { prepend: true })
  ```
- 注入消息以 `user/message`(plugin source) 进会话日志 → 自动满足
  “模型可见 ⟺ 可重放”。节流/去重：可用 `sessionProjections`(time-context 示范)
  或进程内 Map + 时间戳。
- 相关事件目录(host)：`tools/result`(emit，冻结结果观察)、
  `tools/post-execute`(waterfall，可 enrich 工具结果)、`fs/write-intent`、
  `settings/updated`、`agent/session-start` 等。
- ⚠️ 官方 `lsp` 能力缝(`ctx.lsp`/tool-lsp)只有
  `goToDefinition|findReferences|goToImplementation|hover` **导航**四操作，
  是**封闭联合**，无 diagnostics；想加要改产品，纯插件请自建工具。
- **会话启动语义（2026-09-05 实测）**：Web 里点开任意会话（**含 fork 副本**）都会发
  `agent/session-start`，payload 带 `source`（`resume`/`startup`）；**fork 子会话 header 带
  `parentSession`**（同题会话常是 fork 副本，如“熟悉道具×2 / 浮动弹窗×2”）。宿主侧没有
  “用户点开某会话/工作区”之外更细的点击事件；需要“打开即动作”时要么用 session-start，
  要么做 client 点击钩子（GUI 阶段）。

## 5. 持久化事实（工作区 / 设置）

- **工作区**：`$DSH_HOME/storages/workspace.json`（storageDomain `workspace`，version 2）：
  `unit/global.workspaceIds` + `tables.workspaces.<id>` 形如
  `{path,title,sessionIds[],createdAt,updatedAt}`。本机（2026-09）两个工作区：
  `xu_world`(id `6033afd3-…`)与 `deepseek_harness`(id `fee4fa51-…`)。
  - **Workspace 实体是封闭类型**（`packages/workspace/workspace/src/types.ts`：
    id/path/title/createdAt/updatedAt/sessionIds + 方法，无扩展槽）——
    **不要往里塞自定义键，也不直接改该 domain 文件**（他包私有、版本化）。
  - host 读注册表用 `ctx.get('workspaceRegistry').list()`（返回含 `id/path/title`）；
    变动推送有 client 侧 `workspace/follow` 流（`@Remote stream`）。
- **设置(settings)**：`$DSH_HOME/settings.yaml` 顶层按 namespace 分段
  （现含 `ui-onboarding`、`agent-presets`）。
  `ctx.settings.register(ns, zodSchema)` 返回
  `scope{ get(), update(patch), replace(section), watch(cb) }`
  （`packages/settings/settings/src/index.ts`，`SettingsScope`）；并发写冲突抛
  `SettingsConflictError`。产品包多用 `installSection(ctx, ns, schema, entry, hooks)`。
- **插件自存数据的推荐姿势**：注册**自己的 settings namespace**（而非自造 json 文件）。
  lsp-echo 做法：`discovered` 键=**工作区 id**（生命周期跟工作区，删除即同步清）、
  `manual` 键=项目路径（用户配置，独立于工作区）；`scope.watch` 让 GUI/外部修改
  即时刷新插件状态。
- ⚠️ **`settings.register(ns, schema)` 的 schema 是 schemastery `z<T>`，不是 zod！**
  误传 zod 会在 resolve/describe 处失败：注册被跳过、工具正常、settings 永不写入，
  且通常只留 console warn（实踩，2026-09-04）。动态键尽量用**数组对象**形态
  （如 `z.array(z.object({ key, path, projects }))`），别依赖 record/dict 兼容面。

## 6. 扫描/判定策略经验

- 工作区目录树可能巨大（如本仓库）：遍历黑名单
  `.git/.godot/node_modules/.pnpm-store/.dsh-build/…` + 深度封顶（≤4 层）。
- `project.godot` 判定：目录含它即视为项目，**不再下钻**；非项目根才继续。
- 触发时机按产品要求：“首次启用扫已有工作区一次 + 新工作区进入时一次”，
  平时零轮询；变更侦测（文件 mtime）只在已注册项目上做，两者别混。

## 7. 相关落点索引

- 插件本体：`plugins/lsp-echo/`（lib 装载/工具/注入/watcher/registry；
  checkers/godot-lsp = Godot 引擎 bridge；install/ = 装/卸脚本；docs/design.md）。
- Godot 专用 LSP 事实（headless `--lsp-port`、进程双开、BOM 坑等）：
  见 `plugins/lsp-echo/checkers/godot-lsp/README.md`。
- 官方样例目录：`packages/context/time-context/`（注入）、
  `packages/core/tools/src/schema.ts`（工具契约）、
  `packages/settings/settings/src/index.ts`（设置）、
  `packages/workspace/workspace/src/types.ts`（工作区封闭类型）。

## 8. 已知演进风险

- `zod.record` API 与 settings schema 形态可能随依赖升级变化；宽松 record 缓解。
- `workspaceRegistry` host `list()` 形态/字段可能演进；按 id/path/title 兼容读取。
- Windows PowerShell 5.1 `Set-Content -Encoding UTF8` 写 BOM —— 消费 JSON/YAML
  的脚本要容忍 `\uFEFF` 或写入用无 BOM 编码（lsp-echo install 已处理）。

## 9. 增补/纠正（2026-09-05，conversation-summary 与插件管理讨论期间核实）

以下对 §1/§4 的表述做**增补与纠正**，引用前以本节为准：

- **安装 ≠ 启用的完整概念模型（下载→安装→使用）**：
  - 下载 = 产物进入项目/离线资产（产品无感知）；
  - 安装 = 注册进组合层（补丁/预设里出现该插件的行）且包可解析（`$DSH_HOME/profiles/node_modules/@dsh-user/<名>`）；
  - 启用 = 装载运行（行上无 disabled 或 false → apply 注册服务/工具/事件/UI）；停用 = disabled:true（行还在=已安装未跑）；卸载 = 删行（回到已下载）。
  - §1 写的"卸载 = 删目录 + 从 patch 撤行"**补充前提**：`@dsh-user` 目录是所有 profile/home 层共享解析锚，且有的插件目录内含运行态（如 lsp-echo 的 `.runtime/`）；删前须扫全部 profile/home 补丁引用，零引用才删。
- **纠错：宿主静态行"改完需重启才生效"不准确**。web profile `patchReload='live'`：`cordis.patch.yml` 保存即被 watcher 热应用（新增行/disabled 即时生效，§1"热应用"实测一致）；重启仅用于**客户端产物变更后**的确定性验证（新 UI 插件首次启用建议刷新/重启）。install.ps1 文案"重启才激活"在 web 上过严。
- **纠错：用户补丁清单 ≠ 全是用户/三方插件行**。现网 `$DSH_HOME/profiles/web/cordis.patch.yml` 含第一方行（`@deepseek-ai/dsh-time-context`，launcher 持久化写入）与可能的 id-target override 元素；可管理单元应收窄为"顶层 `- insert:` 元素且子条目 `name == '@dsh-user/<slug>'`"，其余行只读保护（第一方可停用、不可卸载）。
- **校验闭环**：补丁冷启动解析失败是硬失败（不可靠"重启看日志"回滚）；写盘流程 = `.bak` 快照 → tmp+原子 rename → 免启动 `dsh web --dump-config`（与装载共用 entryListSchema 方言）预校验 → 失败自动回滚。
- **新增系统提示/常驻上下文注入点**：宿主插件可 `ctx.systemPrompt.context({name,order,text})`（context 文本函数只收 `AssembleContext{scope?,signal?}`，无 session——需按 agent/会话判断时改用 pre-step 注入或投影态）。
- 相关新材料：`research/2026-09-05-conversation-summary.md`（compaction 封层/预算口径/定稿信号/设置页契约等详细核实）；`plugins/conversation-summary/docs/design.md`。
