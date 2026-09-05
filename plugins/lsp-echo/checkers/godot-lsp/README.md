# Godot GDScript 编译错误实时反馈 —— LSP 方案(设计 + 实测 + 可移植工具)

> 面向 DeepSeek Harness / AI 协作工作流:AI(或开发者)每改完一批 `.gd`,能在几秒内拿到
> **全工程语义级别**的解析/编译错误,而不依赖人眼去编辑器里看报错、再手贴文本。
> 本机实测:2026-09-04(Windows, Godot 4.7 stable mono);工具本身跨平台(纯 Node,零依赖)。

---

## 1. 背景与痛点(上一轮会话结论)

- 编辑器(VSCode godot-tools LSP / Godot 原生编辑器)的实时诊断**只有人能看**,AI 侧拿不到 → 只能靠人贴报错文本。
- 曾经验证过的替代方案都有硬伤:
  - `godot --headless --check-only --script res://xxx.gd` 单文件检查:**不注册全局 class_name**,出现 `Identifier not found: ItemLibraryManager` 一类误报;
  - 整项目逐脚本 load 的临时 SceneTree runner:**Godot 进程崩溃**(`0xC0000005`),输出还会被 Tee 写成 UTF-16。

## 2. 方案定论:不做编辑器插件,做一个 LSP 客户端

- 报错本体是 **Godot 引擎自带的语言服务器(LSP)**,不是编辑器 UI;原生编辑器面板和 VSCode godot-tools 是同一个 LSP 的不同客户端。
- Godot 4.2+ 官方支持 `--lsp-port` 启动 **Headless(无窗口)编辑器实例专职当语言服务器**(godot-vscode-plugin 的 `godotTools.lsp.headless` 即此用法,见 [ClientConnectionManager.ts](https://github.com/godotengine/godot-vscode-plugin/blob/master/src/lsp/ClientConnectionManager.ts))。
- 因此原生编辑器用户、VSCode 用户、纯 AI 改文件场景**全部通吃**;不需要 Godot 源码、不需要改引擎。

| 旧痛点 | 本方案 |
|---|---|
| 单文件检查缺 class_name → 误报 | Headless 编辑器全工程加载,全局类全注册 |
| 全量 load 498 脚本 → 崩溃 / Tee UTF-16 | 只走官方 `--lsp-port` + 标准 LSP 协议 |
| AI 拿不到诊断 | 客户端把 `publishDiagnostics` 落盘成 JSON + 打印摘要 |

**运行时不需要** GUI 编辑器、不需要 VSCode、不需要任何编辑器插件。只需要:
① Godot 引擎可执行文件(≥4.2,项目同级或更高版本) ② 对该项目目录的写权限(headless 要写 `.godot/` 导入缓存,权限不足会 signal 11 崩溃) ③ Node.js ≥ 18。

## 3. 目录结构(全部内容可整体拷贝到其他电脑)

```
godot-lsp-tooling/
├── godot-lsp.mjs                  # 桥:零依赖单文件 CLI(Node,无 npm install)
├── godot-lsp.config.json          # 本机配置(不拷贝/或拷贝后改)
├── godot-lsp.config.example.json  # 换机模板
├── README.md
├── .runtime/                      # 运行时状态(自动生成:host pid/port、诊断 JSON、host 日志)
└── reference/
    ├── probe.mjs                  # 最小 LSP 客户端(桥的前身/参考实现)
    └── live-test-evidence.json    # 首次实测记录
```

## 4. 桥 CLI:godot-lsp.mjs

```
node godot-lsp.mjs check <file...> [--project <dir>] [--godot <exe>] [--out <json>] [--once]
node godot-lsp.mjs smoke <file>    [--project <dir>] [--godot <exe>]   # 自检(不改磁盘文件)
node godot-lsp.mjs watch           [--project <dir>] [--godot <exe>] [--out <json>]
node godot-lsp.mjs host | stop     [--project <dir>] [--godot <exe>]
```

自动发现(全部可被 `--xxx` 或配置文件覆盖):
- **Godot**:`--godot` > 配置 `godot`/`godotBin` > 环境变量 `GODOT_BIN` > PATH(`godot`/`godot4`)
- **项目**:`--project` > 配置 `project`/`defaultProject` > 从当前目录向上找 `project.godot`
- **端口**:每次自动挑空闲端口(不写死)
- **输出**:默认 `<工具目录>/.runtime/lsp_diagnostics-<项目名>.json`,`--out` 覆盖

退出码:`0` = 无错误;`1` = 发现错误(供脚本分支);`2` = 用法/配置/运行失败。

### 示例

```powershell
# 全自动(在项目目录内):检查刚改的文件
node E:\GodotProject\godot-lsp-tooling\godot-lsp.mjs check Modules\Storage\UI\item_card.gd

# 多文件 + 指定配置
node godot-lsp.mjs check E:\GodotProject\xu_world\A.gd E:\GodotProject\xu_world\B.gd

# 拉起常驻 host,之后每次 check 秒回
node godot-lsp.mjs host
node godot-lsp.mjs stop
```

### 运行行为

- 首个 `check` 自动拉起 headless host(首次含导入约 20–60s),之后**复用**同一 host(秒级);
- 每个被查文件:读取磁盘内容 → LSP `didOpen`/`didChange` → 等 `publishDiagnostics` → 归一化;
- 结果写 JSON(原子写 tmp+rename),控制台打印人类可读摘要,错误行格式
  `相对路径:行:列: [error] 消息`;
- `smoke <file>`:把真实文件内容送进 LSP 缓冲、注入一行语法错误、验证能报出来、恢复——
  全程不写项目磁盘(自检/换机验证用);
- `watch`:轮询项目 `.gd`(默认跳过 `.godot`、`addons`),文件变化即推送检查并刷新 JSON,
  只在新错误出现/消失时打印。

## 5. 落盘 JSON schema

```jsonc
{
  "tool": "godot-lsp", "version": 1,
  "project": "E:\\GodotProject\\xu_world",
  "server": "headless-godot-lsp", "port": 60192,
  "updated_at": "…",
  "files": {
    "Modules/Equipment/UI/equipment_panel_simple.gd": {
      "checked_at": "…",
      "diagnostics": [
        {
          "severity": 1, "severityName": "error",   // 1=error 2=warning …
          "message": "Expected expression for variable initial value after \"=\".",
          "source": "gdscript", "code": 0,
          "line": 2, "column": 16,                    // 1-based
          "range": { "start": { "line": 1, "character": 15 }, "end": { "line": 1, "character": 18 } },
          "file": "Modules/Equipment/UI/equipment_panel_simple.gd"
        }
      ],
      "errors": 1, "warnings": 0
    }
  },
  "summary": { "files_checked": 1, "errors": 1, "warnings": 0, "files_with_errors": ["…"] }
}
```

## 6. 实测证据

| 阶段 | 结果 |
|---|---|
| Headless host 启动 + `initialize` | ✅ 上报工程 `E:/GodotProject/xu_world` |
| 干净文件(引用 5+ 全局类)`check` | ✅ 0 诊断,跨文件 `class_name` 无误报 |
| `smoke` 注入第 2 行语法错误 | ✅ 4 条诊断,定位 `2:24 Expected expression…` |
| 真实坏文件 `check` | ✅ `_gd_lsp_probe_broken.gd:5:12` 两条解析错误,exit=1 |
| host 复用 | ✅ 第二次 `check` 秒回(`reusing host`) |

完整原始事件见 `reference/live-test-evidence.json`。

### 已知边界与坑

- **headless host 必须能写项目 `.godot/`**:被权限/沙箱拦截时 mono 抛 `UnauthorizedAccessException` 并 signal 11 崩溃(即早年 `0xC0000005` 真凶)。在 DSH 沙箱里跑需放行项目目录写访问。
- **Windows mono 下进程常是"双进程"**(console 启动器 + 承载 LSP/GUI 名子进程);桥按进程树清理(`taskkill /T` / 进程组),`stop` 保证全清。
- Godot LSP **未实现 `shutdown`**(-32601),退出靠杀进程。
- `publishDiagnostics` 的 URI 带百分号编码(`file:///E%3A/…`),桥内已解码匹配。
- 服务端不替你 watch 磁盘:**谁改文件谁推送**;桥在每次 `check`/`watch` 里显式推磁盘内容。
- GUI 原生编辑器实测**不会自动监听 LSP 端口**(4.7 编辑器设置里有 `network/language_server/remote_port=6005` 但不监听);所以不依赖它,统一走 Headless host。桥 host 运行期间建议别同时开 GUI 编辑器编辑同项目(共用 `.godot/` 缓存,可能互相重扫)。
- 同项目大版本引擎必须匹配项目(4.x 用 4.x)。

## 7. 换电脑部署(可移植性)

1. **前置**:Node ≥ 18;Godot ≥ 4.2(版本与项目匹配;装完建议加入 PATH);
2. 拷贝整个 `godot-lsp-tooling/` 目录(无需 `npm install`);
3. 复制 `godot-lsp.config.example.json` → `godot-lsp.config.json`,按本机填三项(可全留空):
   - `godotBin` 留空=走 PATH;填绝对路径如 `E:/Godot Engine/…/Godot_v4.7…_console.exe`(Windows 推荐 console 版,能留日志);
   - `defaultProject` 留空=进项目目录再执行;或直接填项目根;
4. 自检:在工具目录执行 `node godot-lsp.mjs smoke <项目里任意一个 .gd 的绝对路径>`,
   看到 `smoke PASS — clean=0 …, injected-error phase≥1` 即部署成功;
5. 使用:任意位置 `node godot-lsp.mjs check <改过的文件…>`,读 JSON / 退出码。

代码没有任何写死的机器路径;跨平台路径(Windows `\` / POSIX `/`)与进程树清理均已处理。
