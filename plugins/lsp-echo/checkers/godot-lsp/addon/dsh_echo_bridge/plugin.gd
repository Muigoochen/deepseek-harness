@tool
extends EditorPlugin
## DSH Echo Bridge — control socket that lets the DSH lsp-echo plugin ask a
## running Godot engine to rescan the project filesystem.
##
## Godot registers global class names (a script's `class_name`) only while
## scanning the project filesystem, and a running engine never rescans on its
## own: the editor does it when its window regains focus, a headless engine never
## does. A script created after the engine started is therefore reported as an
## unknown type until the engine rescans.
##
## This addon runs inside the editor and inside `--editor --headless` engines
## (enabled editor plugins are loaded in both). It listens on 127.0.0.1 and turns
## one protocol line into the editor's own scan call
## `EditorInterface.get_resource_filesystem().scan_sources()`.
##
## Protocol (one line per request, UTF-8):
##   ping   -> pong
##   whoami -> project:<absolute project path>
##     Which project this instance serves. The caller probes the port range this
##     addon scans when the published file is missing or names no live instance (the
##     file carries one slot per kind of instance, so a second engine replaces the
##     first engine's slot), and must not latch onto another project's addon found in
##     the same range.
##   rescan -> ok   (after the filesystem scan was triggered)
##   unsaved:<res path> -> yes | no
##     Whether that script has unsaved changes in the script editor. The caller
##     checks this before asking the language server to reload the script: a
##     reload rewrites the editor buffer from disk and would silently discard
##     those changes, which is exactly what the editor itself refuses to do
##     without asking (see ScriptEditor::_test_script_times_on_disk).
##   lsp-relocate:<port> -> ok:<port>
##     Move the editor language server to that port and write it into the project's
##     settings file (an `editor_overrides/` entry): the caller configured that port
##     for this project, so the next editor start binds it without another relocation.
##   lsp-relocate-temp:<port> -> ok:<port>
##     Same move, but the port is a substitute for this session only (the configured
##     port is held by something else) and is never written to the project file.
##
## The listening port starts at DSH_ECHO_BRIDGE_PORT (default 6089) and walks
## upward until it binds, so two open projects — or an editor plus its headless
## fallback — never fight over one port. The bound port is published to
## `res://.godot/dsh_echo_bridge.json`, which the DSH bridge reads to find this
## instance without any configuration.

#region -------- 常量定义 --------

const DEFAULT_CONTROL_PORT: int = 6089
const PORT_SCAN_COUNT: int = 16
const STATE_FILE_NAME: String = "dsh_echo_bridge.json"
const MAXIMUM_REQUEST_LENGTH: int = 256
const UNSAVED_PREFIX: String = "unsaved:"
const PROJECT_PREFIX: String = "project:"
const STATE_PREFIX: String = "state:"
const LSP_RELOCATE_PREFIX: String = "lsp-relocate:"
## Relocation that must NOT be written into the project's settings file: the caller only
## needs the server somewhere usable for this session (its configured port came out
## occupied and it picked a substitute).
const LSP_RELOCATE_TEMP_PREFIX: String = "lsp-relocate-temp:"
## Prefix under which a project stores per-project editor setting overrides. The
## language server reads its port through EditorSettings, which prefers this value.
const OVERRIDE_PREFIX: String = "editor_overrides/"
## Ports Godot itself may hold: the language server and debug adapter defaults and
## the remote-debug port. A relocation skips them rather than taking one over.
const GODOT_RESERVED_PORTS: Array = [6005, 6006, 6007]
## How far a relocation walks upward from the configured port.
const LSP_RELOCATE_SCAN: int = 16
## Bumped whenever the published record gains a field, so the DSH side can tell a
## stale addon copy (installed before the field existed) from a current one.
const STATE_VERSION: int = 3
## The record file holds one slot per kind of instance. Both kinds serve the same
## project at once — the user's editor and the headless engine this plugin starts —
## and a single slot let whichever published last erase the other's record, which
## made the editor invisible to a caller looking up its instance.
const SLOT_EDITOR: String = "editor"
const SLOT_ENGINE: String = "engine"
## Editor settings naming the two servers this addon reports on. Both are read
## through EditorSettings.get_setting(), which prefers a per-project
## `editor_overrides/<name>` value — that is where a relocated port lives.
const LSP_PORT_SETTING: String = "network/language_server/remote_port"
const DAP_PORT_SETTING: String = "network/debug_adapter/remote_port"
## Command-line flags that override those settings inside the engine. Their value
## wins over the setting, and scripts cannot read the engine's `port_override`
## variable — but the launcher can export the same value, which scripts do see.
const LSP_PORT_FLAG: String = "--lsp-port"
const DAP_PORT_FLAG: String = "--dap-port"
## Environment variables a launcher sets alongside those flags. Godot consumes most
## engine flags before scripts run (an isolated run exposes only `--editor` and
## `--no-window`), so the environment is the only reliable channel.
const LSP_PORT_ENV: String = "DSH_ECHO_LSP_PORT"
const DAP_PORT_ENV: String = "DSH_ECHO_DAP_PORT"
## How often the recorded port facts are compared against the editor settings.
const STATE_REFRESH_MSEC: int = 5000
## How often the listening port is probed. The probe briefly binds the port, so it
## runs far less often than the comparison above.
const STATE_PROBE_MSEC: int = 30000

#endregion

#region -------- 变量定义 --------

var _control_server: TCPServer = null
var _peer_connection: StreamPeerTCP = null
var _control_port: int = 0
var _state_file_path: String = ""
var _receive_buffer: String = ""
var _published_lsp_port: int = -1
var _published_dap_port: int = -1
## -1 = not probed yet, 0 = nobody listens, 1 = something listens. Remembered so a
## refresh never drops a fact the record already carried.
var _published_listening: int = -1
var _next_state_check_at: int = 0
var _next_state_probe_at: int = 0
## Whether this session wrote an in-memory project-level port override it must remove on
## exit. A port DSH asked for is persisted into project.godot instead, and kept.
var _installed_override: bool = false
## The automatic relocation runs once per session, so a port that stays unusable
## cannot make the language server restart in a loop.
var _lsp_relocate_checked: bool = false

#endregion

#region -------- 基础方法 --------

func _enter_tree() -> void:
	var base_port: int = DEFAULT_CONTROL_PORT
	var environment_port: String = OS.get_environment("DSH_ECHO_BRIDGE_PORT")
	if environment_port.is_valid_int():
		var requested_port: int = int(environment_port)
		# A port outside the usable range would bind something we cannot publish.
		if requested_port > 0 and requested_port <= 65535:
			base_port = requested_port
	var state_directory: String = ProjectSettings.globalize_path("res://.godot/")
	DirAccess.make_dir_recursive_absolute(state_directory)
	_state_file_path = state_directory.path_join(STATE_FILE_NAME)
	_listen_on_first_free_port(base_port)
	if _control_server == null:
		push_error("[dsh-echo-bridge] no free control port in %d..%d" % [base_port, base_port + PORT_SCAN_COUNT - 1])
		return
	# Published without the listening probe: the language server only starts once
	# the editor is ready, so probing now would report a free port as "not
	# listening" and could race the server's own bind. The first probe is deferred
	# by one refresh interval, when the server has had time to start.
	_publish_state()
	var now: int = Time.get_ticks_msec()
	_next_state_check_at = now + STATE_REFRESH_MSEC
	_next_state_probe_at = now + STATE_REFRESH_MSEC
	print_debug("[dsh-echo-bridge] listening on 127.0.0.1:%d" % _control_port)


func _exit_tree() -> void:
	_release_peer_connection()
	if _control_server != null:
		_control_server.stop()
		_control_server = null
	# Drop the in-memory override a self-heal installed: that port was chosen on this
	# machine for this run, so persisting it would rewrite the project's settings file.
	# An override DSH asked for is already saved into project.godot and stays.
	if _installed_override:
		_restore_lsp_override()
	# The published file is deliberately left behind. It carries one slot per kind
	# of instance, and another instance *of the same kind* opening this project
	# overwrites that slot: removing the file here would also take an editor's
	# record with it, which is how a still-listening editor becomes undiscoverable.
	# Readers ignore a record whose pid is gone.


## 每帧轮询控制 socket;EditorPlugin 在主循环里自动调用本方法。
## @param _delta: 距上一帧的秒数(本插件不使用)
## @return: void
func _process(_delta: float) -> void:
	if _control_server == null:
		return
	_maybe_refresh_state()
	if _control_server.is_connection_available():
		_release_peer_connection()
		_peer_connection = _control_server.take_connection()
	if _peer_connection == null:
		return
	_peer_connection.poll()
	if _peer_connection.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		_release_peer_connection()
		return
	if _peer_connection.get_available_bytes() <= 0:
		return
	_receive_buffer += _peer_connection.get_utf8_string(_peer_connection.get_available_bytes())
	# TCP 交付字节流而非整行:只有收到完整一行才处理,否则被拆开的 "rescan"
	# 会被当成未知命令,调用方看到的是假失败。一次可能到达多行,逐行处理完。
	while _receive_buffer.find("\n") >= 0:
		var newline_index: int = _receive_buffer.find("\n")
		var request_line: String = _receive_buffer.substr(0, newline_index).strip_edges()
		_receive_buffer = _receive_buffer.substr(newline_index + 1)
		_handle_request(request_line)
	# 不完整的一行留在缓冲里等下一次轮询;超长(无换行的垃圾数据)则丢弃并回错。
	if _receive_buffer.length() > MAXIMUM_REQUEST_LENGTH:
		_receive_buffer = ""
		_peer_connection.put_data("err line too long\n".to_utf8_buffer())


## 处理一行控制请求。
## @param request_line: 已去除首尾空白的请求行(ping / rescan / unsaved:<path>)
## @return: void
func _handle_request(request_line: String) -> void:
	# 带参数的命令先按前缀分派,再走下面的整行匹配。
	if request_line.begins_with(UNSAVED_PREFIX):
		var script_path: String = request_line.substr(UNSAVED_PREFIX.length())
		var answer: String = "yes\n" if _is_unsaved(script_path) else "no\n"
		_peer_connection.put_data(answer.to_utf8_buffer())
		return
	if request_line.begins_with(LSP_RELOCATE_TEMP_PREFIX):
		var temp_requested: String = request_line.substr(LSP_RELOCATE_TEMP_PREFIX.length())
		var temp_port: int = int(temp_requested) if temp_requested.is_valid_int() else 0
		_peer_connection.put_data((_relocate_lsp(temp_port, false) + "\n").to_utf8_buffer())
		return
	if request_line.begins_with(LSP_RELOCATE_PREFIX):
		var requested: String = request_line.substr(LSP_RELOCATE_PREFIX.length())
		var requested_port: int = int(requested) if requested.is_valid_int() else 0
		_peer_connection.put_data((_relocate_lsp(requested_port, true) + "\n").to_utf8_buffer())
		return
	match request_line:
		"ping":
			_peer_connection.put_data("pong\n".to_utf8_buffer())
		"whoami":
			_peer_connection.put_data((PROJECT_PREFIX + _project_root() + "\n").to_utf8_buffer())
		"state":
			# Explicit request: probe now so the reply is current, without touching
			# the published file.
			_probe_state()
			_peer_connection.put_data((STATE_PREFIX + JSON.stringify(_instance_record()) + "\n").to_utf8_buffer())
		"publish":
			_probe_state()
			_publish_state()
			_peer_connection.put_data("ok\n".to_utf8_buffer())
		"lsp-relocate":
			_peer_connection.put_data((_relocate_lsp(0) + "\n").to_utf8_buffer())
		"lsp-restore":
			_restore_lsp_override()
			_peer_connection.put_data("ok\n".to_utf8_buffer())
		"rescan":
			# The editor's own focus scan: registers newly created class_name scripts.
			EditorInterface.get_resource_filesystem().scan_sources()
			print_debug("[dsh-echo-bridge] filesystem rescan triggered")
			_peer_connection.put_data("ok\n".to_utf8_buffer())
		_:
			_peer_connection.put_data("err unknown command\n".to_utf8_buffer())


## 查询某个脚本是否带着未保存的编辑器改动。
##
## 判定条件与引擎自己的"文件已在磁盘上改变"弹窗同源(ScriptEditorBase::is_unsaved):
## 调用方据此跳过对它的重载,因为重载会用磁盘内容覆盖编辑器缓冲,静默丢掉用户
## 正在编辑的内容。引擎在它自己的重载路径上会先弹窗询问,本插件补上同一道判断。
## @param resource_path: res:// 形式的脚本路径
## @return: bool 该脚本有未保存改动时为 true;编辑器不可用时保守返回 false
func _is_unsaved(resource_path: String) -> bool:
	if resource_path.is_empty():
		return false
	var script_editor: Object = EditorInterface.get_script_editor()
	if script_editor == null:
		return false
	return script_editor.get_unsaved_files().has(resource_path)



## 从起始端口起向上寻找可用端口并监听本机回环地址。
## @param base_port: 起始端口(DSH_ECHO_BRIDGE_PORT 或默认值)
## @return: void 结果写入 _control_server 与 _control_port
func _listen_on_first_free_port(base_port: int) -> void:
	# for 循环变量由引擎决定类型,无法显式标注。
	for port_offset in PORT_SCAN_COUNT:
		var candidate_port: int = base_port + port_offset
		var candidate_server: TCPServer = TCPServer.new()
		if candidate_server.listen(candidate_port, "127.0.0.1") == OK:
			_control_server = candidate_server
			_control_port = candidate_port
			return


## 本实例的端口事实,DSH 侧据此找到本实例并判断周边端口的归属。
##
## 除了控制端口,还报告编辑器语言服务器(LSP)与调试适配器(DAP)的端口:两者都会
## 从编辑器设置读取,而设置又可能被项目级 `editor_overrides/<name>` 覆盖,所以只有
## 实例自己读到的值才是准的(调用方从外面猜不出来)。
## @return: Dictionary 本实例的端口事实(键为 String,与 JSON 往返一致)
func _instance_record() -> Dictionary:
	var launched_lsp: int = _launch_port(LSP_PORT_ENV, LSP_PORT_FLAG)
	var lsp_port: int = _lsp_port()
	var dap_port: int = _dap_port()
	var record: Dictionary = {
		&"version": STATE_VERSION,
		&"port": _control_port,
		&"pid": OS.get_process_id(),
		&"project": _project_root(),
		&"lspPort": lsp_port,
		# True when this instance was started with an explicit port (the headless
		# engines this plugin starts), false when it follows the editor settings (the
		# user's editor). A caller needs that to tell the two apart.
		&"lspFromLaunch": launched_lsp > 0,
		&"dapPort": dap_port,
	}
	# 探测结果一旦拿到就一直带着:否则后续刷新会把已发布的事实抹掉,读取方看到
	# 的记录会自相矛盾。
	if _published_listening >= 0:
		record[&"lspListening"] = _published_listening == 1
	return record


## 本实例属于哪种槽位(见 SLOT_EDITOR/SLOT_ENGINE)。
## @return: String 槽位名
func _own_slot() -> String:
	return SLOT_ENGINE if _launch_port(LSP_PORT_ENV, LSP_PORT_FLAG) > 0 else SLOT_EDITOR


## 读取文件里另一个槽位的内容。
##
## 不在这里判断那个实例是否还活着:实测 Godot 的 OS.is_process_running() 会把同机上
## 另一个活着的引擎报成已退出, 一旦据此丢弃, 对方的记录就白白没了。存活判断交给读取
## 方 —— 它用自己那侧可靠的方式验证。
## @param slot: 槽位名
## @return: Variant 该槽位的记录;不存在或形状不对时为 null
func _read_slot(slot: String) -> Variant:
	var text: String = ""
	var state_file: FileAccess = FileAccess.open(_state_file_path, FileAccess.READ)
	if state_file != null:
		text = state_file.get_as_text()
		state_file.close()
	if text.is_empty():
		return null
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		return null
	var data: Dictionary = parsed
	# Plain String keys throughout: JSON.parse_string() yields String keys, and a
	# StringName key is a DIFFERENT key to Dictionary — a `&"version"` write read
	# back as `"version"` misses, which silently loses the other instance's slot.
	if not data.has("version") or int(data.get("version", 1)) < STATE_VERSION:
		data = { (SLOT_ENGINE if bool(data.get("lspFromLaunch", false)) else SLOT_EDITOR): data }
	var entry: Variant = data.get(slot)
	if typeof(entry) != TYPE_DICTIONARY:
		return null
	return entry


## 生效的 LSP 端口:启动时显式指定优先,其次是编辑器设置。
##
## `port_override` 是引擎里的静态变量、脚本读不到,但它优先于设置,所以不认启动端口
## 就会把实际端口报成设置里的旧值 —— 本插件自起的 headless 引擎正是这种情形。
## @return: int 端口号;都没有时为 0
func _lsp_port() -> int:
	var launched: int = _launch_port(LSP_PORT_ENV, LSP_PORT_FLAG)
	return launched if launched > 0 else _editor_port(LSP_PORT_SETTING)


## 生效的 DAP 端口(同上)。
## @return: int 端口号;都没有时为 0
func _dap_port() -> int:
	var launched: int = _launch_port(DAP_PORT_ENV, DAP_PORT_FLAG)
	return launched if launched > 0 else _editor_port(DAP_PORT_SETTING)


## 启动时显式指定的端口(环境变量优先,其次命令行)。
## @param env_name: 启动器设置的环境变量名
## @param flag: 形如 "--lsp-port" 的开关名
## @return: int 端口;未指定或不是合法端口时为 0
func _launch_port(env_name: String, flag: String) -> int:
	var from_env: String = OS.get_environment(env_name)
	if from_env.is_valid_int():
		var port: int = int(from_env)
		if port > 0 and port <= 65535:
			return port
	return _cli_port(flag)


## 命令行显式指定的端口。
##
## Godot 在脚本运行前就消费掉了自己的开关,实测 `OS.get_cmdline_args()` 只剩
## `["--editor", "--no-window"]`,所以正常路径拿不到 —— 保留它是为了某些确实会把
## 参数透出来的构建,真正的通道是 _launch_port 的环境变量。
## @param flag: 形如 "--lsp-port" 的开关名
## @return: int 该开关后面的端口;未出现或不是合法端口时为 0
func _cli_port(flag: String) -> int:
	var args: PackedStringArray = OS.get_cmdline_args()
	for index in range(args.size() - 1):
		if args[index] != flag:
			continue
		var raw: String = args[index + 1]
		if raw.is_valid_int():
			var port: int = int(raw)
			if port > 0 and port <= 65535:
				return port
	return 0


## 探测 LSP 端口是否有人监听,并记住结果。
## @return: void
func _probe_state() -> void:
	_published_listening = 1 if _port_in_use(_lsp_port()) else 0


## 把端口事实写进 .godot/dsh_echo_bridge.json,DSH 侧默认从这里读。
##
## 只写自己那一格,并把另一格原样带过去:编辑器与本插件自起的引擎会同时服务同一个
## 项目,单槽的旧文件曾让后写的那方抹掉先写的那方(调用方随后就分不清两个会话,编辑器
## 甚至直接消失)。已退出的实例留下的那格由读取方忽略,不在这里清理(见 _read_slot)。
## @return: void
func _publish_state() -> void:
	_published_lsp_port = _lsp_port()
	_published_dap_port = _dap_port()
	var record: Dictionary = { "version": STATE_VERSION }
	for slot in [SLOT_EDITOR, SLOT_ENGINE]:
		if slot == _own_slot():
			continue
		var previous: Variant = _read_slot(slot)
		if previous != null:
			record[slot] = previous
	record[_own_slot()] = _instance_record()
	var state_file: FileAccess = FileAccess.open(_state_file_path, FileAccess.WRITE)
	if state_file == null:
		push_warning("[dsh-echo-bridge] cannot publish state to %s" % _state_file_path)
		return
	state_file.store_string(JSON.stringify(record))
	state_file.close()


## 端口事实变了就重写记录,没变就不写。
##
## 写盘本身无害,但"每 5 秒重写一次、且交替带/不带探测字段"会让读取方看到抖动的
## 记录,所以这里只在端口值真的变化时才写;探测另有更慢的独立间隔。
## @return: void
func _maybe_refresh_state() -> void:
	var now: int = Time.get_ticks_msec()
	if now >= _next_state_probe_at:
		_next_state_probe_at = now + STATE_PROBE_MSEC
		_probe_state()
		# Nobody listens on the configured port: Godot's language server failed to
		# bind it (the engine logs that and gives up instead of trying another port),
		# so move it to a free one. Skipped when the port came from `--lsp-port`: that
		# outranks the setting, which would make the override pointless.
		if _published_listening == 0 and not _lsp_relocate_checked and not _lsp_port_overridden_by_cli():
			_lsp_relocate_checked = true
			print_debug("[dsh-echo-bridge] lsp relocate -> %s" % _relocate_lsp(0))
		_publish_state()
		return
	if now < _next_state_check_at:
		return
	_next_state_check_at = now + STATE_REFRESH_MSEC
	if _lsp_port() != _published_lsp_port or _dap_port() != _published_dap_port:
		_publish_state()


## 读一个编辑器设置里的端口。
## @param setting: 设置名
## @return: int 端口号;未设置或不是数字时为 0
func _editor_port(setting: String) -> int:
	var settings: Object = EditorInterface.get_editor_settings()
	if settings == null:
		return 0
	var raw: Variant = settings.get_setting(setting)
	if typeof(raw) == TYPE_INT or typeof(raw) == TYPE_FLOAT:
		var port: int = int(raw)
		if port > 0 and port <= 65535:
			return port
	return 0


## 回环端口上是否已经有人监听。
##
## GDScript 只有"试着绑定"这一种同步探测手段,所以绑定成功后立刻释放:绑定成功即
## 说明那里本来没人。失败则说明已被占用 —— 但占用者是本编辑器的语言服务器还是别的
## 程序,只有调用方用 LSP 握手才能分辨,本探测不做这个判断。
## @param port: 要探测的端口
## @return: bool 已被占用时为 true
func _port_in_use(port: int) -> bool:
	if port <= 0 or port > 65535:
		return false
	var probe: TCPServer = TCPServer.new()
	var bound: bool = probe.listen(port, "127.0.0.1") == OK
	if bound:
		probe.stop()
	return not bound


## 项目根目录绝对路径(与 whoami 回复同一个字符串)。
## @return: String
func _project_root() -> String:
	return ProjectSettings.globalize_path("res://")


## 把编辑器语言服务器挪到一个端口。
##
## 走的是引擎自己的三条公开链路:
##   1) 写项目级覆盖 editor_overrides/network/language_server/remote_port ——
##      EditorSettings.get_setting() 优先读它;
##   2) mark_setting_changed() 标记该组已变更 —— 否则语言服务器收到通知后会先
##      检查"这组变了吗",没变就直接返回,根本不会重启;
##   3) 请编辑器重新广播设置变更 —— 唯一的广播点(notify_changes)只被设置对话框
##      的防抖回调调用,而该对话框是编辑器场景树里的标准节点、其方法绑定给脚本。
## 任何一步不成立都退回原状并报错,由调用方决定降级方案。
##
## `persist_requested` 且 `requested_port > 0` 表示这个端口来自 DSH 配置(DSH 为准):覆盖会
## **落盘进 `project.godot`**,编辑器下次启动直接绑它,不必等下一次检查再搬一次;否则(本会话
## 自愈、或 DSH 只能用替代端口)只写内存、退出时摘掉 —— 那种端口是这台机器当时挑的,不该落盘。
## @param requested_port: 指定端口;<=0 时自行从预设端口向上找
## @param persist_requested: 是否把目标端口写进项目设置文件
## @return: String "ok:<端口>" 或 "err:<原因>"
func _relocate_lsp(requested_port: int, persist_requested: bool = false) -> String:
	var settings: Object = EditorInterface.get_editor_settings()
	if settings == null:
		return "err no editor settings"
	var target: int = requested_port if requested_port > 0 else _find_free_lsp_port()
	if target <= 0:
		return "err no free port"
	if _port_in_use(target):
		return "err port %d in use" % target
	var persist: bool = persist_requested and requested_port > 0
	ProjectSettings.set_setting(OVERRIDE_PREFIX + LSP_PORT_SETTING, target)
	settings.mark_setting_changed(LSP_PORT_SETTING)
	if not _notify_editor_settings_changed():
		# Without the notification the server keeps its old port, so leave no
		# override behind: a later unrelated settings save would have persisted it.
		ProjectSettings.set_setting(OVERRIDE_PREFIX + LSP_PORT_SETTING, null)
		return "err cannot notify editor settings"
	if persist:
		# Rewriting project.godot is the point here: the port then belongs to the
		# project, so the next editor start binds it without another relocation.
		# ProjectSettings.save() rewrites the whole settings table from memory, so the
		# addon's own enable entry has to be in that table first (see _ensure_self_enabled).
		# A failed save leaves this session working and the next one to relocate again.
		_ensure_self_enabled()
		var saved: Error = ProjectSettings.save()
		if saved != OK:
			push_warning("[dsh-echo-bridge] cannot persist the project LSP port: %s" % error_string(saved))
	_installed_override = not persist
	_published_listening = -1
	_next_state_probe_at = Time.get_ticks_msec() + STATE_REFRESH_MSEC
	_published_lsp_port = target
	# Publish at once: the caller reads the record right after this reply, and the
	# periodic refresh would leave it stale for a whole interval.
	_publish_state()
	return "ok:%d" % target


## 摘掉本会话安装的端口覆盖,让语言服务器回到编辑器设置里的端口。
## @return: void
func _restore_lsp_override() -> void:
	var settings: Object = EditorInterface.get_editor_settings()
	ProjectSettings.set_setting(OVERRIDE_PREFIX + LSP_PORT_SETTING, null)
	# Marking is what lets the language server's notification handler past its
	# "did this group change?" guard; without it the server is left stopped instead
	# of rebinding the configured port.
	if settings != null:
		settings.mark_setting_changed(LSP_PORT_SETTING)
	_installed_override = false
	_published_listening = -1
	_next_state_probe_at = Time.get_ticks_msec() + STATE_REFRESH_MSEC
	if not _notify_editor_settings_changed():
		return
	_published_lsp_port = _lsp_port()
	_publish_state()


## 本 addon 的 plugin.cfg 在 `res://` 下的路径(project.godot 启用项里写的就是它)。
## @return: String 路径;拿不到脚本路径时为空串
func _self_res_path() -> String:
	var script: Script = get_script()
	if script == null:
		return ""
	return script.resource_path.get_basename() + ".cfg"


## 把自己补进内存里的 `editor_plugins/enabled`,供随后的一次落盘使用。
##
## 启用项可能是本插件在编辑器**启动之后**才写进 project.godot 的 —— 那时编辑器内存里的
## 列表还没有我们。`ProjectSettings.save()` 是把内存里整张设置表重写回文件,不先补齐,
## 这次落盘就会把自己刚写的启用项抹掉,下次编辑器启动不再加载桥。
## @return: void
func _ensure_self_enabled() -> void:
	var key: String = "editor_plugins/enabled"
	var self_path: String = _self_res_path()
	if self_path.is_empty():
		return
	var current: Variant = ProjectSettings.get_setting(key)
	var list: PackedStringArray = current if typeof(current) == TYPE_PACKED_STRING_ARRAY else PackedStringArray()
	if list.has(self_path):
		return
	list.append(self_path)
	ProjectSettings.set_setting(key, list)


## 请编辑器重新广播一次设置变更,这是语言服务器重读端口的前提。
## @return: bool 是否成功触发
func _notify_editor_settings_changed() -> bool:
	var tree: SceneTree = get_tree()
	if tree == null:
		return false
	for node in tree.root.find_children("*", "EditorSettingsDialog", true, false):
		if node.has_method("_settings_changed"):
			node.call("_settings_changed")
			return true
	return false


## 从配置端口向上找第一个可用端口,跳过 Godot 自己可能占用的端口、本插件的控制端口
## 区间,以及调试适配器端口。
## @return: int 可用端口;找不到时为 0
func _find_free_lsp_port() -> int:
	var base: int = _lsp_port()
	# An unset or out-of-range setting gives no meaningful port to walk from; the
	# caller falls back to its own engine instead of us picking an arbitrary one.
	if base <= 0:
		return 0
	var dap_port: int = _dap_port()
	for offset in range(1, LSP_RELOCATE_SCAN + 1):
		var candidate: int = base + offset
		if candidate > 65535:
			return 0
		if GODOT_RESERVED_PORTS.has(candidate) or candidate == dap_port:
			continue
		if candidate >= _control_port and candidate < _control_port + PORT_SCAN_COUNT:
			continue
		if not _port_in_use(candidate):
			return candidate
	return 0


## 端口是否由 `--lsp-port` 显式指定(它优先于设置,覆盖就没意义了)。
## @return: bool
func _lsp_port_overridden_by_cli() -> bool:
	return _launch_port(LSP_PORT_ENV, LSP_PORT_FLAG) > 0


## 释放当前对端连接并清空接收缓冲。
## @return: void
func _release_peer_connection() -> void:
	if _peer_connection != null:
		_peer_connection.disconnect_from_host()
		_peer_connection = null
	_receive_buffer = ""

#endregion
