# RFC:lsp-echo 多 LSP 重构(v2,项目为主)

状态:已两轮评审(2026-09-05,意见并入)。作者:臭宝 + lsp-echo 开发者。日期:2026-09-05。

> **首评结论(并入)**:主线可行,先修 4 处再执行:①落盘 per-project 串行扁平 writer
> + 修 v1 main/baseline 双写竞态;②checkers.js 参数化桥文件名 + tool.js/registry.js 入清单;
> ③迁移策略(存量 autoInject:false 处置、config 死字段);④autoInject 全局化副作用。
> 按 §13 四段顺序执行。
>
> **二评结论(实证核查并入)**:方向正确、§8 writer 成立,**段1(注册表参数化)可立即开工**。
> 文档层仍须改 4 项(不阻塞段1;阻塞段2 的为 ①②):
> ① settings 架构事实:scope.get() 返回的**已是 schema resolve 后值**,"读时包装先于 schema
>    校验"不成立 → 迁移改 **schema 双形兼容 + 读侧归一**(§3.2 重写);
> ② seedKnown 顺序文字与现码/design 矛盾:config 必须先于 discovered 或 config 走 setKnown(§3.2.4);
> ③ §8 补"合并后 summary 重算"与"驱逐旧键只以 lsp 配置变更为准";
> ④ manual 写路径与 GUI chips 并发策略:整组列表 stale 覆盖 → host 增量 action 或单飞行。
> 另(应改):autoInject 豁免来源只认 manual 覆盖不到 v1 config 存量 autoInject:false;
> smart 一次落 manual 后永久冻结 config 后续变更;桥状态文件 basename 同名项目冲突。
> 四段落地(§13)不变。

## 1. 动机与心智模型

用户(臭宝)的核心诉求:**一个项目(目录)可含多种语言,每种语言配一个 LSP;
LSP 的职责 = 该语言文件一有编译/编辑变化,错误即时反馈给 agent**。
类比 VSCode"一个工作区装多个语言扩展"。

现在实现是"一项目一引擎"(manual `engine` 单值),无法表达混合语言项目
(如 Godot 项目既有 `.gd`/`.gdshader` 又有 C# `.cs`;又如 Harness 仓库 TS+JS)。

界面诉求:设置页**以项目为主** —— 打开"LSP 诊断"设置页,一眼看到
"我的 N 个项目各挂了哪些 LSP",每个 LSP 标注认领的扩展名。

## 2. 目标模型

```
项目(known 记录,持久化在 manual/config 层)
  path           绝对路径
  lsp[]          [{ engine: 'godot-lsp' }, { engine: 'csharp-lsp' }, ...]
  source         config | manual | workspace(生效优先级见 §5)
  autoInject?    (废弃,见 §7)

引擎(LSP)注册表 checkers/<engine>/
  { bridge, marker(项目类型判据), extensions[](认领的文件扩展名), name }
  现装:godot-lsp   marker=project.godot   extensions=[.gd,.gdshader]
  将来:typescript-lsp(marker=tsconfig.json,…)、csharp-lsp(marker=.csproj,…)…
```

## 3. 数据模型与迁移

### 3.1 settings `lsp-echo` 命名空间(REGISTRY_SCHEMA)

```js
discovered: [{ key(workspace id), path, title, scannedAt, projects: [root,...] }]  // 不变
manual:     [{ path, lsp: [{ engine }], source: 'manual' }]                          // engine 单值 → lsp 数组
```

Config(cordis.yml 静态种子)projects:
```js
projects: [{ path, lsp: [{ engine }] }]   // engine → lsp 数组
```

### 3.2 迁移与 schema 兼容(二评①:settings 架构事实)

**架构事实(实证)**:harness settings 的 `scope.get()` 返回的**已是 schema resolve 后值**
(注册/发布/写路径都在 schema 内 resolve);schemastery object 非 strict 解析对未知键是
**merge 保留**(不 strip 不抛),坑在缺省填充与 requiredness。因此"读时包装先于校验"不成立。
v2 迁移采用:

1. **schema 双形兼容**:REGISTRY_SCHEMA.manual 条目同时接受 `{path, engine}`(v1)与
   `{path, lsp:[{engine}]}`(v2)两种形态——engine 字段保留为可选,新 lsp 字段默认 `[]`;
   **不在读侧做前置转换**(get 已 resolve,无法插入),而在**读侧归一**:`readStore()`/
   `seedKnown()` 时把 `engine`(若在)包成 `lsp:[{engine}]` 并与 lsp 字段合并取并。
   Config.projects 同理(z.object 双字段,归一函数共用)。
2. **存量 autoInject:false 不得静默翻转**(评审③+二评补充):豁免记录在 **manual**(用户
   手配层)与 **config**(种子层)都可出现。生效注入 = 全局 AND 非豁免,其中:
   - manual 条目迁移保真:`{path, engine, autoInject:false}` → 归一后带豁免标记;
   - config 种子同样允许 `autoInject:false`,seedKnown 把 config 的豁免并入 known
     (不只在 manual 上查,否则 v1 config 存量的 false 会静默翻转 —— 二评指出的坑)。
3. **config 层 engine 死字段修复**(首评①):现 index.js:189 只读 `p.engine` 单值且被
   detectEngine 顶掉;v2 中 config projects 的 lsp/engine 字段真正参与合并
   (显式配置优先于 detect)。
4. **seedKnown 顺序**(二评②:文字与现码/design 矛盾):
   现码 = config(addKnown)→ discovered(addKnown)→ manual(setKnown),config 与 discovered
   之间是先到先得(discovered 不覆盖 config)。design.md 却写"discovered > manual > config
   > seed"。v2 定稿文字:**config(种子,addKnown)→ discovered(自动,addKnown,不覆盖
   config)→ manual(setKnown upsert,最高优先,整组替换 lsp)**。manual 可覆盖 config 与
   discovered(经 setKnown);config 与 discovered 同 path 时 config 赢(addKnown 先到先得)。
   与现码一致,文档修正。

### 3.3 known(内存生效集)结构

```js
Map<lowerPath, {
  path, source,
  lsp: [{ engine }],          // 生效 LSP 列表(合并后,manual 覆盖)
  autoInject: boolean,        // 全局 AND 豁免(config/manual 任一 false → false)
}>
```

## 4. 引擎注册表扩展

`lib/checkers.js` 每引擎描述补 `extensions`(已有 `marker`、`bridge`)。新增工具:

- `matchExtension(engine, filePath)`:extensions 命中
- `detectEngine(projectRoot)` / `suggestLsp(projectRoot)`:遍历引擎表,首个 marker 文件
  存在者 → 该引擎 id(marker 主判据);返回**建议 LSP 列表**

### 4.1 桥文件名参数化(评审②)

现 `checkers.js:19` 硬编码桥名 `godot-lsp.mjs`,导致 §12"加目录即出现"不成立。
v2:每个引擎目录内找首个 `.mjs` 桥文件(或按 `bridge: <dir>/<engine>.mjs` 解析时
不写死),使任何 `checkers/<engine>/` 新目录被自动识别,无需改注册表文件名常量。

### 4.2 智能配置语义(补充不覆盖,评审⑥防污染)

扫项目目录建议 LSP 列表:
- **marker 优先**:有 `project.godot` → godot-lsp(强信号);
- **浅层扩展名计数**:对非隐藏、非 skip(node_modules/.git/.godot/addons/.venv/build/dist
  等)目录做**浅层**计数(如深度 ≤3),某扩展名文件数 ≥ 阈值(如 ≥1)且对应引擎已装
  → 建议;防止 `node_modules/.cs` 深埋文件误触发;
- **不覆盖**:以 known(生效集)为准判断"用户是否已配",而非只看 store.manual——
  对 config 源项目点 smart,若其 lsp 来自 config(非 manual),应视作"未手动",建议可
  落成 manual 覆盖 config,而不是冻结 config 种子(评审⑥:diff known 而非 store.manual)。
- **幂等与冻结后果**(二评③):判定用 known.source==='manual' → 首次 smart 落 manual 后
  source 变 manual,再点即跳过(幂等,无反复写;进程内连点无 await 间隙,安全)。后果:
  **一次 smart 后该项目被 manual 永久冻结** —— config 种子后续加引擎/改 lsp 不再生效,
  config 删该项目 manual 残留仍在(manual>config 的推论)。文档注明"config 变更需手动
  解除 manual 或换 path";段4 UI 提供"还原为 config 种子"动作(删该项目 manual 覆盖,
  仅当 config 中确有同名种子)。

## 5. host JSON API

全部仍走 `/lsp-echo/api`(内部工具,保持 GET 简单):

| action | 变更 |
|---|---|
| `projects` | 返回项加 `lsp:[{engine,extensions}]`(替代单 `engine`) |
| `engines` | 返回 `[{id, marker, extensions, name}]` |
| `addLsp&project&engine`(新增) | **增量**:给项目加一个 LSP(服务端读-改-写,幂等) |
| `delLsp&project&engine`(新增) | **增量**:移除项目的一个 LSP |
| `setProject&project&engine` | 手动添加项目(单引擎参数,内部落 `lsp:[{engine}]`);保持用于新建 |
| `resetProject&project`(新增) | 还原 config 种子(删该项目 manual 覆盖,§4.2) |
| `delProject` | 移除 manual 项目 |
| `smart&project` | 探测建议 LSP **列表**,仅补不覆盖 manual |
| `config`(新增) | 全局 autoInject 开关读取/设置(§7) |
| `status/host/stop/baseline/diagnostics` | 多引擎时 `baseline/diagnostics` 合并各引擎结果 |

**写并发策略(二评④)**:GUI chips 增删用**增量 action**(addLsp/delLsp),服务端读-改-写,
客户端不传完整列表 → 消除 stale 覆盖;同项目操作在客户端做单飞行(请求在途禁用该行
其他 chip)作为双保险。写 manual 时保留 autoInject 豁免位不丢字段。

## 6. 变更侦测与路由(pre-step,Mode B)

### 6.1 watcher 扩展名集合化

`ProjectWatcher` 现在硬编码 `.gd/.gdshader`。改为构造时接收
`extensions: string[]`(= 该项目生效 LSP 的 extensions 并集),`scanFiles`
按该集合过滤。项目 LSP 变更 → 重建 watcher。**重建不得丢差量**(评审②):重建时
以旧 map 为基线先算一次 tick(或把旧 dirty 集并入新 watcher),避免换引擎瞬间丢变更。

### 6.2 pre-step 路由

1. dirty 文件按扩展名 → 归属引擎(`extOf(file)` → engine);
2. 每引擎取自己那批文件 → `checkFiles(该引擎 bridge, project, files)`(并发发起,
   落盘经 §8 per-project writer 串行);落盘与注入文本分别在各自队列收敛;
3. 汇总各引擎 payload:
   - 错误注入文本:合并所有引擎有错文件;
   - 诊断快照:§8 单文件 keyspace 合并,由串行 writer 落盘。

### 6.3 baseline(全量)

每引擎对项目内自己 extensions 的文件跑 sweep;结果经同一 writer 合并;
汇总报告/播报同 §7 注入闸约束。

### 6.4 tool.js / registry.js 同步(评审②⑦)

- `tool.js` resolveProject 硬编码 `project.godot`;v2 用引擎注册表 marker 表
  (任一 marker 命中即项目根),避免未来非 Godot 项目工具失效;
- `registry.js` scanProjectRoots 的 marker 也走注册表;
- `lib/checkers.js` 导出 `markers()`(所有引擎 marker 列表),两处共用。

## 7. autoInject 语义(用户定稿 + 评审④副作用)

- **全局开关** Config `autoInject: true`(默认),作用:"项目第一次加入 DSH 时自动智能
  配置 LSP 并开始把编译错误注入 AI 上下文"。
- **关闭**:新加入项目不自动配置 LSP、不自动注入;已配置项目也不再注入(全局闸)。
- **每项目静音能力保留**(评审④副作用 + 二评②来源修正):存量 `autoInject:false` 与用户想
  单独静音某项目的场景,通过项目级 `autoInject:false` 豁免支持——**豁免来源 = 任何 source
  记录(config + manual)的显式 false,在 seedKnown 按 path 求值并入 known**;workspace
  自动发现天然无豁免。生效注入 = 全局开关 AND 非项目级豁免。设置页不设每项目开关
  (用户已定全局语义),豁免记录内部保留、不被全局默认翻转。
- **豁免创建入口取舍**(二评②):段4 UI 提供一个低可见"静音该项目"动作(写 manual
  autoInject:false),否则 discovered/config 项目从 UI 无法新建豁免,只剩迁移存量可用。
- **与 baseline 播报相互作用**(评审④):baseline 播报只随"自动基线扫描"触发;autoInject
  关时 baseline 仍可手动触发(status/scan),但完成播报不注入模型上下文(与 pre-step 注入
  同受全局闸约束)。

## 8. 诊断快照落盘(评审①:per-project 串行扁平 writer)

现状:`manager.checkFiles` 每引擎全量重写 `lsp_diagnostics-<project>.json`,已存在
main/baseline(v1)同路径双写竞态(二评补充:v1 真实竞态不止双 clientd——
`manager.checkFiles` 成功路径用**裸 writeFileSync(非 temp+rename)**,桥 clientd 还原子写
自己 `checkers/.runtime/` 下另一份)。v2 修正:

- **每引擎 keyspace**:合并文件内 `files{}` 键已是文件路径(rel),不同引擎认领不同
  扩展名 → 键空间天然正交;**约定之外加校验**:写入前检查键扩展名归属,跨引擎键报警告。
- **per-project 串行扁平 writer**:同一项目所有写入(多引擎并发、v1 main/baseline、工具
  action、GUI API)经一个**每项目串行队列**(排他写,原子 temp+rename,rename 对 Windows
  瞬时占用做一次短暂重试)。文档写明**按 DSH_HOME 单写者假设**(同 profile 一个 dsh web
  进程即单实例);如需廉价跨进程互斥,复用 `@deepseek-ai/dsh-atomic-write` 的
  withFileLock(settings-file 同款,profile 已提供)—— 段3 先进程内队列,跨进程锁作为
  可选加固。
- **合并后 summary 必须重算**(二评③):不能取最后写入引擎的 payload.summary——
  writer 合并 keyspace 后按新 files{} 重算 `errors/warnings/files_with_errors/files_checked`
  (GUI 角标/浮层读它,错则误报)。
- **驱逐旧键只以 lsp 配置变更为准**(二评③):写入时比较 payload 引擎 id 与 known 当前
  lsp 集合,不在集合才驱逐该引擎键;**绝不以**引擎 host 不在、编辑器关、一次 check 失败
  为准(瞬态不能删最后好结果)。停 host/编辑器关闭只影响下次检查,不动文件。
- 桥 clientd 那份 `.runtime/` 落盘在 v2 明确**停用或声明为残留**(统一由 host writer 写
  最终文件)。
- GUI `diagnostics` action 与浮层读单文件,展示按文件/引擎分组,无需改(§9)。

## 9. UI(设置页,settings.section"LSP 诊断")

以项目为主的项目卡片(见附图草稿):

```
项目(N)                                     [全部智能配置]
[✓] 自动注入(全局):项目第一次加入 DSH 时自动配置 LSP 并开始反馈
引擎已装:godot-lsp(.gd .gdshader)…
┌─ xu_world  ◈ E:\GodotProject\xu_world      [自动发现]
│  注入 LSP:
│    [ godot-lsp · .gd .gdshader ✕ ]
│    [+ 添加 LSP ▾]
│  [智能配置] —— 扫项目建议 LSP(补充不覆盖)
└─
```

- 项目行:LSP chips(可 ✕ 移除,manual/自动均可)+ 添加下拉 + 智能配置按钮;
- "移除项目"仅 manual(discovered 随 workspace 生命周期,config 是种子);
- 全局 autoInject 开关在页头;
- 引擎"未装但项目有对应语言"时给提示角标(如检测到 .cs 但无 csharp-lsp)。

## 10. 改动文件清单

- `lib/checkers.js`:extensions + matchExtension + **桥文件名参数化(§4.1)** + markers()
- `lib/watcher.js`:scanFiles 扩展名参数化 + 重建不丢差量
- `lib/manager.js`:**per-project 串行 writer(§8)**;diagnosticsPath 支持同名项目冲突
  (评审⑦:basename 同名不同目录项目共用文件 → key 用完整 project 摘要/首目录+basename)
- `lib/index.js`:REGISTRY_SCHEMA、Config、known/lsp、迁移(§3.2)、seedKnown、
  suggestLsp、pre-step 路由、baseline 多引擎、API、卸载清理(多引擎逐个停)、
  scope.watch 后 watcher 重建
- `lib/tool.js`、`lib/registry.js`:marker 表共用(§6.4)
- `lib/client.js`:设置页重写(项目为主 + LSP chips + 全局开关);文案去硬编码
  Godot/.gd(评审⑦:引擎名/扩展名来自注册表动态)
- `docs/design.md`、`README.md`:同步
- `checkers/godot-lsp/*`:引擎本身不变(桥名解析已参数化)

## 11. 回归保障

- 单引擎项目(xu_world)行为与现状一致:pre-step 路由退化为"全部分给 godot-lsp",
  baseline/诊断/GUI 不变;
- 迁移兼容:旧 manual/config 单 engine 读取时包成 lsp 数组,autoInject:false 保真;
- 手动测试清单:单引擎全量/增量、main/baseline 并发落盘不丢、设置页 chips 增删、
  智能配置补充不覆盖、全局 autoInject 关→新项目不自动注入、watcher 重建不丢变更。

## 12. 暂不做(留待后续对话)

- 真正接入第二个引擎(TS/C# LSP);本期注册表与路由已支持(桥名参数化后加目录即出现);
- 每 LSP 独立 autoInject(用户已定全局开关语义,项目级豁免保留于内部迁移);
- GUI 诊断浮层按引擎过滤(单文件合并后天然可分组,需求出现再做)。

## 13. 落地顺序(评审⑧:四段)

1. **注册表参数化**:checkers.js(桥名解析、extensions、markers/matchExtension)+
   tool.js/registry.js marker 表共用 —— 不动行为,纯参数化;
2. **数据层 + watcher**:schema lsp 数组、迁移(§3.2)、seedKnown、watcher 扩展名参数化
   + 重建保差量;单引擎行为不变;
3. **路由 + 落盘 + 并发修复**:per-project writer(§8,顺带修 v1 main/baseline 竞态)、
   pre-step/baseline 多引擎路由、卸载清理多引擎;
4. **全局开关 + GUI + smart**:autoInject 全局化(§7)、设置页重写(§9)、suggestLsp(§4.2)。

每段结束可独立回归:段 1-2 后单引擎全量/增量照旧;段 3 后并发正确;段 4 后面向用户。
段间不破坏中间态(段 3 前 engine 仍单值,lsp 数组只读首个)。

**中间态护栏(二评⑤,段2/段3 之间)**:
- known 改存 lsp 数组后,**所有读 `rec.engineId` 的消费者同步改"取 lsp[0]"并经一个
  读入口**(如 `primaryEngine(rec)` helper),不散落各消费者,避免半成品期漏改;
- 段2 内 watcher 仍按 primaryEngine 的 extensions(不是并集),API 写入口保持单引擎
  参数(内部落 `lsp:[{engine}]`),">1 引擎"能力到段3 才开 —— 避免段2 期间手配多引擎
  导致 .ts 文件全发给 godot 桥的空等/check_error 噪音;
- **删除竞态(二评⑦)**:watcher 把"已删除文件"记入 dirty → collectDiagnostics 对不存在
  文件 throw 使整批失败、该 step 注入被吞;路由前先过滤不存在的 dirty。

**桥状态文件同名冲突(二评⑦,段3 前修)**:`godot-lsp.mjs` statePaths 用 basename 生成
`host-<name>.json/.log` 与 .runtime out;同名不同目录两项目 → B ensure 覆盖 A state、
A stopHost 比对失败 → headless 泄漏。桥加显式 state-key/name 覆写 flag(改 godot-lsp.mjs
属插件内文件,允许),manager 传 per-project 稳定 id(路径摘要);与 diagnosticsPath 冲突
修复(§10)共用同一 id 生成器。

**卸载语义(二评⑦)**:ctx.effect 卸载里 stopHost 是 fire-and-forget、进程 detached,
卸载即断后靠重启 readHostState 复用捡回 —— 文档写明"卸载尽力停、不承诺全停"。

---

## 14. 落地记录(2026-09-06,四段全部完成)

- **段1(注册表参数化)✅**:checkers.js engines()/markers()/matchExtension()/extensionsUnion(),
  checkers/godot-lsp/engine.json 声明,lib/tool.js/registry.js marker 表共用。
- **段2(数据层 + watcher)✅**:schema lsp 数组双形兼容(无 .optional —— schemastery 3.18.2
  fork 实测无此法,字段默认可选,.required() 标必填,数组隐含 default []),迁移=读侧归一
  (normalizeProjectEntry/entryEngineIds/primaryEngine),watcher 扩展名参数化 + adopt() 重建
  保差量,ensureWatcher 重建前 tick 旧 watcher 防丢差量。
- **段3(路由 + 落盘 + 并发)✅**:per-project 串行 writer(writeSnapshot keyspace 合并 +
  summary 从合并集重算 + atomicWriteJson temp+rename+Windows 瞬时占用重试)、pre-step 多引擎
  按扩展名路由(Promise.all 并发)、startBaselineFor 逐引擎 sweep、checkFiles 统一出口、
  卸载按全 lsp 逐个停。
- **段4(全局开关 + GUI + smart)✅**:settings 顶层 autoInjectGlobal(缺省回退 Config
  autoInject 默认 true;无 default 键,resolve 后缺失 → normalize 兜底),globalAutoInject()
  闸(pre-step diff-echo 与自动 baseline 同受),web API(action 全走 GET /lsp-echo/api):
  projects/engines(detail)/config/smart(suggestLsp diff known 只补缺,已有 manual 不覆盖)/
  setProject/addLsp/delLsp(增量,服务端读-改-写)/resetProject/delProject/host/stop/status/
  baseline/diagnostics。GUI 设置页:项目为主卡片(目录名标题+全路径小字)、绑定引擎
  chips(✕ 移除)、常驻「手动添加引擎」下拉+按钮(无可用引擎时禁用但不隐藏)、智能配置
  (补充不覆盖)、全局 autoInject 开关、来源经 tooltip(DSH 配置/手动添加/自动发现)。
- **三轮评审修复(2026-09-06,全部实测)**:① rename 重试改同步 Atomics.wait(原 setTimeout
  不阻塞形同虚设);② 快照驱逐落地 —— writeSnapshot 增 keepExts(不属于当前绑定引擎的旧键
  驱逐)、新增 pruneSnapshot(delLsp/setProject/resetProject/delProject/scope.watch 绑定收缩后
  清理,清空则删文件,GUI 不再显示陈旧错误数),驱逐只以 lsp 配置变更为准(RFC §8);③
  tool/API baseline 改 sweepAllEngines 逐引擎路由(不再把整项目文件发主桥);④ 桥 host 启动
  跨进程文件锁(acquireHostLock:mkdir 原子锁 + owner pid 破陈旧 + 等锁期读 state 复用胜者,
  杜绝 baseline/main 双 clientd 并发双起 headless 泄漏);⑤ 引擎作用域计数 engineScope
  (多引擎消费端按扩展名过滤合并快照再聚合/展示,修双计);⑥ GUI baseline summary 真实回填
  warnings/files_with_errors;⑦ tool check 包装补 ownedExts/keepExts(不整份替换抹他人
  keyspace)。
- **回归实测**:单引擎(xu_world,501 文件)全链路 —— 加载/status(editor attach 6005)/baseline
  (501 文件 0 错误 8 warnings)/delLsp 驱逐删快照/setProject+resetProject 还原 config/重复写
  无残留/4 并发 host 全复用 6005;安装副本与 repo 逐字节一致。

**仍推迟(多引擎启用前必修,见 §12 与二评)**:桥 state/diagnostics 文件按项目 basename 命名
(同名不同目录项目共用 state 与最终快照文件 —— 锁与驱逐已按同一 key 保持一致,但两项目
仍互踩);tool.js description 硬编码 Godot;GUI 设置页「还原种子」对无 manual 覆盖项目为
显式 no-op 提示。
