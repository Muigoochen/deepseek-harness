# lsp-echo 设计文档(2026-09-10 更新:引擎桥 §11)

把语言服务器(LSP)的**编译错误自动反馈给 AI**,先以 Godot(GDScript)为引子,
验证 harness 插件开发范式,再扩展到其它语言的 LSP。

## 1. 背景与需求

- AI 改完 `.gd`,编译错误只有人能看 → AI 拿不到 → 依赖人贴文本。
- 目标:① 自动(编辑后错误注入下一轮模型上下文,无需主动查);② 自包含(插件自带引擎程序);
  ③ 可扩展(语言无关,Godot 是第一个 checker);④ 纯插件,不动产品源码。

## 2. 分层:引擎 + 管理

- **引擎(checkers/godot-lsp/)**:headless Godot 编辑器
  `--editor --headless --no-window --lsp-port <free> --dap-port <free>` 作
  LSP 宿主(全工程 `class_name` 注册、语义级诊断),零依赖 Node 桥负责拉起/客户端/落盘。
  `--dap-port` 必须显式给:任何 `--editor` 实例都会顺带打开调试适配器(DAP)监听,默认端口
  6006,而 6006 常被用户当作编辑器 LSP 端口 —— 不指定就会由本插件自己的引擎占掉它。
  两个端口都由 `freePort()` 选定,并避开 `--reserve-ports` 里设置的预留端口。
  可被任何 agent 独立调用(`host|status|stop|check|smoke|watch`)。
- **管理(harness 插件 lib/)**:生命周期、项目自动判定、变更侦测、自动注入、GUI API 钩子。
  存储用 **harness settings 命名空间 `lsp-echo`**(非自建文件)。

### 2.1 智能连接(editor attach,2026-09-05 实测定稿)

「只保留一个引擎」:若用户已打开该项目的 Godot 编辑器,直接 **attach 它的 LSP 端口**
(像官方 godot-vscode-plugin 一样,零额外内存、引擎恒热),否则才自起 headless。

- **端口来源(降序)**:设置页引擎卡「编辑器 LSP 端口」(存 harness settings `enginePorts`,
  host 转成 `--editor-port` flag 传给桥)→ 桥 config `editorPort`(默认 `6005`,无 GUI 时兜底)
  → 内置默认 `6005`。不盲扫端口,避免误连别的服务。
- **归属判定**:信任模型与官方 VSCode 插件一致——单开场景下编辑器端口即当前项目编辑器;
  我们自己 headless 用随机端口,不会占编辑器端口,故 TCP 可连即视为命中
  (实测:attach 0.1s;`gdscript_client/changeWorkspace`/`capabilities` 握手不稳定,
  **不作命中判据**)。多编辑器/多项目用户可设 `attachEditor:false` 走纯 headless——该开关
  **优先于** `attachPolicy`:关掉 attach 之后,编辑器后开也不会被迁回。
- **归属的否定判据(唯一用到 `changeWorkspace` 的地方)**:握手窗口内若对端声明它服务的是**别的项目**,
  则拒绝该端口、记入 5 分钟黑名单并回退我们自己的引擎——否则它对本项目文件的空诊断会伪装成"0 错误"。
  这里只把该通知当**否定**证据用:没收到就不拒绝,所以它的不稳定性只会让判定退回旧行为,不会误拒;
  晚到的通知由 clientd 在每次请求前复查,同样触发拒绝 + 回退。黑名单记录在 host 状态里跨 mode 切换保留
  (`writeHostState` 沿用 `badEditor`,过期与否由 `badActive` 在使用点判定),因此被拒的端口在有效期内不会被再次探测。
- **state 记录 `mode`**:`editor`(pid=0,进程属于用户,`stop`/插件卸载**只 detach 不杀**)
  或 `headless`(pid=我们 spawn 的,可停)。编辑器关闭后下次 ensure 自动 fallback headless。
- **attachPolicy(编辑器后开的处置,2026-09-11 定稿)**:`prefer-editor`(默认)= 若检查时发现
  「我们自己的 headless 在跑、而编辑器现在也可连」,则**迁回 attach 并停掉自己的 headless**(一个项目
  只留一个引擎);`cold-start` = 谁先起就用谁(适合同时用 VSCode Godot 插件连编辑器 LSP 的机器)。
  决策在**每次请求前**重做(host 决策不再只在 clientd 启动时做一次),迁回会新建会话,因此会挤掉
  此刻连在编辑器 LSP 上的其它客户端;被停的 headless 是我们 spawn 的,可安全停。
- **拒绝服务别的项目的编辑器**:编辑器 LSP 服务它当前打开的项目;握手后若 announce 的项目不是本次检查的
  项目,该端口记入黑名单(`badEditor`)并回退到我们自己的引擎——它对本项目文件的空诊断会伪装成"0 错误"。
- **全量扫描在编辑器上同样快**:attach 模式下 501 文件 sweep ≈ 4.8s(headless 相当)。
  外部 didOpen/didClose 不打开编辑器 UI 标签、不干扰用户正在编辑的缓冲(实测)。

## 3. 为什么不复用官方 `lsp` 能力缝

`ctx.lsp` 查询是封闭联合(`goToDefinition|findReferences|goToImplementation|hover`),无诊断操作,
且官方 `lsp` 工具是 AI 主动调用。加操作需改产品 → 自建。

## 4. 采用的 harness 缝(源码证据见 research/harness-plugin-dev-findings.md)

| 用途 | 缝 |
|---|---|
| 装载 | `cordis.patch.yml` 行 + profile node_modules;`patchReload: live` 新增行热生效,代码变更需重启 |
| 工具 | `ctx.tools.register(defineTool({ output:{schema,render}, execute(args,exec) }))` |
| 每步注入 | `agent/pre-step` + `createUserMessage(source:{kind:'plugin',form:'snapshot'})`(time-context 范式) |
| 持久化 | `settings.register('lsp-echo', schemastery schema)` → scope get/replace/watch(**必须是 schemastery,不是 zod**) |
| 工作区枚举 | `ctx.get('workspaceRegistry').list()`(id/path/title) |
| UI 浮窗 | `ctx.toast.show/dismiss`(@dsh-user/toast,依赖) |
| GUI API(未来窗口) | host 路由 `GET /lsp-echo/api?action=…`(见 §8) |

## 5. 项目判定策略(产品定稿规则)

1. 插件启用时:对**已有 harness 工作区**各做一次智能判定(`project.godot`,黑名单+深度封顶);
2. **新加入的工作区**:进入即判一次;
3. 其余一律用户配置(手动层,未来 GUI);**平时零扫描**(变更侦测只在已注册项目上、且只 mtime diff)。
4. 存储:`discovered`(键=工作区 id,工作区删除即同步清理)+ `manual`(键=项目路径)双层;
   有效集 = 配置种子 > manual > discovered 按路径去重。

## 6. 触发机制(实测定稿,2026-09-05)

- **点开会话 = `agent/created source=resume`**(每个被点开的对话都会发,含 fork 副本;新建会话是 `source=startup`);
  该事件在首条消息之前发出(网页端打开会话即 `session.follow` → 后台激活 agent);触发器在 creation 派发之后异步开始,
  所以扫描与用户打字并行(枚举全树的同步部分不占用打开会话的那一刻);
- **fork 子会话带 `parentSession`** —— 初版"仅顶层用户会话"守则误拦了 fork 副本
  (现象:「熟悉道具」永不触发而「现场验收」触发,与最近活跃/先后无关)。
  **结论:基线/注入的门槛只按会话工作区 cwd 判定,不看 parentSession**;
- **自动全量基线**:每次装载后每项目首触发一次(任一命中工作区的会话 `agent/created` 即启动,常见 `startup`/`resume`;行热重载会重新武装),
  扫描跑独立 clientd 角色(role=baseline),开始/完成/失败以插件消息 + toast 播报(完成也播报"0 错误");
- **全量扫描快路径(sweep)**:一次性 didOpen 全部文件 + 无 settle 税(实测 501 文件
  从 ~60s 降到 ~4.7s);`.gdshader` 引擎不发 LSP 诊断,立即记空结果不空等(带 `engine_note`);
- **逐 step 变更侦测(Mode B)**:无后台轮询;每个 `pre-step` 对该项目全树 mtime diff,
  只把变更文件推给引擎 → 注入(有错才注入,同文本 3s 节流);
- **改动脚本的引用者一并检查**:引擎只对递给它的那个文件作答,签名变化弄坏的是调用者,
  所以 pre-step 解析改动 `.gd` 的 `class_name` 与 `res://` 路径,把被监听文件里提到它们的并入
  同一轮(候选集与类名索引同口径,含 `addons/`;词边界 + 路径字面匹配;实测约 500 文件的项目
  一趟 18 ms、平均 5.4 个引用者);**删除或改名** `.gd` 时旧名字已无从读取,那一轮改为对该项目
  做一次全量复查(罕见事件,约 5 s);
- **检查前刷新引擎的内容视图(attach 编辑器独有的陈旧)**:编辑器在文件系统扫描时缓存脚本文本,
  只在窗口重新获得焦点时重扫,因此可能按编辑前的副本作答;本轮有改动文件时先让引擎重扫
  (实测 138 ms socket 往返,不含桥进程启动)再检查。现象:父类方法已改成 `-> bool`,
  子类仍报 `Parent signature is "… -> void"`;我们自起的 headless 引擎无此窗口(依赖从磁盘读取,
  实测"先打开过依赖"与"从未打开"两种变体都立刻反映);
- 调试观测:`$DSH_HOME/lsp-echo-runtime/lsp-echo-trace.log`(pre-step/created/baseline/addon/rescan 全记录)。

## 7. 自动注入与日志

注入经 pre-step 决策并入 `user/message`(plugin source),天然满足“模型可见 ⟺ 可重放”。
toast 浮窗只做**高信号 UI 提示**(就绪/自动发现/首次诊断进度与结果),dismiss 用 `removedSeq`
新事件下发(常驻条也能被服务端关掉);客户端 `sessionStorage` 记 seq,刷新不重播,host 重启自动续拉。

## 8. GUI(浏览器半,2026-09-05 首版定稿)

lsp-echo 带**静态 client 半**(`lib/client.js`,toast/workspace-files 同款:
`exports["./client"]` + `package.json` `dsh.client.platform:web`,零构建,
`window.__ModuleLoader__.load`)。装载同 toast:patch.yml 一行 insert 双端生效,
重启 web 后 ClientModuleRegistry 自动发现并 serve bundle(实测 boot entries 含
`@dsh-user/lsp-echo`)。

### 8.1 数据与控制通道

- **数据**:诊断结果 `$DSH_HOME/lsp-echo-runtime/lsp_diagnostics-*.json`(插件侧 host writer 原子写,
  keyspace 合并后落盘);引擎另有一份自有副本在 `lsp-echo-runtime/<引擎目录名>/`,不参与合并、GUI 不读。
  引擎状态经 host API。
- **控制(host JSON API,`webServer.register` exact `/lsp-echo/api`)**:
  - `?action=projects` → `{ok, projects:[{source,engine,path,autoInject}]}`
  - `?action=status&project=<abs>` → `{ok, mode:'editor'|'headless'|'running'|'off', stdout}`
  - `?action=host|stop|baseline&project=<abs>` → 启/停引擎、全量重扫(同 manager)
  - `?action=diagnostics&project=<abs>` → `{ok, updated_at, summary, files}`(读快照,
    纯读不启引擎;无快照时 `{empty:true}`,浏览器据此提示先做 baseline)
  - `?action=enginePort&engine=<id>[&port=<n>]` → 引擎「编辑器 LSP 端口」覆盖(settings `enginePorts`)
  - `?action=installAddon&project=<abs>` → 把引擎附带的引擎桥 addon 复制进项目并在 project.godot 启用(§11)
  - `?action=bridgeStatus&project=<abs>` → `{ok, port, installed, online, error}`:当前是否有引擎实例能响应重扫
  - **写门**:所有有副作用的 action(`installAddon`/`smart`/`setProject`/`addLsp`/`delLsp`/`resetProject`/
    `delProject`/`baseline`/`host`/`stop` 与带参数的 `config`/`enginePort`)要求请求头
    `x-dsh-lsp-echo: 1`。跨站页面无法给 GET 附加自定义头(预检必失败),因此别的网页不能借 DSH 写用户项目
    或停引擎;只读 action 不设门。

### 8.2 浏览器半(两个槽位,均加性、零产品代码改动)

| 槽位 | 职责 |
|---|---|
| `conversation.session.header.actions`(order -5) | ⧆ 图标 + 角标:仅当前会话 cwd 命中已注册项目时显示(零打扰);
  角标 = 错误数(红)或 ✓(绿),3s 轮询摘要;点击记录按钮锚点并开/关浮层 |
| `shell.overlay`(order 60) | 诊断浮层:锚在图标左缘下方;项目路径 + 模式徽章 + 工具条
  (刷新/全量重扫/启动/停止)+ 按文件分组 error/warning(gdshader 带 engine_note);
  每 3s 自刷,ESC/点外部关闭 |

- 会话绑定:**图标随会话出现**(cwd→项目判定,与 host pre-step 同规则);
  **浮层数据绑定项目**(path 键),切会话不重建同一项目的浮层状态;
- 组件纪律(实测):会话级槽标准 props 含 `sessionId` + `useSessions`
  (`s.byId[sessionId].cwd` 取会话目录)+ `useWorkspaces` 等 —— 订阅 hook 必须在
  渲染顶层调用(不能放进 useEffect);
- **已知 UX**:首次进入会话的 toast(全量扫描)短暂盖过图标 → 图标放 header.actions
  (创造模式右侧)而非 utilities,已避开。

### 8.3 设置面板(2026-09-06 定稿:项目为主,多 LSP v2)

配置级 UI 进 `settings.section`(lsp-echo 专属设置页,order 30,"LSP 诊断"),
走同一 host API(`GET /lsp-echo/api`) + settings 写通道。定稿布局:

- **全局自动注入开关**(页头):新项目第一次加入 DSH 时自动智能配置 LSP 并在编辑后
  反馈诊断;关 = 新项目只登记不自动注入。
- **工作原理卡**:项目=目录,可含多种语言,每种语言一个 LSP 认领自己的扩展名。
- **项目卡(每项目一张,以目录名为主标题,全路径小字)**:
  - 绑定引擎 = chips(实心,✕ 移除单个 LSP);
  - 常驻「手动添加引擎」控件 = 下拉 + 「添加」按钮(**无可用引擎时禁用但不隐藏**,
    下拉列出全部已装引擎,未绑定的可选、已加入的置灰);
  - 「智能配置」:扫描项目补缺失 LSP(只补充,绝不覆盖用户手动删的 / 手动配置);
  - manual 来源卡 = 「移除手动配置」,其余 = 「还原种子」(还原 config/自动发现种子);
  - 来源(config/manual/workspace)进标题 tooltip,不占卡片主视觉;
- 底部「添加项目」行:绝对路径 + 引擎下拉 + 添加 + 「全部智能配置」。
- 引擎卡:列出 checkers/ 已注册引擎(id/name/marker/extensions)。

交互纪律:所有写 action 单飞行(busy token);加/删引擎走 host 增量 action
(addLsp/delLsp 服务端读-改-写),不整组覆盖防 stale。详见 docs/rfc-multi-lsp-v2.md
§14 落地记录与 README。

## 9. 扩展其它语言(checker 契约)

`checkers/<engine>/` 提供 CLI `host|status|stop|check <files…> [--project] [--out]`,
退出码 0/1(结果)/2(致命);`lib/checkers.js` 映射扩展名。管理/注入/GUI API 零改动。
可选能力(engine.json):`rescan` + `rescanPort` + `addon` —— 声明后该引擎可被要求重扫
(桥需实现 `rescan` 子命令,见 §11),host 侧的自愈与「安装引擎桥」按钮自动对该引擎生效。

## 11. 引擎桥(让运行中的引擎重扫文件系统,2026-09-10 实测定稿)

**问题**:Godot 只在**扫描项目文件系统**时注册全局类名
(`editor/file_system/editor_file_system.cpp`:`_update_script_classes()` →
`_register_global_class_script()` → `ScriptServer::add_global_class`)。运行中的引擎不会自己重扫:
编辑器由 `NOTIFICATION_APPLICATION_FOCUS_IN`(`editor/editor_node.cpp:1093-1101` → `scan_changes()`)
驱动,即"切回引擎窗口才会扫描";`--headless` 没有窗口事件,永不触发。LSP 协议里也没有重扫入口:
`gdscript_language_protocol.cpp` 注册的服务端方法只有 `textDocument/*` + `initialize/initialized`,
且 `workspace->initialize()`(首次全量扫描)只在引擎级 `_initialized` 为假时执行一次。
因此运行中新建的 `class_name` 脚本对诊断不可见,引用它的文件被误报 `Could not find type "X"`。

**机制**:随引擎分发的编辑器插件 `checkers/godot-lsp/addon/dsh_echo_bridge`(≈165 行 GDScript,
按目标项目的 GDScript 规范书写:禁 `:=`、显式类型、`#region` 划分、`print_debug`/`push_warning`/`push_error` 分工)
在项目内监听 `127.0.0.1` 控制端口,把一行 `rescan` 变成
`EditorInterface.get_resource_filesystem().scan_sources()`。该路径脚本可见:
`editor_file_system.cpp:3706` 把 `scan_changes` 绑定为脚本方法 `scan_sources`,
`editor_interface.cpp:875` 暴露 `get_resource_filesystem`。`--editor --headless` 同样加载
"已启用的编辑器插件",因此 headless 引擎也能被远程触发(实测)。

**端口发现**:addon 从 6089 起向上找可用端口(多个项目 / 编辑器+headless 并存不互抢),
把选中的端口写进 `<project>/.godot/dsh_echo_bridge.json`;桥 `rescan` 的取端口优先级为
`--bridge-port`/config/env → 发现文件 → 默认 6089,而公布的端口只在**其发布进程仍存活**时被采用
(引擎崩溃后残留的公布文件不会把请求引向别人的端口)。

**触发时机**(host 侧 `lib/index.js`):① `ProjectWatcher.drainStructural()` 报告 `.gd` 新增/删除
→ 检查前先重扫;② `checkWithHeal` 发现诊断含 `Could not find type "X"` 且项目里确有
`class_name X` 时,重扫并**重查一次**采用新结果(名字不存在则不动,真错误不受影响)。

**实测**(临时项目 + 真实 headless 引擎 + 真实桥,经 `lib/addon.js`/`manager.js` 端到端):

| 步骤 | 结果 |
|---|---|
| addon 安装(空项目无 `[editor_plugins]` 段) | 追加段并启用;二次安装幂等 |
| 6089 被别的进程占用 | addon 自动改用 6090 并在 `.godot/dsh_echo_bridge.json` 公布;桥自行找到 |
| headless 引擎加载 addon | 控制端口 `ping` → `pong` |
| 引擎启动前的 `class_name` 引用 | 0 错误 |
| 运行中新建 `class_name` 后引用 | `Could not find type "DshBaz3"`(复现) |
| 桥 `rescan`(自动发现端口) | 同一文件重查 → **0 错误** |
| 显式 `--bridge-port` 指向无人监听端口 | 明确失败(exit 2,不静默通过) |
| addon 安装器 × 5 种 `project.godot` 形态(段尾无换行 / 已有列表且其后还有段 / 无该段 / 启用路径含 `)` / 被注释的同名条目) | 全部正确追加且幂等,`[editor_plugins]` 段数恒为 1 |
| 端口公布文件的发布者存活校验 | 无文件、pid 已死 → 视为无端口;pid 存活 → 采用该端口 |

表中 addon 安装器与端口校验两行来自一次性验证脚本(临时项目,跑完即删,脚本不随包分发);
引擎端到端各步可用插件 README「验证」节的命令重跑。

**边界**:未安装 addon 时不自愈——重扫失败进入 120s 冷却并浮窗提示一次("引擎未刷新"),
诊断按引擎原样注入,绝不伪造成"通过"。安装 addon 会写用户项目的 `addons/` 与 `project.godot`,
只能由用户在设置页显式点击触发;运行中的编辑器需重启(或在「项目设置 → 插件」里启用)才加载它,
headless 引擎下次启动即生效。

## 12. 已知边界

- 引擎需写项目 `.godot/`(权限不足会 signal 11);GUI 编辑器与 headless 并存注意缓存;
- `settings.register` schema 必须 schemastery;Windows PS5.1 写文件带 BOM(已容忍);
- **智能连接**:单开编辑器默认 attach 6005;多编辑器/非默认端口用户通过**设置页引擎卡
  「编辑器 LSP 端口」**指定(settings `enginePorts`,优先于 config `editorPort`)或
  `attachEditor:false` 关闭;attach 模式下编辑器关闭会自动 fallback headless;
- 增量改动检查(role=main)保留 per-file settle(级联诊断语义),全量(sweep)才无 settle;
- **反向依赖的形状**:引用最广的脚本(实测 233 个引用者)一改,就会把 233 个文件拉进当轮检查,
  该轮 pre-step 明显变长;引用判定刻意过近似(注释里提到类名也算引用),代价是多查一个干净文件,
  而漏查会让快照停在旧结果上。规模数字取自约 500 个 GDScript 文件的真实项目,随项目增长;
- `.gdshader` 无 LSP 诊断(引擎不发 publish),结果带 `engine_note` 说明,不报错;
- **引擎桥**(§11)：未安装 addon 的项目里,运行中新建的 `class_name` 仍会被误报直到引擎重启或
  编辑器窗口获得一次焦点;`.godot/dsh_echo_bridge.json` 是 addon 公布端口的位置(引擎退出时按 pid 自删)。
- **引擎桥多实例**:同一个项目同时跑着「你的编辑器」与「插件的 headless 引擎」时,两个实例都往
  `.godot/dsh_echo_bridge.json` 公布端口(后启动者覆盖),因此重扫请求可能落到其中任意一个。
  两者用的是同一条文件系统扫描,注册结果一致,所以诊断不受影响;但"哪一个实例执行了扫描"不确定,
  且该发布文件不携带实例身份(只有 port/pid),桥无法按身份挑选。
  默认 `attachPolicy=prefer-editor` 会在下次检查时收敛成一个(迁回编辑器、停掉自己的 headless);
  只有 `cold-start` 才让两者长期并存。
- **引擎自有运行时状态的位置**:`$DSH_HOME/lsp-echo-runtime/godot-lsp/`(`host-<项目>.json` /
  `host-<项目>.log` / 引擎自己写的那份 `lsp_diagnostics-<项目>.json`)。引擎目录内的 `.runtime/` 是
  迁移前的位置,只作**读取兜底**,新写入一律落到 DSH home(`writeHostState` 会顺手清掉旧副本),
  因此桥的两份副本(仓库检出 / profile 安装)看到的是同一份状态。
