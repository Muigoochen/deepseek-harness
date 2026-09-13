# repeat-stream-guard

拦截模型流式输出**陷入周期性复读**的插件：一旦确认在机械重复，就提前收流，不再空烧到 `max_tokens`。

典型发病现场是思维链（reasoning）：模型写着写着卡进 "写。写。写。写。…" 或 "?? 好。\n\n写。\n\n" 这样的循环，
自己出不来，而 harness 会一直读到输出上限为止——几万 token 就这么没了。本插件就是给这种循环踩刹车。

- **Host 单半**：`lib/index.js`，监听 waterfall 事件 `llm/stream`，无浏览器半。
- **纯插件守则**：不改仓库任何产品/底层源码，不重建产物，零构建（产物即源码），状态只在进程内存里。

## 原理：为什么能真停住

`llm/stream` 是 waterfall 事件，插件能拿到 provider 的异步流并包一层；提前 `break` 会触发上游生成器的
`return()`，而 provider adapter 的 `finally` 会 abort 自己的 HTTP 消费者（`packages/llm/llm-deepseek/src/adapter.ts`
的 `streamWithConnection`）——**是真的掐断请求、立刻停止计费**，不是把剩余内容读完再丢掉。

同时，流里没有 `finish` chunk 时 `BlockAssembler` 会兜底成 `{kind:'stop'}`（`packages/llm/llm/src/assembler.ts`），
所以这次 turn 会**正常结束**：已经生成的内容保留，不报错，也不会留下半个工具调用。

## 检测算法

对文本增量（以及思维链增量）在线累积，去掉所有空白后检测**尾部是否严格周期**：

对候选周期 p ∈ `[1, maxPeriod]`，取窗口 `span = max(minCopies × p, minPeriodicChars)`，
比较"尾部 span 个字符"与"往前挪 p 个字符的同长度窗口"；两者完全相等即判定这段是 p-周期，
也就是至少重复了 `max(minCopies, minPeriodicChars / p)` 遍。

- 去空白是为了让换行/缩进的切分方式不影响判断（delta 边界切在哪都一样）。
- 每新增 `checkEveryChars` 个字符才检查一次，检测开销可忽略。
- **一旦出现 `tool-call-delta` 立即停用**：此刻截断会让 assembler 拿到半截 JSON，反过来生成一次残缺的工具调用；
  工具层面的复读交给仓库里已有的 `repeat-tool-reminder`。
- `minPeriodicChars`（默认 120）是防误伤用的下限：排比、短促的口头重复不会触发。

## 配置

全部字段都有默认值，`config` 可整段省略。改 `$DSH_HOME/profiles/web/cordis.patch.yml` 里那一行的 `config` 即可。

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxPeriod` | `64` | 允许的最长重复单元（字符）；超过这个长度的"重复"不再判定为复读 |
| `minCopies` | `5` | 判定为复读所需的最少重复遍数 |
| `minPeriodicChars` | `120` | 判定为复读所需的周期性字符数下限；调小切得更早，但更容易误伤正常的长重复结构 |
| `checkEveryChars` | `32` | 每新增多少字符做一次检查（控制开销） |
| `retainChars` | `4000` | 检测窗口保留的原始字符数 |
| `watchReasoning` | `true` | 是否把思维链也纳入检测 |
| `notify` | `true` | 命中时是否用 `toast` 插件弹一条提示（`toast` 未装载时自动跳过） |

非法值（非整数、小于 1）在装载时直接抛错，不静默兜底。

## 安装 / 卸载

```powershell
# 安装（幂等：复制包 + 只追加一次 patch 行）
powershell -ExecutionPolicy Bypass -File E:\Deepseek\deepseek_harness\plugins\repeat-stream-guard\install\install.ps1

# 重启 dsh web 后生效（已在跑的实例仍用它的旧 host 行）

# 卸载
powershell -ExecutionPolicy Bypass -File E:\Deepseek\deepseek_harness\plugins\repeat-stream-guard\install\uninstall.ps1
```

install.ps1 会：
1. 把包复制到 `$DSH_HOME\profiles\node_modules\@dsh-user\repeat-stream-guard\`；
2. 在 `$DSH_HOME\profiles\web\cordis.patch.yml` 幂等追加一行 `- id: repeat-stream-guard / name: '@dsh-user/repeat-stream-guard'`。

安装前可跑 `npm run selfcheck` 做语法自检。

## 验证

1. 重启后随便找一轮模型输出，让它反复输出同一个短句（或直接等它自己发病）；
2. 命中时：右上角浮出「已中断模型重复输出」提示，输出在复读开始后约一百多个字符处被截断，
   `turn/end` 仍是 `completed`（不是 error）；
3. 会话日志里的铁证：被切断的那次响应**没有 `finish` chunk、也没有 `usage`**，
   而正常完成的响应两者都有——可以在 `$DSH_HOME/sessions/<cwd>/<session>/session.jsonl.zstd` 里核对。

## 边界与限制

- **不回溯**：已经吐出来的那一小段重复收不回来，只能止损；代价上限约等于 `minPeriodicChars + maxPeriod` 个字符。
- **对工具调用让路**：见上文，工具层面的重复由 `repeat-tool-reminder` 负责建议，本插件不介入。
- **只认严格周期**：近重复（复读时每遍略有差异，比如编号递增）不会被判定，因为那与正常的结构化输出无法区分。
- **合法的机械输出会被误伤**：如果确实需要模型原样输出几百遍同一行（例如生成重复数据），
  请调大 `minPeriodicChars` 或把 `watchReasoning` 关掉，必要时在 patch 行里临时停用本插件。
- **按流隔离**：每个模型调用（含子代理、压缩、起标题）各自一份检测状态，互不影响。
