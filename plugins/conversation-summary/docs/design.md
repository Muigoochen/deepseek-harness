# conversation-summary v0 设计记录

## 目标
- 现状: 压缩由内置 compaction 引擎触发, 固定在"估算 token ≥ 路由模型上下文窗口 80%"才自动压缩(对大窗口太晚、太费), agent 无主动压缩手段, checkpoint 模板固定英文。
- 本插件: 让"什么时候压、要不要压、压多少"更灵活, 并给 agent 主动调用能力。

## 预算口径(用户定义, v0.2 起)
预算只数**对话本体**: 没有压缩时=从头到最近的对话; 有压缩时=各 checkpoint 总结 + 未压缩内容。
**不含**系统提示词与动态注入提示词(time-context/本插件提醒等 plugin 来源 user 消息)。
- 实现: `tokenMeter.measure(session).nodes` 逐节点求和, 仅取 source 属 user/model/tool 或 compaction checkpoint(`isCompactCheckpointSource`, marker plugin='compact') 的节点;
- `budgetScope: envelope` 可切回完整信封计量。
- 尾部保留 `retainTokens` 用同一权重口径, 保证预算与压缩范围一致。

## 压缩执行(委托原生引擎)
- 宿主平面经 `agentPresets.serviceFor(agent, 'compaction')` 取会话引擎(官方 agent 键控读通道, 可穿透 isolate 域);
- 调 `engine.compactRegion(start, end, agent, signal)`(开 turn 内, current-turn 语义, 与内置自动一致);
- 区域选择镜像内置 selectCompactableRange(尾部回溯 + `toolPairingBalancedBefore` 平衡边)。

## "定稿"定义与信号(用户澄清, v0.2 起)
定稿 ≠ 一轮无待办工具调用; 定稿 = 经过多轮方向/调研/细节讨论后, **确定了可实施的技术方案/计划**那一刻。
- 自动信号(仅覆盖走 plan 模式的流程): `plan/mode active:true → false`(提交的方案被批准并退出 plan 模式)之后首个超预算请求步自动压缩 — 折掉设计讨论, 保留含已批准方案的尾部;
- 非 plan 模式的自由讨论定稿: 无可靠事件, 由 agent 在给出可实施方案时调用 `compact_conversation(mode=auto/ask)`(或用户直接要求)。
- `milestoneAuto=true` 才启用 plan-exit 自动压缩(默认关); `mode=auto` 独立提供"跨预算即压"。

## 三件事的区分(避免概念混淆)
1. 超预算提醒(①): 注入给主 agent 的"要不要压"提示 — 文案可配置, 与模板无关。
2. 压缩执行说明/模板(②): 压缩那次 LLM 调用如何产出 checkpoint — v0 用引擎内置英文模板; 中文/自定义模板=v1(子类化 BasicCompactionEngine 覆写 summarize() 并换用户预设行)。
3. checkpoint 产物(③): 合成 user 消息 `<compacted-summary>…</compacted-summary>`, 遮蔽旧历史, 给未来模型续上下文。

## 安全性与降级
- 引擎不可用(预设未挂 compaction, 如 minimal): 全部静默降级/返回"引擎不可用"。
- 压缩事务锁/配对/遮蔽由引擎校验; 计量/引擎异常在监听器内捕获记 warn, 不打断 turn。
- 提醒自身不计入预算(plugin 来源被排除), 不会自我放大。

## v0 已知限制
- checkpoint 模板引擎内置英文(定制=v1)。
- 提醒不记录"用户拒绝", 只按"是否发生过压缩"重置。
- 工具全局可见(含子代理会话)。
- plan-flag 检测扫描日志(每次 pre-step O(events)), 量大时可换 projection 折叠优化。

## v0.3 增补: 常驻策略提示词(自由讨论定稿 + 授权口径)
用户澄清(3):
- 大部分场景是**自由讨论**(不走 plan 模式), "定稿"无可靠日志事件 → 由**常驻提示词**约定: agent 判断方向/调研/讨论已收敛、给出可实施方案那一刻, 主动 evaluate 并决定压缩(ask/auto)。
- **自动压缩 = 授权 agent 不再询问**: 授权口径本身是一段提示词, 由 mode 决定:
  - `mode:auto` → 文案"已授权: 跨预算可直接 auto, 无需询问";
  - `mode:hint` → 文案"未自动授权: 需用户拍板先 ask/询问, 同意后再 auto"。
- 注入方式: `systemPrompt.context({name:'conversation-summary:policy', order: promptOrder(默认9000), text})`, 进程级常驻(所有会话/请求可见)。
- 文案构建: 默认按开关自动拼装(buildPolicyText); `policyText` 整段覆盖(占位符 {budget}/{retain}/{mode}/{milestone}); `promptEnabled:false` 关闭。
- 全部功能已做成可配置项(见 README 配置表), 具体数值与默认文案后续与用户讨论校准。

## v0.4 增补: GUI 设置页「会话压缩」
- 用途: 让用户直接看到整组配置能力并试调, 判断是否所需(不需改代码)。
- 形态: Client 半(toast 同款 __ModuleLoader__ 闭包工厂)注册 `settings.section` id=conversation-summary; 页面含预算/触发/授权/常驻提示词各卡片 + 策略文案实时预览 + YAML 导出复制。
- Host 半新增两条 JSON 路由:
  - GET  `/conversation-summary/config` → 当前生效配置(只读真源);
  - POST `/conversation-summary/policy` → 把草稿渲染成策略文案(与真实注入共用 buildPolicyText/renderPolicyPlaceholders, 单一文案源)。
- 页面改动是草稿: 只产出可粘贴的 cordis.patch.yml 片段, 不写运行态(宿主行配置只读于装载)。
- package.json 增加 exports './client' 与 dsh.client.platform=web(web 客户端模块扫描所需); install.ps1 校验两份产物。

## v0.5 重构(评审后, 取代 v0.3 的授权口径与 milestoneAuto 语义)
用户澄清: 压缩 = **压缩场景 × 授权模式**两个正交轴, 判断权归插件/配置, agent 不自判授权。

- **场景**(什么时候该考虑压): ① 超预算(恒在, 插件每步估算判定); ② plan 模式退出(`planExit`, 默认关, 插件按 `plan/mode true→false` 事件判定, **未超预算也压**); ③ 自由讨论定稿(`freeform`, 默认关, 非 plan 且未超预算, 无事件, 时机由 agent 按对话认定, 只报时点不判授权)。
- **授权 mode**(统一作用于全部场景): `hint`=场景出现先询问用户(插件注入一条询问提醒, 每压缩周期至多一条、互斥不叠加, plan 退出文案优先), 同意才压; `auto`=场景出现插件在下一请求步前直接压。
- **`milestoneAuto` 删除**, plan-exit 不再是独立自动授权轴; 已安装 patch 行里残留的 `milestoneAuto` 键被忽略(可清理)。
- **未超预算也能压**: `evaluate()` 新增 `allowBelowBudget`, 场景②/③与 freeform 下的工具流程贯通; 尾部保留与工具配对平衡约束不变。
- 配置键变更: `milestoneAuto` → `planExit`/`freeform`; 占位符 `{milestone}` → `{planExit}`/`{freeform}`; `buildPolicyText` 重写为"场景列表 + 一句 mode 授权"。
- 以上 v0.2/v0.3 各节中"agent 判断授权/定稿后主动决定"的描述以本节为准; 实现同步(见 lib/index.js 与 GUI 触发场景卡)。

## v0.6 微调(GUI 行话清除 + 所有提示词可编辑)
- GUI 文案去除设计讨论行话(场景①②③/定稿等), 换成人话: plan 模式结束 / 自由讨论收尾 / 先问还是直接压; 卡片标题、行文案、README 同步(内部代码注释与本文档保留术语作历史)。
- **注入的提示词全部可编辑**(留空 = 默认文案): 常驻策略提示词 `policyText`(已有)、超预算提醒 `hintTemplate`(已有)、plan 模式结束提醒 `planExitHint`(新增, 默认 `DEFAULT_PLAN_EXIT_HINT`)。
- `hintTemplate`/`planExitHint` 取值规则统一: 缺省或空串 → 默认常量; GET /config 返回生效默认全文, GUI 文本框预填并随草稿导出 YAML。

## v0.7 重构: 3 触发时机 × 2 处理方式 = 6 条文案(取代 v0.6 的两个模板)
用户澄清: 每个触发时机在"先询问/直接压"下应有各自的文案, 例如超预算的询问与直接压文案不同 → 六条全部可编辑:
- 配置键: `askOverBudget`/`autoOverBudget`/`askPlanExit`/`autoPlanExit`/`askFreeform`/`autoFreeform`(缺省/空串 → 各自默认常量)。
- **运行时角色**(用户已拍板): auto=插件到点自动压, auto 文案只作说明写入常驻策略, 不重复注入; hint 的①②在到点把 ask 文案注入询问用户(前加一行实时用量: `composeAskMessage`); ③两行只作 agent 策略指引(无事件)。
- 常驻策略 = 介绍 + 按当前 mode 选取的 3 条文案(按开关启用, 超预算恒在); `policyText` 非空时整段覆盖。
- GUI 按触发时机分组: 每时机一张卡, 开关与两条文案(先询问/直接压)放一起; YAML 只导出改动过的文案(未改省略=默认); `hintTemplate`/`planExitHint` 键废弃。

## v0.8 收敛: 文案只留给"agent 参与"的时机(取代 v0.7 的六条)
用户澄清关键认识: auto 的①②是**插件直接调压缩引擎**(不经过"发提示词→AI 调工具"), 压缩引擎会自行产出 checkpoint 文案(那是给模型续上下文的**结果摘要**, 不是决策话术) → auto①② 不需要也不应给 AI 发文案。
- **可编辑文案收敛为 4 条**: `askOverBudget`/`askPlanExit`(hint 下到点注入询问)、`askFreeform`/`autoFreeform`(③ 收尾无事件, 两种 mode 都需 agent 参与); `autoOverBudget`/`autoPlanExit` 删除。
- 策略拼装: hint = ask①②(+③开则 askFreeform); auto = ①② 固定一句话说明"由插件直接压、无需操作"(不经 AI 话术, 仅让 agent 不致困惑) + (③开则)autoFreeform。
- GUI: 超预算卡/plan 卡只留"先询问"文案并在卡内注明 auto 由引擎直接压; 自由收尾卡保留两条; YAML 只导出改动项。

## v0.8.1 提醒可读性: 说明文 → 命令式文案(用户实测反馈)
另一会话实测: 到点提醒被 agent 当作普通系统注入滑过(它复述的形态是常驻策略出现在"每轮消息边界/与时间采样同区", 恒定文本 → 习惯性无视)。
- 事实核对: 询问提醒本身**已是当次请求消息列表最末一条**(先 `await next()` 走完 pre-step 链再 append), 位置无法更靠尾; 被习惯性忽略的更可能是**每次请求恒定出现的常驻策略**。
- 用户拍板: **不加固定决策壳**, 直接把默认文案从"情况说明+请向用户询问"改成**命令式/提示式**(【压缩提醒】+ 编号步骤 + 同意/拒绝分支 + "非普通系统说明、勿自行决定"字样), 仍全部可编辑; 运行时注入前缀(实时用量行)保留, 使到点提醒与常驻文本在形态上可区分。
- 位置: 维持"post-next 追加 = 消息列表尾部"的实现; 后续若仍漏可考虑同轮升级重提(未实施, 用户未选)。
