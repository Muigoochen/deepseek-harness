# DeepSeek Harness 项目功能分析

> 本文件面向后续扩展开发，梳理仓库整体架构、每个包组的功能定位、子包构成与扩展方式。基于 AGENTS.md、docs/architecture.md、packages/README.md 及各包组 README 整理。

---

## 1. 项目概览

**DeepSeek Harness** 是一个基于 **Cordis** 插件的 Agent（智能体）运行时脚手架（harness），由 DeepSeek AI 开源维护。它不是一个成品应用，而是一套"全部由插件构成"的 Agent 运行时：模型适配、工具注册表、会话日志、Agent 循环本身都是插件，均可通过配置替换或扩展。

- **包管理**：pnpm workspaces（node ^22.19 || >=24），monorepo 结构
- **根包**：`@deepseek-ai/dsh-root` v0.1.2-alpha.3
- **语言**：TypeScript（strict 模式，全 ESM），另有 Python SDK
- **workspace**：`vendor/*`、`packages/*/*`、`native/*`、`apps/*`、`website`
- **核心理念**：
  - **无特权核心**——扩展 = 在既有插件旁挂载一个新插件；注册是可逆副作用（unload 时回滚）
  - **Capability Seam（能力接缝）**——每个可替换能力分三角色：Service Definition（接口）/ Service Provider（实现）/ Consumer（通常是模型工具）
  - **模型可见 ⟺ 已记录**——任何进入模型请求的内容必须能从会话日志重建
  - **应用启动唯一入口**——只有 `dsh` CLI 配 profile 能启动受支持的 Node 应用

---

## 2. 顶层架构

### 2.1 Cordis 插件框架

Cordis 是底层框架（vendored 于 `vendor/cordis/`）：插件向共享 Context 贡献服务、类型化事件与可逆效果。产品每个部分都是插件，包括模型适配器、工具注册表、会话日志、Agent 循环。插件间通过 `ctx.<service>` 访问服务，事件通过声明合并实现类型化（`SessionEventMap` 等）。

### 2.2 Profile 与 Bundle（组合方式）

一个运行的 `dsh` 是由启动时按有序层级组成的插件树：

| 概念 | 说明 |
|---|---|
| **Profile** | 命名组合，存放在 Harness home：列出叠加的 bundle、安装的外部插件、用户自己的 `cordis.patch.yml`。内置模板：`web`、`headless`、`sdk`、`sdk-minimal`、`acp` |
| **Bundle** | Cordis 配置行 + 所挂载代码的分发格式（patch 文档），上层可继续 patch 覆盖 |
| **Patch 层级** | bundle 顺序 → profile 的 `cordis.patch.yml` → home 级 → `--patch` 覆盖层；patch 按行 id 替换整行配置或插入新行 |

**内置 bundle**（`packages/bundle/`）：

- `dsh-base`——web/headless/sdk/acp 四个 profile 共享的第一层：模型适配器、工具、持久化、沙箱与批准策略、设置、凭据、遥测
- `dsh-web-app`——叠加浏览器应用
- `dsh-headless`——一次性命令行 task runner，无服务器
- `dsh-sdk-app`——SDK JSON-RPC 服务器
- `dsh-acp-app`——自动化专用 ACP 服务器
- `dsh-sdk-minimal`——刻意例外：单独一个 bundle 拥有完整显式 SDK 树，不叠加 `dsh-base`

> 扩展提示：可用 `dsh --profile web --dump-config` 查看机器实际启动的插件树，任何一行都可用自己的 patch 替换。

### 2.3 应用启动（Application Launch）

所有受支持的 Node 应用从 `dsh` CLI 以命名 profile 启动：

- `dsh web`（即 `--profile web`）——浏览器 GUI
- `dsh --profile headless`——一次性任务
- `dsh --profile sdk` / `sdk-minimal`——SDK
- `dsh --profile acp`——自动化

`verify-application-entrypoints` 门禁拒绝任何绕过 `dsh` 的 Node 应用路径。

### 2.4 Turn 流程（一次对话回合）

```
turn/start
  claim next-step input + queued message
  组装 prompt 分节 + 工具 schema
  → agent/pre-step       (waterfall：可改写/拒绝身份)
      step/start
      append entered messages as user/message
      从日志派生模型历史
      agent/request → llm/stream → assistant/chunk* → assistant/message
      tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
      step/end
  → agent/turn-stopping  (serial，无 next())
turn/end
```

`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 是持久会话事件；其余是跨三个域的 live 扩展点。`agent/pre-step`、`agent/request`、`llm/stream`、`tools/*` 是 waterfall（必须调用 `next()` 放行）。

---

## 3. packages/ 包组详解（按能力族分类）

共 50 个包组目录（`packages/README.md` 的包组表格列 49 个，另有 `mcp/`），每个包组包含若干 `@deepseek-ai/dsh-<name>` 子包。以下按功能聚类呈现。

### 3.1 产品 API 骨架

| 包组 | 定位 | 子包构成 |
|---|---|---|
| **core/** | 产品 API 主干：会话日志、系统提示词、工具注册表、Agent 句柄与默认驱动循环。所有组合必启动 | `scope`（作用域注册原语，无 ctx key）、`session`（只追加事件日志，`ctx.sessions`）、`system-prompt`（提示词装配，`ctx.systemPrompt`）、`tools`（工具注册表+守卫管线，`ctx.tools`）、`agent`（Agent 公共契约，`ctx.agents`）、`agent-loop`（默认驱动，`ctx.agentLoop`）、`agent-default-model`（`ctx.agentDefaultModel`）、`agent-tool-presentation`（按 agent 的工具展示选择器） |
| **api/** | Remote 远程调用层：Client → Host 的类型化远程能力 | `gateway`（unary 调用+多路流）、`remotes`（暴露哪些能力）、`session-controller`（会话命令/历史/实时控制）、`settings-controller`（配置面）、`workspace-controller`（工作区变更） |
| **typert/** | 类型图生成器、加载器与运行时注册表 | `generator`、`loader`、`protocol`、`registry` |
| **boot/** | 共享应用启动胶水 | `app-boot`（profile 解析/分层/自定义）、`cmdline`（命令行解析） |
| **bundle/** | 可安装的 profile patch 层 | `base`、`web-app`、`headless`、`sdk-app`、`sdk-minimal`、`acp-app`（见 2.2） |

### 3.2 LLM 能力族

| 包组 | 定位 | 子包构成 |
|---|---|---|
| **llm/** | 模型调用能力：中立服务 `ctx.llm` + 提供商适配器 | `llm`（消息/流词汇 + 适配器接缝，`ctx.llm`）、`llm-deepseek`（DeepSeek 官方适配器，含 thinking/图片）、`llm-pi-ai`（pi-ai 目录/协议路由）、`deepseek-llm-api-extensions`（官方请求扩展字段）、`plugin-package-inventory-deepseek`（插件清单注入请求）、`llm-retry`（`agent/request-error` 处重试）、`token-meter`（`ctx.tokenMeter` 从日志测 token） |

### 3.3 执行能力族（代码/命令执行）

| 包组 | 定位 | 子包构成 |
|---|---|---|
| **shell/** | Bash/PowerShell 命令执行能力族 | `shell`（执行器契约 `ctx.shell`）、`bash-local`/`pwsh-local`（本机）、`bash-sandbox`/`pwsh-sandbox`（沙箱受限）、`shell-env`（DSH_* 环境注入）、`tool-bash`/`tool-pwsh`（模型工具）、`tool-bash-persistent`/`tool-pwsh-persistent`（持久会话） |
| **subprocess/** | 全部子进程/终端会话的统一底座 | `subprocess`（`ctx.subprocess` 服务契约）、`subprocess-local`（本机 Provider）、`win32-process`（Win32 受限进程绑定库） |
| **terminal/** | 持久 PTY 会话能力族 | `terminal`（能力缝）、`terminal-bash`（Bash 实现）、`tool-terminal`（模型工具） |
| **code-runtime/** | 代码执行能力族（PTC 模式） | `code-runtime`（Service Definition）、`code-runtime-python`、`code-runtime-worker-thread`（worker 线程 Provider） |
| **sandbox/** | 进程约束接缝 | `sandbox`（`ctx.sandbox`）、`sandbox-local`、`sandbox-policy`（策略）、`sandbox-windows-acl`（Windows ACL） |
| **fs/** | 文件系统能力族 | `fs`（`ctx.fs` 接缝）、`fs-local`（本机）、`fs-sandbox`、`fs-observation-policy`、`tool-fs`、`tool-fs-search`、`tool-str-replace-editor`（字符串替换编辑器） |
| **e2b/** | E2B 远程运行时 Provider（POC，未发布） | `e2b`、`fs-e2b`、`subprocess-e2b` |
| **lsp/** | LSP 语言服务器能力族 | `lsp`（接缝）、`lsp-stdio`（通用 stdio Provider）、`tool-lsp`（模型工具） |

> 接缝的意义：FS 与 subprocess Provider 共享一个执行世界，把两者指向远程沙箱即可整体迁移 Bash、PTY、LSP，无需各 Provider 分叉。

### 3.4 模型工具族（面向模型的能力/工具）

| 包组 | 定位 | 子包构成 |
|---|---|---|
| **skill/** | 可复用任务指令（技能）注册/加载 | `skill`（注册表 `ctx.skills`）、`skill-filesystem`（目录发现+监听）、`skill-badge`（官方徽章）、`tool-skill`（模型加载工具） |
| **web/** | Web 搜索与 URL 抓取 | `web`（`ctx.web` 服务）、`web-search-exa`/`web-search-perplexity`/`web-search-deepseek`（搜索后端）、`web-fetch-http`（抓取后端）、`tool-web`（`web_search`/`web_fetch` 工具） |
| **workflow/** | 模型编写编排脚本，扇出到 subagent | `workflow`（接缝）、`workflow-worker-thread`（worker 线程引擎）、`tool-workflow`、`tool-ralph` |
| **subagent/** | 子代理能力族：委托任务给子 agent | `subagent`（Provider 注册契约 `ctx.subagent`）、`subagent-in-process-driver`/`subagent-spawn-in-process`/`subagent-fork-in-process`（进程内）、`subagent-dsh-sdk`、`subagent-claude-code`、`subagent-codex`、`subagent-acp`（外部产品驱动）、`tool-subagent`/`tool-subagent-control`/`tool-subagent-report`（模型工具） |
| **jobs/** | 后台任务运行时 | `jobs`（`ctx.jobs`）、`jobs-local`、`tool-jobs`（`job_*` 工具） |
| **todo/** | 模型向 `todo_write` 工具 | `tool-todo` |
| **plan/** | 计划协作状态 | `plan-mode`（直接进入命令 + 受审退出） |
| **compaction/** | 上下文压缩能力族 | `compaction`（Service Definition）、`compaction-basic`（基础 Provider）、`command-compact`（命令 Consumer）、`compaction-tool-result-pruner`（工具结果裁剪） |
| **context/** | 模型可见的请求上下文 | `agent-instructions`（工作区指令）、`file-reference`/`file-reference-local`（文件引用）、`session-reference`（会话引用）、`time-context`（时间）、`tmux-context` |
| **attachment/** | 持久附件身份与本地内容寻址存储 | `attachment`、`attachment-local` |
| **spill/** | 工具结果溢出存储 | `spill`（接缝）、`spill-local`、`spill-policy` |
| **webhook/** | 已验证外部事件写入 Workspace 会话 | `webhook`（`ctx.webhookRuntime`）、`webhook-github`（GitHub 适配器） |
| **mcp/** | MCP 客户端 | `mcp-client` |
| **preset/** | 每会话 agent 组合 | `agent-presets`、`persona` |
| **experimental/** | 私有原型（不发布） | `agent-team`/`agent-team-profile`/`agent-team-web-profile`/`tool-agent-team`/`client-ui-agent-team`（Agent 团队协作缝）、`inspector`、`webworker-packer`/`webworker-runtime` |

### 3.5 会话、持久化与状态

| 包组 | 定位 | 子包构成 |
|---|---|---|
| **session/** | 持久会话数据面 | `session-persistence`/`session-persistence-jsonl`（持久化接缝+JSONL 后端）、`session-projection`/`session-projection-cache`（投影）、`session-title` 系列（`session-title-llm`/`-first-prompt-llm`/`-all-prompts-llm`）、`session-telemetry`/`session-telemetry-otel`（遥测）、`session-stats`、`session-turn-outline`、`session-log-deepseek`、`session-checkpoint-policy` |
| **session-query/** | 会话检索族 | `session-query`（逻辑语料库）、`session-query-sqlite`（SQLite 全文检索）、`session-log-export`（导出）、`tool-session-query` |
| **storage/** | 非会话存储中枢 | `storage`、`storage-domain`、`storage-json`、`storage-sqlite` |
| **settings/** | 用户设置接缝 | `settings`（`ctx.settings`）、`settings-file`（文件 Provider） |
| **credentials/** | 凭据引用/记录与授权流程 | `credentials`（`ctx.credentials`）、`credentials-local`（env-over-`.env` Provider）、`authorization`（询问人类的授权流） |
| **workspace/** | 工作区实体 | `workspace` |

### 3.6 人类协作平面

| 包组 | 定位 | 子包构成 |
|---|---|---|
| **interaction/** | 人机交互：批准、命令、提问 | `commands`（斜杠命令，`ctx.commands`）、`user-approval`（一次性放行/拒绝）、`permission-presets`（沙箱+批准策略），`tool-ask-user`、`user-questions` |
| **goal/** | 同会话目标持久化与生命周期 | `goal`（`ctx.goals`）、`goal-round-driver`、`tool-goal`、`command-goal` |
| **schedule/** | 会话内定时跟进 | `schedule` |
| **feedback/** | 人类反馈捕获 | `command-feedback`、`message-feedback` |
| **identity/** | 共享匿名身份 | `anonymous-user-id` |
| **guard/** | 循环卫生守卫 | `repeat-tool-reminder`（重复调用提醒）、`timeout-policy`（`tools/execute` 超时执行者） |
| **hooks/** | Claude Code / Codex hook 桥 | `hook-protocol`（共享线协议库）、`hooks-claude-code`、`hooks-codex` |

### 3.7 Web GUI（Host 半 + 浏览器半）

| 包组 | 定位 | 子包构成 |
|---|---|---|
| **host/** | Web GUI 的 Host（服务端）半：API 网关 + HTTP 路由服务器 | `webserver`、`frontend-static`、`plugin-inventory`、`directory-picker` 系列（`-auto`/`-browse`/`-native`） |
| **client/** | Web GUI 的浏览器半：shell、线速、object services、slots、`ui-*` 插件 | 内核：`web`（启动 shell）、`modules`（加载浏览器模块）、`connection`（浏览器-Host RPC）、`store`（React-free 状态）、`hmr`、`locale`、`ui-renderer`、`ui-slots` |
| | | UI 功能（40+ 个 `ui-*` 插件）：`ui-chat`、`ui-conversation`、`ui-session`、`ui-layout`、`ui-sidebar`、`ui-workspace`、`ui-approval`、`ui-tool`、`ui-workflow-run`、`ui-goal`、`ui-trajectory`、`ui-commands`、`ui-input-trigger`、`ui-skill`、`ui-reference`、`ui-subagent`、`ui-schedule`、`ui-jobs`、`ui-model-selection`、`ui-permission-presets`、`ui-plan`、`ui-settings` 系列（`-general`/`-models`/`-plugins`/`-plugin-inventory`）、`ui-user-questions`、`ui-agent-preset`、`ui-deliverables`、`ui-message-feedback`、`ui-directory-picker-*`、`ui-primitives`、`ui-theme`、`ui-attachment`、`ui-brand-official` |

> 前端扩展通过 **Slots（槽位）系统**：每个插件向声明的扩展槽填充类型化 props 与 store，shell 渲染组装后的树。`ui-renderer` 把槽数据绑定到 React。

### 3.8 外部集成与自动化

| 包组 | 定位 | 子包构成 |
|---|---|---|
| **sdk/** | 进程外 SDK：JSON-RPC 协议 + TS 客户端/服务器 | `protocol`（换行分隔 JSON-RPC 线协议）、`client`（TS 客户端，派生运行时子进程）、`server`（jsonrpc 插件，stdio 服务） |
| **acp/** | 自动化专用 Agent Client Protocol 服务器 | `acp`（ACP v1，JSON-RPC stdio，无人回路） |
| **extensions/** | Agent 运行时自修改：挂载/卸载自身插件 | `cordis-client-runner`、`cordis-host-runner`、`tool-cordis`（模型工具）、`ui-cordis` |

### 3.9 基础设施与支持

| 包组 | 定位 | 子包构成 |
|---|---|---|
| **util/** | 低层零依赖工具库（支持角色） | `brand`（`Branded<B>`）、`home-paths`、`time`、`timeout`、`atomic-write`、`crypto`、`deque`、`values`、`launch-environment`、`native-command`、`output-retention`、`workspace-path` |
| **test-support/** | 测试基础设施 | `agent-loop-testkit`、`llm-mock-server`、`llm-replay`、`loader-smoke`、`session-snapshot`、`client-runtime` |
| **runtime-diagnostics/** | 包内不变量检查 | `invariants` |

---

## 4. 外围目录

| 目录 | 定位 | 核心构成 | 与 packages/ 协作 |
|---|---|---|---|
| **apps/cli/** | `dsh` 命令唯一实现，全仓库唯一 Node 应用启动入口 | `src/bin.ts`（argv 分发）、`src/args.ts`（命令语法）、`src/profile-boot.ts`（profile 组装）、`src/plugin.ts`（插件管理）、`src/dump-config.ts` | 自身几乎无业务逻辑：从 bundle 包拉 profile 组合，从各插件包拉工具与服务；`verify-application-entrypoints` 强制唯一入口 |
| **apps/web/** | Web 前端入口（Vite 构建壳） | `src/main.ts` 导入 `@deepseek-ai/dsh-client-web` 的 `AppWebEntry` | 只做打包装配，真实逻辑在 `packages/client` |
| **python/** | Python SDK 与捆绑运行时 | `sdk/`（Python 客户端）、`sdk-runtime/`（打包 `dsh --profile sdk` 的 wheel） | 运行时 wheel 打包标准 dsh CLI；Python 暴露 profile 选择与 patch 文件，不暴露完整 Cordis 树 |
| **native/** | 原生模块的 source of record | `landlock-run/`（`@deepseek-ai/node-addon-landlock-run`，Linux Landlock 沙箱） | 为 sandbox 能力提供原生约束后端 |
| **scripts/** | 仓库门禁与生成器 | `run-gates.ts`（gate 编排）、`verify-*.ts`（各门禁）、`gen-*.ts`（生成目录/文档/图）、`build.ts`/`clean.ts`、`release/`（发布流程） | 全链路质量门禁：typecheck/lint/coverage/doc-sync/hygiene，消费方是无依赖的 scripts |
| **website/** | VitePress 文档站点投影 | `build.ts`、`docs.ts`（发布清单）、`.vitepress/` | 从 `docs/` 选择页面投影；`.generated/` 产物被忽略 |
| **vendor/** | 固定版本的上游源码拷贝 | `cordis/`、`cosmokit/`、`group/`、`hmr/`、`loader/`、`logger-console/`、`schemastery/`、`timer/`、`include/` | 按 `vendor/README.md` 的同步流程更新；rescope 为 `@deepseek-ai/*` |
| **docs/** | 架构/子系统/教程/手册文档 | `architecture.md`（架构地图）、`subsystems/`（每子系统一页）、`cookbook/`（扩展步骤指南）、`cordis-tutorial/`、`cordis-api/`（生成 API）、`i18n/`（双语）、`postmortem/`、`user/` | 遵循 docs/AGENTS.md 层级；生成目录由 scripts 刷新 |
| **snapshots/** | 记录会话快照（回放输入+期望输出） | `session/`、`web/`、`sdk/`、`acp/` | 仅存会话驱动测试；非会话期望输出在各所有者处 |

---

## 5. 关键机制（扩展开发必读）

### 5.1 事件是扩展点

- **Session 事件**：持久事实，追加到日志并广播（`session/event`）；事实需在重载后存活时用
- **Agent 事件**（`agent/*`）：携带活动 `Agent`：inbox、step、status、request、validation、continuation；用于观察/拦截进行中的工作
- **Capability 事件**（`fs/*`、`tools/*`、`telemetry/*`）：给接缝挂策略与适配器，不引入 loop

### 5.2 Capability Seam 三角色

每个可替换能力 = Service Definition + Service Provider + Consumer（通常是模型工具）。一个角色不成接缝；添加能力意味着设计全部三角色。示例：

- 新增模型 Provider → 在 `ctx.llm` 注册适配器
- 新增模型能力 → 在 `ctx.tools` 注册工具，schema 加入提示词装配
- 新增 shell 执行后端 → 注册 `ctx.shell` 后端
- 新增人类命令 → 注册 `ctx.commands`（不产生模型回合）
- 新增后台工作 → 注册 `ctx.jobs`

### 5.3 会话日志与投影

- 会话日志是模型所见上下文的来源；`deriveMessages()` 从日志投影模型历史
- 持续会话状态 → 扩展 `SessionEventMap`，从日志渲染/回放
- `session-projection` 拥有 `ctx.sessionProjections`：注册单元增量折叠提交事件，`stateOf()` 读取类型化状态

### 5.4 作用域注册（scope）

`core/scope` 提供按 agent 隔离注册的原语；工具注册表、事件路由构建其上。把注册限定到某 agent → 使用 `agent.ctx`。

### 5.5 Model Experience（模型体验）

每个面向模型的工具/能力必须考虑模型体验：prompt、工具 schema、结果、诊断只含任务相关概念，不含 UI/传输/实现词汇。稳定的模型可见文本要逐字锁定，动态行为用快照或 e2e 覆盖。

---

## 6. 扩展开发快速指引

1. **定位扩展点**：对照 5.2 表找归属（工具→`ctx.tools`、模型→`ctx.llm`、命令→`ctx.commands`、后端→对应接缝）
2. **设计三角色**：按 Capability Seam 补全 Service Definition / Provider / Consumer（或挂到既有接缝）
3. **类型化事件**：若需模型可见输入 → 扩展 `SessionEventMap` 并加 session event；用声明合并
4. **注册即副作用**：贡献走 `ctx.effect()`/`ctx.on()`，`register()` 返回 disposer
5. **快速验证**：`dsh --profile <你的profile> --dump-config` 检查组合；写 e2e/快照覆盖
6. **质量门禁**：publish README、JSDoc、`./invariant` 注册、非平凡改动附 Agent Note

---

## 7. 包组依赖关系速记

- **core** 是最低稳定契约层，运行组合在 `bundle/`（`dsh-base` 为默认）
- 扩展插件依赖 **Service Definition**，绝不依赖具体 Provider（`agent-loop` 可整体替换）
- **subprocess** 是全部子进程（bash/LSP/PTY/跨进程 subagent）的底座
- **sandbox** 通过 wrapper 约束 spawn 的 argv；FS/Subprocess 共享执行世界
- **client/host** 分灵浏览器半与服务端半，中间经 api 层 RPC
- **util** 是零依赖支持层，**test-support**/**runtime-diagnostics** 是开发期支持
- 每个 package 拥有 `./invariant`（事件/数据关系检查或显式空安装器的理由）

---

## 8. 模型请求 messages 构造链路（会话上下文）

发送给模型的 `messages` 数组完全由**会话日志派生**，整个链路是 `SessionEvent 日志 → Surface 投影 → agent-loop 组装 → Provider 适配器映射`。核心不变量：**模型可见 ⟺ 已记录**——任何进入模型请求的内容都能从会话日志重建，agent-loop 的 `invariant.ts` 会在每次请求时断言 `request.messages` 与 `session.deriveMessages()` 完全一致。

### 8.1 整体数据流

```
用户输入 / 注入上下文
   │  claim（inbox.next-step / next-turn）
   ▼
[agent/pre-step]  waterfall：可改写 messages / 拒绝
   │  通过后：把 decision.messages 逐个 append 为 user/message 事件（surfaceOp:'append'）
   ▼
SessionEvent 日志（只追加，source of truth）
   │  session.deriveMessages() —— 折叠 surface 节点列表
   ▼
Message[]（provider 中立的请求历史：role + ContentBlock[]）
   │  buildRequest 组装 GenerateOptions { config..., messages, system, tools, sessionId }
   ▼
LlmRuntime.stream(request) → 适配器 translate
   │  DeepSeek：serializeRequest → system 消息 + serializeMessages
   ▼
Wire payload = { messages: [{role:'system'|'user'|'assistant'|'tool', ...}], tools, stream:true }
```

### 8.2 第一层：会话日志（core/session）

- 会话是**只追加的 `SessionEvent[]`**（`packages/core/session/src/index.ts` 的 `Session` 类，`seq = log.length` 连续性契约）
- 一个例行 turn 产生的事件序列：`turn/start` →（`step/start` → `user/message`* → `assistant/chunk`* → `assistant/message` → `tool/call`* → `step/end`）→ `turn/end`，另随时有 `request/header`（路线配置）与 `request/context`（路由上下文）
- **只有 3 种事件会出现在模型历史里**（`surface.ts` 的 `SURFACE_EVENT_TYPES`）：
  - `user/message` —— 用户/注入的普通消息
  - `assistant/message` —— 模型完成消息（空 content 的只作 usage 载体，投影为 null）
  - `tool/result` —— 工具结果

### 8.3 第二层：Surface 投影（surface.ts）

- `session.append(type, data, { surfaceOp: 'append' })` 要求每个消息类事件携带 `surfaceOp` 标记；surface 据此维护一个**有序节点序列**（被 compaction 的 `{op:'replace', start, end}` 会遮蔽旧节点）
- `deriveMessages()`（`index.ts`）把 surface 节点逐个经 `deriveEventMessage()` 投影：
  - `user/message` → 原样返回 `event.data`（provider 中立的 `Message`）
  - `assistant/message` → 返回 `event.data.message`；content 为空则返回 null（跳过）
  - `tool/result` → 返回 `event.data.message`
  - 其余（chunk、turn/step 边界等）→ null
- 结果是一个**深冻结 `Message[]`**，带增量缓存（每节点只投影一次，surface `replaceGeneration` 变化时重建），且与磁盘持久化、UI 回放共享同一份 frozen 数据

### 8.4 第三层：agent-loop 组装（core/agent-loop/src/agent.ts）

单步请求构造在 `ReactLoopAgent.preStep()` + `step()` + `buildRequest()`：

1. **claim 消息**：`inbox.claim(target, turn)` 取出用户输入
2. **装配系统提示词**：`systemPrompt.assemble(assembleContextFor(this, signal))` 收集全局+作用域的 prompt sections、动态 contexts、工具 schemas、变量 → 经 `system-prompt/assemble` waterfall
   - `renderContextSections()` + `joinContextSections()` 生成**动态运行时上下文快照**（如沙箱策略、批准策略、子代理委托说明），文本形如 `Current runtime context. This snapshot supersedes earlier...`
3. **pre-step 决策**：`agent/pre-step` waterfall 把 `claimed` 与注入的 context 合并成 `decision.messages`（waterfall 可改写或拒绝）
4. **落日志**：`decision.messages` 逐个 `session.append('user/message', message, { surfaceOp: 'append' })` —— 注入的上下文也因此成为持久 user/message
5. **流式 step**：`renderPrompt(assembly)` 渲染最终 system 字符串 → 调 `buildRequest(turn, step, assembly.tools, system, this.session.deriveMessages(), ...)` 取**当前完整派生历史**作为 `boundaryMessages`
6. **组装不可变请求**：
   ```
   request = deepFreeze({ 
     ...header.config,          // provider/model/reasoningEffort/maxTokens...
     messages: boundaryMessages, // ← 核心：session.deriveMessages()
     system,                     // ← renderPrompt 渲染的系统提示词字符串
     tools: assembly.tools,      // 规范化排序后的工具 schema
     sessionId, signal,
   })
   ```
7. 模型响应以 `assistant/chunk` 流式落日志，`BlockAssembler` 组装成 `assistant/message`（携带使用量）；工具调用经 `tools/pre/execute/post` 管线执行，结果以 `tool/result` 落日志——下一个 step 的 `deriveMessages()` 自然包含新消息

### 8.5 第四层：Provider 适配器映射（llm/ + llm-deepseek）

- 统一请求类型 `GenerateOptions`（`packages/llm/llm/src/types.ts`）：`{ provider, model, messages: Message[], system?, tools?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose? }`
- `Message`（`llm/src/message.ts`）：`{ id: MessageId, role: 'system'|'user'|'assistant', content: ContentBlock[], source: MessageSource }`；`ContentBlock` 支持 `text` / `reasoning` / `image` / `tool-call` / `tool-result` 五种核心块（可合并扩展）
- **DeepSeek 适配器**（`llm-deepseek/src/serialize.ts`）的 wire 映射规则：
  - `options.system` → 压入最前一条 `{ role: 'system', content }`（循环里的 system role 消息也会映射）
  - `assistant` 消息 → `{ role: 'assistant', content: 文本, reasoning_content?: 推理文本, tool_calls?: [...] }`（纯工具回合 content 用 `""` 而非 null）
  - `user` 消息 → `{ role: 'user', content: 文本 }`；含图片时用 `[{type:'text'}, {type:'image_url'}]` 部件数组
  - `tool-result` 块 → harness 词汇里挂在 user 消息上，wire 上**拆分为独立 `{ role: 'tool', tool_call_id, content }`**（空输出补 `'(no output)'`）
  - 默认 `stream: true`、`stream_options: { include_usage: true }`；thinking/推理档位经 `thinking:{type}` / `reasoning_effort` 传输

### 8.6 扩展时如何向请求注入内容

| 场景 | 机制 |
|---|---|
| 增加**系统提示词分节** | `ctx.systemPrompt.section({ name, order, text })`（用 `getSectionOrder('XXX')` 取仓库统一排序位） |
| 增加**动态运行时上下文** | `ctx.systemPrompt.context({ name, order, text })`（如沙箱/批准策略） |
| 注册**提示词变量** | `ctx.systemPrompt.variable('name', ctx => value)`，分节文本用 `{{name}}` 引用 |
| 注入**一次性上下文**到下拉请求 | `agent.inject(userMessage)` → 进 next-step inbox → 成为下一条 user/message |
| 改写/拒绝**即将发送的消息** | 监听 `agent/pre-step` waterfall（返回 `{kind:'enter', messages}` 或 `{kind:'reject'}`） |
| 改写/确认**请求配置** | 监听 `agent/request` waterfall（返回 provider/model/参数提案） |
| 新增**模型提供商** | 在 `ctx.llm` 注册适配器，实现 `serializeRequest` 把 `GenerateOptions.messages` 映射为自家 wire 的 `messages` 字段 |
| 新增**模型可见输入类型** | 扩展 `SessionEventMap` 新增持久事件 + `deriveEventMessage` 投影规则（或直接复用 `user/message`） |

### 8.7 会话历史是否可以修改？（追加 vs 遮蔽 vs 派生）

**核心结论：会话日志本身是不可变的（append-only + deep-freeze），但"模型看到的派生历史"可以通过追加 / 遮蔽 / 派生三种方式改变。** 分述如下：

**① 日志不可变（写入层面）**
- `Session` 只有 `append(type, data, surfaceOpts)` 一个写入入口：事件进入日志即被 `deepFreeze`，`seq = log.length` 连续，磁盘 JSONL 只增不改
- 没有 `update`/`delete`/`edit` API；事件 envelope 校验（`assertSessionEventEnvelope`）拒绝任何改写痕迹；`deriveMessages()` 返回深冻结数组，消费者改动消息对象会抛错（`derived-cache.spec.ts` 有验证）
- 持久化后端拒绝旧格式（`SESSION_FORMAT_VERSION` 单调递增），旧版日志通过迁移/修复加载，不是原地改写

**② 模型可见历史可被"遮蔽"（Surface replace，供压缩场景）**
- compaction 落一条 `{op:'replace', start, end}` 的 surface 元数据事件，surface 节点列表把 `[start..end]` 替换为新事件 seq——`deriveMessages()` 从此只投影新节点，旧对话不再进入模型上下文
- 关键点：**旧事件仍留在日志里**（`isAppendSurfaceEvent` 专门区分"append 源事件"与"替换副本"），UI 的人类可读转录用 append 源事件，模型历史用 surface——遮蔽 ≠ 删除
- 替换有严格校验：必须 `sourceEventSeqs` 覆盖全部被遮蔽节点；`tool/result` 的 replace 只能改 content（`assertToolResultRewrite`），且一次只改一个节点

**③ 派生新会话（Fork，不改原会话）**
- `ctx.sessions.fork(source, boundary?, childSessionId?)` 从原日志某边界派生一个**新**会话，携带 `parentSession`/`seedLength`/`origin:'subagent'` 谱系 metadata；原会话不受影响
- `Session.create(id, seed)` 直接种子导入也可构造任意回放/派生实例

**④ 崩溃修复是"补齐"而非"修改"（repair.ts）**
- 进程崩溃导致日志尾部有未闭合的 `turn/start`/`step/start`/悬挂 tool-call 时，`interruptedTurnClosers()` 生成**合成关闭事件**（未开始调用的 error 结果 + `step/end` + `reason:{kind:'interrupted'}` 的 `turn/end`）并 append——与持久化格式兼容，且保证恢复后的转录对 provider 合法
- 合成 tool/result 的 `sourceEventSeqs` 引用原 `tool/call` seq，时间戳复用最后真实事件，确定性生成

**⑤ 对扩展开发的启示**
- 想让模型看到"新事实"永远走**追加**：扩展 `SessionEventMap` 增加持久事件类型（如 `todo/write`、`goal/change`），并在 `deriveEventMessage` 或渲染器中赋予投影/呈现规则
- 想把**长历史压缩**成摘要：落 `assistant/message`（摘要）后用 `{op:'replace'}` 遮蔽旧区间
- 想构建**并行分支**或子代理隔离上下文：用 fork
- 永远不要尝试改写旧事件——它既是数据完整性根基，也是回放/持久化/UI 一致性的前提
