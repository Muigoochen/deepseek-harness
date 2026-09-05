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
│  ├─ watcher.js           项目扩展名参数化 mtime 差量 + 重建保差量
│  ├─ registry.js          工作区扫描/判定原语(存储=harness settings 命名空间)
│  └─ checkers.js          引擎注册表(engine.json: name/marker/extensions/bridge)
├─ checkers/               ← 引擎程序(每语言一目录,加目录即注册)
│  └─ godot-lsp/           第一个引擎(原 godot-lsp-tooling 迁入)
│     ├─ engine.json       注册表描述(name/marker/extensions/bridge)
│     ├─ godot-lsp.mjs     桥 CLI: host/status/stop/check/smoke/watch
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

引擎自身的 Godot exe / 默认项目 / **编辑器端口**等**机器配置**在引擎自己的 `godot-lsp.config.json`(由安装脚本生成),与插件配置分离。智能连接相关:

```jsonc
// checkers/godot-lsp/godot-lsp.config.json
{ "editorPort": 6005,     // 你已打开的 Godot 编辑器 LSP 端口;非默认端口改这里
  "attachEditor": true }  // false = 不 attach,始终自起 headless
```

**智能连接语义**:attach 模式下引擎是你编辑器的客人(`stop`/卸载只 detach,**绝不杀你的编辑器进程**);编辑器关掉后下次检查自动 fallback headless;实测 attach 就绪 0.1s、全量 501 文件 ≈4.7s。

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
  **智能配置**(扫描项目补缺失引擎,只补充不覆盖)+ 还原种子/移除手动配置;
- 底部可手动添加项目(绝对路径 + 引擎),也可对全部非手动项目一次智能配置。

实现:静态 client 半(`lib/client.js`),挂 `conversation.session.header.actions` + `shell.overlay`
+ `settings.section`;数据/控制走 host 路由 `GET /lsp-echo/api`
(action:`projects|engines|config|smart|setProject|addLsp|delLsp|resetProject|delProject|host|stop|status|baseline|diagnostics`)。
详见 `docs/design.md` §8。

## 扩展其它语言(路线)

1. `checkers/<engine>/` 放入一个实现统一契约的桥:`host|status|stop|check <files...> --project <dir>`(可参考 `godot-lsp.mjs`);
2. 在该目录加 `engine.json` 声明 `{ name, marker, extensions[], bridge }` —— **注册表自动出现,
   设置页引擎卡/智能配置/编辑路由/管理工具全部零改动**;
3. 自动反馈/管理/生命周期代码无需改动。

详见 `docs/design.md`。
