# conversation-summary（会话总结/压缩插件）v0

宿主平面静态插件：把**"什么时候该压缩"**与**"先问还是直接压"**解耦成两个可配置维度。需要压缩的时刻有三种——**对话超过预算 / plan 模式结束 / 自由讨论收尾**；处理方式由 `mode` 统一决定——`hint`=先询问你、同意才压，`auto`=直接压。提供询问提醒、步内自动压缩、`compact_conversation` 工具与常驻策略提示词；全部特性可配置。**该不该压、要不要问由插件（配置）决定，agent 不自判授权**——仅"自由讨论收尾"这个时刻没有事件，由 agent 看对话判断后按设定行动。

压缩本体**委托给会话自带的 compaction 引擎**（持久 checkpoint、遮蔽旧历史、保留尾部、并发锁、可重放全部是原生机制）。v0 的 checkpoint 产出仍用引擎内置英文模板（模板定制留给后续子类化引擎版本）。

## 预算口径

预算默认只统计**对话本体内容**（`budgetScope: conversation`）：
- 计数对象 = **各 checkpoint 总结 + 尚未总结的历史内容**（用户/助手消息、工具往返、压缩生成的 `<compacted-summary>` checkpoint）；
- **不计入**：系统提示词、工具定义、动态注入的 plugin 消息（time-context 读数、本插件提醒等），避免"提醒自身撑大预算"；
- 计量源为 `tokenMeter.measure()` 逐节点估算，仅累计对话来源节点。
- `budgetScope: envelope` 可切回完整请求信封计量。

## 功能（每项都可配置开关）

**模型：压缩 = 触发时机 × 处理方式。** 触发时机（什么时候该考虑压）与处理方式（`mode`：先问还是直接压）正交；授权由配置决定，agent 不自判。**只有 agent 参与的时机才有文案**：`auto` 下 ①② 由插件直接调用压缩引擎、引擎自行产出 checkpoint，AI 侧不需要话术。

1. **对话超过预算**（恒在）：每步请求前计量，对话内容 ≥ `absoluteBudgetTokens` 即符合条件。
2. **plan 模式结束**（`planExit: true`，默认关）：退出 plan 模式（v0 事件只记 `active`，批准/驳回/`/plan off` 同落 `active:false`）即符合条件；**没到预算也会压**。
3. **自由讨论收尾**（`freeform: true`，默认关）：没用 plan 模式、对话量也没到预算时，方向/调研/讨论收敛、即将给出可实施方案视为收尾。**无产品事件**：这个时刻由 agent 看对话判断（只认时刻、不判授权），需要时经工具执行；没到预算也能压。
4. **处理方式 `mode`**（默认 `hint`）：
   - `hint`（①② 与 ③ 都需 agent 参与）→ 插件到点注入该时机的"先询问"文案，agent 问、**你同意才压**；
   - `auto`（①② 由插件直接压）→ 插件在下一个请求步前**直接调用压缩引擎**，不经过 AI、也不询问；③ 无自动信号，仍由 agent 按"直接压"指引执行。
5. **`compact_conversation` 工具**（`toolEnabled: true`）：`estimate` 只算账 / `auto` 立即压缩 / `ask` 先征求用户；你主动要求总结也经它执行。
6. **可编辑文案（4 条，都是 agent 参与的时机）**：`askOverBudget`、`askPlanExit`（hint 下到点注入）、`askFreeform`、`autoFreeform`（③ 收尾指引，按 mode 各用一条）；缺省/留空=默认。常驻策略默认拼装规则：
   - `hint` → `askOverBudget` +（开 planExit 则）`askPlanExit` +（开 freeform 则）`askFreeform`；
   - `auto` → ① ② 由插件直接压（固定一句话说明，不经 AI）+（开 freeform 则）`autoFreeform`。
   `policyText` 可整段覆盖拼装结果（占位符 `{budget} {retain} {mode} {planExit} {freeform}`，后两个替换为 开启/关闭），`promptOrder` 调位置。

运行时提醒互斥（hint）：同一轮至多提醒一条（plan 结束文案优先于超预算文案），压缩后重置。

## 配置项（cordis.patch.yml 行内 config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `absoluteBudgetTokens` | `200000` | 绝对预算（对话内容 tokens），跨过即触发 |
| `retainTokens` | `30000` | 压缩后保留的最近尾部（对话内容 tokens），须小于预算 |
| `budgetScope` | `'conversation'` | `conversation`=对话本体（checkpoint+未总结内容，不含系统/注入）；`envelope`=完整请求 |
| `mode` | `'hint'` | 授权模式，作用于全部场景：`hint`=先询问用户；`auto`=直接压缩 |
| `hintEnabled` | `true` | "先询问"时是否注入"询问用户"提醒 |
| `askOverBudget` | 中文默认 | 超预算 × hint 文案（到点注入，agent 询问你；留空=默认） |
| `askPlanExit` | 中文默认 | plan 结束 × hint 文案（到点注入，agent 询问你；留空=默认） |
| `askFreeform` | 中文默认 | 自由收尾 × hint 文案（agent 判断收尾后先问你；留空=默认） |
| `autoFreeform` | 中文默认 | 自由收尾 × auto 文案（agent 判断收尾后直接压；留空=默认） |
| `planExit` | `false` | plan 模式结束(批准/驳回/关闭)时也触发 |
| `freeform` | `false` | 自由讨论收尾时也触发（agent 认定时刻） |
| `toolEnabled` | `true` | 注册 `compact_conversation` 工具 |
| `promptEnabled` | `true` | 注入常驻策略提示词 |
| `promptOrder` | `9000` | 策略提示词在 prompt 中的排序值 |
| `policyText` | 由开关自动拼装 | 整段自定义策略文案（`{budget} {retain} {mode} {planExit} {freeform}`）；留空用自动拼装版 |

> 注：`auto` 下的超预算/plan 结束没有文案——插件直接调压缩引擎，checkpoint 由引擎产出，AI 不需要任何话术。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File install\install.ps1
```

脚本用 DSH 官方方式安装本包：`dsh plugin --profile web add <本包路径>`，由它把包链入 profile 并登记为
依赖与 bundle，随后自检宿主半能否导入、浏览器半是否合法。**不再复制文件**，安装后 profile 通过 `link:`
指向本目录，改完源码直接生效。web profile 组合是 **live 热应用**：web 正在运行时保存即生效（宿主半），
无需为宿主逻辑重启；要看到设置页等客户端界面，需**刷新页面**做确定性验证。

本包贡献的配置层在包根的 `cordis.patch.yml`（只有 id 与 name）；profile 自己那份
`$DSH_HOME\profiles\web\cordis.patch.yml` 在同 id 上后应用、会覆盖它，所以预算与触发设置写在那里。

卸载：`dsh plugin --profile web remove @dsh-user/conversation-summary`（或 `install\uninstall.ps1`），
它同时从 profile 的 bundle 列表里摘掉本包；运行中保存即停用（建议刷新确认）。

## GUI（设置页「会话压缩」）

安装（或重启）后，在 Web 界面 设置 → **会话压缩** 打开配置驾驶舱：

- **预算口径与数值**：`absoluteBudgetTokens` / `retainTokens` / `budgetScope`；
- **处理方式与总开关**：`mode`（hint 先询问 ↔ auto 直接压）、`hintEnabled`、`toolEnabled`；
- **按触发时机分组**：每个时机一张卡——超预算/plan 结束卡各一条"先询问"文案（它们的 auto 侧由插件直接压、无文案）；自由讨论收尾卡两条（先询问 / 直接压，两种 mode 都要 agent 参与）。开关（planExit/freeform）与文案放在同一张卡；
- **常驻策略提示词**：`promptEnabled`、`promptOrder`、`policyText`，并**实时预览**当前草稿会注入的文案（与宿主同源渲染，经 `/conversation-summary/policy`）；
- **生效配置片段**：一键复制生成的 `cordis.patch.yml` 行（草稿 → YAML，非法数值会禁用复制），粘贴后宿主配置即热应用。

页面数据只读真源是宿主：GET `/conversation-summary/config`（当前生效配置）；改动仅停留在页面草稿，不会偷偷改运行态。

## 已知限制（v0）

- checkpoint 模板为引擎内置英文 8 节结构，暂不可配置（中文/自定义模板=v1，子类化引擎）。
- 宿主平面插件是**进程级全局**：常驻提示词与工具对所有会话（含子代理会话）可见，无法按单个会话单独开关（按会话配置需要复制预设/改会话级组合，后续版本）。
- 提醒只在"压缩发生"后重置，不记录"用户明确拒绝"（拒绝后同周期不再追问）。
- "自由讨论收尾"这个时刻无可靠事件，只能由 agent 看对话判断（处理方式仍由 `mode` 给定），效果取决于模型遵循度，需要实测校准文案。
- "plan 模式结束"用的是退出 plan 模式的近似信号，非精确"方案获批"；驳回/放弃也会触发。
- 提醒互斥：同一轮内 超预算/plan 结束 至多提醒一条（plan 结束文案优先）；一次压缩后整体重置。
- `mode: auto` 与内置引擎的 80% 阈值自动压缩并存时，理论上可能在同一请求步先后各压一次（两个 checkpoint）；预算明显低于 80%×上下文窗时不发生。介意可二选一（关引擎 auto 或本插件用 `hint`）。
- 运行依赖：需 profile 环境已具备 `zod`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-compaction`（install.ps1 只部署本包、不安装依赖）。
- 提醒、estimate 均不含系统提示/注入的成本，实际省钱要叠加 `envelope` 一起看。
