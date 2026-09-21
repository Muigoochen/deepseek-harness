# 会话历史修改/删除机制 —— 调研与方案

> 本文档记录 DeepSeek Harness 中"修改/删除已发送会话历史"需求的调研结论与方案讨论。
> 属于项目自有调研笔记，与官方 `docs/` 文档树分开存放。

---

## 1. 背景与目标

用户希望在对话过程中：
- 当 AI 回复部分内容不佳或需要修正时，**手动修改该部分内容**，而无需重新生成整个回复
- 当某一段对话（可能污染上下文）需要**整体删除**时，将其从模型上下文中移除

目标：在不破坏系统数据一致性的前提下，实现上述"编辑/删除会话历史"能力。

---

## 2. 已确认的事实

### 2.1 仓库状态：原生未修改
- 当前在 `master` 分支，工作树干净（唯一未跟踪文件是根目录 `PROJECT-ANALYSIS.md`，即本仓库整体分析文档）
- 最新提交：`dd6322d604`（release/dsh-0.1.2-alpha.3）

### 2.2 原生没有"编辑/删除已发送历史"能力
- `Session` 只有 `append()` 一个写入入口，**没有任何 edit/delete API**；已落日志的消息不可原地修改
- 全仓搜到的"编辑/删除"均只作用于**待发送队列**：
  - `core/agent/src/inbox.ts` 的 `remove()` / `replace()` / `splice()` —— 只改 pending（未进日志）消息，供 `agent-instructions`、`acp` 撤销/替换排队消息
  - `ui-conversation` 的 `queue.edit` / `queue.remove` —— locale 原文为 "Edit queued message"（编辑队列中、未发送的消息）
- 结论：修改/删除已发送历史需要自行扩展

---

## 3. 架构底线：会话日志是 append-only 的

**"日志不可修改"是架构底线，不是技术限制**。直接改中间日志会破坏 6 个一致性环节：

| # | 环节 | 破坏后果 |
|---|---|---|
| ① | seq 连续性契约（`seq = log.length`） | 删中间一条，后续 seq 全错位；surface replace 的 start/end、sourceEventSeqs 指向错误位置 |
| ② | 重放一致性（`replayed.deriveMessages() === original.deriveMessages()`） | 回放与"当时真实发生"分叉 |
| ③ | 派生缓存（`deriveMessages()` 增量缓存基于 log 位置） | 静默失效或输出错乱 |
| ④ | 崩溃修复（`repair.ts` 扫描 turn/step/tool-call 配对） | 边界扫描给出错误结论 |
| ⑤ | 投影（`session-projection` 增量折叠同样按 seq 缓存） | 错位即错乱 |
| ⑥ | 事件 deep-freeze | 普通代码改写即抛 TypeError；模块边界外够不到私有 log |

关键认知：**"让模型看到修改后的内容"不需要破例改日志**——官方为此设计了 Surface replace。

---

## 4. 核心机制：Surface replace（官方正统方案）

### 4.1 机制说明

会话历史分为两层：
- **原始事件日志**：append-only，不可变，磁盘 JSONL 只增不改，保留完整审计轨迹
- **surface 表面**：决定模型看到什么（`deriveMessages()` 投影的唯一来源）

`session.append()` 支持 `surfaceOp` 标记：
```ts
session.append(type, data, {
  surfaceOp: { op: 'replace', start, end },  // 遮蔽旧区间
  sourceEventSeqs: [...被遮蔽节点的 seq],
})
```
- 追加一条修正后的消息（`assistant/message` / `user/message` / `tool/result`）+ replace 标记
- `deriveMessages()` 从此只投影新节点；旧对话不再进入模型上下文
- compaction（上下文压缩）已经在使用同一机制

### 4.2 原生、可持久化（证据链）

1. `surfaceOp` 是 `SessionEvent` envelope 的 **7 个合法字段之一**：
   `type / seq / time / data / surfaceOp / sourceEventSeqs / ignorable`
   （`packages/core/session/src/index.ts` 的 `assertSessionEventEnvelope` 逐 key 校验）
2. replace 形状由官方定义：`{ op: 'replace', start, end }`，start/end 必须是非负安全整数
   （`packages/core/session/src/surface.ts` 的 `isReplaceOp`）
3. 持久化闭环：事件（含 surfaceOp）经 `session/event` 广播、`session/flush` 落盘 JSONL（`chunk-rows.ts` 原样保留）→ 重启加载同套校验放行 → `SurfaceManager._processDelta()` 重放重建表面
4. 旁证：`compaction-basic` 依赖 replace 持久化才能让压缩在重启后生效；`compaction-basic.spec.ts` 断言 replay 后 `deriveMessages()` 与压缩前一致

### 4.3 操作形态

```
修改第 X 条 assistant 回复：
  新内容构造成新 assistant/message
  → append(…, { surfaceOp: {op:'replace', start: X.seq, end: X.seq}, sourceEventSeqs: [X.seq] })
  → 持久化；磁盘同时有"旧消息 + 新消息 + replace 标记"
  → deriveMessages() 只投影新消息；重启回放一致

删除第 X~Y 段对话：
  append(…, { surfaceOp: {op:'replace', start: X.seq, end: Y.seq}, sourceEventSeqs: [X..Y 的 seq] })
```

---

## 5. 方案对比

| 维度 | A 单独文件存覆盖 | B 新增事件类型+投影 | C 官方 surface replace |
|---|---|---|---|
| 是否动核心 | 否（绕开） | 需扩展投影面 | 需扩展投影面（更小） |
| 单一真相源 | ✗ 破坏（第二真相源） | ✓ | ✓ |
| 兼容 invariant/持久化/回放 | ✗ 需自建 | ✓（需扩展投影） | ✓（原生） |
| 原始日志保留审计 | ✓ | ✓ | ✓ |
| 侵入性 | 低但外挂 | 中 | 最低（复用现成机制） |
| 推荐度 | 不推荐 | 可选 | **推荐** |

### 方案 A 的坑（单独文件 overlay）
- 引入第二真相源，违反"一件事只有一个家"原则
- `deriveMessages()` 内置在 core/session，不认 overlay；请求前拦改写会破坏 invariant（`agent-loop/invariant.ts` 断言 `request.messages === session.deriveMessages()`），请求无法发出
- 磁盘持久化、投影、回放、崩溃修复全部不自动认识 overlay

### 方案 B 的约束（新增事件类型）
- 给**已有**事件加字段会被 envelope 校验直接拒绝
- 合法变形：`SessionEventMap` 是 merge-extensible，可新增自定义事件类型（如 `session/message-override`）携带覆盖指令；但需在 `surface.ts` 投影规则（SURFACE_EVENT_TYPES + deriveEventMessage）或等价扩展点处理该事件，属于动 core/session 投影面，风险中等

### 方案 C（选定）：官方 surface replace
- 不新增文件、不改字段；日志单一真相源；invariant、持久化、回放、投影全兼容
- compaction 已有现成实现可参考
- 原始事件保留在日志里（审计轨迹）——这是特性而非缺陷

---

## 6. 已知硬约束

1. **replace 是整节点替换，不是改几个字**；原始事件永远留在日志里（架构底线）。UI 人类可见转录如何处理需另行设计
2. **删除必须整段配对删除**：删 assistant 的 tool-call 轮时，必须连同其 tool/result 一起删；只删一半会留下孤悬的 `{role:'tool'}` 消息，DeepSeek 适配器转换后 provider 会拒绝请求
3. replace 有严格校验：`sourceEventSeqs` 必须覆盖全部被遮蔽节点；`tool/result` 的 replace 只能改 content 且一次只改一个节点

---

## 7. 待验证 / 待设计项

- [ ] **tool-call/tool-result 配对的精确约束**：替换边界如何定义才能保持 provider 合法
- [ ] **Web UI 渲染**：`ui-chat` / `ui-conversation` 当前对 surface replace 的渲染是否显示替换后的新内容（决定是否要动客户端渲染层）
- [ ] **触发入口**：新增什么工具/命令/API 供用户发起修改/删除
- [ ] **删除边界规则**：如何定义"一轮对话"的安全删除区间

---

## 8. 与官方文档的关系

- 本目录 `research/` 为项目自有调研笔记，与官方 `docs/`（架构/子系统/教程文档树，由 `docs/AGENTS.md` 管控）完全分开
- 根目录 `PROJECT-ANALYSIS.md` 为整体功能分析（面向扩展开发），与本文档互补
- 若未来实现落地，涉及 core/session 的改动需遵循仓库约定（Agent Note、README/JSDoc 同步、`verify-*` 门禁）
