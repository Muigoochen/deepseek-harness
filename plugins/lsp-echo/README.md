# lsp-echo

把**语言服务器(LSP)的编译/诊断错误自动"回声"给 AI** 的 harness 插件。
**自包含**:管理代码 + 引擎程序(bridge)一起分发,用户不需要单独去弄"桥"。

- Godot 项目 → 自带 `godot-lsp` 引擎(真正的 Godot LSP → 编译诊断);
- 后续其它语言 → 在 `checkers/` 加一个引擎目录即可(如 C#)。

**纯插件守则**:不改仓库任何产品/底层源码;所有机器状态落在 `$DSH_HOME`;仓库 `packages/`、`apps/` 一行不动。

## 它会做什么

| 能力 | 说明 |
|---|---|
| **自动反馈(#1 核心)** | AI(或人)编辑项目后,插件在下一轮模型请求前自动跑编译检查,**有错误就把 `文件:行:列` 清单注入上下文**(`agent/pre-step` 插件快照,同 time-context 范式,自动落会话日志) |
| **多 LSP(项目为主)** | 一个项目(目录)可绑**多个引擎**,各自认领自己的文件扩展名(如 GDScript `.gd` + 未来 C# `.cs`);编辑变化按扩展名路由到对应引擎检查,结果合并进一个按项目诊断快照 |
| **显式管理工具** | 模型工具 `lsp_echo`:`host`/`stop`/`status`/`check`/`baseline`/`projects`/`scan` |
| **引擎生命周期** | **智能连接**:你已打开该项目的 Godot 编辑器时,直接 attach 它的 LSP 端口(6005,零额外内存、秒级就绪);否则自起 headless 引擎常驻复用;启动决策带**跨进程文件锁**(杜绝并发双起);插件卸载时自动 detach/停止,`stop` 显式停 |
| **引擎桥(新脚本即时可见)** | Godot 只在**扫描文件系统**时注册 `class_name`,而运行中的引擎不会自己重扫(编辑器靠"窗口重新获得焦点"触发,headless 永不触发)。把一个约 165 行的编辑器插件 `addons/dsh_echo_bridge` 装进项目后,插件可以**要求运行中的引擎重扫**,"新建脚本 → 引用它的文件报 `Could not find type`"这类**假错会自动消失**。同一机制也覆盖**内容改动**:你在 DSH 里改过的脚本(如父类方法签名)会在检查前先让引擎重扫,不会再出现"子类仍按旧父类签名报错"。见「引擎桥」 |
| **改签名即时反映到调用点** | 引擎只对递给它的那个文件作答,所以签名变化弄坏的是**调用者**而不是被改的文件。改动 `.gd` 时插件按 `class_name` 与 `res://` 路径找出引用它的文件,并入同一轮检查(实测 500 文件项目索引一趟 18 ms、平均 5.4 个引用者),「改了函数参数却没有任何反馈」不会再发生 |
| **GUI(浏览器半)** | 会话头部 **⧆ 图标 + 错误角标**(仅项目会话显示),点击弹**诊断浮层面板**:项目路径 + 引擎模式徽章(`editor attach`/`headless`) + 工具条(刷新/全量重扫/启停引擎)+ 按文件分组的 error/warning 列表,每 3s 自动刷新;另有**设置页("LSP 诊断")**:项目为主卡片 + 全局自动注入开关 + 手动添加引擎 + 智能配置 |
| **按项目门控** | 只对已知项目生效;会话工作区不在其中就不注入、零打扰 |
| **项目自动发现** | **只在两个时机各扫一次(不周期轮询)**:①插件启用时扫已有 harness 工作区;②会话进入未扫过的工作区时按需扫。发现结果**持久化在 harness 自带 settings(`lsp-echo` 命名空间,settings.yaml 同款机制),以工作区 id 为键**,工作区删除即由同步自动清理;`projects`/`scan` 可查看/手动触发 |

## 目录结构(自包含)

```
plugins/lsp-echo/
├─ package.json            @dsh-user/lsp-echo(host 函数插件 + web client 半)
├─ README.md               本文件
├─ docs/design.md          架构 + seams 证据 + 语言扩展路线
├─ .gitignore              零构建:豁免父级对 lib/ 的忽略(lib 即源码,须入库)
├─ lib/                    harness 插件代码
│  ├─ index.js             装载入口:配置/接线/自动注入/多引擎路由/host JSON API
│  ├─ client.js            浏览器半(GUI):会话头部图标+角标、诊断浮层、设置页
│  ├─ tool.js              lsp_echo 模型工具
│  ├─ manager.js           调引擎 + per-project 串行诊断快照 writer(keyspace 合并/驱逐)
│  ├─ watcher.js           项目扩展名参数化 mtime 差量 + 重建保差量 + 新增/删除文件跟踪
│  ├─ dependents.js        改动脚本的反向引用扫描(class_name 词边界 + res:// 路径字面,含 addons/)
│  ├─ addon.js             引擎桥 addon 的安装/端口发现/探测(installAddonInto/ensureEditorPluginEnabled/discoverBridgePort)
│  ├─ registry.js          工作区扫描/判定原语(存储=harness settings 命名空间)
│  └─ checkers.js          引擎注册表(engine.json: name/marker/extensions/bridge[/rescan/rescanPort/addon])
├─ checkers/               ← 引擎程序(每语言一目录,加目录即注册)
│  └─ godot-lsp/           第一个引擎(原 godot-lsp-tooling 迁入)
│     ├─ engine.json       注册表描述(name/marker/extensions/bridge/rescan/rescanPort/addon)
│     ├─ godot-lsp.mjs     桥 CLI: host/status/stop/check/smoke/watch/rescan
│     ├─ addon/dsh_echo_bridge/  随引擎分发的 Godot 编辑器插件(控制socket → scan_sources())
│     ├─ godot-lsp.config.example.json
│     ├─ README.md         桥自身文档(自检/换机)
│     └─ reference/        实测证据与探针
└─ install/
   ├─ install.ps1          复制到 profile + 生成机器配置 + patch 加行(幂等)
   ├─ uninstall.ps1        逆操作
   └─ patch.example.yml    cordis.patch.yml 行示例
```

## 安装(每台机器一次)

```powershell
# 仓库内(无需网络/依赖,拷贝即用)
powershell -ExecutionPolicy Bypass -File E:\Deepseek\deepseek_harness\plugins\lsp-echo\install\install.ps1 `
  -GodotBin "E:\Godot Engine\Godot_v4.7-stable_mono_win64\Godot_v4.7-stable_mono_win64_console.exe" `
  -Project "E:\GodotProject\xu_world"

# 重启 dsh web 后生效
# 卸载:
powershell -ExecutionPolicy Bypass -File ...\install\uninstall.ps1
```

install.ps1 会:
1. 把整个插件包复制到 `$DSH_HOME\profiles\node_modules\@dsh-user\lsp-echo\`(**含 checkers 引擎**);
2. 若引擎缺机器配置,自动探测/生成 `checkers\godot-lsp\godot-lsp.config.json`(可省略,桥会走 PATH 或 `--godot`);
3. 在 `profiles\web\cordis.patch.yml` 幂等追加 `lsp-echo` 行(可卸载)。

**依赖**:需与 `plugins/toast`(@dsh-user/toast)同装——本插件的浮窗提示(就绪 / 自动发现 / 首次全量诊断
进度与结果)经 `ctx.toast` 发出;`inject` 已声明 `toast`,未装 toast 时插件会等待而不激活。

仓库只携带 `*.config.example.json`;**本机路径永远不提交**。

## 验证(装完/换机后)

```powershell
# ① 引擎自检(不需要编辑器窗口;真实 Godot 引擎编译)
node "$env:DSH_HOME\profiles\node_modules\@dsh-user\lsp-echo\checkers\godot-lsp\godot-lsp.mjs" smoke E:\GodotProject\xu_world\Modules\Equipment\UI\equipment_panel_simple.gd

# ② 在会话里让 AI 改坏一个 .gd → 下一轮应自动出现 [lsp-echo] 错误清单
# ③ 手动:模型工具 lsp_echo: host / status / check files=[...]
```

## 配置(装载行)

```yaml
- insert:
    - id: lsp-echo
      name: '@dsh-user/lsp-echo'
      config:
        projects:                    # 显式注册(可选;发现的项目自动合并)
          - path: 'E:/GodotProject/xu_world'
            lsp:                     # v2:lsp 数组(旧 engine 单值仍兼容,读侧归一)
              - engine: godot-lsp
            autoInject: true         # 默认(项目级豁免;通常不动)
        autoInject: true             # 全局自动注入默认值(设置页可切,持久化在 settings)
        autoDiscover: true           # 启用时/会话进新工作区时一次性扫描注册
        watchSkip: ['.godot', 'addons']
        discoverSkip: ['.git', '.godot', 'node_modules', 'addons', '.venv', 'dist', 'build', 'plugins', 'vendor']
```

装载行也可只写 `projects: [{ path, engine }]`(v1 单值,读侧自动归一成 lsp 数组)。
项目绑定(含用户手动配置/全局自动注入开关)在运行时经**设置页写入 harness settings 的
`lsp-echo` 命名空间**(manual 层),与装载行 config 种子叠加(config → discovered → manual
优先级)。

引擎自身的 Godot exe / 默认项目等**机器配置**在引擎自己的 `godot-lsp.config.json`(由安装脚本生成),与插件配置分离。**编辑器 LSP 端口**建议在**设置页 → LSP 诊断 → 引擎(LSP)卡**直接填(存入 harness settings `enginePorts`,attach 时优先于此 config),config 仅作兜底:

```jsonc
// checkers/godot-lsp/godot-lsp.config.json
{ "editorPort": 6005,           // 兜底:设置页没填「编辑器 LSP 端口」时用这个(默认 6005)
  "attachEditor": true,         // false = 完全不 attach,始终自起 headless(优先于 attachPolicy)
  "attachPolicy": "prefer-editor" }  // 编辑器后开时:迁回 attach(默认)/ cold-start 保持先到者
```

**智能连接语义**:attach 模式下引擎是你编辑器的客人(`stop`/卸载只 detach,**绝不杀你的编辑器进程**);编辑器关掉后下次检查自动 fallback headless;实测 attach 就绪 0.1s、全量 501 文件 ≈4.7s。

**编辑器后开怎么办(attachPolicy)**:引擎决策在**每次检查前**重做,不是"启动时定终身"。
`prefer-editor`(默认)= 若发现"我们自己的 headless 在跑、而你的编辑器现在也可连",就**迁回 attach 并停掉我们自己那个 headless**,一个项目只留一个引擎;
`cold-start` = 谁先起就用谁(适合你同时用 VSCode 的 Godot 插件连编辑器 LSP 的机器——迁回会挤掉它一次,它会自己重连)。
改法:引擎的 `godot-lsp.config.json` 里设 `"attachPolicy": "cold-start"`(见 `godot-lsp.config.example.json`)。
迁回只停**我们 spawn 的** headless,你的编辑器进程永远不动。

若编辑器端口可达、但它服务的是**别的项目**,插件会拒绝该端口并记 5 分钟黑名单(见下一条)。
黑名单到期后会重试一次,因此"编辑器长期开着另一个项目"时,每个周期会重复一次
"迁回 → 拒绝 → 回退自己的引擎";期间诊断不会出错(拿不到就自起引擎),代价是那一轮要多起一次引擎。

**拒绝"服务别的项目"的编辑器**:编辑器 LSP 服务的是它当前打开的那个项目。若握手后发现它 announce 的项目
不是本次检查的项目,该端口会被记入黑名单并回退到我们自己的引擎——否则拿到的空诊断会伪装成"0 错误"。

**项目注册数据的持久化**:写入 **harness 自带 settings** 的 `lsp-echo` 命名空间(`settings.yaml` 机制),不新增插件配置文件。结构:
`discovered`(键=工作区 id;自动发现,工作区删除即被同步清理)+ `manual`(键=项目路径;用户/未来 GUI 配置)。

## GUI(浏览器半)

装好后,打开某 **Godot 项目会话**(工作区在已注册项目内),会话头部("创造模式"按钮右侧)会出现 **⧆ 图标**:

- 图标角标 = 该项目最近一次诊断的错误数(红数字/绿 ✓),每 3s 刷新;
- **点图标** → 从图标下方展开**诊断浮层**:项目路径 + 引擎模式徽章
  (`editor attach` = 附加你的编辑器 / `headless`)+ 工具条(**刷新 / 全量重扫 / 启动引擎 / 停止**)+
  摘要(`501 files · 0 err · 8 warn`)+ 按文件分组的 error/warning(点文件名展开详情,
  `.gdshader` 显示 `engine_note`);
- ESC 或点浮层外关闭;非项目会话不显示图标(零打扰)。

**设置页**(设置面板 → "LSP 诊断"):项目为主的卡片列表 ——
- 顶部**自动注入(全局)**开关:新项目第一次加入 DSH 时自动智能配置并在编辑后反馈;
- 每张项目卡 = 项目目录名 + 已绑定引擎 chips(✕ 移除)+ 常驻**手动添加引擎**下拉/按钮 +
  **安装引擎桥 / 检测引擎桥**(见「引擎桥」)+ **智能配置**(扫描项目补缺失引擎,只补充不覆盖)+ 还原种子/移除手动配置;
- **登记行**:从 **DSH 工作区项目下拉**选择登记(已登记的选项禁用,含无 GDScript 的
  工作区根——登记仅占位,不会产生诊断;无需手输绝对路径);
- 引擎(LSP)卡:每引擎一行(名称+扩展名)+「编辑器 LSP 端口」输入(留空保存 = 恢复默认自动);
- 操作结果提示显示在设置页顶部;无引擎文件的项目首次全量只提示一次。

实现:静态 client 半(`lib/client.js`),挂 `conversation.session.header.actions` + `shell.overlay`
+ `settings.section`;数据/控制走 host 路由 `GET /lsp-echo/api`
(action:`projects|engines|config|enginePort|addCandidates|smart|setProject|addLsp|delLsp|resetProject|delProject|host|stop|status|baseline|diagnostics|installAddon|bridgeStatus`)。
**有副作用的 action 必须带 `x-dsh-lsp-echo: 1` 头**(`installAddon`/`smart`/`setProject`/`addLsp`/`delLsp`/`resetProject`/`delProject`/`baseline`/`host`/`stop`,以及带参数的 `config`/`enginePort`):
浏览器不会给跨站请求附加自定义头,因此别的网页无法让 DSH 写你的项目或停你的引擎;只读 action 不设门。
详见 `docs/design.md` §8。

## 引擎桥(让运行中的引擎发现新建脚本)

**问题**:Godot 只在**扫描项目文件系统**时把脚本的 `class_name` 注册为全局类名
(`EditorFileSystem::_update_script_classes` → `ScriptServer::add_global_class`)。
运行中的引擎不会自己重扫:编辑器靠 `NOTIFICATION_APPLICATION_FOCUS_IN → scan_changes()`
(窗口重新获得焦点)触发,`--headless` 引擎**永不触发**。于是新建一个带 `class_name` 的脚本后,
引用它的文件会被误报 `Could not find type "X" in the current scope.`,直到引擎重启。

**做法**:插件把一个随引擎分发的 Godot 编辑器插件复制进项目并登记启用:

1. 设置页项目卡 → **安装引擎桥** → 写入 `<项目>/addons/dsh_echo_bridge/`(plugin.cfg + plugin.gd),
   并在 `project.godot` 的 `[editor_plugins] enabled` 里追加一条(已有该条则不动,幂等);
2. **重启 Godot 编辑器**(或在「项目设置 → 插件」里确认已启用)后生效;
   **headless 引擎下次启动会自动读取该设置**——不需要额外操作;
3. **检测引擎桥** 报告当前是否有引擎实例在线(能响应重扫请求)。

addon 在本机 `127.0.0.1` 上监听一个控制端口,把一行 `rescan` 变成
`EditorInterface.get_resource_filesystem().scan_sources()`(与编辑器获得焦点时同一条扫描路径)。
端口从 6089 起**自动向后找可用端口**(多个项目/编辑器+headless 并存时不会互抢),
并把选中的端口写进 `<项目>/.godot/dsh_echo_bridge.json`;桥读该文件即可找到属于本项目的实例,
**无需任何配置**。CLI 也支持显式指定:`node godot-lsp.mjs rescan --project <dir> [--bridge-port <n>]`。

**触发时机**(全部自动):

- 检测到项目里 **`.gd` 文件新增/删除** → 检查前先让引擎重扫;
- **本轮有 `.gd` 改动**(内容变了,例如你或在 DSH 里改了父类签名) → 检查前先让引擎重扫。
  attach 到你的编辑器时它可能仍持编辑前的副本,不重扫就会报出**陈旧签名**;headless 引擎无此问题,重扫对它也无害;
- 诊断里出现 `Could not find type "X"`,而项目里**确实存在** `class_name X` → 判定为"引擎未刷新",
  重扫后**再检查一次**并采用新结果(真错误不会受影响:名字不存在就不重扫)。

**撤销**:删除 `<项目>/addons/dsh_echo_bridge/`,并把 `project.godot` 的
`[editor_plugins] enabled` 里 `"res://addons/dsh_echo_bridge/plugin.cfg"` 这一项删掉(该段若只剩这一项,
整段删除即可)。删掉后插件自动退回"提示引擎未刷新"的降级行为,不会报错。

**未安装 addon 时**:插件不会静默假装正常——会尝试一次,失败后进入冷却,并浮窗提示一次
("引擎未刷新"),agent 侧看到的仍是引擎真实诊断。这保证了"没装桥"永远不会变成假通过。

**版本要求**:引擎桥调用 `EditorFileSystem.scan_sources()`(编辑器脚本可见的方法)。在 Godot 4.7 上
实测通过;更早的 4.x 若未暴露该方法,addon 会抛 `Invalid call`,插件按"重扫失败"处理(冷却 + 提示),
同样不会静默当成通过。

**代码风格**:随插件分发的 addon 遵循目标项目的 GDScript 规范——禁用 `:=` 类型推断、显式类型提示、
`#region` 区域划分、`print_debug()`/`push_warning()`/`push_error()` 日志分工、字符串字典键用 `StringName`、
`## @param` / `## @return` 方法注释。要放进你自己项目的东西,就得按你项目的规范写。

## 扩展其它语言(路线)

1. `checkers/<engine>/` 放入一个实现统一契约的桥:`host|status|stop|check <files...> --project <dir>`(可参考 `godot-lsp.mjs`);
2. 在该目录加 `engine.json` 声明 `{ name, marker, extensions[], bridge }` —— **注册表自动出现,
   设置页引擎卡/智能配置/编辑路由/管理工具全部零改动**;若该引擎也能"被要求重扫",可再声明
   `{ rescan: true, rescanPort: <端口>, addon: <随引擎附带的 addon 目录名> }`,并在桥里实现
   `rescan [--project <dir>] [--bridge-port <n>]` 子命令(向 addon 的控制端口发一行 `rescan` 并等待 `ok`);
3. 自动反馈/管理/生命周期代码无需改动。

详见 `docs/design.md`。
