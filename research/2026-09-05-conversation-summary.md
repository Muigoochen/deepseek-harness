# conversation-summary（会话总结/压缩插件）开发记录

> 日期：2026-09-05。本轮开发 `plugins/conversation-summary/`（@dsh-user 静态插件：Host + 浏览器设置页）。
> 性质：源码核实事实 + 待验证假设 + 走过的弯路。非官方权威，随版本演进可能变化。

## 1. 目标与产物

- 需求（用户原话口径）：上下文达到**可配置绝对预算**（如 200k）时，把早期对话总结成 checkpoint，减少每步请求发送量；压缩要能被 **agent 主动调用**；支持"定稿即压"。
- 载体：宿主平面静态插件 `plugins/conversation-summary/`（约定同 toast/lsp-echo：`@dsh-user/<名>` + `install/install.ps1` + `cordis.patch.yml` 行）。
- v0 范围：压缩本体**委托内置 compaction 引擎**（不换模板/引擎）；自带超预算提醒、`compact_conversation` 工具、plan 定稿自动压缩、常驻策略提示词、设置页 GUI（草稿→YAML）。

## 2. 从源码核实的机制事实（引用前再对源码）

- **compaction 封层**（`packages/compaction/`）：
  - `CompactionTrigger = 'pressure' | 'context-overflow'`；`compaction-basic` 默认 `auto:true`，`agent/pre-step` 上估算 **≥ 路由模型上下文窗口 80%** 才自动压；`agent/request-error` 遇 `CONTEXT_WINDOW_EXCEEDED` 强制压并 retry。
  - 压缩事务 = `compaction/start → compaction/summary → 替换 user/message → compaction/end` 日志事件对；被压旧消息**不删除**，仅以 `sourceEventSeqs` 遮蔽，表面替换由紧跟的 `user/message` 承担；`isCompactCheckpointSource` 识别 checkpoint（marker = `{kind:'plugin', plugin:'compact'}`）。
  - checkpoint 产出为**内置英文 8 节模板**（`summarizer.ts` 常量 `COMPACTION_INSTRUCTION`），**不可配置**；换中文/自定义模板 = 子类化 `BasicCompactionEngine` 覆写唯一钩子 `summarize()`（属仓库包或用户预设行替换，非宿主动态插件能改）。
  - 区域选择镜像算法：尾部按保留 token 回溯 + `toolPairingBalancedBefore/After`（公开导出于 `@deepseek-ai/dsh-compaction`）。
- **跨域取会话引擎**：宿主平面经 `agentPresets.serviceFor(agent,'compaction')`（`packages/preset/agent-presets/src/mount.ts` serviceForAgent）可拿到 isolate 域内的会话引擎实例——官方设计给"持 agent 的外部调用者"（浏览器 RPC 同款通道）；对未挂引擎的预设（minimal）返回 undefined，须降级。
- **计量**：`ctx.tokenMeter.measure(session)` → `{totalTokens, nodes:[{seq,tokens}]}`；node 是逐消息定价，适合做"对话内容"口径的求和；`requestHeader()/requestContext()` 提供路由与上下文窗。
- **预算口径（用户定义）**：只数对话本体 = checkpoint 总结 + 未总结历史；**排除系统提示词与动态注入 plugin 消息**（time-context 读数、提醒等）。实现 = 按 node source 过滤：`user/model/tool` 或 `isCompactCheckpointSource` 才计权；`budgetScope:'envelope'` 可回退全信封。
- **step 内注入范式**：`agent/pre-step`(waterfall) 里 `await next()` 后把 `createUserMessage({source:{kind:'plugin',...form:'notice'}})` 追加进 `decision.messages` → 以 user/message 进日志（模型可见⟺可重放）。频率/去重用 `sessionProjections.register({key,stateSchema(zod),init,apply})`（time-context/tmux-context 样板）。注意 settings 的 schema 是 schemastery、projection 的 schema 是 **zod**，别搞混。
- **定稿信号（方案定稿）**：plan 模式提交方案经用户批准退出时会落 `plan/mode active:false`（前有 active:true）——产品级"获批定稿"事件；自由讨论定稿无事件，只能靠常驻提示词让 agent 自判（本插件 `systemPrompt.context` 全局注入策略文案，name `conversation-summary:policy`）。
- **GUI 位**：`settings.section`(list, root, 加性) 注册新 id 即得到完整设置页；`settings.general.item` 只适合单行偏好。Client 半契约 = `window.__ModuleLoader__.load({id, factory(require)})`（require 只有 'react'），`ctx.get('slots')` + `slots.inject/register`，样式用 `<style>` 注入；package.json 需 `exports['./client']` + `dsh.client.platform:'web'`，缺 `lib/client.js` 会让 web 启动 FAILED。
- **Host↔页面通信**：静态用户插件用 `ctx.webServer.register({kind:'exact',path,handler})` JSON 路由（toast 长询同款）；策略文案预览走 POST 渲染，与真实注入共用同一构建函数（单源）。

## 3. 本次纠正/更新的事实（写进研究便于以后不再踩）

- ~~"静态宿主行改完必须重启才生效"~~ → **web profile 是 live**（`patchReload:'live'`，`cordis.patch.yml` watcher 热应用）；新增行/disabled 保存即生效，重启只是客户端产物变更后的确定性验证。
- ~~"组合行=一条插件记录、可统一接管整份补丁清单"~~ → 补丁清单还含**第一方行**（现网已有 `@deepseek-ai/dsh-time-context`）与 **id-target override 元素**；可管理单元收窄为"顶层 `- insert:` 且子条目 `name==@dsh-user/<slug>`"，其余只读保护。
- ~~"install.ps1 的复制到 node_modules + 加行"是唯一安装方式~~ → 只是"命令行前端"；安装语义 = 可解析(包入 profile node_modules) + 组合行(注册)；卸载删共享目录前须跨 profile/home 扫引用。
- 校验手段：不要靠"重启看日志"兜底（冷启动解析失败是硬失败）；用免启动 `dsh web --dump-config` 预校验 + `.bak`/tmp/rename + 自动回滚。

## 4. 待验证假设（装到实机后验证）

- 宿主平面监听 `agent/pre-step`/`agent/turn-stopping` 事件能收到各会话事件（time-context 宿主行用法佐证，未在本插件实测）。
- 工具执行时 `exec.agent` 若只带 `{id}`，用 `ctx.agents.get(id)` 回查完整 agent（已兜底）。
- 常驻策略提示词是否真让模型在自由讨论定稿时自觉 evaluate（文案效果依赖模型遵循度）。

## 5. 关联文件

- 插件：`plugins/conversation-summary/`（README/config 表、docs/design.md v0.1-0.4、lib/index.js host、lib/client.js 设置页、install/install.ps1）。
- 方案评审：`tools/dsh-offline-installer/docs/插件管理-设计.md`（v0.2/v0.3 修订节 + 子代理两轮评审结论）。
- 生命周期/安装模型研究：`research/harness-plugin-dev-findings.md` §1 与文末增补节。

## 6. 装机前代码审查与修复（2026-09-05，子代理评审 → 已修）

结论：**可装机，无高危**；主功能链路(提醒注入/auto/plan 退出检测/projection/context/工具/路由/客户端)全部对照真实实现核对无 API 级误解。已修：

- **M1(中)** `budgetScope:'envelope'` 原实现只算节点和(缺 header 估算)；改为 envelope 用 `measurement.totalTokens`（与内置引擎口径一致），conversation 仍用权重和。
- **M2/L5(中)** GUI 可导出"重启即炸"的非法数值 → 客户端校验(预算>0、保留<预算)、非法时禁用复制并红字提示。
- **M3(中/语义)** `plan/mode active:false` 不区分"批准/驳回/`/plan off`"（事件仅 {active}）→ 文档与实现措辞改为"退出 plan 模式近似"，非"方案获批"。
- **L1** 提醒 source.summary 加 120 字符截断；**L3** 预览请求加过期/卸载护栏；**L4** GUI 补 hintTemplate 编辑框；**L6** 版本号收敛为 PLUGIN_VERSION；**L2** package.json 补运行依赖声明(zod@^4.4.3、dsh-llm/dsh-compaction@0.1.2-alpha.3)。
- **文档纠错**：install.ps1"需重启才生效"在 web profile(live) 上不准确 → README 改为"宿主配置保存即热应用；新装/改宿主代码/客户端界面需重启或刷新做确定性验证"。
- **未修(已记录为限制)**：M4 `mode:auto` 与内置 80% 自动可能同一步双压（预算远低于 80% 窗口时不发生；介意则二选一）。
- 装机前验证清单（评审原表）已留：静态自检→install 幂等→重启后 GET config 200 + 设置页出现 + 工具出现 → 触发冒烟(调小预算/mode auto/plan 退出)。

## 7. 装机实测（2026-09-05，live 热应用 + 真机演示，全部通过）

- 部署：`install\install.ps1` 幂等执行成功（复制到 `~/.dsh/profiles/node_modules/@dsh-user/conversation-summary`，向 `profiles\web\cordis.patch.yml` 追加行）。
- **写盘即热应用，无需重启**：紧接着的会话里常驻策略提示词(`systemPrompt.context`)与超预算提醒(pre-step 注入)都已真实出现在模型上下文 → 验证：patch hot-apply、context 注入、预算计量(对话本体 310k+ 不含系统/注入)、每预算段一次提醒。
- **工具热注册**：`Tool.listTools` 可见 `compact_conversation`；下一个请求步即进模型可调用集合。
- **estimate**：对话内容 326,809 / 预算 200,000（超 ~127k）；信封 395,970（>对话内容，验证 M1 envelope 修复——差额=系统/工具/注入）；可压 ~296,653（375 节点），压缩后留最近 ~30k/82 条。
- **auto**：`已压缩早期内容约 314,448 tokens（375 条表面节点被遮蔽），checkpoint 已写入会话`——压缩事务/遮蔽/写入链路实测成功。压缩后提醒预算段应重置（下一次超预算才提醒）。
- 遗留验证项：设置页「会话压缩」GUI 目视（客户端 Slot 热载需刷新/重启才见）；重启后 host 行为保持（live 与冷启动一致）。

## 8. 设计重构 v0.5：压缩场景 × 授权模式（2026-09-05，评审意见落地）

用户澄清（含 GUI 实机看到提示词后）：**判断权归插件/配置，agent 不自判授权**；`milestoneAuto` 不应是独立授权轴。新模型两轴正交：

- **场景**（何时考虑压）：① 超预算（恒在，插件估算判定）；② plan 模式退出（`planExit`，默认关，`plan/mode true→false`，**未超预算也压**）；③ 自由讨论定稿（`freeform`，默认关，非 plan 且未超预算；无事件，时机由 agent 按对话认定，只报时点不判授权）。
- **授权 mode**（统一作用于全部场景）：`hint`=场景出现先询问用户（插件注入询问提醒，每压缩周期至多一条、互斥不叠加、plan 退出文案优先）；`auto`=插件下个请求步前直接压。
- 实现变化（仓库 `plugins/conversation-summary/`，尚未重部署——运行中实例仍是旧代码，需重跑 install + 重启/刷新才可见）：
  - `resolveConfig`/GUI/YAML：删 `milestoneAuto`，增 `planExit`/`freeform`（默认 false）；占位符 `{milestone}`→`{planExit}`/`{freeform}`；安装行残留 `milestoneAuto` 键会被忽略。
  - `buildPolicyText` 重写为"启用场景列表 + 一句 mode 授权"；提醒文案（hint）改为明确"请询问用户…同意后执行 mode=auto"；新增场景②固定文案 `PLAN_EXIT_HINT`。
  - pre-step：auto 分支压 ①②；hint 分支只注入单条询问提醒（场景②优先、压缩后才重置）；不再有"milestone 绕开 hint 自动压"。
  - `evaluate()` 增 `allowBelowBudget`：场景②/③与 freeform 下未超预算也可出 span（尾部+配对约束不变），工具 estimate/ask/auto 贯通。
- 测试建议（GUI 上线后）：默认配置行为应与 v0.4 一致（仅①、hint）；开 `planExit` 走一次 plan→退出 验证②（未超预算也提醒/自动）；开 `freeform` 在未超预算的收敛对话上验证 ask/auto 可压。

## 9. v0.6 微调（2026-09-05 重启后用户反馈）
- 用户已重启验证 v0.5（本次会话模型上下文里的常驻文案已见新版）。
- 反馈 1：GUI 不应出现方案讨论行话（场景②/③、定稿等）→ GUI/README/install 示例全部改成人话（plan 模式结束 / 自由讨论收尾 / 先问还是直接压）；内部代码注释与 docs/design.md 保留术语作历史。
- 反馈 2：**所有提示词都可编辑**（留空=默认）：`policyText`（常驻，已有）、`hintTemplate`（超预算提醒，已有）、新增 `planExitHint`（plan 结束提醒，默认 `DEFAULT_PLAN_EXIT_HINT`）；`hintTemplate`/`planExitHint` 缺省或空串均回退默认；GET /config 返回默认全文供 GUI 预填。
- 状态：代码已改（仓库），**尚未重部署**——需 install.ps1 + 重启 dsh web + 刷新页面后 GUI 可见新文案与 planExitHint 编辑框。

## 10. v0.7 重构：3 时机 × 2 模式 = 6 条文案（2026-09-05 用户反馈）
- 反馈：超预算的"询问"与"直接压"应是不同文案；需要 6 条（3 时机 × 2 模式）。用户拍板 auto 语义 = **插件到点自动压，auto 文案只作说明写进常驻策略，不重复注入**；hint 的①②到点把 ask 文案注入让 agent 询问（前加实时用量行 `composeAskMessage`）；③（自由讨论收尾）两条仅作 agent 策略指引。
- 落地：六键 `askOverBudget/autoOverBudget/askPlanExit/autoPlanExit/askFreeform/autoFreeform`（缺省/空串=各自默认）；常驻策略=介绍+按当前 mode 取 3 条（按开关启用，超预算恒在）；`policyText` 非空整段覆盖。
- GUI：按触发时机分组（每时机一张卡：开关 + 先询问/直接压两条文案放一起）；YAML 只导出改动过的文案；`hintTemplate`/`planExitHint` 键废弃（README/example 同步）。
- 状态：仓库已改+语法通过；**未部署**（需 install + 重启 + 刷新）。

## 11. v0.8 收敛为 4 条文案（2026-09-05 用户二次澄清）
- 用户认识确认：auto ①② = **插件直接调压缩引擎**（不经过 AI），引擎自行产出 checkpoint 文案（结果摘要，非决策话术）→ auto①② **不需要** AI 话术。
- 用户确认（选项"收敛为 4 条"）：可编辑文案 = `askOverBudget`/`askPlanExit`（hint ①② 注入询问）+ `askFreeform`/`autoFreeform`（③ 收尾指引）；`autoOverBudget`/`autoPlanExit` 删除。
- 策略拼装：hint=ask①②(+③)；auto=①② 固定一句"插件直接压"说明 + ③ autoFreeform。GUI：超预算/plan 卡只留"先询问"文案并注明 auto 由引擎处理；freeform 卡两条。
- 状态：仓库已改+语法通过（host/client `node --check` OK）；**未部署**。另注：本轮实测 hint 到点注入正常（本会话 200,107/200,000 触发一次 askOverBudget 注入）。

## 12. v0.8.1 提醒被忽略 → 默认文案改命令式（2026-09-05 晚，用户实测反馈）
- 反馈来源：另一会话实测，agent 把压缩提醒当普通系统注入滑过；其复述形态 = 常驻策略（出现在消息边界、与"时间采样"运行时块同区，恒定文本）。
- 事实核对：到点提醒实现为 pre-step 链 `await next()` **之后** append → 已是当次请求消息列表最末一条（无更靠尾可移）；被习惯性无视的更可能是每次请求恒在的常驻策略文本。
- 用户拍板（多选留空+自定义）：① 不加固定决策壳，直接把默认文案改成**提示/命令式**（可编辑优先）；② 注入位置维持"上下文最末"。
- 落地：四条默认文案（askOverBudget/askPlanExit/askFreeform/autoFreeform）改为【标签】+ 编号步骤（转述问题 → 等答复 → 同意执行/拒绝跳过）+ "实时提醒非系统说明、勿自行决定"；运行时前缀（实时用量行）保留以便与常驻文本区分。
- 状态：仓库已改+语法通过；**未部署**。后续候选（未做）：同轮升级重提、仅回应用户首步注入。

## 13. 多引擎 director spike：共享镜像事故与整改（2026-09-06）
- 背景：director（`plugins/compaction-director`）想"免新预设"接入，采用了**别名占位官方包名**（把 `@deepseek-ai/dsh-compaction-basic` 换实体目录 + 官方改名 `-official`）。
- 事故根因：`profiles/node_modules/@deepseek-ai` 是 boot **自愈共享镜像**（`healProfilesModuleFallback` 把闭包内包重建为 junction / `dsh.moduleFallback` proxy）；实体目录（非 junction 无标记）→ fail-loud → 结构门与 `dsh web` 启动双炸（同根因两入口）。
- 修复（用户侧已验证）：备份到 `C:\Users\kelei\.dsh\_spike_backup_20260906\` → 删共享镜像实体占位 → boot 自愈重建 junction → web/结构门恢复正常；会话压缩回到官方 basic。
- 整改：director **只以 `@dsh-user` 命名空间随 preset 引擎行挂载**；官方引擎按原名 `import('@deepseek-ai/dsh-compaction-basic')`（解析到 junction，无需改名副本）；回滚=删占位重启让 boot 重建；"不写共享镜像"写入 multi-engine-design §7/§10/§11 与 director README。install.ps1 本身干净（只写 `@dsh-user`）。
- 多引擎落地约束收窄：无新预设/无镜像写入的"全局免新预设"路线不可行；引擎选择仍按 preset（director-test 副本）隔离验证，或后续受管安装实测。
