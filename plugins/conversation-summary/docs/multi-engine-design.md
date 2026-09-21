# 多压缩引擎 · 引擎总机（Engine Director）设计方案 v2.1

配套：`plugins/conversation-summary`（策略层，我们已有）↔ `plugins/dsh-compaction-instant`（第三方即时引擎，已克隆参考，MIT v0.1.4）；`plugins/compaction-director`（总机实现）。
状态：设计稿，待 P0 spike 验证。v2.1 = 子代理评审修正 + 2026-09-06 共享镜像事故后的硬约束（见 §7/§10）。

## 0. 决策记录（已定）

1. **auto 所有权默认归策略层**（`autoOwnership: 'policy'`）：引擎自带 auto 一律关掉，何时压缩由 conversation-summary 决定（hint 先问 / auto 直接压 / plan 退出 / freeform）。
2. **楼层语义 = 默认选区 + 用户显式覆盖**：默认只归档"最后一个 checkpoint 之后"的新内容（不重压旧楼层，没必要而非禁止）；用户显式指定范围（含合并历史楼层）时允许，`compact_conversation` 提供可选起点参数。
3. **引擎按会话分发，目标支持会话内热换**：同一对话中途可切引擎、甚至按楼层混用（用户：当前对话用官方 basic，另一助手会话用 instant）。
4. **选型：方案 A「引擎总机」**（零产品代码改动）；**弃用方案 B**（改底层放开 preset 锁）与**方案 C「别名顶替官方包名」**（手工写共享镜像会炸 boot，见 §7 事故记录；受管安装是否可行需另实测，不作为默认路线）。

## 1. 目标与背景

- 官方 basic（LLM 摘要）与 instant（VCC 编译、免 LLM、近无损、毫秒级）是两种压缩引擎，挂在**会话 preset 的压缩组（isolate realm）**上，实现同一 `ctx.compaction` 契约。
- 产品约束（已从源码核实）：`agent-presets.swap()` 对已跑过回合的会话抛 `agent-preset/locked`——**preset 选择**会话开局定终身。但锁的是"组合期选 preset"，不是"每次压缩时选引擎实现"。
- 因此要同一对话中途换引擎，不能靠换 preset，而应把"选哪个引擎"从**组合期**挪到**每次压缩调用期**：用一个常驻的「引擎总机」占据 `ctx.compaction` 座位，内部持有多个子引擎，按会话分发。

## 2. 分层架构

```
host / web profile
  conversation-summary（策略层，现有）
    ├─ 触发决策：超预算/plan 退出/freeform；hint 先问 / auto 直接压
    ├─ 计量：tokenMeter（会话口径），与引擎无关
    ├─ 会话→引擎选择表 + GUI「压缩引擎」卡（当前引擎显示 / 默认引擎 / 本会话覆盖）
    └─ 楼层默认选区（frontier）+ 显式范围覆盖 + 引擎盖印

preset 压缩组（每 preset 一个 standing isolate realm，实例跨该 preset 的会话共享；seat = ctx.compaction）
  compaction-director（引擎总机，常驻座位，唯一 ctx.compaction 实现）
    ├─ 子作用域 childA：官方 basic 子引擎实例（auto:false）
    ├─ 子作用域 childB：instant 子引擎实例（auto:false）
    └─ 每次压缩调用：resolveEngine(sessionId) → 委托给选中的子引擎
       子引擎直接发 compaction/* 事件、走同一会话日志与持久化

找回层（可选旁挂）
  recall / search 工具 + /recall 命令（instant 配套，只读日志）
```

- 策略层**不直接认识**任何具体引擎；它永远只调"座位上的引擎"——接入总机后座位就是总机，触发代码零改动。
- 总机必须与 `toolResultPruner` 同 realm（引擎组的既有 isolate 约束原样保留）。
- **realm 语义修正**（评审）：standing isolate 是**每 preset 一个**、该 preset 的会话共享同一实例（现官方 basic 亦如此），不是每会话一个。会话差异一律靠内部 `sessionId` 键（含派发表），director 是共享单例按 sessionId 分发。

## 3. 组件设计

### 3.1 compaction-director（新引擎插件，坐 seat）

- 形态（唯一合法）：`CompactionEngine` 子类，包名 **`@dsh-user/compaction-director`**（本人命名空间，随 preset 压缩组引擎行挂载）；仓库目录 `plugins/compaction-director`。官方引擎由其代码按原名 `import('@deepseek-ai/dsh-compaction-basic')` 导入（解析到共享镜像 junction），**不得**手工写 `@deepseek-ai` 共享镜像、不得做改名副本。
- 子引擎挂载：director 的 ctx 里，为每个引擎**单独建一个子作用域 ctx**，在其中实例化子引擎（`auto: false`），避免两个引擎在同一个 ctx 里注册同名 `compaction` 服务冲突。director 持有实例引用。
- 派发：实现引擎对外方法面（见 P0-b），每次调用按 `sessionId` 查选择表 → 委托给对应子引擎 → 原样返回其结果/抛错。
- **关闭子引擎自触发**：两个子引擎实例 `auto:false`（避免与策略层双压、避免自选区重压旧 checkpoint）。
- **压力/溢出兜底（评审必须项）**：原引擎 auto 自注册的两条兜底——pre-step 压力压缩与 `agent/request-error` 上下文溢出强制恢复（`compactIfNeeded`）——在 auto:false 后出现空窗。director 需注册等价监听并**委托当前会话选中的子引擎**执行，否则属功能回归。同时护栏：策略层场景压缩与 director 压力压缩同处 pre-step，二者以"压缩后重新计量再判断"避免同轮双压（P0-i 实测定序）。
- **settings 复活防护（评审必须项）**：instant 自带 settings 命名空间，其 user 层默认能把 `auto` 翻回 true 而重新武装子引擎。director 构造子引擎时钉死 `auto:false`，并禁用/隔离其 settings 段（或提供不含 settings 的构造路径），防双压。
- 事件与持久化：委托后由子引擎照常产出 `compaction/summary|end|prune`（`commit/persistence` 是错误码非事件，见 P0-b）写入会话日志（评审确认"事件直发、无需 director 转发"成立）。
- 身份暴露：director 提供只读 `getEngineInfo(sessionId) → { engineId, provider, model }`，供策略层 GUI/盖印使用。

### 3.2 会话→引擎选择表

来源优先级（高→低）：

1. **本会话显式覆盖**（GUI 里给某会话指定 basic/instant）；
2. **preset 压缩组行配置** `config.defaultEngine`（preset 作者可为该预设定默认）；
3. **全局默认** `config.defaultEngine`（director 或 conversation-summary 行，默认 `basic`）。

存储选择（评审已定）：**settings 命名空间按 sessionId 键**（支持运行时 GUI 读写、文件热发布；sessionProjection 是纯只读派生 fold，不可作写通道）。需为 GUI 新增宿主写通道 + 表状 schema（现 conversation-summary 只有复制 YAML 的读通道）。

每次压缩**实时查表、不缓存** → 改表后下一次压缩即生效（同会话热换的语义来源）。

### 3.3 conversation-summary 增强（策略层，小改）

- GUI 引擎卡：当前引擎显示（调 director.getEngineInfo）、默认引擎下拉、本会话覆盖下拉；切完即时生效提示；instant 档案说明 + recall 工具指引 + patch 片段。
- estimate/evaluate/预算/提醒逻辑全部不变（tokenMeter 口径与引擎无关）。
- 楼层默认选区：**这是策略层新逻辑，不是引擎默认行为**——两引擎的 `selectCompactableRange` 默认都从表面开头（`surface[0]`，含旧 checkpoint）选起；frontier 起点（"最后一个 checkpoint 之后"）由 conversation-summary 的 `compactableSpan` 实现（现亦从 surface[0] 起，需改成 checkpoint 感知起点）。显式传 `(start,end)` 时引擎照做。
- 引擎盖印：压缩归档时记录 checkpoint → {引擎档案, provider/model, 起始楼层}（compaction/summary 优先，回退 director 身份）。

### 3.4 GUI（设置 → 会话压缩，新增/扩展）

- 「压缩引擎」卡（预算卡上方）：当前引擎 / 默认引擎 / 本会话覆盖 / 双 auto 警告（若探测到任何引擎行 auto 开着）/ 档案指引。
- 文案与既有卡保持"人话、无行话"；引擎档案表集中在插件内置表 + README。

## 4. 部署与接入步骤

1. 安装引擎包：instant（受管安装或复制到本人命名空间做测试）与 recall 工具（可选）。
2. 把目标 preset 压缩组引擎行换成 director 行（`name: '@dsh-user/compaction-director'`），保留 `toolResultPruner` 同行、保留 isolate。
3. director/策略行配置 `defaultEngine`；GUI 设置会话覆盖。
4. **重启一次 dsh web**（待实测，见 P0-h）：现有会话恢复时是否按新行重挂 director 未获直接证据（standing 世代机制主要服务后续会话）；若证实不重挂，现有会话需新开或进一步验证。
5. 验证：切换 basic ↔ instant，下一轮压缩产物随引擎变化；旧 checkpoint 原样；recall 可用。

## 5. 关键不变量与冲突规避

- **一个 seat**：realm 里 `ctx.compaction` 只有 director 一个实现（满足"每上下文一个实现"）。
- **无双重自动压**：子引擎 auto:false（且防 settings 复活）+ 引擎行 native auto 关闭 + director 的压力/溢出兜底只按压缩后重新计量判断 + 策略层场景压缩独占触发语义（`autoOwnership: policy`）。
- **压力/溢出无空窗**：原引擎 auto 自带的 pre-step 压力与 `agent/request-error` 溢出恢复由 director 等价补上并委托子引擎（见 §3.1）。
- **楼层不重压（默认）**：由策略层 frontier 起点保证（引擎默认选区含旧 checkpoint，见 §3.3）；显式范围覆盖始终可用。
- **切换安全**：子引擎均为 drop-in 契约（同一事件/日志/持久化/计量），历史 checkpoint 两种引擎都按普通节点处理；盖印保证楼层归属可追溯、免迁移。
- **不改产品包**：无 packages/ 改动；安装走 profile 插件层。

## 6. P0 可行性 spike（代码先行，后实跑）

| # | 验证项 | 方法 | 通过标准 |
|---|---|---|---|
| a | 子作用域构造两个引擎实例 | 读 cordis ctx API（scope/isolate）与两引擎 ctor；写最小挂载探针 | 同一 realm 下两引擎各持子 ctx、无服务名冲突、依赖可达 |
| b | director 需实现的对外方法面 | 读 dsh-compaction 的 Service/Engine 契约（abstract = compactIfNeeded/compactNow/compactRegion）与 `/compact` 消费点；并核对 **/compact、策略层、溢出恢复三个入口都走 seat**（无旁路直连旧引擎） | 方法清单齐全；无旁路 |
| c | auto 关闭路径 | 两引擎 Config 校验（不显式传则默认 true） | `auto:false` 均被接受且不注册 pre-step/request-error 监听 |
| d | 会话覆盖存储选型 | settings 命名空间按 sessionId 键 + 宿主写通道/表状 schema | 可 GUI 读写、文件热发布、不破坏回放 |
| e | frontier 起点受尊重 | instant 已可读（region.js selectCompactableRange 默认 surface[0]）；basic 读 region.ts（同）——两者默认**都含旧 checkpoint**，frontier 是策略层新起点 | 显式传 `start=frontier` 时两引擎照做、不改动其前节点（勿写"引擎默认一致"） |
| f | 热换语义 | director 每次实时查表 + 实测 GUI 切换后下一压缩生效 | 切换无需重启 |
| g | 事件/持久化由子引擎直发 | 构造探针跑一次压缩 | compaction/start\|summary\|end\|prune 落日志、UI 检查点行正常 |
| h | 现有会话重启后是否重挂 director | 改 preset 行后重启 dsh web，观察本文档所在会话等既有会话座位 | 明确"重挂 / 不重挂"，据此定接入说明 |
| i | 双压与复活护栏 | 策略层场景压缩 vs director 压力压缩同轮 pre-step 定序；instant settings 段能否把 auto 翻回 true | 同轮不双压；子引擎 auto 永不复活 |

## 7. 风险与边界

- **子引擎在"别人的 realm"里构造**是核心不确定点：引擎虽按 ctx+session 工作，但隔离/注入假设需 spike 实锤（P0-a/b/g）；若构造不可行，回退为"总机在 host 层自建子 ctx"（另一个 spike 分支）。
- `/compact` 命令、pruner、溢出恢复等原生入口若绕开 director 直连旧引擎，会造成分流——需确保消费方都走 seat（P0-b 覆盖）。
- instant 为第三方 MIT 包：固定版本 + 锁 SHA 记录，启用前代码走读。
- **共享镜像事故（2026-09-06，硬约束）**：`profiles/node_modules/@deepseek-ai` 是 boot **自愈镜像**（每次 profile 装配把闭包内包恢复为 junction / `dsh.moduleFallback` proxy；遇到实体目录会 fail-loud，`dsh web` 无法启动）。因此 director 只能以 `@dsh-user` 命名空间随 preset 行挂载；"别名占位官方名/改名副本/手工回填"全部禁止。若将来真要"顶替官方名"，走受管安装（`dsh plugin`）并先实测与自愈的兼容性。
- 会话覆盖表增长与多开会话的 UX：按会话粒度管理可能产生"一堆会话各设各的"——GUI 提供"恢复默认"一键。

## 8. 验收清单（草案）

1. basic + policy：行为与现状完全一致（回归，含提醒命令式文案 v0.8.1）。
2. 同会话 GUI 从 basic 切 instant：下一次压缩产物变为编译存档；旧 checkpoint 原样；estimate 数字口径不变。
3. 会话 A=basic、会话 B=instant、其余=默认：分发正确。
4. 楼层默认选区生效：策略层 frontier 起点下同引擎连续压缩不重压旧楼层；显式范围（合并历史楼层）可用。
5. 双 auto 警告、档案指引、盖印可查。
6. 溢出恢复回归：人为构造 `agent/request-error` 上下文超限，director 按当前会话引擎恢复压缩（P0-i 后）。
7. settings 复活护栏：即使 instant user 层曾存 auto:true，子引擎实例不复活（无双压）。

## 9. 后续里程碑（v2+）

- 会话内"按楼层混合引擎"的完整楼层剧本（盖印 + 表按楼层覆盖）。
- 产品级能力诉求（若总机被证伪或想原生支持）：向 harness 提议"per-agent 服务挂载覆盖" seam（方案 B 的轻量版）。
- 与离线安装器 backlog（插件托管）对齐：director/instant/recall 作为受管单元安装。

## 10. 评审记录（子代理 · 2026-09-06）

对照真实源码核验后的结论与修正（均已并入上文）：

- **主干可行**：组合期 preset 锁定与调用期按 sessionId 派发不冲突；isolate + 行 name 解析 + "同 realm 只一个 compaction provider"使 director 坐 seat 成立；`ctx.isolate`/`ctx.extend` 子上下文可隔离双引擎同名服务注册；manual new 子引擎 + `auto:false` 可行（不显式传则默认 true）。
- **已修正**：
  1. realm 是**每 preset 一个 standing isolate、会话共享实例**（非每会话），会话差异走内部 sessionId；
  2. 两引擎默认选区都从 surface[0] 含旧 checkpoint → **frontier 是策略层新起点**（compactableSpan 需 checkpoint 感知），P0-e 标准改为"显式 start 受尊重"；
  3. auto:false 后 **pre-step 压力与 `agent/request-error` 溢出恢复出现空窗** → director 补等价监听并委托子引擎（P0-i 定序防双压）；
  4. instant settings user 层能把 auto 翻回 true → **复活护栏**（钉死 base auto:false / 禁用其 settings 段）；
  5. 会话覆盖存 settings 按 sessionId，需**新增宿主写通道 + 表状 schema**（projection 只读不可作写通道）。
- **待 P0 实锤**：h（现有会话重启后是否重挂 director）、a/g（子 ctx 构造与事件直发探针）、i（双压定序/settings 复活）、b（三入口无旁路）。
- **可行性总评**：director 坐 seat + 子 ctx 隔离双引擎 + 调用期查表，与 Cordis/compaction 结构兼容、基本可行；补齐上述修正后 P0 spike 值得投入。

## 11. 共享镜像事故记录与整改（2026-09-06）

- **事故**：director spike 按"形态 2 别名占位"手工把实体目录写进 `profiles/node_modules/@deepseek-ai/dsh-compaction-basic`、并把官方复制为 `-basic-official`。随后任何 profile 装配（结构门 / `dsh web` 启动）在 `healProfilesModuleFallback` 撞上"非 junction 且无 `dsh.moduleFallback` 标记的实体占用"→ fail-loud 抛错，web 无法启动。
- **修复**（用户侧完成，已验证）：备份两目录到 `C:\Users\kelei\.dsh\_spike_backup_20260906\` → 删除共享镜像里的实体占位 → boot 自愈把 `dsh-compaction-basic` 重建为 junction（指向 `apps/cli/node_modules/...`）；`dsh web` 正常、结构门 exit 0、无 `-official` 残留。会话压缩回到官方 basic，行为与改动前一致。
- **整改（已并入上文）**：director 只以 `@dsh-user/compaction-director` 随 preset 行挂载；官方引擎按原名导入（解析到 junction，无需改名副本）；回滚=删占位让 boot 重建 junction，禁止手动 rename/复制回填；conversation-summary 的 install.ps1 只写 `@dsh-user`，无需改动；若收编 director 进 conversation-summary 仓库分发，"只经 preset 引擎行 + 本人命名空间、不写共享镜像"作为验收约束。
