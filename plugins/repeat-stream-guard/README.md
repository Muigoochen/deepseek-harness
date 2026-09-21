# repeat-stream-guard

拦截模型流式输出**陷入周期性复读**的插件：一旦确认在机械重复，就提前收流；切断之后由设置页的开关决定**停下来等你**还是**带着提醒自动继续**。

典型发病现场是思维链（reasoning）：模型写着写着卡进 "写。写。写。写。…" 或 "?? 好。\n\n写。\n\n" 这样的循环，自己出不来，而 harness 会一直读到输出上限为止——几万 token 就这么没了。本插件就是给这种循环踩刹车。

- **Host 半** `lib/index.js`：监听 waterfall 事件 `llm/stream`，检测 + 切断 + 提醒投递。
- **浏览器半** `lib/client.js`：在「设置 → 通用」放一行开关（停止 / 继续）。
- **纯插件守则**：不改仓库任何产品/底层源码，不重建产物，零构建（产物即源码），状态只在进程内存里（开关值除外，它持久化在 settings）。

## 原理：为什么能真停住

`llm/stream` 是 waterfall 事件，插件能拿到 provider 的异步流并包一层；提前 `break` 会触发上游生成器的 `return()`，而 provider adapter 的 `finally` 会 abort 自己的 HTTP 消费者（`packages/llm/llm-deepseek/src/adapter.ts` 的 `streamWithConnection`）——**是真的掐断请求、立刻停止计费**，不是把剩余内容读完再丢掉。

同时，流里没有 `finish` chunk 时 `BlockAssembler` 会兜底成 `{kind:'stop'}`（`packages/llm/llm/src/assembler.ts`），所以那一步**正常结束**：已经生成的内容保留，不报错，也不会留下半个工具调用（检测到工具参数一开始流式输出，本插件就停用，见下文）。

## 切断之后：stop 还是 continue

两种模式共用一件事：**切断瞬间给该 agent 挂一条提醒消息**（plugin 来源、`form:'notice'`，不会被渲染成用户提问）。差别在怎么送出去：

| 模式 | 做法 | 表现 |
|---|---|---|
| **`stop`**（默认） | 提醒挂在内存里；那一步正常结束。该 agent 下一次 `agent/pre-step` 时把提醒插到消息最前面 | 对话停住等你；模型下一轮知道自己是被复读打断的，不会接着复读 |
| **`continue`** | 切断瞬间 `agent.inbox.append('next-step', 提醒)` | 本轮**不结束**——`agent.ts` 检查 `inbox.nextStep.length === 0` 才 break，收件箱非空就带着提醒自动再发一次请求 |

`continue` 走的是既有机制，不是新造轮子：`Inbox.append` 会持久写 `agent/inbox/spliced` 事件，和工具结果回灌上下文用的是同一条路径，满足"模型可见 ⟺ 已记录"。

**续跑有上限**：`maxContinues`（默认 `2`，`0` = 从不续跑）限制同一 turn 内连续续跑的次数，到顶就降级为 `stop`。没有上限的话"继续 → 又复读 → 再继续"能无限循环——这是刻意的防失控设计。

## 开关装在哪

- **值**：Host 半注册 settings 命名空间 `repeat-stream-guard`（`ctx.settings.register`），由 settings-file provider 持久化到 `$DSH_HOME`；`applies` 默认 `live`，**改完即时生效、不用重启**。
- **界面**：浏览器半注册进 `settings.general.item` 槽位，也就是「设置 → 通用」页里的一行「复读时：停止 / 继续」，和「语言」「外观」「Enter 行为」并列。
- **优先级**：`cordis.patch.yml` 的 `config` 是 base 层，设置页的用户选择覆盖它；无头/CI 场景只用 YAML 也能跑。

## 检测算法

对文本增量（以及思维链增量）在线累积，去掉所有空白后检测**尾部是否严格周期**：

对候选周期 p ∈ `[1, maxPeriod]`，取窗口 `span = max(minCopies × p, minPeriodicChars)`，比较"尾部 span 个字符"与"往前挪 p 个字符的同长度窗口"；两者完全相等即判定这段是 p-周期，也就是至少重复了 `max(minCopies, minPeriodicChars / p)` 遍。

- 去空白是为了让换行/缩进的切分方式不影响判断（delta 边界切在哪都一样）。
- 每新增 `checkEveryChars` 个字符才检查一次，检测开销可忽略。
- **一旦出现 `tool-call-delta` 立即停用**：此刻截断会让 assembler 拿到半截 JSON，反过来生成一次残缺的工具调用；工具层面的复读交给仓库里已有的 `repeat-tool-reminder`。
- `minPeriodicChars`（默认 120）是防误伤用的下限：排比、短促的口头重复不会触发。

## 配置与设置

`config`（`cordis.patch.yml`，作为 base 层）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxPeriod` | `64` | 允许的最长重复单元（字符） |
| `minCopies` | `5` | 判定为复读所需的最少重复遍数 |
| `minPeriodicChars` | `120` | 判定为复读所需的周期性字符数下限；调小切得更早，但更容易误伤 |
| `checkEveryChars` | `32` | 每新增多少字符做一次检查 |
| `retainChars` | `4000` | 检测窗口保留的原始字符数 |
| `watchReasoning` | `true` | 是否把思维链也纳入检测 |
| `notify` | `true` | 命中时是否用 `toast` 弹提示（未装载 toast 自动跳过） |
| `mode` | `stop` | 切断后 `stop` 停止 / `continue` 续跑 |
| `maxContinues` | `2` | `continue` 模式下同一 turn 的续跑上限，`0` = 不续跑 |

设置页那一行只写 `mode`；`maxContinues` 需要时直接改设置文件或 YAML。非法值：`config` 里的在装载时抛错（fail-loud）；设置文件里被人手改成非法值时退回默认并告警（不让插件装载失败）。

想改**模型看到的那条提醒文案**：改 `lib/index.js` 里的 `REMINDER_TEXT` 常量（默认英文，与仓库自带的 `repeat-tool-reminder` 一致）；toast 文案在同文件的 `notifyUser` 调用处。

## 安装 / 卸载

```powershell
# 安装（幂等：链入 profile + 登记为 bundle；缺 lib/client.js 会直接报错）
powershell -ExecutionPolicy Bypass -File E:\Deepseek\deepseek_harness\plugins\repeat-stream-guard\install\install.ps1

# 重启 dsh web 后生效（已在跑的实例仍用它的旧 host 行）

# 卸载
powershell -ExecutionPolicy Bypass -File E:\Deepseek\deepseek_harness\plugins\repeat-stream-guard\install\uninstall.ps1
```

install.ps1 会（幂等）：

1. 用 DSH 官方方式安装本包 —— `dsh plugin --profile web add <本包路径>`，由它把包链入 profile 并登记为
   依赖与 bundle。**不再复制文件**：安装后 profile 通过 `link:` 指向本目录；
2. 自检：导入宿主半，并按浏览器半的规则解析 `lib/client.js`。

本包贡献的配置层在包根的 `cordis.patch.yml`（这一行同时带起 Host 半和浏览器半）；profile 自己那份
`$DSH_HOME\profiles\web\cordis.patch.yml` 在同 id 上后应用、会覆盖它。改了 `lib/*.js` 无需重跑安装
（`link:` 指向源码），重启或刷新即可。

`uninstall.ps1` 走 `dsh plugin --profile web remove @dsh-user/repeat-stream-guard`，**不会递归删除**
profile 的 `node_modules` 目录 —— 那个路径可能是指回本 checkout 的链接，递归删除会连带删掉源码。

## 验证

1. 重启后进入「设置 → 通用」，应看到「复读时」那一行；
2. 让模型反复输出同一个短句：命中时右上角浮出提示，输出在复读开始后约一百多个字符处被截断；
3. 会话日志里的铁证：被切断的那次响应**没有 `finish` chunk、也没有 `usage`**，而正常完成的响应两者都有——可在 `$DSH_HOME/sessions/<cwd>/<session>/session.jsonl.zstd` 里核对；
4. 选 `continue` 时，日志里应看到随后**同一个 turn 自动又发了一次请求**（收件箱投递写成 `agent/inbox/spliced` 事件）。

## 边界与限制

- **不回溯**：已经吐出来的那一小段重复收不回来，只能止损；代价上限约等于 `minPeriodicChars + maxPeriod` 个字符。
- **对工具调用让路**：见上文，工具层面的重复由 `repeat-tool-reminder` 负责建议，本插件不介入。
- **只认严格周期**：近重复（每遍略有差异，比如编号递增）不会被判定，因为那与正常的结构化输出无法区分。
- **合法的机械输出会被误伤**：确实需要模型原样输出几百遍同一行时，调大 `minPeriodicChars`、关掉 `watchReasoning`，或临时停用本插件。
- **按流隔离**：每个模型调用（含子代理、压缩、起标题）各自一份检测状态，互不影响。
- **子代理场景**：子代理被切断后它的 turn 正常结束（或按开关续跑），把结果交回父代理；父代理的流程不受影响。
- **`continue` 每次会多花一次请求**：上限 `maxContinues` 就是为了兜住这一点。
