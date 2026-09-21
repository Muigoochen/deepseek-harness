# godot-vscode-plugin 的 LSP 交互全量梳理

对象:Godot 官方 VS Code 插件 `godotengine/godot-vscode-plugin`(源码 `E:\VsCodePrograms\godot-vscode-plugin-master`,
`package.json:5` 版本 2.7.1,`package.json:929` 依赖 `vscode-languageclient ^9.0.1`)。
目的:给 `plugins/lsp-echo/` 的自建 Godot LSP 客户端桥提供**可抄的做法**与**不能抄的部分**。
所有行号均为本次实际读到的行号;凡未经代码证实的判断,一律写明"未能确认"。

---

## 1. 三条先导结论

1. **插件自己几乎不写 LSP 同步代码**。`didOpen`/`didChange`/`didClose`/`didSave`、`initialize`、
   `publishDiagnostics` 的收发全部由 `vscode-languageclient` 内置特性完成;插件侧只有
   `src/lsp/` 五个文件提供"socket + 分帧 + 过滤器"(`src/lsp/GDScriptLanguageClient.ts:107-128`)。
2. **`textDocument/didSave` 会发,且带全文 `text`**(见 §3.3 的完整证据链)。它由 VS Code 的
   保存事件驱动,引擎收到后**忽略 `text` 字段**,改为从磁盘重新加载脚本
   (`gdscript_text_document.cpp:92-114`),并且**不发布诊断**。
3. **拿诊断靠的是 `didOpen`/`didChange`,不是 `didSave`**。引擎在 `lsp_did_open`(`gdscript_language_protocol.cpp:455-475`)
   与 `lsp_did_change`(`:477-505`)里都会随即解析并 `publish_diagnostics`(`:387-421`,发布点在 `:414`)。

---

## 2. 连接与生命周期(`src/lsp/`)

### 2.1 五个文件各管什么

| 文件 | 职责 | 关键位置 |
|---|---|---|
| `src/lsp/index.ts` | 只导出 `ClientConnectionManager` / `ManagerStatus` | `src/lsp/index.ts:1` |
| `src/lsp/ClientConnectionManager.ts` | 生命周期总控:状态机、状态栏、重连定时器、headless 进程拉起、用户提示 | `ClientConnectionManager.ts:32-368` |
| `src/lsp/GDScriptLanguageClient.ts` | 继承 `LanguageClient`;定义目标(`EDITOR`/`HEADLESS`)、三个过滤器、自定义请求辅助、工作区校验 | `GDScriptLanguageClient.ts:88-379` |
| `src/lsp/MessageIO.ts` | 把裸 TCP socket 适配成 `MessageReader`/`MessageWriter`(库要求的接口),并在此挂过滤器 | `MessageIO.ts:21-151` |
| `src/lsp/MessageBuffer.ts` | `Content-Length` 分帧缓冲(源自 Microsoft 的 `vscode-jsonrpc` 实现,见文件头版权) | `MessageBuffer.ts:17-157` |

状态机:`ManagerStatus` 八个状态(`ClientConnectionManager.ts:21-30`);客户端侧四态 `ClientStatus`
(`GDScriptLanguageClient.ts:20-25`);目标两态 `TargetLSP`(`GDScriptLanguageClient.ts:27-30`)。
`globals.lsp` 是全局单例,在 `activate` 里最早创建(`src/extension.ts:61`)。

### 2.2 连到哪个端口、怎么决定

- 设置项:`godotTools.lsp.serverHost` 默认 `127.0.0.1`(`package.json:318-322`);
  `godotTools.lsp.serverPort` 默认 **6008**(`package.json:323-329`)。
- 连接时端口判定(`GDScriptLanguageClient.ts:135-146`):
  1. 先取 `lsp.serverPort`;
  2. 若 `this.port !== -1`(headless 自选端口)则用它覆盖;
  3. 若目标是 `EDITOR` 且端口是 6005 或 6008,**一律改成 6005** —— 即 attach 编辑器时优先 Godot 4 的默认端口。
- 断线后还有一次端口兜底(`GDScriptLanguageClient.ts:362-375`):目标是 `EDITOR`、配置端口是 6005/6008、
  且上次试的是 6005 时,改试 6008 再连一次。这是修 Godot3/4 端口差异的历史遗留
  (`CHANGELOG.md:155` "Improve LSP connection behavior (fixes Godot3/4 port issue)")。
- 对外展示的连接串是 `host:port`(`ClientConnectionManager.ts:186-193`),状态栏 tooltip 与提示文案都用它。

### 2.3 headless 模式:什么时候拉起 Godot、怎么拉

触发条件有两个:

- 设置 `godotTools.lsp.headless` 为真(`package.json:330-334`,默认 `false`);
  `connect_to_language_server()` 里把目标设为 `HEADLESS` 并先 `await start_language_server()`
  (`ClientConnectionManager.ts:86-98`)。
- 用户执行命令 `godotTools.startLanguageServer`(`package.json:72-75`):命令回调里
  `start_language_server()` → 目标改 `HEADLESS` → 重新连接(`ClientConnectionManager.ts:60-67`)。

`start_language_server()` 的完整流程(`ClientConnectionManager.ts:104-184`):

1. 先杀掉自己名下旧的 `LSP` 子进程(`:105`,实现在 `:100-102`);
2. 必须能找到 `project.godot`,否则报 "Current workspace is not a Godot project"(`:107-111`);
3. 按项目版本设最低版本门槛:Godot 3 要求 ≥ 3.6、Godot 4 要求 ≥ 4.2(`:113-119`);
4. 由项目大版本拼设置名 `editorPath.godot<大版本>`(`:120-124`),`verify_godot_version` 校验可执行文件
   (`:123-124`,实现在 `src/utils/godot_utils.ts:218-246`);版本不符/非法都弹窗
   `prompt_for_godot_executable`(`:126-137`,`src/utils/prompts.ts:27-36`);
5. 低于门槛时给四个按钮:Select Godot executable / Open Settings / Disable Headless LSP / Ignore(`:140-155`);
6. **端口由操作系统分配**:`this.client.port = await get_free_port()`(`:157`),
   `get_free_port` 用 `net.createServer().listen(0)` 取临时端口后关闭(`src/utils/index.ts:28-36`);
7. 命令行(`:161-163`):
   `"<godotPath>" --path "<projectDir>" --editor --headless --no-window --lsp-port <port>`,
   `shell: true, detached: true`,进程记账名 `"LSP"`(`src/utils/subspawn.ts:58-64`);
8. stdout 转发到 "Godot LSP" 输出通道(`:165-171`);stderr 的处理被整段注释掉(`:173-179`);
9. 子进程 close 只写日志(`:181-183`),不触发重连(重连由 socket 断开驱动)。

### 2.4 attach 编辑器,还是自起实例

- 默认目标是 `EDITOR`(`GDScriptLanguageClient.ts:91`,以及 `ClientConnectionManager.ts:88` 每次连接前重置),
  即**默认只连、不拉进程**;只有 `lsp.headless` 为真或用户点了 start 命令才自起。
- 连接失败且目标为 `EDITOR` 时,错误提示会多一个 "Open workspace with Godot Editor" 按钮,
  点击后执行 `godotTools.openEditor` 并再次尝试连接(`ClientConnectionManager.ts:353-366`);
  该命令在集成终端里拉起 `"<godot>" --path "<projectDir>" -e`(`src/extension.ts:189`),进程记账名 `GodotEditor`
  (`src/extension.ts:280`),终端关闭时 `killSubProcesses("GodotEditor")`(`src/extension.ts:302-304`)。
- 插件**从不杀用户的编辑器进程**,也从不抢占端口:attach 时它只是去连配置端口;自起时用随机端口,
  因此不会与编辑器端口冲突(见 §2.3 第 6 条)。

### 2.5 握手:`initialize` 发什么、`initialized` 之后做什么

插件只提供 `serverOptions`(把 `MessageIO` 的 reader/writer 交给库,`GDScriptLanguageClient.ts:107-112`)
与 `clientOptions`(`documentSelector` 仅含 `file`/`untitled` 的 `gdscript`,`:114-119`)。`initialize`
参数由库生成(vscode-languageclient 9.0.1 `lib/common/client.js`,下称 "client.js"):

- `rootPath` / `rootUri`:取自**工作区第一个文件夹**(`_clientGetRootPath()`;`rootUri = asUri(Uri.file(rootPath))`),
  不是 `project.godot` 所在目录 —— 插件未设置 `clientOptions.workspaceFolder`;
- `processId: null`(9.0.1 的 `initParams` 字面量;我在 client.js 中检索 `process.pid` 无命中,
  未能确认是否有特性覆盖它);
- `clientInfo: { name: env.appName, version: vscode.version }`、`locale`、`trace`;
- `capabilities: computeClientCapabilities()`,其中与本项目相关的声明:
  `workspace.applyEdit = true`、`textDocument.publishDiagnostics`(开启 `relatedInformation`、
  `tagSupport`(Unnecessary/Deprecated)、`codeDescriptionSupport`、`dataSupport`,`versionSupport = false`)、
  `textDocument.synchronization.didSave = true`(client.js `DidSaveTextDocumentFeature.fillClientCapabilities`);
- `workspaceFolders`:未走 `workspaceFolder` 选项时为 `null`;
- `initializationOptions` 未设置。

引擎侧的 `initialize`(`gdscript_language_protocol.cpp:210-259`):

- 读 `rootUri`(其次 `rootPath`),若与当前打开的 Godot 项目根不一致,就发 `window/showMessage` 警告
  并发自定义通知 `gdscript_client/changeWorkspace`(`:216-239`);
- 首次调用触发 `workspace->initialize()` 全量扫描,之后置 `_initialized`(`:241-244`);
- 读客户端能力:`textDocument.completion.completionItem.snippetSupport`(`:248-249`)与
  `general.markdown.allowedTags`(`:251-256`)。

`initialized` 之后(`:261-276`):引擎把 `DocTools` 里的全部原生类打包成 `gdscript/capabilities` 通知发出
(`:275`)。插件在 `notification_filter` 里接住并交给文档提供者建立原生类索引
(`GDScriptLanguageClient.ts:289-291` → `src/providers/documentation.ts:43-64`)。
文档查看器在真正渲染前会 `while (!this.ready) await sleep(100)` 等这份能力表
(`documentation.ts:97-99`)。

### 2.6 重连、退避、失败处理(注意:没有黑名单)

- **定时器**:构造时 `setInterval(retry_callback, godotTools.lsp.autoReconnect.cooldown)`,
  默认 3000 ms(`ClientConnectionManager.ts:49-51`,`package.json:340-344`);
  `retry_callback` 仅在 `this.retry` 为真时动作(`:324-328`)。
- **退避策略**:不是指数退避,而是"固定间隔 × 次数上限"。`retry_connect_client()` 在
  `autoReconnect.enabled`(默认 true)且 `reconnectionAttempts <= attempts - 1`(默认 10)时
  计数 +1 并重连,否则置 `DISCONNECTED` 并弹提示(`:330-347`,`package.json:335-349`)。
- **断线即重建客户端**:每次 `ClientStatus.DISCONNECTED` 都调 `create_new_client()`
  (`:296-299`),源码注释给出理由:服务端无法知道重连的客户端是同一个,复用会造成
  "客户端管理的文件状态"失同步(`:297-298`)。`create_new_client` 会摘掉旧 `io`/`events` 监听、
  调 `stop()`,并**继承旧端口**(`:76-84`)。
- **被拒绝的连接**:引擎宣告"服务的是别的项目"时,`check_workspace` 记 `rejected = true` 并
  `socket.resetAndDestroy()`(`GDScriptLanguageClient.ts:268-283`);此后 `request_filter` 只放行
  `shutdown`(`:187-192`),断线回调把它转成 `ClientStatus.REJECTED`(`:357-361`)→
  `ManagerStatus.WRONG_WORKSPACE`,`retry = false`(`ClientConnectionManager.ts:311-314`),
  **不会自动重试**,只能靠用户点状态栏(`:228-230`)。
- **没有黑名单**:全仓没有"坏端口/坏项目"的持久化拒绝表,也没有端口扫描;与 lsp-echo 的
  `badEditor` 黑名单相比,它只有上述一次性 `REJECTED` 态。允许客户端工作区是引擎项目的**子目录**
  (`GDScriptLanguageClient.ts:272-276`)。
- **用户反馈**:右侧状态栏常驻,文案与 tooltip 随状态变化(含重连计数 `x/y`)
  (`:55-58`、`:234-280`);点击状态栏按状态给动作——`CONNECTED` 弹连接成功信息(HEADLESS 时附
  "Restart LSP" 会重新走一遍连接)(`:208-221`),`DISCONNECTED`/`WRONG_WORKSPACE` 立即重试,
  `RETRYING` 弹重试失败提示(`:195-232`)。重试失败文案:
  "Couldn't connect to the GDScript language server at `<host:port>`. Is the Godot editor or language server running?",
  按钮 Retry / Ignore(EDITOR 目标另加 Open workspace with Godot Editor)(`:349-367`)。
- 另有一处静默:`textDocument/documentSymbol` 报
  "selectionRange must be contained in fullRange" 时不弹通知(注释指向 issue #820)
  (`GDScriptLanguageClient.ts:154-184`)。

### 2.7 进程与端口的所有权

- headless 进程以 `"LSP"` 记账(`ClientConnectionManager.ts:163`),停止即 `killSubProcesses("LSP")`
  (`:100-102`);该命令同时暴露为 `godotTools.stopLanguageServer`(`package.json:76-80`)。
- `subspawn` 在进程退出与 SIGINT/SIGTERM/SIGQUIT 时杀掉所有记账子进程(`src/utils/subspawn.ts:42-56`);
  Windows 用 `taskkill /pid <pid> /T /F`、macOS 用 `kill -9`、其它平台 `process.kill(-pid)`(`:26-32`)。
- 插件卸载时只 `globals.lsp?.client.stop()`(`src/extension.ts:132-137`);对 headless 进程的回收依赖
  `subspawn` 的进程级钩子 —— 扩展宿主只是重启(进程未退出)时是否回收,**未能确认**。
- 端口所有权:自起实例用 OS 分配的临时端口并显式 `--lsp-port` 传入,所以"不抢编辑器端口"是设计结果;
  attach 时期望用户把编辑器 LSP 端口保持在配置值(默认 6005),README 的 FAQ 也是这个口径
  (`README.md:200-208`)。

### 2.8 分帧与 IO 层的实现细节(可直接借用的部分)

- **帧格式**:出方向自己拼 `Content-Length: <字节数>\r\n\r\n<json>`,长度用
  `Buffer.byteLength(json, "utf-8")` 计算(不是字符数)(`MessageIO.ts:139-140`)。
- **接收缓冲**:`MessageBuffer` 维护可增长 Buffer(初始 `DefaultSize = 8192`,`MessageBuffer.ts:10`),
  `append` 在剩余空间不足时按 8192 的整数倍扩容(`:37-48`);`tryReadHeaders` 线性扫描 `CRLFCRLF`
  作为头/体分隔(`:51-82`);`tryReadContent` 按 `Content-Length` 截取(`:84-93`);
  `ready()` 组合两步(`:95-124`)。
- **半包处理**:拿到头但内容不足时不报错,而是启动/重置一个 **10 秒**的
  `_partialMessageTimeout` 定时器(`:24-25`、`:139-156`),超时后向 reader 报 partial message。
- **头异常**:缺 `Content-Length` 或值不是数字都只 `log.warn` 并返回 `undefined`,不抛异常
  (`:101-110`)。
- **未连接时的写入**:消息进 `messageCache`,socket `connect` 后按 FIFO 全部补发
  (`MessageIO.ts:40-53`、`:67-73`)—— 因此"连接建立瞬间发出的 `initialize`"不会丢,
  这也解释了为什么 `connect()` 只 resolve 在 `connect` 事件里(`:40-53`)。
- **过滤器的位置**:入方向只有在 `JSON.parse` 成功之后才有机会修改或丢弃;丢弃即"静默不交给库",
  日志按 debug 级别记录(`MessageIO.ts:113-117`)。
- **日志标签**:`lsp.io`(`MessageIO.ts:17`)、`lsp.buf`(`MessageBuffer.ts:8`)、
  `lsp.client`(`GDScriptLanguageClient.ts:18`)、`lsp.manager`(`ClientConnectionManager.ts:19`),
  均可用来在输出通道里过滤。

---

## 3. 消息流(重点)

### 3.1 过滤器挂在哪

三个过滤器在客户端构造时绑定到 `MessageIO`(`GDScriptLanguageClient.ts:125-127`),
`MessageIO` 上的默认值是恒等函数(`MessageIO.ts:25-27`):

- 出方向:`MessageIOWriter.write` 先调 `requestFilter`,返回 `false` 即丢弃并记日志
  (`MessageIO.ts:130-135`);之后自行拼 `Content-Length: <n>\r\n\r\n<json>` 帧(`:139-140`)。
- 入方向:`MessageIOReader.on_data` 攒够一帧后 `JSON.parse`,**有 `id` 视为响应走 `responseFilter`,
  有 `method` 视为通知走 `notificationFilter`**,返回 `false` 则丢弃,其余交给库
  (`MessageIO.ts:95-120`)。
- 连接建立前写入的消息进 `messageCache`,连上后按序补发(`MessageIO.ts:67-73`、`:40-53`);
  socket `error` 只清 `this.socket`(`:57-59`),`close` 才发 `disconnected`(`:60-63`)——
  即"连不上"与"连上后断开"都收敛到同一条断开回调。

### 3.2 `request_filter` 原文(`GDScriptLanguageClient.ts:186-211`)

```ts
	private request_filter(message: RequestMessage) {
		if (this.rejected) {
			if (message.method === "shutdown") {
				return message;
			}
			return false;
		}
		this.sentMessages.set(message.id, message);

		// discard outgoing messages that we know aren't supported
		// if (message.method === "textDocument/didSave") {
		// 	return false;
		// }
		// if (message.method === "textDocument/willSaveWaitUntil") {
		// 	return false;
		// }
		if (message.method === "workspace/didChangeWatchedFiles") {
			return false;
		}
		if (message.method === "workspace/symbol") {
			// Fixed on server side since Godot 4.5
			return false;
		}

		return message;
	}
```

逐条解读:

| 分支 | 现状 | 含义 |
|---|---|---|
| `rejected` 时只放行 `shutdown` | 生效(`:187-192`) | 拒绝别的项目的引擎后,除了正常关闭,一切请求不再发出 |
| `didSave` 丢弃 | **已注释**(`:196-198`) | 理由注释只有一句"discard outgoing messages that we know aren't supported",说明当年认为引擎不支持,后来放开了 —— **现在会发** |
| `willSaveWaitUntil` 丢弃 | **已注释**(`:199-201`) | 现在会发;引擎声明了 `willSaveWaitUntil = true`(`godot_lsp.h:603`),处理器会把编辑器的文档从脚本清理出去(`gdscript_text_document.cpp:80-90`) |
| `didChangeWatchedFiles` 丢弃 | 生效(`:202-204`) | 见 §3.4 |
| `workspace/symbol` 丢弃 | 生效(`:205-208`) | 注释明说 Godot 4.5 起服务端已修好,但客户端仍然屏蔽;对应 `CHANGELOG.md:98` |
| 其余 | 原样放行 | 包括所有 `textDocument/*` 请求、`initialize`、`shutdown` |

`this.sentMessages.set(message.id, message)`(`:193`)是给 `response_filter` 判断"这个响应来自哪个请求"用的。

### 3.3 ★ `textDocument/didSave` 的确切结论

**(a) 发不发:发。** 两条独立证据:插件侧 `didSave` 的丢弃分支被注释掉
(`GDScriptLanguageClient.ts:196-198`);库侧 `DidSaveTextDocumentFeature.initialize` 在服务端
`textDocumentSync.save` 存在时注册保存处理器(该特性也在 `client.js` 的 `registerFeatures` 中被注册)。
Godot 4 服务端确实声明了 `save`:`TextDocumentSyncOptions` 默认带 `SaveOptions save`
(`godot_lsp.h:605-609`),而 `SaveOptions.includeText` 默认 **true**(`godot_lsp.h:567-578`),
序列化时 `dict["save"] = save.to_json()`(`:617`)并挂到 `textDocumentSync`(`:1792`)。

**(b) 什么时候发:VS Code 的"保存"事件,不是内容变化。** 库把
`workspace.onDidSaveTextDocument` 直接作为该特性的触发源(textSynchronization.js 里
`DidSaveTextDocumentFeature` 构造器的第一个参数),即用户在编辑器里保存文件时才发。
程序化写盘(外部工具/AI 直接改文件)不会产生该事件。

**(c) 带哪些字段:带 `textDocument`,并在服务端要求时带全文 `text`。** 库的规则是
`this._includeText = !!data.registerOptions.includeText`,其中
`includeText` 取服务端 `save` 选项的 `includeText`(若服务端把 `textDocumentSync` 声明成数字,
库会强制 `{ openClose: true, change: <n>, save: { includeText: false } }`,即不带 text)。
Godot 声明的是**对象形式**且 `includeText = true`,因此官方插件发出的
`textDocument/didSave` **包含全文 `text`**。参数由
`code2ProtocolConverter.asSaveTextDocumentParams(textDocument, this._includeText)` 生成 ——
"`text` 字段确实被写进请求体"这一点,我是从库把 `_includeText` 作为第二个实参传进
`asSaveTextDocumentParams` 推断的,未逐行阅读该转换器实现;**复核时可用 §4.5 的 `tx:` 日志
抓一次真实报文确认**。

**(d) 引擎怎么处理:忽略 `text`,改为从磁盘重载脚本。**
`GDScriptTextDocument::didSave`(`gdscript_text_document.cpp:92-114`)只做三件事:取
`textDocument.uri` → `path`;`ResourceLoader::load(path)` + `scr->load_source_code(path)`;
按是否 tool 脚本分别 `reload_tool_script()` / `reload(true)` 并 `update_exports()`。
全过程**不读 `params.text`**,也不发布诊断;`reload_script()` 里还会
`ScriptEditor::reload_scripts(true)` + `trigger_live_script_reload()`(`:116-120`)。

**(e) 诊断与 `didSave` 无关。** 诊断在 `didOpen`(`gdscript_language_protocol.cpp:455-475`)
与 `didChange`(`:477-505`)里随即产生:`LSPeer::parse_script` 在有 `managed_files` 条目时用
**客户端给的文本**解析并立即 `publish_diagnostics`(`:387-421`,发布在 `:414`)。
`lsp_did_save` 在引擎里**不存在**(`gdscript_language_protocol.cpp` / `.h` 内检索 `did_save` 无命中),
`didSave` 的处理只在文本层。

### 3.4 `workspace/didChangeWatchedFiles` 为什么被丢弃

- 丢弃点:`GDScriptLanguageClient.ts:202-204`,注释只说"我们已知不支持"。
- 引擎侧证据:协议的构造函数只注册 `textDocument/*` 方法、`initialize`/`initialized`
  (`gdscript_language_protocol.cpp:662-685`);虽然定义了 `SET_WORKSPACE_METHOD` 宏(`:653`),
  但**从未使用**,即没有任何 `workspace/*` 方法被暴露。也就是说 `workspace/didChangeWatchedFiles`
  发过去对引擎毫无意义,`workspace/symbol` 则会报未知方法(所以才被静默丢弃)。
- 客户端库侧:它在 `registerFeatures` 里注册了 `FileSystemWatcherFeature`,但该特性是否注册取决于
  服务端是否声明 `fileEvents`(**未逐行确认**);Godot 未声明,因而这条通道两边都是死的。
- 替代机制:引擎靠**编辑器焦点事件**发现磁盘变化 —— `EditorNode` 在
  `NOTIFICATION_APPLICATION_FOCUS_IN` 里调 `EditorFileSystem::scan_changes()`
  (`editor_node.cpp:1093-1102`)。

### 3.5 收方向:两个过滤器

`notification_filter`(`GDScriptLanguageClient.ts:285-307`)只做两件事:

- `gdscript_client/changeWorkspace` → `check_workspace()`(`:286-288`;实现 `:268-283`);
- `gdscript/capabilities` → `globals.docsProvider.register_capabilities(message)`(`:289-291`)。

`publishDiagnostics` 的处理被整段注释(`:293-304`),原意是按 `diagnostic.code === 6`(UNUSED_SIGNAL)
与 `=== 2`(UNUSED_VARIABLE)过滤,现状不生效 —— **插件对诊断零干预**。

`response_filter`(`:213-266`)按 `sentMessages` 记录的请求方法修补两类响应,详见 §3.8。

另:引擎会主动发自定义通知 `gdscript/show_native_symbol`
(`gdscript_text_document.cpp:124`,在 `nativeSymbol` 请求里顺带发出)。插件侧**没有任何处理分支**
(全仓检索 `show_native_symbol` 无命中),该通知被忽略;是否产生库层日志噪声未能确认。

### 3.6 `publishDiagnostics` 怎么收、怎么归一化、怎么清理

- **收**:插件没有任何相关代码(全仓检索 `publishDiagnostics` 只命中 `GDScriptLanguageClient.ts:293-304`
  这段注释)。接收方是库:建立连接时
  `connection.onNotification(PublishDiagnosticsNotification.type, params => this.handleDiagnostics(params))`
  (client.js),`handleDiagnostics` 经 `middleware.handleDiagnostics`(未设置,即直通)后
  `setDiagnostics(uri, converted)`,写入库自持的诊断集合。
- **能力声明**:客户端在 `initialize` 里声明 `publishDiagnostics` 支持 `relatedInformation`、
  `tagSupport`(Unnecessary/Deprecated)、`codeDescriptionSupport`、`dataSupport`,
  `versionSupport = false`(client.js `computeClientCapabilities`)。`versionSupport=false` 意味着
  诊断不带文档版本号,库不做"诊断版本落后于文档"的丢弃判定。
- **归一化**:引擎发的就是标准 `{ uri, diagnostics: [...] }`(`gdscript_workspace.cpp:593-608`),
  库用 `p2c.asUri` + `asDiagnostics` 转成 VS Code 类型。引擎**每次发该文件的完整列表**
  (`errors.resize(list.size())`,包含空数组),因此语义是"整体替换该 URI 的诊断",
  而不是增量追加。
- **清理策略**:引擎在 `lsp_did_close` 里只删 `managed_files` 条目与缓存的解析器,
  **不发布空诊断**(`gdscript_language_protocol.cpp:507-522`)。插件侧亦无清理代码。
  我在库里读到的"文档关闭即清理诊断"逻辑位于**拉取式(pull)诊断**特性中
  (client.js/`diagnostic.js` 的 `closeFeature.onNotificationSent(... cleanUpDocument ...)`),
  而 Godot 只支持推送式发布。因此"关闭 .gd 后 Problems 面板里旧诊断是否会残留"
  —— **未能确认**,建议实测(这也是本项目快照式清理与它的关键差异点)。

### 3.7 自定义 LSP 方法与通知清单

**插件发出的自定义请求**(只有一条):

| 方法 | 用途 | 插件侧位置 | 引擎侧实现 |
|---|---|---|---|
| `textDocument/nativeSymbol` | 取某个原生类的完整文档符号(供 `.gddoc` 文档页渲染) | `src/providers/documentation.ts:109`;参数类型 `NativeSymbolInspectParams{native_class, symbol_name}`(`src/providers/documentation_types.ts:3-6`) | `gdscript_text_document.cpp:127-139`;注册时注释标为 "Custom method"(`gdscript_language_protocol.cpp:680`) |

**引擎发出的自定义通知**(插件侧处理情况):

| 通知 | 用途 | 引擎发送位置 | 插件侧位置 |
|---|---|---|---|
| `gdscript/capabilities` | 全量原生类清单(建立文档索引) | `gdscript_language_protocol.cpp:275` | `GDScriptLanguageClient.ts:289-291` → `documentation.ts:43-64` |
| `gdscript_client/changeWorkspace` | 告知引擎当前服务的项目路径 | `gdscript_language_protocol.cpp:237` | `GDScriptLanguageClient.ts:286-288` → `:268-283` |
| `gdscript/show_native_symbol` | 让客户端跳转到原生符号 | `gdscript_text_document.cpp:124` | **无处理** |
| `window/showMessage` | 工作区不匹配时的警告 | `gdscript_language_protocol.cpp:230-234` | 由库内置处理,插件无自定义代码 |

**executeCommand 通道:空。** 引擎的 `executeCommandProvider` 里 `commands` 是空数组
(`godot_lsp.h:555-561`、`:1786-1800`),插件侧也检索不到任何
`workspace/executeCommand` 调用。`show_native_symbol_in_editor`(`gdscript_text_document.cpp:45`、
`:375-379`)是引擎内部的 GDScript 方法,不经 LSP 暴露成命令。

**注意**:除上表外,`gdscript/` 前缀下没有别的 LSP method;引擎注册的服务端方法就是
`didOpen/didClose/didChange/willSaveWaitUntil/didSave` + 一批 `textDocument/*` 查询
(`gdscript_language_protocol.cpp:662-685`)。

### 3.8 `response_filter` 里对响应的修补

两处修补,原因都写在代码注释里:

1. **hover 的 markdown**(`GDScriptLanguageClient.ts:215-236`):把 `\n#+` 压成 `\n`
   (注释:"dirty hack",引擎发的是预渲染 markdown 却没去掉前导 `#`,导致 docstring 被显示成标题,`:219-222`);
   `` `br` `` → 两个换行(`:225`);删掉 `` `codeblocks` ``/`` `/codeblocks` `` 标记(`:228-229`);
   把 `` `gdscript` ``/`` `csharp` `` 转成代码围栏(`:230-233`)。
2. **documentLink 的 `uid://` 过滤**(`:237-262`):引擎对 `uid://` 资源不返回有效路径,
   于是把这些链接整条剔除(注释同样标为 "dirty hack",`:249-254`),改由插件自己的
   `GDDocumentLinkProvider` 通过 `.uid` 文件反查提供(`src/providers/document_link.ts:74-88`,
   反查实现 `src/utils/godot_utils.ts:148-209`)。

为什么需要:引擎在服务端把 BBCode 预渲染成 HTML/伪 markdown,客户端只能靠字符串修补对齐 VS Code
的渲染;`HoverResult` 在插件里也被硬编码成 `{ contents: { kind, value }, range }` 的单对象形态
(`GDScriptLanguageClient.ts:38-53`)。

### 3.9 一次典型交互的消息序列

按"打开 → 编辑 → 保存 → 关闭"把每一跳都落到代码位置,便于照抄时序:

1. **打开 `.gd`**:库 `DidOpenTextDocumentFeature`(注册时已对 `workspace.textDocuments` 里匹配
   selector 的文档补发过一次)发 `textDocument/didOpen`;引擎 `lsp_did_open` 要求该 URI 此前未被
   open 过(重复 open 直接 `ERR_FAIL_COND_MSG`,`gdscript_language_protocol.cpp:469`),
   把文本存进 `managed_files`(`:471`)并
   `parse_script()`(`:472`)→ 有 managed 文本分支 → **立即 `publish_diagnostics`**
   (`:391-421`,发布点 `:414`)。
2. **编辑**:库发 `textDocument/didChange`,因为服务端声明 `change = Full`
   (`godot_lsp.h:591`)携带**全文**;引擎只取 `contentChanges.back()`
   (`gdscript_language_protocol.cpp:499-502`)覆盖 managed 文本,再次解析并发布(`:504`)。
3. **保存**:库发 `textDocument/didSave`(带全文 `text`);引擎**忽略 text**,从磁盘
   `load_source_code` 并重载脚本(`gdscript_text_document.cpp:92-114`),**不发诊断**。
4. **关闭**:库发 `textDocument/didClose`;引擎删除 `managed_files` 条目、释放缓存的解析器
   (`gdscript_language_protocol.cpp:507-522`),**不发诊断**(旧诊断去向见 §3.6)。
5. **查询**(hover/definition/inlay hints 等):走同一个 socket 的请求-响应,
   响应先经 `response_filter` 修补再交给库(`GDScriptLanguageClient.ts:213-266`)。
6. **断线**:`MessageIO` 的 socket `close` → `disconnected`(`MessageIO.ts:60-63`)→
   `ClientStatus.DISCONNECTED` → `create_new_client()`(§2.6);**新的客户端实例会把
   当前打开的文档重新 `didOpen` 一遍**(库的 open 特性在注册时遍历 `workspace.textDocuments`),
   因此"重连后引擎仍认得这些文件"这件事是由库兜住的,而不是插件自己重放。

---

## 4. 文件与文档同步

### 4.1 `didOpen` / `didChange` / `didClose` / `didSave` 谁在发

全部由库发,插件只声明"哪些文档属于我":`documentSelector = [{scheme: file, language: gdscript},
{scheme: untitled, language: gdscript}]`(`GDScriptLanguageClient.ts:114-119`)。

- `didOpen`:特性注册时会遍历 `workspace.textDocuments` 给已打开的 `.gd` 补发
  (textSynchronization.js `DidOpenTextDocumentFeature.register`);
- `didChange`:同步类型由服务端声明为 **Full**(`godot_lsp.h:588-591`,`change = TextDocumentSyncKind::Full`),
  即每次变更发全文;引擎也只取最后一个变更事件(`gdscript_language_protocol.cpp:499-502`);
- `didClose` / `didSave`:同源(见 §3.3);
- 引擎对顺序很严格:未 open 就 change 直接 `ERR_FAIL`(`:487`),重复 open 也 `ERR_FAIL`(`:469`)。
  这意味着客户端必须自己保证"每个 URI 只 open 一次"——库用 `_syncedDocuments` 做这件事。
- `.tscn` / `.tres` / `.gdshader` **不在 selector 内**,因此不存在对应的 LSP 文档会话
  (这也解释了本项目记录的"`.gdshader` 引擎不发诊断")。

### 4.2 插件自己的文件监听

只有一处:`ScenePreviewProvider` 建了 `workspace.createFileSystemWatcher("**/*.tscn")`
(`src/scene_tools/preview.ts:41`,注册在 `:69`,回调 `:102-114`,且回调里人为延迟 20 ms)。
**没有任何 `.gd` 级别的 file watcher**,也不走 `didChangeWatchedFiles`(§3.4)。
所以"磁盘上的 `.gd` 变了"这件事,插件本身不感知;感知它的是引擎(下一节)。

### 4.3 `document_drops.ts` 在做什么(澄清:与文档同步无关)

`GDDocumentDropEditProvider`(`src/providers/document_drops.ts:22-131`)实现的是**把场景树节点拖进
编辑器时的代码生成**:数据由 `preview.ts:93-99` 以 `godot/scene`、`godot/class`、`godot/path`、
`godot/unique` 等 MIME 放进 `DataTransfer`;拖到空行生成
`@onready var <snake>: <Class> = $Path`(`document_drops.ts:110-119`,Godot 4 才加 `@`,`:112-115`),
拖到其它位置生成 `$Path` 或 `%Name`(唯一节点,`:98-103`),C# 里生成
`GetNode<Class>("Path")`(`:126-128`)。名字里的 `document_*` 指的是 VS Code 的
`DocumentDropEditProvider` 接口,**不涉及 `didOpen`/`didClose`**。

### 4.4 引擎侧如何察觉磁盘变化

- 焦点驱动:`EditorNode::NOTIFICATION_APPLICATION_FOCUS_IN` → `EditorFileSystem::scan_changes()`
  (`editor_node.cpp:1093-1102`);
- 脚本级:每个编辑器标签保存 `edited_file_data.last_modified_time`,与
  `FileAccess::get_modified_time()` 比对(`script_editor_plugin.cpp:1583-1586`);
  发现不一致时,**若没开"自动重载外部改动"或该标签有未保存改动(`seb->is_unsaved()`),
  就置 `need_ask = true` 并弹窗询问**(`:1590-1593`),否则直接 `reload_scripts()`(`:1597-1603`)。
  这条与 §7.4 的"未保存缓冲"讨论直接相关。

### 4.5 日志与排障

- 输出通道由 `createLogger` 的 `output` 选项创建,底层是
  `window.createOutputChannel(name, { log: true })`(`src/utils/logger.ts:52-54`);
  插件建了 **"Godot LSP"** 与 **"Godot Debugger"** 两个通道
  (`ClientConnectionManager.ts:19`、`GDScriptLanguageClient.ts:18`、`src/debugger/debugger.ts:31`)。
- 控制台输出只在调试模式打印:`is_debug_mode()` 读 `process.env.VSCODE_DEBUG_MODE === "true"`
  (`logger.ts:57-71`,`src/utils/index.ts:11-13`)。
- 日志级别固定为 `LOG_LEVEL.DEBUG`,没有设置项可调(`logger.ts:40`)。
- **报文级日志是排查"某个通知到底发没发"的第一手材料**:`tx:` / `rx:` / `tx [discarded]:` /
  `rx [discarded]:`(`MessageIO.ts:133-136`、`:113-117`)。§3.2 的结论都可以用它复核。
- headless 子进程的 stdout 进同一通道(`ClientConnectionManager.ts:165-171`),而
  **stderr 整段被注释、不落到任何地方**(`:173-179`)—— 排查 headless 启动失败时,
  应直接照 §2.3 的命令行手工复现,不要指望插件日志里有引擎的 stderr。

---

## 5. 功能清单

| 功能 | 关键文件:行 | 做什么 |
|---|---|---|
| `providers/completions.ts` | `src/providers/completions.ts:19-40`(注册 `:26-28`) | 目前是**空实现**(返回空数组),框架保留 |
| `providers/definition.ts` | `src/providers/definition.ts:18-69` | `.tscn/.tres` 里对原生类跳 `.gddoc`(`:32-57`);`.gd` 里借 hover 拿到 `Class.member` 再拼文档 URI(`:59-68`) |
| `providers/hover.ts` | `src/providers/hover.ts:17-150` | 场景文件里 `ExtResource`/`SubResource` 的代码块与图片预览(`:49-107`);`res://`、`uid://` 链接内容预览(`:110-147`) |
| `providers/semantic_tokens.ts` | `src/providers/semantic_tokens.ts:18-59` | 用正则给 `get_node("...")` 里的节点路径打 `nodePath` token;`extension.ts:71` **已注释**,未启用 |
| `providers/inlay_hints.ts` | `src/providers/inlay_hints.ts:65-205` | `.gd`:`documentSymbol` 拿 detail,缺失时逐变量发 hover 推断类型(`:107-166`);`.tscn`:标注 ExtResource/SubResource 类型(`:168-204`);LSP 状态变化时刷新(`:81-88`) |
| `providers/document_link.ts` | `src/providers/document_link.ts:17-91` | ExtResource/SubResource 定义跳转(`:39-64`)、`res://`(`:66-72`)、`uid://`(`:74-88`) |
| `providers/documentation.ts` | `src/providers/documentation.ts:24-150` | `gddoc` 自定义只读编辑器;`register_capabilities` 建原生类索引(`:43-64`);渲染时请求 `textDocument/nativeSymbol`(`:109`) |
| `providers/documentation_builder.ts` | `src/providers/documentation_builder.ts:59-119`、`:121+` | 用 marked + prismjs + ya-bbcode 生成 webview HTML(`:59`),符号详情(`:121`) |
| `providers/document_drops.ts` | 见 §4.3 | 拖放生成节点引用代码 |
| `providers/tasks.ts` | `src/providers/tasks.ts:18-47` | 空壳任务提供者;`extension.ts:73` **已注释**,未启用 |
| `formatter/` | `src/formatter/formatter.ts:7-18`、`src/formatter/textmate.ts:276` | 自研 GDScript 格式化(vscode-textmate 解析,非 LSP),三个 `formatter.*` 设置项控制 |
| `scene_tools/` | `src/scene_tools/parser.ts:9-183`、`preview.ts:33-280`、`types.ts:12/77/87` | 解析 `.tscn`(带 mtime 缓存,`parser.ts:25-31`)并渲染场景预览树、拖拽、锁定、跳转命令(`preview.ts:54-73`) |
| `debugger/`(公共) | `src/debugger/debugger.ts:81-398` | 注册 DAP 工厂与 12 个命令(`:93-108`);按项目大版本选 Godot3/4 会话(`:111-130`);会话树/检查器/固定场景 |
| `debugger/godot3/` | `godot3/debug_session.ts:30`、`godot3/server_controller.ts:41-654`、`godot3/variables/variant_decoder.ts:19`、`variant_encoder.ts:16` | 命令名无前缀(`get_stack_dump`、`inspect_object` 等,`server_controller.ts:86-104`);检查对象回调走 `session.inspect_callbacks`(`debugger.ts:302-305`) |
| `debugger/godot4/` | `godot4/debug_session.ts:22`、`godot4/server_controller.ts:68-796`、`godot4/variables/variables_manager.ts:14`、`godot_id_to_vscode_id_mapper.ts:12`、`godot_object_promise.ts:18` | 命令名带前缀(`scene:inspect_object`、`scene:request_scene_tree`,`server_controller.ts:123-129`);对象用 `VariablesManager` + Godot id ↔ VS Code id 映射 + Promise 化(`debugger.ts:291-300`) |
| `debug_runtime.ts` | `src/debugger/debug_runtime.ts:8-81` | 断点、栈帧、作用域变量与 `GodotDebugData` |

命令与视图的注册总表在 `package.json:60-250`(commands)、`:463-635`(debugger)、`:641-887`
(views/menus);`extension.ts:85-92` 注册扩展自有命令。

---

## 6. 配置项全表(`contributes.configuration`)

来源:`package.json:258-375`。★ = 影响 LSP 行为。

| 设置项 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `godotTools.documentation.pageScale` | integer(50–200) | `100` | 文档查看器缩放百分比(`:262-268`) |
| `godotTools.documentation.displayMinimap` | boolean | `true` | 文档查看器是否显示 minimap(`:269-273`) |
| ★ `godotTools.editorPath.godot3` | string | `"godot3"` | Godot 3 可执行文件路径;**headless 拉起时用它**(`ClientConnectionManager.ts:120-124`) |
| ★ `godotTools.editorPath.godot4` | string | `"godot"` | Godot 4 可执行文件路径;同上 |
| `godotTools.editor.verbose` | boolean | `false` | 打开编辑器时加 `-v`(`extension.ts:190-192`) |
| `godotTools.editor.revealTerminal` | boolean | `true` | 打开编辑器时是否显示终端(`extension.ts:204-206`) |
| `godotTools.formatter.maxEmptyLines` | number(≥0) | `2` | 格式化:允许的连续空行数(`:294-299`) |
| `godotTools.formatter.denseFunctionParameters` | boolean | `false` | 格式化:压缩参数列表空格(`:300-304`) |
| `godotTools.formatter.spacesBeforeEndOfLineComment` | enum `"1"`/`"2"` | `"1"` | 格式化:行尾注释前空格数(`:305-317`) |
| ★ `godotTools.lsp.serverHost` | string | `"127.0.0.1"` | LSP 主机(`GDScriptLanguageClient.ts:148`) |
| ★ `godotTools.lsp.serverPort` | number(0–65535) | `6008` | LSP 端口;attach 时 6005/6008 会被归一为 6005(`GDScriptLanguageClient.ts:135-146`) |
| ★ `godotTools.lsp.headless` | boolean | `false` | 是否自起 headless Godot 作为语言服务器(`ClientConnectionManager.ts:91-94`) |
| ★ `godotTools.lsp.autoReconnect.enabled` | boolean | `true` | 是否自动重连(`ClientConnectionManager.ts:331`) |
| ★ `godotTools.lsp.autoReconnect.cooldown` | number | `3000` | 检查重连的间隔(ms),同时是 `setInterval` 周期(`:49-51`) |
| ★ `godotTools.lsp.autoReconnect.attempts` | number | `10` | 重连次数上限(`:335`) |
| `godotTools.scenePreview.previewRelatedScenes` | enum `anyFolder`/`sameFolder`/`off` | `"sameFolder"` | 从脚本找关联场景的范围(`preview.ts:123-146`) |
| ★ `godotTools.inlayHints.gdscript` | boolean | `false` | 是否在 `.gd` 里显示 inlay hints;开启后才发 `documentSymbol`/`hover` 请求(`inlay_hints.ts:107-114`) |
| `godotTools.inlayHints.gdresource` | boolean | `true` | 是否在 `.tscn/.tres` 里显示 inlay hints(`inlay_hints.ts:168-170`) |

历史键迁移表在 `src/utils/settings_updater.ts:3-13`,其中 `godot_tools.gdscript_lsp_server_port` →
`godotTools.lsp.serverPort`、`godot_tools.reconnect_cooldown` → `lsp.autoReconnect.cooldown`
等,可用于理解这些键的来历。

---

## 7. 对本项目(lsp-echo)的可借鉴结论

### 7.1 值得抄的 5 条

1. **断线即重建客户端,而不是复用连接**(`ClientConnectionManager.ts:296-299` + `create_new_client`
   `:76-84`)。源码注释给的理由正是我们也会踩的坑:服务端无法知道重连的客户端是同一个,
   复用会让"客户端管理的文件集合"失同步。lsp-echo 每次重建 clientd 会话/清空已打开文件表,
   与此同构。
2. **端口决策要显式、有序、可解释**:attach 时把 `6005/6008` 归一为 `6005`
   (`GDScriptLanguageClient.ts:135-146`),断线后再兜底试一次 `6008`(`:362-375`),自起时用
   OS 临时端口 + `--lsp-port` 显式传入(`ClientConnectionManager.ts:157-163`)。全程不扫端口。
3. **"别的项目"必须是一个显式拒绝态,且拒绝后不再循环重试**:`check_workspace` 校验失败即
   `socket.resetAndDestroy()` + `rejected = true`(`:268-283`),之后除 `shutdown` 外一律不发
   (`:187-192`),状态落到 `WRONG_WORKSPACE` 且 `retry = false`(`:311-314`)。
   比 lsp-echo 的 `badEditor` 黑名单更"即时",思路一致:宁可拒绝,也不要让空诊断伪装成 0 错误。
4. **把重活/额外请求与连接状态挂钩**:inlay hints 在每次 LSP 状态变化时整体刷新,并在
   `CONNECTED` 后 250 ms 再刷一次(`inlay_hints.ts:81-88`)——承认"刚连上时引擎还没热"。
   对 lsp-echo 的 settle 问题有直接参考价值。
5. **协议适配层可以很短,但要自己写**:`MessageIO`(151 行)+`MessageBuffer`(157 行)就构成了
   一个可用的 LSP 分帧读写器;`MessageBuffer` 的 `Content-Length` 解析(`MessageBuffer.ts:51-124`)
   与"半包 10 秒定时器"(`:139-156`)可以直接借用实现细节。

### 7.2 不能照抄的部分

- **一切依赖 VS Code 文档模型的行为**:`didOpen`/`didChange` 的自动发送、诊断的落库与展示、
  保存事件、状态栏、`Problems` 面板,全部来自 `vscode.workspace` 与 `vscode-languageclient`。
  lsp-echo 没有编辑器缓冲,必须自己定义"文本与版本从哪来"(我们的答案:磁盘 + 主动 didOpen 全文)。
- **诊断的清洗与去重**:插件一行都没有(§3.6),它把这件事整个交给库;我们既没有库,也没有
  `DiagnosticCollection`,清理策略(文件关闭、内容变化、项目切换)必须自己写。
- **`response_filter` 之类的字符串修补是针对引擎输出形态的**:如果 lsp-echo 只消费诊断,
  不需要抄 hover/documentLink 的修补;但要知道引擎在这两条路径上的输出并不规范(§3.8)。
- **attach 的信任模型**:官方插件靠"端口写死 + 用户自己保证"来认定归属(§2.7),
  唯一的验证是 `changeWorkspace` 后的硬拒绝。lsp-echo 的 attachPolicy/黑名单是更严的版本,
  不应因为这份参照而退回"TCP 可连即命中"。
- **`processId` 的用法**:库默认发 `processId: null`(client.js),引擎也不使用它
  (引擎只读 `rootUri`/`rootPath`,`gdscript_language_protocol.cpp:220-226`),不要为了对齐而照搬。

### 7.3 它的 `didSave` 用法 vs "AI 改文件后主动补发 didSave"

差异要点(证据见 §3.3):

| 维度 | 官方插件 | lsp-echo 的场景 |
|---|---|---|
| 触发源 | VS Code 保存事件(`onDidSaveTextDocument`) | AI/工具直接写盘,**没有保存事件**,只能自己补发 |
| 字段 | 带全文 `text`(服务端 `includeText = true`) | 引擎不读 `text`,`didSave` 只取 uri(`gdscript_text_document.cpp:92-114`),带上更符合声明,但不是必需 |
| 引擎行为 | 从**磁盘**重新加载脚本 + 重载/`update_exports()`(`:98-107`) | 同上 |
| 与诊断的关系 | **不发布诊断**;诊断靠 didOpen/didChange 的解析(§3.3(e)) | 我们想让引擎看到新内容并给诊断 → **didOpen(全文)+ didChange 才是对口的通道** |
| 前置条件 | 只对已在引擎 `managed_files` 中的文件发生 | `didSave` 处理器不检查 `managed_files`,理论上可对任意 `.gd` 补发 |

结论:**"主动补发 didSave"对拿诊断不是必需,而且有副作用** —— 它会触发引擎的脚本重载
(`reload_script()` 里还调 `ScriptEditor::reload_scripts(true)` 与 `trigger_live_script_reload()`,
`gdscript_text_document.cpp:116-120`)。因此若目的只是"让引擎按新文本给诊断",优先用
`didOpen`/`didChange`;如果确实需要"让运行中的引擎重载脚本",再把补发 `didSave` 当作一个
显式、可关闭的动作,并且要清楚它作用于磁盘内容而不是我们发的 `text`。

### 7.4 "文件在编辑器里有未保存改动"时的行为

- **官方插件侧没有任何防护**:它发送的 `didChange` 就是编辑器缓冲文本,引擎把它当权威文本
  (有 `managed_files` 条目就只用它,`gdscript_language_protocol.cpp:391-406`);
  `didSave` 则让引擎改从磁盘读(§3.3(d))。插件从不检查"这份缓冲是否有未保存改动"。
- **引擎侧的保护只存在于编辑器自身的磁盘检测路径**:`ScriptEditor::_test_script_times_on_disk`
  在 mtime 变化时,若 `!use_autoreload || seb->is_unsaved()` 就 `need_ask = true`,改为弹窗询问
  而不是静默重载(`script_editor_plugin.cpp:1586-1603`,判断点在 `:1590`;`is_unsaved()` 定义在
  `script_editor_base.cpp:627`)。
- **LSP 的 `didSave` 路径没有这层保护**:`GDScriptTextDocument::didSave` 直接
  `load_source_code(path)` + `reload()`(`gdscript_text_document.cpp:98-107`),不做未保存检查。
  它是否会导致编辑器里那份未保存缓冲被丢弃,取决于 `ScriptEditor::reload_scripts` 的内部实现,
  **未能确认**,建议在临时项目里实测(编辑器打开一个有未保存改动的 `.gd`,再从 LSP 侧发一次 `didSave`)。
- 对本项目的直接含义:lsp-echo 无法从外部得知"编辑器里这份文件有没有未保存改动",
  因此**应避免对可能正被用户编辑的文件补发 `didSave`**,以免把"AI 想刷新诊断"变成
  "强制引擎重载用户正在改的脚本";需要新内容时用 `didOpen`(全文)走 managed 文本通道,
  这条路径不动磁盘也不动编辑器缓冲。

---

## 8. 来源与复核方式

**读过的插件源码(逐文件通读,行号取自这些读取)**:

- `package.json`(全文 935 行):配置项、命令、debugger 贡献点、依赖版本;
- `README.md`(229 行):headless 说明与 FAQ;
- `CHANGELOG.md`(仅按关键词检索 `LSP`/`headless`/`workspace/symbol` 等);
- `src/extension.ts`、`src/lsp/{index,ClientConnectionManager,GDScriptLanguageClient,MessageIO,MessageBuffer}.ts`、
  `src/providers/{index,completions,definition,hover,semantic_tokens,inlay_hints,document_link,documentation,documentation_types,documentation_builder,document_drops,tasks}.ts`、
  `src/formatter/{index,formatter}.ts`、`src/scene_tools/{index,parser,preview}.ts`、
  `src/debugger/{index,debugger,godot3/debug_session,godot3/server_controller,godot4/debug_session,godot4/server_controller}.ts`、
  `src/utils/{index,godot_utils,subspawn,vscode_utils,prompts,logger,settings_updater}.ts`。

**读过的引擎源码**(`E:\Godot Engine\godot-master-4.7`):

- `modules/gdscript/language_server/gdscript_language_protocol.cpp`(全文 693 行)、
  `godot_lsp.h`(第 555-664、1660-1809 行)、
  `gdscript_workspace.cpp`(第 575-654 行)、`gdscript_text_document.cpp`(按 `didSave`/`nativeSymbol` 定位读取);
- `editor/editor_node.cpp:1093-1102`、`editor/script/script_editor_plugin.cpp:1540-1639`。

**读过的第三方库源码**(插件仓库无 `node_modules`,故取自 npm 上的已发布包
`vscode-languageclient@9.0.1`,与 `package.json:929` 声明的 `^9.0.1` 一致):

- `lib/common/client.js`:initialize 参数构造、`processId`/`rootUri` 取值、`publishDiagnostics`
  的 `connection.onNotification` 与 `handleDiagnostics`、`registerFeatures` 列表、
  `computeClientCapabilities` 中 `publishDiagnostics` 段;
- `lib/common/textSynchronization.js`:`DidSaveTextDocumentFeature`/`DidOpenTextDocumentFeature`/
  `DidChangeTextDocumentFeature` 的注册条件与 `_includeText` 逻辑;
- `lib/common/diagnostic.js`(拉取式诊断特性,用于对照"关闭文档时清理诊断"的归属)。

**用到的命令/工具**:`glob`(定位 `src/**/*.ts`、`*.md`、引擎源文件)、`grep`(检索
`didSave|publishDiagnostics|didOpen|didClose|didChange`、`gdscript/`、`sendRequest|sendNotification`、
`Diagnostic`、`export class|export function`、`createFileSystemWatcher|onDidSaveTextDocument` 等)、
`read`(整文件与指定区间)、`pwsh` 的 `Select-String`(对引擎 C++ 与下游库 JS 做带上下文检索,
URL 为 `https://unpkg.com/vscode-languageclient@9.0.1/lib/common/*.js`,未落盘)。

**明确未能确认的点**(需要实测或进一步读码):

1. 关闭 `.gd` 后引擎/客户端是否清空该文件的旧诊断(§3.6);
2. 扩展宿主重启(而非进程退出)时 headless 子进程是否被回收(§2.7);
3. `FileSystemWatcherFeature` 的具体注册条件(§3.4);
4. 引擎在 `didSave` 里 `reload()` 对"编辑器内未保存缓冲"的实际影响(§7.4);
5. `processId` 是否被某个特性覆盖为真实 pid(§2.5)。
