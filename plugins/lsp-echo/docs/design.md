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
  搬到 DSH 配置的目标端口时,桥把该端口写成项目级覆盖
  (`editor_overrides/network/language_server/remote_port`)并**落盘进 `project.godot`**,所以编辑器下次
  启动直接绑它、不必再搬一次(端口是机器相关的,项目文件里因此会多一段会随仓库走的配置;DSH 配置仍是
  唯一来源,改了下次检查会覆盖)。两种情况不落盘:目标端口被别人占着、只能用替代端口时(替代端口仅本次
  会话有效,桥用 `lsp-relocate-temp:` 收到它),以及桥**自愈**时自己挑的端口 —— 两者都只写内存、退出即摘掉。
  落盘走 `ProjectSettings.save()`,它会用内存里的整张设置表重写 project.godot,所以写之前桥会先把自己补进
  内存的 `editor_plugins/enabled`(否则启用项可能是插件在本编辑器启动之后写的,这次落盘会把它抹掉)。
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
  - `?action=status&project=<abs>` → `{ok, mode:'editor'|'headless'|'running'|'off', stdout, editor:{port,listening,instance}, bridge:{installed,enabled}}`
    (`editor`/`bridge` 两组事实供浮层解释「为什么还在用独立引擎」;`port` 取**桥自己报的**探测目标 ——
    `status` 也带 `--editor-port`,所以它等于「设置 → 桥 config → 默认」的实际取值,不是主机的猜测;
    引擎副本过旧、状态行里没有该字段时回退到设置值/默认 6005(只影响这一行提示);
    端口用**纯 TCP 连接**探测,不用 LSP 握手 —— 编辑器 LSP 单会话,额外握手会踢掉已连客户端)
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
  (刷新/全量重扫/启动/停止)+ **独立引擎时的原因行**(端口没监听 / 桥已复制但未启用 / 端口有响应但没有实例上报 /
  编辑器在线但尚未检查)+ 按文件分组 error/warning(gdshader 带 engine_note);
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

`evidence`(pattern 列表):项目树里每个 pattern 都存在才把该引擎绑到项目上,用于构建入口在项目
深处的引擎 —— Godot GDExtension 的 `SConstruct` + `*.gdextension` 在 `addons/<plugin>/platform/native`
(深度 4-5),根级 marker 探测与浅层扩展名扫描都到不了。绑定发生在种子层(config/workspace),
**manual 层逐字采纳**(手绑/删掉的引擎不会被自动改回来),要靠设置页「智能配置」补充。

`fallback`:项目根无任何 marker 时用哪个引擎。原来回退到"目录枚举顺序里的第一个",加引擎目录会让
这个顺序变化(新增的 `cpp-gdextension` 排在最前),所以改成由引擎自己声明;`godot-lsp` 标了它。

引擎不必有常驻进程:`cpp-gdextension` 用项目自己的构建当引擎(编译错误 = 真构建会遇到的错误,
含链接阶段),`host/stop` 是预检与空操作,`clientd` 只是把请求串行化(`lib/manager.js` 的
clientd 契约不变,payload 形状与 godot/typescript 桥一致)。

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

**半装状态**(addon 文件在、`project.godot` 里没有启用项,2026-09-23 实测补):此前是**完全无声**的坏态 ——
文件存在让自动安装直接跳过,而 Godot 从不加载它,于是编辑器里的实例不上报端口,DSH 探不到编辑器、只能一直用自己的
headless(现象:你的编辑器和插件的 headless **同时跑着**,徽章一直是「独立引擎」,刷新界面也不会变,因为收敛决策
只在每次检查前做)。现在自动安装**按启用项判断**而非文件是否存在:发现半装状态就在 `project.godot` 补上启用项,
时机为**打开该项目的会话(`agent/created`)**与每次检查前,并浮窗提示「重启 Godot 编辑器后生效」(重启后实例才会加载
addon 并上报端口)。补写失败(只读/被占用、`[editor_plugins]` 列表缺右括号等)时**明确报错**,并按项目进入
5 分钟冷却,避免每次检查都重抄一遍 addon、重发浮窗、并把下一轮要用的引擎停掉。**只补启用项时不打断正在跑的引擎**:
运行中的编辑器会用自己那份旧 `project.godot` 覆盖文件(实测:编辑器开着时启用项被它抹掉,下一次检查又补回来),
此时若顺手把引擎停掉,没有任何东西会再把它起回来,徽章就变成「已停止」(实测踩到);只有**新复制 addon** 才需要停引擎
重启(那个引擎起在 addon 存在之前,加载不了它),而触发复制的那条路径紧接着就会起一个新引擎(baseline 或本轮检查)。
会话打开这条触发与检查路径同样受「全局自动注入 + 项目 autoInject」门控 —— 注入关掉的项目不会被改写 `project.godot`。

**边界**:未安装 addon 时不自愈——重扫失败进入 120s 冷却并浮窗提示一次("引擎未刷新"),
诊断按引擎原样注入,绝不伪造成"通过"。安装 addon 会写用户项目的 `addons/` 与 `project.godot`:
自动安装受设置页「自动安装 Godot 引擎桥」开关(默认开)约束,也可由用户在设置页显式点击;
运行中的编辑器需重启(或在「项目设置 → 插件」里启用)才加载它,headless 引擎下次启动即生效。

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
  编辑器窗口获得一次焦点;`.godot/dsh_echo_bridge.json` 是 addon 公布端口的位置(实例退出时**不删**
  这个文件,读取方按 pid 忽略已退出的那一格)。
- **引擎桥多实例**:同一个项目同时跑着「你的编辑器」与「插件的 headless 引擎」时,两个实例写的是文件里
  各自的槽位(`editor` / `engine`,见 §11),谁都不覆盖对方;只有同一种实例有两个(两个 headless 引擎)
  时才覆盖同一格。记录里带项目路径 / pid / 版本 / 端口,读取方据此校验身份并忽略已退出实例留下的格子。
  默认 `attachPolicy=prefer-editor` 会在下次检查时收敛成一个(迁回编辑器、停掉自己的 headless);
  只有 `cold-start` 才让两者长期并存。**注意**:编辑器那边没加载 addon(未启用/旧副本)时它**不会**公布端口,
  DSH 也就看不见它 —— 此时只能探到「配置的编辑器端口」有没有监听;配置端口与实际不符(如 DSH 配 6007、
  编辑器在 6006)时两边永远接不上,直到启用桥(插件会自动补,见 §11)或把端口改成一致。浮层会把这种状态说清楚。
- **引擎自有运行时状态的位置**:`$DSH_HOME/lsp-echo-runtime/godot-lsp/`(`host-<项目>.json` /
  `host-<项目>.log` / 引擎自己写的那份 `lsp_diagnostics-<项目>.json`)。引擎目录内的 `.runtime/` 是
  迁移前的位置,只作**读取兜底**,新写入一律落到 DSH home(`writeHostState` 会顺手清掉旧副本),
  因此桥的两份副本(仓库检出 / profile 安装)看到的是同一份状态。
- **C++(GDExtension)编译检查的环境前提**:项目自己的构建必须能跑(桥只当调度者,编译参数/工具链
  发现都留给项目的 `build.ps1`)。工具链按**项目产物**判定(`.a` = MinGW,`.lib`/`.obj` = MSVC,取最新),
  因为一台机器常常只有一套能编:本机 VS BuildTools 装了但**没装 Windows SDK**,`cl` 连 `stddef.h`
  都找不到,能编的是 MinGW 14.2 —— 这时若按 `build.ps1` 的默认(MSVC)跑,报出来的是一片
  "无法打开包括文件" 的环境错误,而不是源码错误。`--toolchain` 可显式覆盖,`status` 会报告它选了什么。
- **C++ 检查的编码坑**(实测):SCons 是 Python,stdout 接管道时按 ANSI 代码页编码,编译器输出里只要
  有一个该代码页表示不了的字符,报告就以 `UnicodeEncodeError` 收场、对象被判"失败",真正的错因反而
  看不见。桥给子进程开 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`,并把 Windows PowerShell 的
  控制台输出编码抬到 UTF-8(`-Command` 而不是 `-File`)。
- **C++ 检查的时间与范围**:一次改动检查只编 debug(110s 预算),全量重扫才 debug+release(190s);
  改过 godot-cpp 之后第一次检查可能要重编依赖、大概率超预算 —— 手动跑一次 `build.ps1` 之后就是增量。
  链接与构建系统错误统一挂在 `<link>` 条目下,项目外的依赖头文件用 `../` 相对路径如实保留。
- **C++ 引擎的绑定**:config / workspace 层按 `evidence` 自动绑;manual 层(设置页手绑过项目)逐字采纳,
  要补 C++ 引擎用设置页的「智能配置」。绑定用的是「所有命中的引擎」而不是「第一个命中的引擎」——
  `project.godot` 与 `*.gdextension` 可以同处项目根(GDExtension 就放在项目根是常见布局),
  只绑第一个会让另一种语言**静默停查**(见 `seedEngines`)。**未做**:每项目指定工具链/构建参数的设置页
  字段(现在只有 CLI `--toolchain`,插件侧不传参)。
- **合成键**(`<link>` 这类没有扩展名的条目):引擎在 `engine.json` 里用 `syntheticKeys` 声明归属,
  桥在 payload 里同样声明一次 —— 只有写它的引擎能替换它,别的引擎的快照合并不会把它挤掉,
  引擎作用域过滤也只在**它自己的轮次**里保留它(扩展名表看不见没有扩展名的键)。快照把这份声明
  记成 `synthetic_keys`(后写的引擎不声明时保留上一份,清剪时按仍在绑定的引擎重算),于是不持有引擎表的
  读者(GUI 行标签、配置变更时的清剪、汇总计数)也能按声明而不是按"名字里有没有点"来判断:
  合成键的错误算进 `errors`,但既不算"检查过的文件"也不算"有错误的文件"。已有记录不追溯 ——
  manual/config 层保留原绑定顺序,补引擎用设置页「智能配置」(它在末尾追加,所以主引擎不变)。
  没有这条,链接错误会在下一次 `.gd` 检查写快照时被静默删除;有了这条,它既不会消失,也不会在无关
  轮次里伪装成本轮结果,更不会每轮重复注入。
- **同一构建目录的并发**:宿主在 clientd 超时后会退回一次性 `check`,第二个 DSH 实例也可能在查同一个
  项目,而同目录里两个 SCons 会互相抢 object/输出文件。桥因此给每次构建加一把运行目录下的锁
  (不写进项目树),锁里记**取锁进程 pid 与构建子进程 pid** —— 杀掉检查进程不会杀掉它启动的编译器,
  任一 pid 还活着就仍算"有人在构建",拿不到就等、等不过自己的预算就如实报"另一个检查正在构建";
  读不出来的锁有 5 秒宽限,接管陈旧锁用 rename 保证只有一个等待者抢到(抢错用 `{flag:'wx'}` 写回,
  不会覆盖别人新写的锁),记录超过 24 小时也按陈旧处理;重写记录前先读一次确认锁还是自己的,写入
  走临时文件 + rename,读者不会读到半截记录。**等待与构建共用同一份预算**:等锁的时间从预算里扣,
  只有剩余不足 3 秒才提前拒绝(短窗口照样编:桥会在自己的预算内给出结论,拒绝等于拿可能成功换一定
  失败)。预算到点先杀构建树(Windows `taskkill /T /F`,POSIX 进程组,失败再直接 kill),被杀的子进程
  若仍握着管道,5 秒后也照样作答(**预算 + 最多 5 秒**,仍在宿主 120s/200s 之内) —— 这一路会把锁留成
  "孤儿构建"记录(只记 `childPid`、不带取锁 pid:那个进程就是还活着的检查自己),下一次检查等它或
  如实报它,而不是在那个杀不掉的构建旁边再开一个。宿主侧同一件事:clientd **答出**的失败是检查结论,
  不再退回一次性 `check` 重跑(否则会在刚被杀掉的构建后面再起一个)。快照里的引擎自述只有一个槽位:
  后写的引擎覆盖,它自己 payload 里没有就清空 —— 所以它只会消失,不会伪装成别的引擎的话。
  已知边界:锁只在共享一个 `DSH_HOME` 的进程之间有效,且按构建目录分锁,两个项目共用一份 `godot-cpp`
  检出时仍可能各编各的(刻意不做全局串行)。
