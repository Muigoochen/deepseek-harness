# AI 工具调用：请求与回复格式 —— 调研笔记

> 记录 DeepSeek Harness 中"模型调用工具（读文件/改文件/执行命令等）"的请求与回复格式。
> 属于项目自有调研笔记，与官方 `docs/` 文档树分开存放。
> 对应问题：AI 要调用工具或对应功能时，发出去/收回来的是什么格式？

---

## 1. 三层视角：一份工具调用横跨三个表示

同一份工具调用在 harness 里经历了三种形态，理解格式前要先分清层：

| 层 | 载体 | 说明 |
|---|---|---|
| ① 会话日志层 | `assistant/message`、`tool/result` 事件 | 持久真相源（session.jsonl），`Message` 对象带 `content: ContentBlock[]` |
| ② 模型请求层 | `GenerateOptions.messages` | `session.deriveMessages()` 投影，provider 中立 |
| ③ 传输层（wire） | DeepSeek chat-completions payload | 适配器 `serializeMessages` 转换后的最终 JSON，`role` 会变 |

**核心词汇：`ContentBlock`（内容块）**。一条消息的 `content` 是若干块的数组，块按 `type` 区分：

```ts
// 五种核心块类型（可合并扩展）
type ContentBlock =
  | { type: 'text'; text: string }                                  // 普通文本
  | { type: 'reasoning'; text: string }                             // 推理/thinking
  | { type: 'image'; attachment: ImageAttachmentRef }               // 图片
  | { type: 'tool-call'; id; name; arguments: string }              // 模型请求调工具
  | { type: 'tool-result'; toolCallId; content: ContentBlock[]; isError? } // 工具结果
```

---

## 2. 模型"请求调用工具"的格式（assistant 侧）

模型要求调用工具时，产出的 `assistant/message` 的 content 里含 `tool-call` 块：

```json
// assistant/message 事件的 message.content（真实样例，来自 snapshots/sdk/bash-tool）
[
  { "type": "reasoning", "text": "The user wants me to run a specific bash command and reply with its stdout only." },
  {
    "type": "tool-call",
    "id": "call_00_Ry17evSfTr0uJnHhg3X93070",   // provider 生成的 call id，用于和结果配对
    "name": "bash",                                // 工具名（注册名）
    "arguments": "{\"command\": \"echo dsh-sdk-proof-7391\", \"description\": \"Run the echo command as requested\"}"
    //                                     ↑ arguments 是 JSON 字符串，不是对象！
  }
]
```

要点：
- **`arguments` 是 JSON 字符串**，不是解析后的对象（`serializeAssistant` 原样传给 wire；`tool/call` 事件、`tool/result` 里都一样）
- `id`（call id）是 `ToolCallId`，由 provider 分配，工具结果必须用它回指
- 流式过程：模型先吐 `tool-call-chunks`（逐 token 增量），`BlockAssembler` 汇总成完整 `tool-call` 块，最后落 `assistant/message`

工具调用的**入参 schema**来自工具注册（模型看到的工具描述）：

```ts
// packages/fs/tool-fs/src/read.ts（真实 schema，注册到 ctx.tools）
ctx.tools.register(defineTool({
  name: 'read',
  description: 'Read a UTF-8 text file and return line-numbered content.',
  parameters: {
    file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
    offset:    { type: 'number', description: '1-based first line to return. Defaults to 1.' },
    limit:     { type: 'number', description: 'Maximum number of lines to return. Defaults to 2000.' },
  },
  ...
}))
```

同族的其他工具 schema 一览（`tool-fs`、`shell`）：

| 工具 | 注册名 | description | 关键参数 |
|---|---|---|---|
| 读文件 | `read` | Read a UTF-8 text file and return line-numbered content. | `file_path`、`offset`、`limit` |
| 写/替换文件 | `write` | Create or fully replace a UTF-8 text file. | `file_path`、`content`（完整内容） |
| 文本替换编辑 | `edit` | Edit an existing UTF-8 text file by replacing literal text. | `file_path`、`old_string`、`new_string`、`replace_all` |
| 执行命令 | `bash` / `pwsh` | 见各 shell 工具 | `command`、`description` |
| 搜索文件 | `glob` / `grep` | 见 `tool-fs-search` | — |
| 替换编辑器 | `str_replace_editor` | 见 `tool-str-replace-editor` | — |

---

## 3. 工具"回复结果"的格式（user 侧）

工具执行完毕后，harness 落一条 `tool/result` 事件回到会话。**注意：在 harness 内部，工具结果的角色是 `user`**，内容是 `tool-result` 块：

```json
// tool/result 事件（真实样例：bash 执行成功）
{ "type": "tool/result",
  "data": {
    "turn": 1, "step": 1,
    "message": {
      "source":  { "kind": "tool", "callId": "call_00_Ry17evSfTr0uJnHhg3X93070" },
      "content": [{
        "type": "tool-result",
        "toolCallId": "call_00_Ry17evSfTr0uJnHhg3X93070",
        "content": [{ "type": "text", "text": "dsh-sdk-proof-7391\n" }],  // 实际 stdout
        "isError": false
      }],
      "role": "user",   // ← harness 内部工具结果挂在 user 角色上
      "id": "{{message:4}}"
    }
  },
  "sourceEventSeqs": [67], "surfaceOp": "append"
}
```

**工具结果内部通常还是 `ContentBlock[]`**（最外层是 `tool-result`，里面再嵌文本/推理/图片等）。例如文件写入的实际产物格式（fs 风格模型可见标记，来自真实样例）：

```json
// write 工具成功后返回的文本内容
"text": "<path>{{cwd}}/escalated.md</path>\n<type>file</type>\n<content>\nCreated file\n</content>"
```

`read` 工具则把结构化输出渲染成带行号、行数提示的文本（`formatReadOutput`），同时把结构化数据投影到 `meta` 供 UI 回放。

---

## 4. 传输层（wire）：DeepSeek 适配器的 role 转换

`deriveMessages()` 里的历史到 DeepSeek payload 要过一次 `serializeMessages`（`packages/llm/llm-deepseek/src/serialize.ts`）。转换规则是理解"实际发出去长什么样"的关键：

| harness `Message` | wire 上变成 |
|---|---|
| `system`（仅 request.system，或显式 system role 消息） | `{ "role": "system", "content": ... }` |
| `assistant` + `tool-call` 块 | `{ "role": "assistant", "content": "", "tool_calls": [{ "id": "...", "type": "function", "function": { "name": "bash", "arguments": "{\"...\": ...}" } }] }` |
| `user` 普通消息 | `{ "role": "user", "content": "文本" }` |
| `user` + **`tool-result` 块** | **拆成独立 `{ "role": "tool", "tool_call_id": "...", "content": "结果文本" }`** |

即：harness 内部把工具结果放在 `user` 消息里（`tool-result` 块），**wire 上必须拆出来**，因为 OpenAI 兼容协议要求工具结果单独占一条 `role: "tool"`，并且用 `tool_call_id` 指回对应的 `tool_calls[].id`。这也是"删除对话时 tool-call 必须连 tool-result 一起删"的原因——wire 上一旦有孤悬的 `role:tool` 而前面没有对应的 `tool_calls`，DeepSeek 会直接拒绝请求。

**模型实际收到的每轮请求的 messages 完整形态**：

```jsonc
// DeepSeek chat-completions payload.messages（示意）
[
  { "role": "system",  "content": "（renderPrompt 渲染的系统提示词，含工具使用指引分节）" },
  { "role": "user",    "content": "Run this exact command with your bash tool..." },   // 用户提问
  // （可选）动态运行时上下文快照也作为一条 user 消息
  { "role": "assistant", "content": "", "tool_calls": [{ "id": "call_00_...", "type": "function",
      "function": { "name": "bash", "arguments": "{\"command\": \"echo ...\"}" } }] },  // 模型上一轮请求
  { "role": "tool", "tool_call_id": "call_00_...", "content": "dsh-sdk-proof-7391\n" }, // 工具结果
  { "role": "user", "content": "再看看" },  // 用户下一轮
  ...
]
```

`request/header` 里的 `"system": "{{system}}"`、`"tools": "{{tools}}"` 是快照脱敏 token，真实值见同场景的 `system-prompt.expected.md` 与 `tool-schemas.expected.json` 旁车文件。

---

## 5. 一条完整工具回合的时序（真实样例逐事件）

以 `snapshots/sdk/bash-tool/session.jsonl` 为底，一个工具回合的完整事件序列：

```
user/message            ← 用户输入（含动态运行时上下文 snapshot 共 2-3 条 user）
assistant/chunk (reasoning)   ← 模型推理（逐 token，reasoning-chunks 落盘）
assistant/chunk (tool-call)   ← 模型请求工具（tool-call-chunks 逐 token）
assistant/chunk (usage/finish)
assistant/message       ← 组装好的含 tool-call 块的完整 assistant 消息
tool/call               ← 登记一次工具调用（执行管线入口，记录 callId）
  └─ (可选) approval/asked → approval/decided   ← 需要人工审批时
tool/result             ← 工具执行结果（user 角色 + tool-result 块，回写历史）
step/end / (下一轮 step/start ...)
assistant/message       ← 模型读完成果后的最终回答（text）
turn/end
```

执行管线细节见官方 `docs/tool-execution-pipeline.md`：`tool/call` 落日志 → `tools/pre-execute` waterfall（权限/沙箱/钩子）→ 守卫 → `tools/execute` → 工具体 → `tools/post-execute` → `finalizeContent` → `tools/result` 通知 → `tool/result` 事件落盘 → UI 呈现卡片。

---

## 6. 关键结论（可直接用于扩展开发）

1. **模型表达"要调工具"** = assistant 消息里一个 `tool-call` 块：`{ type, id, name, arguments(JSON字符串) }`
2. **工具表达"处理完毕"** = 一条 user 角色消息里的 `tool-result` 块：`{ type, toolCallId, content(块数组), isError }`；结果文本通常带工具族自己的模型可见标记（如 fs 的 `<path>…</path>`、行号等）
3. **wire 上**：assistant 带 `tool_calls`（content 用 `""`）、工具结果独立成 `role:"tool"` + `tool_call_id`
4. 新增一个模型工具 = 在 `ctx.tools.register(defineTool({ name, description, parameters, output }))`，参数 schema 用 JSON Schema 风格；执行后的结构化结果可由 `output.render` 决定模型看到的文本、`presentationMeta` 决定 UI 回放
5. 修改/删除历史时，删除边界必须以"assistant tool-call ↔ tool/result"为最小配对单元，此约束正是第 4 节 wire 转换的必然推论

---

## 7. 与官方文档的关系

- 本目录 `research/` 为项目自有调研笔记，与官方 `docs/` 分开
- 工具 schema 全集见官方生成目录 `docs/tool-catalog.md`；管线图见 `docs/tool-execution-pipeline.md`；事件签名见 `docs/persistence-catalog.md`
- 会话历史修改/删除专项见同目录 `session-history-editing.md`
