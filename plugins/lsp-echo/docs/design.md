# lsp-echo 设计文档(终版,2026-09-05)

把语言服务器(LSP)的**编译错误自动反馈给 AI**,先以 Godot(GDScript)为引子,
验证 harness 插件开发范式,再扩展到其它语言的 LSP。

## 1. 背景与需求

- AI 改完 `.gd`,编译错误只有人能看 → AI 拿不到 → 依赖人贴文本。
- 目标:① 自动(编辑后错误注入下一轮模型上下文,无需主动查);② 自包含(插件自带引擎程序);
  ③ 可扩展(语言无关,Godot 是第一个 checker);④ 纯插件,不动产品源码。

## 2. 分层:引擎 + 管理

- **引擎(checkers/godot-lsp/)**:headless Godot 编辑器 `--editor --headless --no-window --lsp-port` 作
  LSP 宿主(全工程 `class_name` 注册、语义级诊断),零依赖 Node 桥负责拉起/客户端/落盘。
  可被任何 agent 独立调用(`host|status|stop|check|smoke|watch`)。
- **管理(harness 插件 lib/)**:生命周期、项目自动判定、变更侦测、自动注入、GUI API 钩子。
  存储用 **harness settings 命名空间 `lsp-echo`**(非自建文件)。

### 2.1 智能连接(editor attach,2026-09-05 实测定稿)

「只保留一个引擎」:若用户已打开该项目的 Godot 编辑器,直接 **attach 它的 LSP 端口**
(像官方 godot-vscode-plugin 一样,零额外内存、引擎恒热),否则才自起 headless。

- **端口来源(降序)**:桥 config `editorPort`(默认 `6005`,用户非默认端口改这里)→
  `--editor-port` flag → 内置默认 `6005`。不盲扫端口,避免误连别的服务。
- **归属判定**:信任模型与官方 VSCode 插件一致——单开场景下编辑器端口即当前项目编辑器;
  我们自己 headless 用随机端口,不会占编辑器端口,故 TCP 可连即视为命中
  (实测:attach 0.1s;`gdscript_client/changeWorkspace`/`capabilities` 握手不稳定,
  不作为判据)。多编辑器/多项目用户可设 `attachEditor:false` 走纯 headless。
- **state 记录 `mode`**:`editor`(pid=0,进程属于用户,`stop`/插件卸载**只 detach 不杀**)
  或 `headless`(pid=我们 spawn 的,可停)。编辑器关闭后下次 ensure 自动 fallback headless。
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

- **点开会话 = `agent/session-start source=resume`**(每个被点开的对话都会发,含 fork 副本);
- **fork 子会话带 `parentSession`** —— 初版"仅顶层用户会话"守则误拦了 fork 副本
  (现象:「熟悉道具」永不触发而「现场验收」触发,与最近活跃/先后无关)。
  **结论:基线/注入的门槛只按会话工作区 cwd 判定,不看 parentSession**;
- **自动全量基线**:进程内每项目首触发一次(任一命中工作区的会话 resume 即启动),
  扫描跑独立 clientd 角色(role=baseline),开始/完成/失败以插件消息 + toast 播报(完成也播报"0 错误");
- **全量扫描快路径(sweep)**:一次性 didOpen 全部文件 + 无 settle 税(实测 501 文件
  从 ~60s 降到 ~4.7s);`.gdshader` 引擎不发 LSP 诊断,立即记空结果不空等(带 `engine_note`);
- **逐 step 变更侦测(Mode B)**:无后台轮询;每个 `pre-step` 对该项目全树 mtime diff,
  只把变更文件推给引擎 → 注入(有错才注入,同文本 3s 节流);
- 调试观测:`$DSH_HOME/lsp-echo-runtime/lsp-echo-trace.log`(pre-step/session-start/baseline 全记录)。

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

- **数据**:诊断结果 `$DSH_HOME/lsp-echo-runtime/lsp_diagnostics-*.json`(bridge 原子写);
  引擎状态经 host API。
- **控制(host JSON API,`webServer.register` exact `/lsp-echo/api`)**:
  - `?action=projects` → `{ok, projects:[{source,engine,path,autoInject}]}`
  - `?action=status&project=<abs>` → `{ok, mode:'editor'|'headless'|'running'|'off', stdout}`
  - `?action=host|stop|baseline&project=<abs>` → 启/停引擎、全量重扫(同 manager)
  - `?action=diagnostics&project=<abs>` → `{ok, updated_at, summary, files}`(读快照,
    纯读不启引擎;无快照时 `{empty:true}`,浏览器据此提示先做 baseline)

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

## 10. 已知边界

- 引擎需写项目 `.godot/`(权限不足会 signal 11);GUI 编辑器与 headless 并存注意缓存;
- `settings.register` schema 必须 schemastery;Windows PS5.1 写文件带 BOM(已容忍);
- **智能连接**:单开编辑器默认 attach 6005;多编辑器/非默认端口用户通过 config
  `editorPort` 指定或 `attachEditor:false` 关闭;attach 模式下编辑器关闭会自动 fallback headless;
- 增量改动检查(role=main)保留 per-file settle(级联诊断语义),全量(sweep)才无 settle;
- `.gdshader` 无 LSP 诊断(引擎不发 publish),结果带 `engine_note` 说明,不报错。
