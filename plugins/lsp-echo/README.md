# lsp-echo

把**语言服务器(LSP)的编译/诊断错误自动"回声"给 AI** 的 harness 插件。
**自包含**:管理代码 + 引擎程序(bridge)一起分发,用户不需要单独去弄"桥"。

- Godot 项目 → 自带 `godot-lsp` 引擎(真正的 Godot LSP → 编译诊断);
- 后续其它语言 → 在 `checkers/` 加一个引擎目录即可(如 C#)。

**纯插件守则**:不改仓库任何产品/底层源码;所有机器状态落在 `$DSH_HOME`;仓库 `packages/`、`apps/` 一行不动。

## 它会做什么

| 能力 | 说明 |
|---|---|
| **自动反馈(#1 核心)** | AI(或人)编辑项目后,插件在下一轮模型请求前自动跑编译检查,**有错误就把 `文件:行:列` 清单注入上下文**(`agent/pre-step` 插件快照,同 time-context 范式,自动落会话日志)。**每次插件装载后、每个项目首次进入其会话时自动做一次全量诊断**:网页端点开对话即触发(`agent/created`,常见 `resume`/`startup`),在首条消息之前就已开始,引擎扫描与用户打字并行;此后每轮只查变更文件 |
| **多 LSP(项目为主)** | 一个项目(目录)可绑**多个引擎**,各自认领自己的文件扩展名(如 GDScript `.gd` + 未来 C# `.cs`);编辑变化按扩展名路由到对应引擎检查,结果合并进一个按项目诊断快照 |
| **显式管理工具** | 模型工具 `lsp_echo`:`host`/`stop`/`status`/`check`/`baseline`/`projects`/`scan` |
| **引擎生命周期** | **智能连接**:你已打开该项目的 Godot 编辑器时,直接 attach 它的 LSP 端口(6005,零额外内存、秒级就绪);否则自起 headless 引擎常驻复用;启动决策带**跨进程文件锁**(杜绝并发双起);插件卸载时自动 detach/停止,`stop` 显式停 |
| **引擎桥(新脚本即时可见)** | Godot 只在**扫描文件系统**时注册 `class_name`,而运行中的引擎不会自己重扫(编辑器靠"窗口重新获得焦点"触发,headless 永不触发)。把一个约 165 行的编辑器插件 `addons/dsh_echo_bridge` 装进项目后,插件可以**要求运行中的引擎重扫**,"新建脚本 → 引用它的文件报 `Could not find type`"这类**假错会自动消失**。同一机制也覆盖**内容改动**:你在 DSH 里改过的脚本(如父类方法签名)会在检查前先让引擎重扫,不会再出现"子类仍按旧父类签名报错"。见「引擎桥」 |
| **改签名即时反映到调用点** | 引擎只对递给它的那个文件作答,所以签名变化弄坏的是**调用者**而不是被改的文件。改动 `.gd` 时插件按 `class_name` 与 `res://` 路径找出引用它的文件,并入同一轮检查(实测 500 文件项目索引一趟 18 ms、平均 5.4 个引用者),「改了函数参数却没有任何反馈」不会再发生 |
| **GUI(浏览器半)** | 会话头部 **⧆ 图标 + 错误角标**(仅项目会话显示),点击弹**诊断浮层面板**:项目路径 + 引擎模式徽章(`editor attach`/`headless`) + 工具条(刷新/全量重扫/启停引擎)+ 按文件分组的 error/warning 列表,每 3s 自动刷新;另有**设置页("LSP 诊断")**:项目为主卡片 + 全局自动注入开关 + 手动添加引擎 + 智能配置 |
| **按项目门控** | 只对已知项目生效;会话工作区不在其中就不注入、零打扰 |
| **监控范围可配(项目级)** | 决定哪些目录里的脚本改动会触发检查。`node_modules`/`.git`/`.godot` **铁定跳过**;其余**按项目**在设置页「跳过目录」输入框里按逗号配置,支持目录名(任意层级)与项目相对路径(`addons/third_party`)两种写法。**`addons/**` 默认在监控范围内** —— 不少项目的交付物就是一个 Godot 插件;只有本插件自己的引擎桥 `addons/dsh_echo_bridge` 默认跳过 |
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
   ├─ install.ps1          用 `dsh plugin` 装进 profile + 生成机器配置(幂等)
   ├─ uninstall.ps1        逆操作
   └─ patch.example.yml    profile 层覆盖行示例(projects 是机器本地信息)
```

包根还有 `cordis.patch.yml` —— 本包作为 bundle 贡献给 profile 的配置层(见「安装」)。

## 安装(每台机器一次)

```powershell
# 需要 pnpm 在 PATH 上:`dsh plugin` 会转发给它
powershell -ExecutionPolicy Bypass -File E:\Deepseek\deepseek_harness\plugins\lsp-echo\install\install.ps1 `
  -GodotBin "E:\Godot Engine\Godot_v4.7-stable_mono_win64\Godot_v4.7-stable_mono_win64_console.exe" `
  -Project "E:\GodotProject\xu_world"

# 重启 dsh web 后生效
# 卸载:
powershell -ExecutionPolicy Bypass -File ...\install\uninstall.ps1
```

install.ps1 会(幂等):
1. 用 DSH 官方方式安装本包 —— `dsh plugin --profile web add <本包路径>`,在
   `profiles\web\node_modules\@dsh-user\lsp-echo` 建立**指回本仓库的 junction**,并把它登记进该 profile 的
   bundle 列表(层顺序由 `dsh.profile.bundles` 决定);
2. 若缺引擎机器配置,自动探测并写入 `$DSH_HOME\lsp-echo\godot-lsp.config.json`
   (机器本地状态一律落在 `$DSH_HOME`,**不写进仓库**;可省略,桥会走 PATH 或 `--godot`);
3. 若给了 `-Project`,`profiles\web\cordis.patch.yml` 幂等追加带 `projects` 的 `lsp-echo` 行
   (同 id 的行在 bundle 层之后应用并胜出,所以机器本地项目列表写这里);
4. 跑安装自检(见「安装自检」)。

装的是 **junction**,所以改源码立即生效,重装不再是必需步骤。卸载:
`dsh plugin --profile web remove @dsh-user/lsp-echo`,或用 `install\uninstall.ps1`。

**依赖**:需与 `plugins/toast`(@dsh-user/toast)同装——本插件的浮窗提示(就绪 / 自动发现 / 首次全量诊断
进度与结果)经 `ctx.toast` 发出;`inject` 已声明 `toast`,未装 toast 时插件会等待而不激活。

仓库只携带 `*.config.example.json`;**本机路径永远不提交**。

## 验证(装完/换机后)

```powershell
# ① 引擎自检(不需要编辑器窗口;真实 Godot 引擎编译)
node "$env:DSH_HOME\profiles\web\node_modules\@dsh-user\lsp-echo\checkers\godot-lsp\godot-lsp.mjs" smoke E:\GodotProject\xu_world\Modules\Equipment\UI\equipment_panel_simple.gd

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
            # skipDirs: 'addons/third_party'   # 可选:本项目额外跳过的目录,逗号分隔
        autoInject: true             # 全局自动注入默认值(设置页可切,持久化在 settings)
        autoDiscover: true           # 启用时/会话进新工作区时一次性扫描注册
        watchSkip: ['addons/dsh_echo_bridge']   # 全局兜底的项目级跳过列表(项目自己设了就不用它)
```

**跳过目录(监控范围)**:决定哪些目录里的脚本改动会触发一次检查。分两层——

- **铁定跳过**(不可配):`node_modules`、`.git`、`.godot`。它们不可能放你要交付的源码。
- **可配跳过**(默认 `addons/dsh_echo_bridge`,即本插件自己的引擎桥):其余 `addons/**` **默认已经在监控范围内**,因为不少项目的交付物就是一个 Godot 插件,放在 `addons/<你的插件>/` 下。

在**设置页 → LSP 诊断 → 项目卡**的「跳过目录」输入框里按项目改,逗号分隔。两种写法:

| 写法 | 匹配 |
| --- | --- |
| `build` | 任意层级下所有叫 `build` 的目录 |
| `addons/third_party` | 按**项目相对路径**精确匹配(还包含它的子目录) |

留空 = 该项目不跳过任何可选目录(即整个 `addons/` 都监控)。输入框里显示的是**这个项目自己设的值**,旁边那行「生效:」才是当前实际生效的完整列表——两者不同即说明该项目在继承全局。改完要点「保存」才生效——Host 会把当前跳过列表并入 watcher 的缓存键,下一次 `ensureWatcher` 自然重建。

> **保存的副作用**:项目级跳过列表只能存在 settings 的 **manual 层**(与引擎绑定同一个位置),所以给一个从 config/自动发现来的项目保存跳过列表,会把它变成**手动配置**——卡片来源徽章变成「手动」、按钮从`还原种子`变成`移除手动配置`,并且此后`智能配置`不再自动改它。想退回种子用`还原种子`,但注意那会**连跳过列表一起清掉**。

> **从旧版本升级**:旧版默认 `watchSkip: ['.godot', 'addons']`。如果你在 profile 的 `cordis.patch.yml` 里**显式写过** `watchSkip`,那个值会继续生效——全局列表里的 `addons` 被视为可选跳过项,于是所有没有单独设置的项目仍然看不见 `addons/**`。这种情况下项目卡的「生效:」会明确列出 `addons`,不再是无提示的静默行为。想享受新默认:把 `watchSkip` 那行删掉,或在项目卡里保存一个空值。
>
> 全局 `watchSkip: []`(空数组)是**回退到默认**、而不是「全局不跳过任何可选目录」;要表达后者,请在每个项目里保存一个空值。

> 注意:**引擎桥 `addons/dsh_echo_bridge` 默认仍然跳过**。若把它也纳入监控,首次装桥会产生一次无意义的变动比较;它由本插件自动维护,不是你要编辑的源码。

装载行也可只写 `projects: [{ path, engine }]`(v1 单值,读侧自动归一成 lsp 数组)。
项目绑定(含用户手动配置/全局自动注入开关)在运行时经**设置页写入 harness settings 的
`lsp-echo` 命名空间**(manual 层),与装载行 config 种子叠加(config → discovered → manual
优先级)。

引擎自身的 Godot exe / 默认项目等**机器配置**位于 `$DSH_HOME\lsp-echo\godot-lsp.config.json`(由安装脚本生成),与插件配置分离。旧位置 `checkers\godot-lsp\godot-lsp.config.json` 仍作**读取兜底**,但不要再往那里写:装成 junction 后那就是本仓库,写进去等于把本机路径提交上去。**编辑器 LSP 端口**建议在**设置页 → LSP 诊断 → 引擎(LSP)卡**直接填(存入 harness settings `enginePorts`,attach 时优先于此 config),config 仅作兜底:

```jsonc
// $DSH_HOME/lsp-echo/godot-lsp.config.json
{ "editorPort": 6005,           // 兜底:设置页没填「编辑器 LSP 端口」时用这个(默认 6005)
  "attachEditor": true,         // false = 完全不 attach,始终自起 headless(优先于 attachPolicy)
  "attachPolicy": "prefer-editor" }  // 编辑器后开时:迁回 attach(默认)/ cold-start 保持先到者
```

**预留端口不会被自己占用**:设置页里填过的**每个**编辑器 LSP 端口(跨项目、跨引擎)都会作为「预留端口」经 `--reserve-ports` 转给引擎启动逻辑,自起的 headless 引擎**必须避开**它们(本项目没填覆盖时,`godot-lsp.config.json` 的兜底端口也算)。除了 `--lsp-port`,还会额外指定 `--dap-port`,因为 Godot 任何 `--editor` 实例都会顺带打开**调试适配器(DAP)**监听,其默认端口是 **6006**。若你把编辑器 LSP 端口设成 6006,不指定 DAP 端口的引擎就会把它占掉 —— 后果是:你的编辑器绑不上该端口,而插件探测 6006 时探到的是**自己的引擎**,于是把你的编辑器端口误报成「可连接但不响应」并拉黑 5 分钟。

现在:**(1)** 这种"占位者其实是自己"的情形会被识别为**内部端口冲突**,文案明确说是插件自己的引擎(而不是让你去查编辑器),插件会停掉那个引擎、释放端口,并且**不拉黑**你的编辑器端口。**(2)** 若某个 Godot 版本(4.2 不认 `--dap-port`)仍抢占了预留端口,插件**不会**因此杀掉引擎 —— 因为同一个现象也可能是你的编辑器恰好在引擎启动那几秒内起来占了端口,误杀会让诊断全没。此时引擎照常工作,只弹一条提示说明"很可能是引擎占的",并建议把编辑器 LSP 端口改成 6006 以外的值(例如 6008)或换用 Godot 4.3+。

**智能连接语义**:attach 模式下引擎是你编辑器的客人(`stop`/卸载只 detach,**绝不杀你的编辑器进程**);编辑器关掉后下次检查自动 fallback headless;实测 attach 就绪 0.1s、全量 501 文件 ≈4.7s。

**多项目并存**:每项目独立状态文件(`host-<项目目录名>.json`)、独立 clientd、独立基线与重扫冷却键,
所以两个项目同时开发互不干扰;addon 控制端口从 6089 起向上走位,且每个实例只把端口公布在自己项目的
`.godot/` 下,因此不互抢。**唯一的例外是编辑器 attach 端口**:两个 Godot 项目共用一个引擎 id,
而「编辑器 LSP 端口」可以按项目分别配置(见设置页引擎卡),**必须分别填写**,否则两个项目都去探同一个
端口,第二个项目的编辑器会因"服务的是别的项目"被拒 → 回退 headless(仍可用,但不是 attach)。

**项目身份**:一律用项目根的**绝对路径**(比对时小写归一化),与登记表、clientd 池、基线状态、
重扫冷却键完全一致——这样一个项目不会在某处算一个、在另一处算两个。项目被移动或改名后,
它的端口配置条目自然失配,回落到兜底设置,不会出错。Godot 项目本身没有唯一 ID,目录即身份。

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
- 徽章显示「独立引擎」时,浮层顶部会说明原因(编辑器端口没监听 / 桥已复制但未启用 / 端口有响应但没实例上报 / 编辑器在线但还没检查),不让你猜;
- ESC 或点浮层外关闭;非项目会话不显示图标(零打扰)。

**设置页**(设置面板 → "LSP 诊断"):项目为主的卡片列表 ——
- 顶部**自动注入(全局)**开关:新项目第一次加入 DSH 时自动智能配置并在编辑后反馈;
- 顶部**自动安装 Godot 引擎桥**开关(**默认开**):发现项目缺 `addons/dsh_echo_bridge` 时自动装上(新增该目录,
  并写 `project.godot` 的 `[editor_plugins]` 启用)。引擎桥是 **Godot 专属**的**进阶能力**——不装也能正常诊断(检查、注入、
  多项目路由都不依赖它),但缺了它会退化三处:新建 `class_name` 脚本首轮误报未知类型、改动后的自愈重检不触发、
  且「改动后刷新」失去「该脚本有无未保存改动」的守卫(会覆盖你正在编辑的内容)。关掉后仍可用项目卡的
  「安装 Godot 引擎桥」按钮手动安装——**重复安装即覆盖更新/修复**;
  开关开启时,自动安装**不只看文件是否存在**:项目里 addon 文件在、而 `project.godot` 里没有启用项
  (Godot 从未加载它 → 编辑器里的实例无法上报端口 → 项目永远接不上你的编辑器、只能一直用独立引擎)也会被补上启用;
  时机是**打开该项目的会话**与每次检查前,并浮窗提示重启 Godot 编辑器;补写失败会**明确报错**并按项目冷却 5 分钟再试
  (避免每次检查都重抄 addon、重发提示、并把下一轮要用的引擎停掉);注入关掉的项目不会被改写;
- 每张项目卡 = 项目目录名 + 已绑定引擎 chips(✕ 移除)+ 常驻**手动添加引擎**下拉/按钮 +
  **安装 Godot 引擎桥 / 检测 Godot 引擎桥**(见「引擎桥」)+ **智能配置**(扫描项目补缺失引擎,只补充不覆盖)+ 还原种子/移除手动配置;
- **登记行**:从 **DSH 工作区项目下拉**选择登记(已登记的选项禁用,含无 GDScript 的
  工作区根——登记仅占位,不会产生诊断;无需手输绝对路径);
- 引擎(LSP)卡:每引擎一块 —— 名称+扩展名,下挂「编辑器 LSP 端口」输入,分**全部项目(兜底)**与**每个项目**两档;
  项目级优先于兜底,再回落到引擎默认(6005)。留空保存 = 清除该行覆盖;
- 操作结果提示显示在设置页顶部;无引擎文件的项目首次全量只提示一次。

实现:静态 client 半(`lib/client.js`),挂 `conversation.session.header.actions` + `shell.overlay`
+ `settings.section`;数据/控制走 host 路由 `GET /lsp-echo/api`
(action:`projects|engines|config|enginePort|addCandidates|smart|setProject|addLsp|delLsp|resetProject|delProject|host|stop|status|baseline|diagnostics|installAddon|bridgeStatus|locales|setLocale`)。
**有副作用的 action 必须带 `x-dsh-lsp-echo: 1` 头**(`installAddon`/`smart`/`setProject`/`addLsp`/`delLsp`/`resetProject`/`delProject`/`baseline`/`host`/`stop`,以及带参数的 `config`/`enginePort`/`setLocale`):
浏览器不会给跨站请求附加自定义头,因此别的网页无法让 DSH 写你的项目、停你的引擎,也无法改掉浮窗提示所用的语言;只读 action(`projects`/`engines`/`diagnostics`/`status`/`addCandidates`/`bridgeStatus`/`locales`)不设门。
`status` 另带 `editor`/`bridge` 事实(端口是否有监听、是否有实例上报端口、桥是否已装/已启用),供浮层解释「为什么还在用独立引擎」;其中端口取桥自己报的探测目标(设置 → 引擎配置 → 默认),因此和真正会去连的端口一致;引擎副本过旧、状态行里没有该字段时回退到设置值或默认 6005(只影响这一行提示)。
详见 `docs/design.md` §8。

## 多语言(中 / 英)

界面文案与浮窗提示都走词典,**一种语言一个 JSON,键值对**:

```
lib/locales/zh.json     中文(默认语言,也是回退目标)
lib/locales/en.json     英文
```

**语言跟随 DSH,插件不另设开关**。浏览器半把词典注册进 Client 的 `locale` 服务,你在 DSH 设置里选中文还是
英文,插件的设置页、浮层、按钮提示**立即跟着切换**,并复用该服务的回退链(活跃语言 → 回退语言 →
`common` 命名空间 → 原样显示 key)。`locale` 服务缺席时(极简组合)退回用 API 返回的当前语言词典,
插件照常可用——少一个服务不该让设置页变空。

**Host 侧文本(浮窗提示)也是同一语言**。host 发通知时并不知道当前语言,所以浏览器半在语言变化时通过
`action=setLocale` 告知它,host 用**同一份 JSON** 翻译。

**段落排版**:一个键的值可以是**字符串数组**,数组每一项就是一段。长说明因此逐段成行、段间留间距,
而不是挤成一大段。渲染侧有三个入口:`t(key, params)` 返回原值(字符串或数组)、`tLine()` 拼成单行
(给浮窗这类单行目标)、`renderParts()` 渲染成多段(给设置页)。

**加一种语言**:在 `lib/locales/` 放 `<lang>.json`,键集合与 `zh.json` 保持一致,并在 `lib/i18n.js` 的
`localeIds()` 里登记。占位符写成 `{name}`,由调用方通过 `params` 替换,两种语言里的位置可以不同。

## 安装自检

`install/install.ps1` 装好之后会跑四道检查,**任何一道失败都中止安装并以 exit 1 结束**,
而不是等你重启 `dsh web` 才发现问题:

1. **host 半可导入** —— 插件在模块顶层构造 schema,写错会让 `dsh web` 整个起不来;
2. **`client.js` 可作为浏览器半解析** —— 它由页面原样加载,只能 `require` 平台种子。
   注意 `node --check` 对 `.js` 会按 ESM 解析(包里有 `"type": "module"`),因此这一步是把它
   复制成 `.cjs` 再解析的:**`import`/`export`/顶层 await 会在这里失败**,而这正是零构建产物最致命的错误;
3. **词典可解析、中英键完全一致、段落结构一致** —— 不一致会静默退化成显示 key;
4. **源码引用的每个 i18n 键都存在于词典** —— 从**源码树**检查(陈旧安装掩盖不了),并指出缺失键所在的文件与行号;
   同时报告**未被引用的死键**(不判失败,只提示清理)。

安装后 profile 通过 `link:` 指向本目录,**没有复制步骤**,源码改动直接生效。但 `package.json` 的
`files` 必须列全运行期资源(`lib/`、`checkers/`、`cordis.patch.yml`、`README.md`)——那个清单决定的是
**打包发布**时包里有什么,漏项会让别人装到的副本缺文件。

## 引擎桥(让运行中的 Godot 引擎发现新建脚本)

**问题**:Godot 只在**扫描项目文件系统**时把脚本的 `class_name` 注册为全局类名
(`EditorFileSystem::_update_script_classes` → `ScriptServer::add_global_class`)。
运行中的引擎不会自己重扫:编辑器靠 `NOTIFICATION_APPLICATION_FOCUS_IN → scan_changes()`
(窗口重新获得焦点)触发,`--headless` 引擎**永不触发**。于是新建一个带 `class_name` 的脚本后,
引用它的文件会被误报 `Could not find type "X" in the current scope.`,直到引擎重启。

**做法**:插件把一个随引擎分发的 Godot 编辑器插件复制进项目并登记启用:

1. 设置页项目卡 → **安装 Godot 引擎桥** → 写入 `<项目>/addons/dsh_echo_bridge/`(plugin.cfg + plugin.gd),
   并在 `project.godot` 的 `[editor_plugins] enabled` 里追加一条(已有该条则不动,幂等);
2. **重启 Godot 编辑器**(或在「项目设置 → 插件」里确认已启用)后生效;
   **headless 引擎下次启动会自动读取该设置**——不需要额外操作;
3. **检测 Godot 引擎桥** 报告当前是否有引擎实例在线(能响应重扫请求)。

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
`#region` 区域划分、`print_debug()`/`push_warning()`/`push_error()` 日志分工、`## @param` / `## @return` 方法注释。

**字符串键要留意一个坑**:常量键用 `StringName`(`&"port"`)是项目惯例,但**任何与 JSON 往返的字典,读回来的键是 `String`** —— 而 `String` 与 `StringName` 在 `Dictionary` 里是**两个不同的键**。用 `&"version"` 写、用 `"version"` 读会静默读不到(我们踩过:记录文件里另一格因此丢失)。规则:凡是要在 GDScript 侧再查一遍的键,统一用 `String`。

## 已知问题

**1. 首次全量诊断的「0 个编译错误」可能滞后**(实测)

- 现象:启用后第一次全量诊断报 `扫描 29 个文件，0 个编译错误`,而磁盘上正躺着 2 个硬语法错误(逐脚本 `--check-only` 立刻 `exit 1`);那几条 error 过一会儿才补报出来。
- 方向:冷启动的引擎在完成首次项目导入前对任何文件都答"无诊断",而摘要在此之前就发出了。
- 处理:待修 —— 等引擎首次扫描稳定后再给结论,或让文件集停止增长后重试一次(见 `lib/index.js` 的 `TODO(baseline-lag)`)。
- **在修好之前:这个「0 个错误」只能读作"没发现",不能当"通过"**;逐脚本编译门(如 `Test/spike/check_compile.ps1`)仍是唯一判定依据。插件自身的定位是**第一道快速提示**。

**2. addon 要更新到当前版本才会上报端口事实**

旧副本答不了 `state`(回 `err unknown command`),插件会回退到"按配置端口尽力而为"的模式。更新:设置页 → 项目卡 →**安装 Godot 引擎桥**(它同时就是更新);此外,在开着「自动安装引擎桥」时,装了**旧副本的项目会在下次检查时自动覆盖为新版本**并浮窗提示(插件每轮比对自带与已装的 `plugin.cfg`/`plugin.gd` 内容;关掉该开关则不自动更新)。两种方式都需要重启该项目的 Godot 编辑器,新副本才会被加载。

另外,「addon 文件在、但 Godot 没加载它」这种半装状态现在会被自动补上启用项(见「引擎桥」一节),并浮窗提示重启编辑器;此前它是完全无声的 —— 表现为「你的编辑器和插件的独立引擎同时跑着,而徽章一直是独立引擎」。

**3. 编辑器 LSP 端口与 Godot 自己的 DAP 默认端口(6006)冲突**

Godot 任何 `--editor` 实例都会打开调试适配器(DAP),默认端口正是 **6006** —— 也是用户最常给编辑器 LSP 选的端口。插件按设置里的目标端口对齐:`alignEditorTarget()` 先问 addon 报的实际端口,不一致就让它搬(目标空闲时精确搬到目标);目标被占(常见就是被编辑器自己的 DAP 占着)则搬到一个空闲端口,并在 host 状态里记下替换(`reason: editor-port-relocated`,含原目标与新端口),交给 DSH 侧采纳与告知。**host 侧的"采纳并写入设置 + 提示用户"尚未接线。**

搬到设置里的目标端口时,桥会把该端口写成**项目级覆盖**(`editor_overrides/network/language_server/remote_port`)并**落盘进 `project.godot`**:编辑器下次启动直接绑这个端口,不必再搬一次。代价是项目文件里多一段与机器相关的配置(它会随仓库一起被提交)——DSH 的配置是唯一来源,端口改了下次检查会覆盖它。以下两种情况**不落盘**:目标端口被别的进程占着、只能搬到替代端口时(替代端口只对本次会话生效),以及桥为**本会话自愈**(配置端口没人监听、它自己挑了一个)时。落盘失败只在编辑器日志里留一条 warning,本会话照常可用。

## 扩展其它语言(路线)

1. `checkers/<engine>/` 放入一个实现统一契约的桥:`host|status|stop|check <files...> --project <dir>`(可参考 `godot-lsp.mjs`);
2. 在该目录加 `engine.json` 声明 `{ name, marker, extensions[], bridge }` —— **注册表自动出现,
   设置页引擎卡/智能配置/编辑路由/管理工具全部零改动**;若该引擎也能"被要求重扫",可再声明
   `{ rescan: true, rescanPort: <端口>, addon: <随引擎附带的 addon 目录名> }`,并在桥里实现
   `rescan [--project <dir>] [--bridge-port <n>]` 子命令(向 addon 的控制端口发一行 `rescan` 并等待 `ok`);
3. 自动反馈/管理/生命周期代码无需改动。

详见 `docs/design.md`。
