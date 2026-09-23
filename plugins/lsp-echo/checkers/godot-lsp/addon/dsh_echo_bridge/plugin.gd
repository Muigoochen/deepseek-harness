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
##     addon scans when the published file is missing or stale (the file holds a
##     single slot, so a second engine's record replaces it), and must not latch
##     onto another project's addon found in the same range.
##   rescan -> ok   (after the filesystem scan was triggered)
##   unsaved:<res path> -> yes | no
##     Whether that script has unsaved changes in the script editor. The caller
##     checks this before asking the language server to reload the script: a
##     reload rewrites the editor buffer from disk and would silently discard
##     those changes, which is exactly what the editor itself refuses to do
##     without asking (see ScriptEditor::_test_script_times_on_disk).
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
## Bumped whenever the published record gains a field, so the DSH side can tell a
## stale addon copy (installed before the field existed) from a current one.
const STATE_VERSION: int = 2
## Editor settings naming the two servers this addon reports on. Both are read
## through EditorSettings.get_setting(), which prefers a per-project
## `editor_overrides/<name>` value — that is where a relocated port lives.
const LSP_PORT_SETTING: String = "network/language_server/remote_port"
const DAP_PORT_SETTING: String = "network/debug_adapter/remote_port"
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
	# The published file is deliberately left behind. It holds one instance's
	# record, and another engine opening this project overwrites it: removing it
	# here would take that other instance's only record with it, which is how a
	# still-listening editor becomes undiscoverable. Readers ignore a record
	# whose pid is gone.


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
	match request_line:
		"ping":
			_peer_connection.put_data("pong\n".to_utf8_buffer())
		"whoami":
			_peer_connection.put_data((PROJECT_PREFIX + _project_root() + "\n").to_utf8_buffer())
		"state":
			# Explicit request: probe now so the reply is current, without touching
			# the published file.
			_probe_state()
			_peer_connection.put_data((STATE_PREFIX + _state_json() + "\n").to_utf8_buffer())
		"publish":
			_probe_state()
			_publish_state()
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
## @return: String 单行 JSON(控制协议按行分帧,不能带换行)
func _state_json() -> String:
	var lsp_port: int = _editor_port(LSP_PORT_SETTING)
	var record: Dictionary = {
		&"version": STATE_VERSION,
		&"port": _control_port,
		&"pid": OS.get_process_id(),
		&"project": _project_root(),
		&"lspPort": lsp_port,
		&"dapPort": _editor_port(DAP_PORT_SETTING),
	}
	# 探测结果一旦拿到就一直带着:否则后续刷新会把已发布的事实抹掉,读取方看到
	# 的记录会自相矛盾。
	if _published_listening >= 0:
		record[&"lspListening"] = _published_listening == 1
	return JSON.stringify(record)


## 探测 LSP 端口是否有人监听,并记住结果。
## @return: void
func _probe_state() -> void:
	_published_listening = 1 if _port_in_use(_editor_port(LSP_PORT_SETTING)) else 0


## 把端口事实写进 .godot/dsh_echo_bridge.json,DSH 侧默认从这里读。
## @return: void
func _publish_state() -> void:
	_published_lsp_port = _editor_port(LSP_PORT_SETTING)
	_published_dap_port = _editor_port(DAP_PORT_SETTING)
	var state_file: FileAccess = FileAccess.open(_state_file_path, FileAccess.WRITE)
	if state_file == null:
		push_warning("[dsh-echo-bridge] cannot publish state to %s" % _state_file_path)
		return
	state_file.store_string(_state_json())
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
		_publish_state()
		return
	if now < _next_state_check_at:
		return
	_next_state_check_at = now + STATE_REFRESH_MSEC
	if _editor_port(LSP_PORT_SETTING) != _published_lsp_port or _editor_port(DAP_PORT_SETTING) != _published_dap_port:
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


## 释放当前对端连接并清空接收缓冲。
## @return: void
func _release_peer_connection() -> void:
	if _peer_connection != null:
		_peer_connection.disconnect_from_host()
		_peer_connection = null
	_receive_buffer = ""

#endregion
