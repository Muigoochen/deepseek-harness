# 原生源码速查：时钟上下文任务读过的关键文件

> 记录本次「time-context 时钟上下文」开发过程中实际阅读过的原生源码：每个文件做什么、暴露哪些主要方法/属性，方便以后开发其它功能时快速定位，不必重翻源码。
> 属于项目自有调研笔记，与官方 `docs/` 文档树分开存放。基于 commit `dd6322d604`（release 0.1.2-alpha.3），2026-09-04。功能结论见 [time-context-clock-feature.md](time-context-clock-feature.md)。

> 说明：只收录本任务确实读过/用到的文件；「主要导出」给出名称与签名要点，内部函数会标注。跨文件相对路径均相对仓库根。
> 存放：`plugins/time-context/docs/`（项目单一归属；仓库树已回滚纯净，本项目相关代码只以参考形态留在 `plugins/time-context/reference/`）。

## A. `@deepseek-ai/dsh-time-context` 插件包（本次主题）

### A1. `packages/context/time-context/src/index.ts` —— 插件入口

**作用**：注册 `agent/pre-step` 监听（prepend、先 delegate），在步骤进入且读数到期时把一条持久化时钟读数追加进该步骤的候选 user 消息。

| 导出 | 说明 |
|---|---|
| `name = 'time-context'` | Cordis 插件名（loader 诊断用） |
| `inject = ['agents', 'sessionProjections']` | 声明依赖：agent 注册表 + 会话投影注册表 |
| `interface Config { timeZone?: string; refreshIntervalMs?: number }` | `timeZone`：无唯一浏览器时区时的回退显示时区（省略=进程时区，插件加载时解析一次）；`refreshIntervalMs`：同会话最小注入间隔，省略或 0 = 每步注入 |
| `Config: z<Config>` | schemastery 校验（无效值在插件加载时报错） |
| `apply(ctx, config): void` | 注册投影 `timeContext`（stateVersion 2，字段 `lastMessageTime/lastInjectionTime/lastTurnInjectionTime`）+ prepend pre-step listener |

内部要点：`formatDuration(elapsedMs)` 紧凑整秒时长；`requestMessages(agent, turn, proposed)` 收集 open turn 内已进入+拟议的 user 消息；`renderText(...)` 拼三行读数；`validateRefreshInterval` 拒绝非负安全整数以外的值。浏览器策略与格式化分别委托给 A2/A3。

### A2. `packages/context/time-context/src/request-zone.ts` —— 浏览器时区推导

**作用**：从 open turn 的 user-rpc 消息里读 Host 已校验的浏览器时区，产出「唯一 / 混合 / 缺失」策略并渲染模型可读的政策行。

| 导出 | 说明 |
|---|---|
| `type BrowserTimeZoneContext = {kind:'resolved';timeZone} \| {kind:'mixed';timeZones} \| {kind:'missing'}` | 单一时区 / 多时区排序去重 / 无时区 |
| `deriveBrowserTimeZoneContext(messages): BrowserTimeZoneContext` | 对 `source.kind==='user'` 且带 `rpcId`+`clientTimeZone` 的消息取时区；非规范/不支持时区抛 `TypeError` |
| `renderBrowserTimeZoneContext(context): string` | 渲染成模型指令：resolved →「按该时区理解」；mixed/missing →「向用户澄清，不要猜」 |

> 取值前提（在会话控制器侧定义，见 B 节）：`'user-rpc'` 消息源 = `{ kind:'user'; rpcId; clientTimeZone? }`，Web GUI 每轮 prompt 都会带。

### A3. `packages/context/time-context/src/timestamp.ts` —— 时间戳格式化

**作用**：把 epoch 毫秒渲染成「ISO 形状 + 数字偏移 + IANA 时区」的持久文本。

| 导出 | 说明 |
|---|---|
| `createTimestampFormatter(timeZone?): Intl.DateTimeFormat` | 固定 en-US、`h23`、`timeZoneName:'longOffset'` 的格式化器 |
| `formatTimestamp(now, formatter, timeZone): string` | 输出如 `2026-09-04T10:19:57+08:00[Asia/Shanghai]` |

### A4. `packages/context/time-context/src/invariant.ts` —— 不变量伴生插件

**作用**：校验已加载与新追加的 time-context 读数（快照形状、正则可读、turn/step 位置、来源归属、浏览器策略文本、渲染时间戳与事件时间先后、resolved 时区下时间戳必须一致）。

| 导出 | 说明 |
|---|---|
| `name = 'time-context-invariant'` / `inject = ['invariants']` | 伴生插件身份 |
| `apply(ctx): Promise<() => void>` | 经 `ctx.invariants.register('@deepseek-ai/dsh-time-context', install)` 安装 |

### A5. 测试与夹具（上游 `packages/context/time-context/tests/`；本项目回归证据移存 `plugins/time-context/reference/`）

| 文件 | 作用 / 要点 |
|---|---|
| `time-context.spec.ts` | 单元测试：伪造时钟（`vi.useFakeTimers` + `TZ`），手搭 `Session`/`Agent`，验证两种基线、间隔边界、取消等 |
| `time-context.e2e.ts` | keyless loader-smoke：headless shipped profile + fixture patch + mock LLM，两轮后从 `.sessions/*.jsonl` 断言读数的持久事件与格式 |
| `time-context-web-example.e2e.ts`（移存 `plugins/time-context/reference/`） | 本项目回归证据：把本插件 `cordis.patch.yml` 当真实 overlay 挂载，验证浏览器时区优先与配置回退（仓库内复跑需临时放回本 tests 目录，见 H 节） |
| `tests/fixtures/`（上游自带 `driver.ts`、`*.patch.yml`、`mock-llm.ts` 等）与 `plugins/time-context/reference/{web-example-driver.ts, web-example.patch.yml}` | 子进程 driver（`bootProductionProfile` + 手动 followup 轮次）；companion patch 里插 `./mock-llm.ts`（确定性 `time-context-mock` 适配器） |
| `tests/request-zone.spec.ts` / `invariant.spec.ts` | 时区推导与不变量伴生的单元测试 |

## B. 会话与消息源（时间读数为什么合规）

### B1. `packages/api/session-controller/src/types.ts`（约 361–369 行）

**作用**：定义客户端提示词的 `user-rpc` 消息源，是 `clientTimeZone` 的「家」。

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'user-rpc': { kind: 'user'; rpcId: SessionRequestId; clientTimeZone?: string }
  }
}
```

### B2. `packages/core/session`（文档级理解，未逐文件展开）

- 会话是**只追加的 `SessionEvent` 日志**：每项带单调 `seq`、`time`、按 `type` 判别的 `data`。
- `Session.deriveMessages()` 把日志投影成模型看到的 `Message[]`（缓存 + 冻结）；`deriveEventMessage(event)` 是对外暴露的逐节点纯函数。
- 推论：任何要进模型请求的内容都必须能在日志里重建 → time-context 采用「持久 user 消息 + snapshot source」而不是「系统提示词里放实时时间」。

## C. 系统提示词服务（角色理解）

- `ctx.systemPrompt`（`packages/core/system-prompt`）：按步骤组装提示词段落与工具 schema；`system-prompt/assemble` 是权威 waterfall，`system-prompt/change` 是变更 emit。time-context **刻意不碰**这里（避免破坏 request/header 快照与历史重建）。

## D. profile / patch / boot 组合机制（本次关键技术栈）

### D1. `packages/boot/app-boot/src/profile.ts`

**作用**：profile 目录模型与生命周期（模板、初始化、加载、模块回退、条目组合）。

| 主要导出 | 说明 |
|---|---|
| `PROFILE_PATCH_FILENAME = 'cordis.patch.yml'` | profile 用户 patch 层文件名（注释模板也在该文件） |
| `PROFILE_TEMPLATES` | 内置模板：`acp`/`web`/`headless`/`sdk`/`sdk-minimal`，各含 `bundles` 与 `patchReload`；web = `['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']` + `patchReload:'live'` |
| `type ProfilePatchReload = 'live' \| 'startup'` | patch 文件热更新与否 |
| `resolveProfileDir(name, home?)` | `$DSH_HOME/profiles/<name>`；校验非法名字 |
| `initProfile(dir, bundles, patchReload)` | 幂等初始化：package.json manifest + 空 patch 模板 + pnpm-workspace.yaml |
| `loadProfile(binName, name, installAnchor, home?, opts?)` | 解析 bundles → patch 层 + 解析 profile 自身 patch（`userLayer:false` 可跳过） |
| `healProfilesModuleFallback(options)` | 维护 profile 的模块回退（保证 bundle 依赖可见） |
| `composeEntries(...)` | 把 patch 条目组合成最终配置树 |

### D2. `packages/boot/app-boot/src/index.ts`

**作用**：boot 胶水与 overlay/user-patch 加载、live patch 热更新。

| 主要导出 | 说明 |
|---|---|
| `resolveConfigPath(path, root?)` | 配置路径解析（相对 root 或 cwd） |
| `loadOptionalPatches(binName, file): PatchOptions[] \| undefined` | 解析「顶层是 loader patch 条目数组」的 yml；文件缺失=无层，坏文件抛错 |
| `loadOverlayPatches(binName, file): PatchOptions[]` | 加载 `--patch` overlay（必须有内容） |
| `watchUserPatches(ctx, {binName, filename, compose?})` | 经 Cordis HMR 事务性重放 profile/home patch（要求 HMR + 根 Include） |
| `mountRootInclude(...)` / `boot(...)` | 建根 Include / 完整启动 |
| `installFailLoud(...)`、`assertEntriesLoaded/Activated(...)` | fail-loud 与装载断言 |

### D3. `apps/cli/src/profile-boot.ts`

**作用**：`dsh` 各 surface 共享的 profile 启动：层顺序 = bundle 层（按 `dsh.profile.bundles`）→ profile 自身 `cordis.patch.yml` → home patch → `--patch` overlays → telemetry 开关；按 `patchReload` 生命周期挂树并接 fail-loud/退出。

| 主要导出 | 说明 |
|---|---|
| `homePatchPath(): string` | `$DSH_HOME/cordis.patch.yml`（每次调用现解析） |
| `INSTALL_ANCHOR` | 安装锚点 package.json（src/ 与 lib/ 的解析源头） |
| `PROFILE_ROOT_FILENAME = 'cordis.yml'` | profile 根配置名（生成文件，注释明示「改 cordis.patch.yml，别改这里」） |
| 内部 | `composeLive`、watchUserPatches 注册（web 类 live profile 同时 watch profile patch 与 home patch）；telemetry 开关 patch |

## E. 出货组合与示例 overlay（本次产物参照物）

| 文件 | 作用 / 要点 |
|---|---|
| `packages/bundle/base/cordis.patch.yml` | 四 profile 共享第一层：agent/session/工具/沙箱等；`insert` 项可带 `config`（如 session-title 行） |
| `packages/bundle/web-app/cordis.patch.yml` | Web 专属层；`ui-schedule` 以 **shipped-disabled** 存在（客户端包解析但 `disabled: true`），由显式 overlay 翻转启用——这是「可选功能出厂带壳、overlay 打开」的模板 |
| `apps/cli/config/examples/schedule/cordis.yml` | overlay 模板：`insert` time-context + schedule，再 id-targeted 翻 `ui-schedule`；配 `docs/user/guide/schedule.md`（`dsh web --patch …`） |
| `plugins/time-context/cordis.patch.yml` | 本项目 overlay（曾临时放 `apps/cli/config/examples/time-context/`，按纯插件原则已移出并回滚仓库）：只 `insert` time-context + `timeZone: Asia/Shanghai` |

> loader patch 语义：顶层数组；`insert` 加行；按 `id` 的目标条目做 config 覆盖 / `disabled`。`scripts/verify-cordis-config.ts` 会扫描 `apps/cli/config/examples/**/*.yml` 校验元数据与插件包可解析性（bare 插件须出现在所属 workspace 的依赖里）。

## F. Loader-smoke 测试基建（keyless REAL-composition 测试的标准姿势）

### F1. `packages/test-support/loader-smoke/src/index.ts`

**作用**：子进程级 Loader 冒烟：隔离临时 DSH_HOME 里启动真实 `cordis.yml` 树，喂空 stdin、等干净退出、按退出码断言，并在 `inspect` 回调里检查落盘世界状态。

| 主要导出 | 说明 |
|---|---|
| `runLoaderSmoke(options): Promise<{stdout,stderr}>` | 主入口；超时 SIGKILL、临时目录清理、src/lib 双模式 |
| `LoaderSmokeOptions` | `binScript/libBinScript/configPath/binArgs/tsconfigPath/env/prepare/inspect/expectedExitCode/…` |
| `resolveExampleLaunch(options): ExampleLaunch` | 解析 src（tsx + tsconfig paths）或 lib（plain Node）启动向量 |
| `resolveExampleMode(raw?)` / `EXAMPLE_MODE_ENV = 'DSH_EXAMPLE_MODE'` | `'src'`（默认，dev）或 `'lib'`（CI 装包路径） |
| `LOADER_SMOKE_TEST_TIMEOUT_MS` | 测试超时常量 |

### F2. `packages/test-support/loader-smoke/src/agent-turn.ts`

**作用**：对「恰好一个根 agent」的组合执行一轮任务（`agent.followup` → `whenIdle` → flush），返回最终助手文本与 token 用量；可用于自定义消息源（本次 driver 仿它构造带 `clientTimeZone` 的 user-rpc 消息）。

| 主要导出 | 说明 |
|---|---|
| `runFixtureTurn(ctx, {task, onEvent?}): Promise<FixtureTurnResult>` | 一轮任务 |
| `FixtureTurnOptions / FixtureTurnResult` | 入参 / `{type:'result', sessionId, output, usage?}` |

### F3. `packages/test-support/loader-smoke/tests/fixtures/production-profile.ts`

**作用**：在 shipped profile（如 `headless`/`web`）的 bundle 层之上叠加测试 overlay 并 boot。

| 主要导出 | 说明 |
|---|---|
| `bootProductionProfile({binName, profile, overlayPaths, prepare?}): Promise<Context>` | overlay 路径必须以 `.patch.yml` 结尾；自动为 overlay 里 insert 的 bare 包做模块回退（`healProfilesModuleFallback`） |
| `ProductionProfileOptions` | 见左 |

> 本项目回归 driver（存 `plugins/time-context/reference/`）用它：boot headless profile + 插件 patch/companion，跑真实组合（仓库内复跑需按原布局临时放回）。

## G. apps/web 真实浏览器 e2e 基建（UI 层证据标准）

### G1. `apps/web/tests/scaffold.ts`

**作用**：组装 base+web-app+overlay 的真实 web 组合（`launchWebScaffold`），起 playwright 驱动页面，支持 **record / replay / refresh** 三种快照模式，会话种子、金样对比、控制台巡检等。

| 主要导出（摘） | 说明 |
|---|---|
| `webSnapshotMode(): 'replay'\|'record'\|'refresh'` | 由环境决定模式（keyless 默认 replay 记录会话） |
| `launchWebScaffold(options): Promise<WebScaffold>` / `interface WebScaffold` | 启动组合+服务器；`whenTurnSettled()` 等待一轮结束；`ctx` 可挂 `session/event` 收集器 |
| `recordFixture` / `seedSession` / `seedBlankSession` | 录制会话 / 用 fixture 播种会话 |
| `captureStableAria` / `compareOrRefreshGolden` | 金样对比或刷新 |
| `assertFixtureInventory` / `watchConsole` | 夹具清单 / 页面错误与警告巡检 |

### G2. `apps/web/tests/support.ts`

**作用**：页面级小工具。

主要导出（摘）：`REPO_ROOT`、`requireDist()`（要求构建产物）、`probeFreePort()`、`newEnglishPage(browser)`、`connectFreshWorkspace(page, root)`、`writeComposerDraft(page, input, text)`、`saveFailureShot(page, name)`、`conversationContextKey(kind, id)`。

### G3. 代表用例（供抄模板）

- `schedule-after.e2e.ts`：`loadOverlayPatches` + `launchWebScaffold` 挂 schedule overlay；断言真实页面 prompt 的 `user.data.source` 带 `clientTimeZone`（浏览器时区证据），并断言模型请求上下文/工具调用。
- `permission-policy-context.e2e.ts`：断言 `request/header.header.system` **不含**运行时快照文本、而 durable `user/message`（来源 `@deepseek-ai/dsh-system-prompt`）含完整政策——「缓存安全运行时上下文快照」的断言范式，与 time-context 的持久读数同构。

## H. 回归证据文件速览（原仓库 e2e → 现移存 `plugins/time-context/reference/`）

- 背景：曾以 `packages/context/time-context/tests/time-context-web-example.e2e.ts` 挂在仓库 `vitest.e2e.config.ts` 下跑通（`packages/*/*/tests/**/*.e2e.ts` 命中 include；keyless loader-smoke）。为遵守「纯插件、不碰仓库」，已移出仓库，现仅作参考存于 `plugins/time-context/reference/`。
- 组合驱动链（原样）：e2e → `runLoaderSmoke`（子进程）→ `web-example-driver.ts`（`bootProductionProfile` + 自定义 source followup）→ 落盘 `.sessions/*.jsonl` → e2e 回读断言。
- 复跑条件：需按原布局放回仓库（连同 `mock-llm.ts` 等依赖）后执行 `pnpm exec vitest run --config vitest.e2e.config.ts time-context`；跑完清理，仓库保持纯净。

## 附：本次读过的其它参照物

- `packages/boot/app-boot/tests/user-patches.spec.ts`、`packages/context/time-context/tests/*.spec.ts`：理解 HMR watch 与插件的单测手法。
- `.agents/notes/implemented/feature/2026-07-16-durable-per-step-time-context.md`：本功能的设计决策原文（为什么默认不挂、为什么走持久消息、被否决的替代案）。
- `docs/user/guide/schedule.md`：官方 overlay 启用文档范例。
