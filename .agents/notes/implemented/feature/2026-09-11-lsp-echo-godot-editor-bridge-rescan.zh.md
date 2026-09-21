# Agent Note: lsp-echo 引擎桥——请求运行中的 Godot 引擎重扫

Status: implemented

[English](2026-09-11-lsp-echo-godot-editor-bridge-rescan.md) | 中文

## Problem

Godot 只在扫描项目文件系统的过程中把脚本的 `class_name` 注册为全局类：`EditorFileSystem::_update_script_classes()` 在扫描内部抵达 `ScriptServer::add_global_class()`。运行中的引擎不会自行重扫。编辑器在窗口重新获得焦点（`NOTIFICATION_APPLICATION_FOCUS_IN`）时触发 `EditorFileSystem::scan_changes()`，而没有任何定时器、文件监听器或外部入口调用它——因此 `--headless` 引擎完全不重扫。

语言服务器也没有提供请求重扫的途径。`gdscript_language_protocol.cpp` 注册了 `textDocument/*` 请求以及 `initialize`/`initialized`，而首次全量扫描在引擎级 `_initialized` 守卫之后只运行一次。

代价以最昂贵的形式落在 agent 循环上：写入一个声明 `class_name X` 的脚本，随后在引擎尚未扫描前检查引用 `X` 的另一个文件，检查便报告 `Could not find type "X" in the current scope.`。该诊断是假错，它紧跟在引发它的那次编辑之后出现，并持续到引擎重启——循环于是被告知去修一个本来正确的文件。

同一机制在 **attach 编辑器**模式下会把外部编辑过的内容读成陈旧。编辑器在扫描项目时缓存脚本文本,且只在窗口重新获得焦点时才重新载入,所以在这里改过的父类方法,会持续在子类里以 `Parent signature is "… -> void"` 的形式报出来:检查打开了子类,编辑器就着它仍持有的副本重新分析,于是诊断描述的仍是编辑之前的签名——而那个文件在磁盘上早已正确。我们自起的引擎没有这个窗口:它分析一个文件时从磁盘读取依赖,[依赖检查 Note](2026-09-11-lsp-echo-dependent-recheck.zh.md)用"先打开过依赖"与"从未打开"两种变体量过这一点。

## Decision

lsp-echo 在引擎桥旁边附带一个 Godot 编辑器插件，通过它请求运行中的引擎重扫。

### addon 与其磁盘记录

[`checkers/godot-lsp/addon/dsh_echo_bridge`](../../../../plugins/lsp-echo/checkers/godot-lsp/addon/dsh_echo_bridge) 存放该 addon（`plugin.cfg` + `plugin.gd`）。插件的 `installAddonInto` 把它复制到 `<项目>/addons/dsh_echo_bridge/`，`ensureEditorPluginEnabled` 把 `"res://addons/dsh_echo_bridge/plugin.cfg"` 追加进 `project.godot` 的 `[editor_plugins] enabled` 数组。`project.godot` 的重写经临时文件加重命名完成（半写的副本会丢掉用户的编辑器设置），addon 的拷贝是一次递归同步复制。两个步骤都是幂等的。该数组的重写是引号感知的，因此路径中含右括号的相邻条目不会被破坏，被注释掉的 `;enabled=…` 行也不算作 addon 已启用。

插件写入用户项目的位置恰好是上述两处，README 记录了配套的卸载步骤。

### 控制端口与端口发现

addon 在 `127.0.0.1` 上绑定 `DSH_ECHO_BRIDGE_PORT`（默认 6089）起十六个候选中的第一个空闲端口，并把 `{"port": N, "pid": P}` 发布到 `<项目>/.godot/dsh_echo_bridge.json`。每行一个请求；`rescan` 回 `ok`，其它回 `err unknown command`。`rescan` 调用 `EditorInterface.get_resource_filesystem().scan_sources()`——`EditorFileSystem::scan_changes()` 绑定的正是该方法，因此 addon 走的是焦点通知所用的同一条扫描路径。

插件侧从已发布的记录取端口，再退回引擎声明的 `rescanPort`；桥 CLI 侧先取显式端口（`--bridge-port`、机器配置的 `bridgePort` 或环境变量 `DSH_ECHO_BRIDGE_PORT`），再取已发布的记录，最后才退回随包分发的默认值。已发布的端口仅在其发布者 pid 存活时有效（[`lib/addon.js`](../../../../plugins/lsp-echo/lib/addon.js) 的 `discoverBridgePort`，以及桥自身的查找），因此崩溃引擎留下的状态文件无法把一次检查引向如今属于其它进程的端口。两侧都按整行匹配（`ok`、`pong`），因此无关的本机服务无法靠包含该词来完成应答。

### 自愈触发点

插件在三处请求重扫，三者都是自动的：

- 结构性变化——`.gd` 的新增或删除，由 [`lib/watcher.js`](../../../../plugins/lsp-echo/lib/watcher.js) 跟踪——在检查运行前被清空处理，因此新文件在任何引用它的事物之前就进入了引擎视野。
- 本轮有文件改动时先请求一次重扫，并跳过成功间隔抑制，因为引擎手头这些文件的副本正是检查将要描述的东西。`fresh` 这个开关只为这一触发点存在：它必须落在看到那次编辑的那一轮，而不是间隔之后的某一轮。
- 含 `Could not find type "X"` 的载荷，仅当项目确实声明了 `class_name X` 时才被当作可疑（`missingTypeNames` 针对本轮文件，对照 [`lib/index.js`](../../../../plugins/lsp-echo/lib/index.js) 中按 mtime 增量的类名索引）。随后插件重扫并再检查一次，其预算有上限，且若该次调用抛错则保留第一份载荷。项目并未声明的缺失类型是真实错误，不触发任何动作。

该请求经由检查所用的同一个桥进程发出，该进程的会话归属见[编辑器 LSP 会话 Note](../bug-fix/2026-09-11-lsp-echo-editor-lsp-single-session.zh.md)。

### 失败是可见的

一次失败之后，该「引擎 × 项目」组合在 120 秒内不再被请求重扫；说明引擎尚未发布其新类的浮窗提示最多每 600 秒出现一次；一次成功的重扫只抑制下一次请求 3 秒，但本轮有文件改动的那个触发点不受抑制，否则一次编辑就可能被这段间隔挡在外面。重扫失败绝不转化为干净结果：无论哪种情况，检查载荷都是引擎自己的答复。`bridgeStatus` 报告 `{installed, port, declared, online, error}`，`installAddon` 报告 `{ok, addonPath, enabled, enableChanged, stoppedForRestart, error}`；设置页把两个结论都呈现出来。

插件中会写入状态或停止引擎的 HTTP action 要求 `x-dsh-lsp-echo: 1` 请求头，而跨站页面无法给普通 GET 附加该头：别的网页无法让 harness 往用户项目里写文件或停止引擎。

## Alternatives considered

| 被否决 | 一句话理由 |
|---|---|
| 向运行中的引擎注入 DLL 并直接调用类注册 | 依赖任何引擎升级都会破坏的私有 ABI，需要调试权限，且抵达不了受支持的编辑器插件 API 尚未暴露的东西 |
| 每次检查都另起一个 `--headless` 引擎 | 每次编辑都要付一次全项目扫描，而且仍看不到用户编辑器尚未扫描的类 |
| 通过语言服务器协议发送重扫请求 | 该协议只注册 `textDocument/*` 与 `initialize`/`initialized`，并不存在重扫请求 |
| 出现新文件时重启 headless 引擎 | 代价是一次全量扫描并丢掉编辑器 attach 会话；重扫请求只是向已运行的引擎发一行 |
| 轮询引擎以判断类名是否新鲜 | 扫描跑起来之前没有任何可观测的变化，检查载荷是引擎唯一的输出 |
| 把 addon 作为需用户单独安装的下载分发 | 插件的约定是自包含安装；一个手动前置条件会让每个跳过它的项目继续带着那条假错 |

## Consequences

新建的 `class_name` 脚本在一次请求内对运行中的引擎可见，因此假错 `Could not find type` 在编辑器 attach 与 headless 两种模式下都消失。插件在注册表中有了若干引擎能力字段（`engine.json` 的 `rescan`、`rescanPort`、`addon`），桥多了 `rescan` 子命令；未声明 `rescan` 能力的引擎保持原有行为，[TypeScript 引擎](2026-09-11-lsp-echo-typescript-engine.zh.md)正是如此。

接受的代价：插件会往用户项目写入一个 addon 目录和一条 `project.godot` 条目；addon 需要 `EditorFileSystem.scan_sources()` 对脚本可见（在 Godot 4.7 上实测；未暴露该方法的引擎会使重扫失败，按失败处理而非当作通过）；控制端口在回环上无鉴权，任何本机进程都能触发一次重扫；headless 引擎只在启动时加载编辑器插件，因此在我们自己的 headless 引擎运行期间安装 addon 会停止该引擎，并让下一次检查启动一个读取到新设置的引擎。用户的编辑器绝不会被停止——其 addon 在编辑器下次启动时加载。

## Testing

addon 安装器针对五种 `project.godot` 形态做过验证（段在文件末尾且无结尾换行、已有列表且其后还有别的段、完全没有该段、启用路径中含 `)`、以及被注释掉的条目），每种都在二次运行后保持一致且 `[editor_plugins]` 段恰好一个。端口发现分别在没有状态文件、发布者 pid 已死、发布者 pid 存活三种情形下验证。端到端验证中，默认端口被占用时 addon 绑定下一个端口、发布它，并对探测与桥的 `rescan` 都作出应答；随后，引用一个在引擎运行期间创建的类的文件从一条错误变为零条；面对已死端口，桥以退出码 `2` 结束并报告失败。

安装器与端口的验证由一次性脚本在临时项目上完成，因此结论记录在此处与插件的设计文档中，而不作为测试文件随包分发；引擎各步可用插件 README 记载的桥 CLI 命令重跑。

本轮有文件改动的那个触发点在真实项目上量过：一个经由 harness 改过的父类方法，让两个子类与一个调用者报出九条关于旧 `-> void` 签名的错误，而那个文件在磁盘上已经返回 `bool`。一次重扫——到编辑器桥的 138 ms socket 往返，不含桥进程启动——之后重新检查同样的六个文件，报出零条错误；检查前的重扫复现的正是这个结果。模式差异在临时项目上用真实 headless 引擎量过：改动一个依赖后，无论调用者之前是否打开过该依赖，检查都报出新签名，因此自起的引擎从不需要这个触发点，attach 编辑器是唯一需要它的模式。

插件没有随包测试，这里也不新增：仓库的测试与类型检查目标是 `packages/`、`apps/`、`scripts/`，不含 `plugins/`。
