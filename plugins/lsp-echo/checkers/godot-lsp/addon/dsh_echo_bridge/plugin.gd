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
##   rescan -> ok   (after the filesystem scan was triggered)
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

#endregion

#region -------- 变量定义 --------

var _control_server: TCPServer = null
var _peer_connection: StreamPeerTCP = null
var _control_port: int = 0
var _state_file_path: String = ""
var _receive_buffer: String = ""

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
	_publish_control_port()
	print_debug("[dsh-echo-bridge] listening on 127.0.0.1:%d" % _control_port)


func _exit_tree() -> void:
	_release_peer_connection()
	if _control_server != null:
		_control_server.stop()
		_control_server = null
	# Remove the published port only when it is ours: another engine instance may
	# have replaced the file while this one was shutting down.
	if _state_file_path == "" or not FileAccess.file_exists(_state_file_path):
		return
	var state_file: FileAccess = FileAccess.open(_state_file_path, FileAccess.READ)
	if state_file == null:
		return
	var parsed_state: Variant = JSON.parse_string(state_file.get_as_text())
	state_file.close()
	if parsed_state is Dictionary and int(parsed_state.get(&"pid", -1)) == OS.get_process_id():
		DirAccess.remove_absolute(_state_file_path)


## 每帧轮询控制 socket;EditorPlugin 在主循环里自动调用本方法。
## @param _delta: 距上一帧的秒数(本插件不使用)
## @return: void
func _process(_delta: float) -> void:
	if _control_server == null:
		return
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
## @param request_line: 已去除首尾空白的请求行(ping / rescan)
## @return: void
func _handle_request(request_line: String) -> void:
	match request_line:
		"ping":
			_peer_connection.put_data("pong\n".to_utf8_buffer())
		"rescan":
			# The editor's own focus scan: registers newly created class_name scripts.
			EditorInterface.get_resource_filesystem().scan_sources()
			print_debug("[dsh-echo-bridge] filesystem rescan triggered")
			_peer_connection.put_data("ok\n".to_utf8_buffer())
		_:
			_peer_connection.put_data("err unknown command\n".to_utf8_buffer())


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


## 把实际绑定的端口写进 .godot/dsh_echo_bridge.json,DSH 侧据此找到本实例。
## @return: void
func _publish_control_port() -> void:
	var state_file: FileAccess = FileAccess.open(_state_file_path, FileAccess.WRITE)
	if state_file == null:
		push_warning("[dsh-echo-bridge] cannot publish control port to %s" % _state_file_path)
		return
	state_file.store_string(JSON.stringify({ &"port": _control_port, &"pid": OS.get_process_id() }))
	state_file.close()


## 释放当前对端连接并清空接收缓冲。
## @return: void
func _release_peer_connection() -> void:
	if _peer_connection != null:
		_peer_connection.disconnect_from_host()
		_peer_connection = null
	_receive_buffer = ""

#endregion
