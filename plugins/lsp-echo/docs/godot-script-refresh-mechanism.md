# Godot 脚本刷新的三层数据与"改完不生效"的成因(2026-09-21 实测定稿)

本文回答一个具体问题:**外部程序(本插件/AI)改了 `.gd` 之后,Godot 引擎什么时候才认得这次改动**;
以及为什么本插件的「重扫文件系统」在用户的真实编辑器里**救不回来**。

结论:

> 引擎里与脚本有关的数据分成**三层**。重扫只可靠地刷新第一层;语义诊断真正读取的第三层,
> 在重扫路径上**要过一道唯一的闸门**`_should_reload_script()`,而用户日常的编辑器状态恰好让这道闸门
> 恒为假。引擎自己把这个问题的出路写在代码注释里:`Script::editor_can_reload_from_file()` 说明脚本
> 只有三条重载途径——脚本编辑器内编辑、**外部编辑器经 LSP 服务器编辑**、以及磁盘直接更新时的
> `EditorFileSystem::_update_script_documentation`。本插件走的是重扫(第三条),而有效的入口是第二条。

## 1. 现象与复现条件

用户侧现象:AI 改完某个脚本后,检查报出的错误是**上一次**的状态——新增的成员说"找不到"。重启 Godot
编辑器可暂时消除,改几次之后复发。

复现**同时**需要两个条件(§7.2 有对照):

1. **被改的脚本在脚本编辑器的脚本列表里**——用户打开过且没手动关掉。Godot 把它记在
   `<project>/.godot/editor/script_editor_cache.cfg`,重启编辑器后自动恢复,因此**一旦满足就长期成立**。
   它对结果的作用是让 §5.2 的闸门 `_should_reload_script()` 恒为假——**不是**"钉住解析树"(§3)。
   实测用户工程该文件 347 个条目,其中 331 个 `.gd`,报错涉及的脚本几乎全在其中。
2. **存在一个活着的解析树持有者**(§3),通常是编辑器内置 LSP 客户端对某个引用方文档的 didOpen。
   它把被引用脚本的**旧**解析树钉在内存里。

补充说明:§1 的条件 1 目前的操作化是"`script_editor_cache.cfg` 里有条目"。该文件由编辑器在保存布局/
退出时写入(`script_editor_plugin.cpp:3657` 的 `save(...get_project_settings_dir()...)`),严格说
**不等于**"运行中的实例此刻正开着它"。本次实验中该条件由用户当场确认("现在它就是打开的"),cfg
条目作为佐证,不是唯一依据。

## 2. 三层数据

| 层 | 内容 | 位置 | `rescan` 是否刷新 |
|---|---|---|---|
| A 文件树 + 全局类表 | 文件条目、mtime、`class_name` 注册表(纯字符串) | `EditorFileSystem`、`ScriptServer` | ✅ 刷新 |
| B 已加载资源 | `Resource` 对象(含 `GDScript`) | `ResourceCache` | ⚠ 有条件(§5.2) |
| C 解析树 | `GDScriptParser` 语法/语义树 | `GDScriptCache` | ❌ 重扫路径上不刷新 |

**语义诊断读 C 层,不读 `GDScript::member_indices`。**证据:

- `GDScriptAnalyzer::make_global_class_meta_type`(`gdscript_analyzer.cpp:3968-3994`):
  `ScriptServer::get_global_class_path`(3971)→ `parser->get_depended_parser_for(path)`(3974)
  → `ref->get_parser()->head->self_type`(3990)。
- `GDScriptParser::get_depended_parser_for` 调 `GDScriptCache::get_parser` 并存入
  `depended_parsers`:`gdscript_parser.cpp:872-885`;缓存条目构造在 `gdscript_cache.cpp:213-239`。
- 成员判定落在 `ClassNode::members_indices` 与 `has_member`(`gdscript_parser.h:765`、`805-807`),
  分析器使用点 `gdscript_analyzer.cpp:237`、`874`、`978`。实测
  `grep -n member_indices modules/gdscript/gdscript_analyzer.cpp` 为 **0 命中**(该文件出现的是
  `members_indices`,共 3 处);`GDScript::member_indices` 的读取者只有 `gdscript.cpp`、
  `gdscript_compiler.cpp`、`gdscript_utility_functions.cpp` 与 `gdscript_editor.cpp:412`。
- 用户看到的 `Cannot find member "X" in base "Y".` 来自 `reduce_subscript`
  (`gdscript_analyzer.cpp:4983`,函数始于 4867);带 `Did you mean "%s"?` 的两组分属**内建基类**分支
  (`4190`/`4192`、`4234`/`4236`,在 `SUGGEST_GODOT4_RENAMES` 下),不是本条。

A 层的全局类表只存字符串——`GlobalScriptClass { language, path, base, is_abstract, is_tool }`,
定义在 **`core/object/script_language.h:64-70`**(不在 `modules/gdscript/` 下)。所以"类还在"不代表
"成员是新的"。

## 3. C 层的生命周期:寿命 = 活着持有者的寿命

`GDScriptCache::parser_map` 存**裸指针**(`gdscript_cache.h:87`),条目由引用计数决定生死:
`~GDScriptParserRef` 在未被 `abandoned` 时把条目从 map 擦除(`gdscript_cache.cpp:137-144`)。
所以正确的表述是:

> 解析树条目**没有自主失效机制**(`raise_status` 单向推进,已 `FULLY_SOLVED` 就直接返回结果、
> 不再读盘:`gdscript_cache.cpp:69-114`),但它的寿命 = **活着的 `Ref` 持有者的寿命**。
> 引用归零后它立刻消失,下次分析**重新从磁盘解析**——这正是"没人引用时改完立刻就好"的来源。

**持有者有两个,不止一个**:

1. `GDScriptParser::depended_parsers`(`gdscript_parser.h:1393`;写入 `gdscript_parser.cpp:872-885`)。
2. `GDScriptAnalyzer::external_class_parser_cache`(`gdscript_analyzer.h:56`;插入
   `gdscript_analyzer.cpp:4050`)——它在 `depended_parsers` 之外**独立**持有外部 parser ref,
   注释(`gdscript_analyzer.cpp:3997-4001`)明确说这是"有意不走 GDScript cache"的另一条路径。
   analyzer 本身由 `GDScriptParserRef` 拥有(`gdscript_cache.cpp:133-134`)。

**哪些东西不是持有者**(这一点容易判错):

- **`GDScript`/`Script` 实例不持有任何 parser ref。**全仓库 `GDScriptParserRef` 只出现在
  `gdscript_parser.*`、`gdscript_cache.*`、`gdscript_analyzer.*`、`gdscript_editor.cpp` 的函数内局部
  (1784/2377/2590 等),以及 `gdscript.cpp:791`(`reload()` 内局部)。
- **因此"编辑器里开着的脚本"本身不是钉子。**编辑器打开的是 `Ref<GDScript>`;它自己的校验走
  **栈上**临时 parser(`gdscript_editor.cpp:172-179`:`GDScriptParser parser; GDScriptAnalyzer
  analyzer(&parser);`),函数返回即释放。`editor/` 目录下 `GDScriptCache::` 与 `GDScriptParserRef`
  各 **0 处**,也没有 LSP 客户端代码。
- **真正的钉子来自 LSP 的 `parse_results`**:`gdscript_language_protocol.cpp:387-421` 把
  `ExtendGDScriptParser*` 存进 `parse_results`,`439-447 get_parse_result` 复用;该 parser 会跑完整
  分析器(`gdscript_extend_parser.cpp:964-982`),其 `depended_parsers` 因此长期存活。
  `lsp_did_close` → `remove_cached_parser`(`gdscript_language_protocol.cpp:516`)释放钉子。

于是两个条件在机制上**各司其职**,又**同源**:编辑器打开脚本 → 它内置的 LSP 客户端对该文档
didOpen → 既提供了钉子(条件 2),又让 §5.2 的闸门为假(条件 1)。

## 4. 清除 C 层的全部站点

| 站点 | 位置 | 效果 | 生产调用者 |
|---|---|---|---|
| `remove_parser` | `gdscript_cache.cpp:246-264` | 把 ref 标记 `abandoned = true` 并记入 `abandoned_parser_map`(246-253),再移除该条目**并递归移除其反向依赖**(259-263) | `GDScript::reload()`(`gdscript.cpp:789-801`)、`move_script`(`:167`)、`remove_script` 内部(`:206`) |
| `move_script` | `gdscript_cache.cpp:156-178` | 换路径时调用 `remove_parser(p_from)` | `GDScript::set_path`(`gdscript.cpp:1123-1125`,在 `is_root_script()` 内)——全仓库仅此一处 |
| `remove_script` | `gdscript_cache.cpp:180-211` | 移除脚本相关条目,并 `clear()` `abandoned_parser_map` 里的孤儿 ref | **无生产调用者**,仅 `modules/gdscript/tests/gdscript_test_runner.cpp:718` |
| `clear` | `gdscript_cache.cpp:455-497` | 整池清空 | `GDScriptLanguage::finish()`(`gdscript.cpp:2225`)与 `~GDScriptCache()`(`gdscript_cache.cpp:503-506`,对象在 `register_types.cpp:152`/`184` 创建销毁) |

`abandoned_parser_map` 的记账是理解"条目已移除、旧树仍被现有持有者使用"的关键:`~GDScriptParserRef`
正是靠 `if (!abandoned)` 决定是否擦除 map 条目(`:137-144`)。

**内容变化引发的唯一自动清除路径是 `GDScript::reload()`**(`gdscript.cpp:742-822`):

- 早退:`if (reloading) return OK;`(742-745)、TOOLS_ENABLED 下脚本模板目录(772-777)、
  `if (!p_keep_state && has_instances) return ERR_ALREADY_IN_USE;`(755-759)。
- 比对顺序是 `has_parser`(789)→ `get_parser`(791)→ 与**内存中** `source.hash()` 比较(793-799),
  不一致才 `remove_parser`(800)。**`reload()` 自己不读盘**,必须由调用方先
  `load_source_code` 刷新 `source`。
- `reload(true)` 绕过 `has_instances` 保护,编辑器与 `GDScriptCache::get_full_script`
  (`gdscript_cache.cpp:388`)走的都是 `reload(true)`。

## 5. `rescan` 到底做了什么

本插件的 `rescan` → 编辑器 addon → `EditorFileSystem::scan_changes`
(`editor_file_system.cpp:3706` 把 `scan_sources` 绑定到它)。它**不直接碰 C 层**:
实测 `grep -rn "GDScriptCache::" editor/` 为 **0 命中**。

### 5.1 A 层:每次都刷新

- **全局类表**:`_update_script_classes()`(`:2146-2192`)。唯一前置是队列非空(2147-2153 早退),
  随后 `2183 emit_signal("script_classes_updated")` **无条件**发出——不是"仅在真正变化时"。
  它**从不**加载资源、也不碰解析树:`_register_global_class_script`(2557-2578)只做
  `ScriptServer` 登记与加载器注册表重建(2188-2191);类名来自扫描期**栈上** `GDScriptParser`
  (`gdscript.cpp:2714-2722`),不经 `GDScriptCache`。
- **脚本文档**:`_process_update_pending()`(2297-2305)→ `_update_script_documentation()`(2194+),
  其中 `2249 ResourceLoader::load(path)`,并在 `2253-2256` 于 `_should_reload_script(path)` 为真时
  调 `scr->reload_from_file()`。★ 这一步有两个后果,都要记住:它把脚本**放进 `ResourceCache`**,
  并且它是重扫路径上**唯一**真正重载脚本脚本的地方。
- 信号:`sources_changed` 在两条扫描路径末尾都发(1728、1792/1810),但其 bool 参数恒为 false——
  该信号量是 `List<String>`(`editor/file_system/editor_file_system.h:269`)且**全仓库从未被写入**,
  三处 emit 都写 `size() > 0`,所以它是**死字段**,不是"设计上恒假"。纯内容改动不触发
  `filesystem_changed`:`scan_changes` 只在 `_update_scan_actions()` 返回 true 时发(1722-1724),
  而 `ACTION_FILE_RELOAD` **不置 `fs_changed`**(1010-1018,对照 1008 的其它动作与 1073 的 return)。

### 5.2 B/C 层:过一道唯一的闸门

内容变化产生 `ACTION_FILE_RELOAD`,但它**只对已在 `ResourceCache` 里的资源**生效
(`ResourceCache::has`,1010-1018);这些文件进入 `reloads` → `update_files(reloads)`(1052-1055)
→ `_queue_update_script_class()`(2505-2507)→ 进入 `update_script_paths_documentation` →
`_process_update_pending()`(1066)→ `_update_script_documentation()`(2302/2194)→
**`_should_reload_script()` 为真时才 `scr->reload_from_file()`(2253-2256)** →
`GDScriptLanguage::reload_scripts` → `load_source_code` + **`reload(true)`**
(`core/object/script_language.cpp:200-211`、`gdscript.cpp:2550-2552`)——到这里 C 层才真的被清。

★ **注意这条链的另一半**:`_update_scan_actions()` 随后发出的 `resources_reload`(1068-1070)
**到不了脚本**。`Script` 覆写 `editor_can_reload_from_file()` **恒返回 false**
(`core/object/script_language.h:117-125`),而 `EditorNode::_resources_changed()` 的第一道过滤就是
`if (!res->editor_can_reload_from_file()) continue;`(`editor_node.cpp:1330-1340`);全仓库只有
TextFile/PackedScene/Script/GDExtension 覆写为 false,**GDScript 没有覆写**。所以 `resources_reload`
只服务非脚本资源,脚本的重载**只**走 `_update_script_documentation` 这一条,而它由
`_should_reload_script()` 把关——这道闸门因此是重扫路径上的**唯一**开关,不是"更前面的一道"。

`_should_reload_script()`(`editor_file_system.cpp:2278-2295`,全仓库唯一调用点是 2248)三种情况
返回 false,**没有第四种**:

1. 首次扫描(`first_scan`,2279);
2. 目标脚本不在 `ResourceCache` 里(2283-2287);
3. ★ **目标脚本正开在脚本编辑器里**
   (`ScriptEditor::get_singleton()->get_open_scripts().has(scr)`,2290-2292)
   ——意思是"交给脚本编辑器自己处理"。

`GDScriptLanguage::reload_scripts` **本身不看**是否在编辑器打开(它只筛
`is_root_script() && !get_path().is_empty()`,`gdscript.cpp:2508-2515`;以及
`p_scripts.has(scr) || to_reload.has(scr->get_base())`,2527)。所以能不能重载,完全取决于上面那道闸门。

第 3 条是用户场景的命门:脚本编辑器只在窗口获得焦点、`Ctrl+S` 之类的时机检查磁盘,所以在用户一直
开着那些脚本的情况下,`rescan` **永远不会**重载它们。

**`rescan` 生效的两种情形**(§7.2 的对照组里都出现过):

- 目标脚本**没开在编辑器里**(第 3 条不触发),且**已在 `ResourceCache` 里**(第 2 条不触发)。
- 目标脚本没有活着的解析树持有者——此时它本来就不陈旧(§3)。

★ 关于第 2 条要**收紧一个说法**:§5.1 的 `ResourceLoader::load` 副作用**不普遍成立**。它只对已经
排进 `update_script_paths_documentation` 的路径执行(2212),而该集合的写入者是
`_queue_update_script_class`(2311),调用点仅:新增脚本(945)、删除/改名(959/974/2413)、
`update_files()` 内(2505-2507/2523,而 `update_files` 只被 `reloads` 调用:1052-1055)、以及
`_process_removed_files`(1409-1421)。而 `reloads` 的先决条件又是 `ResourceCache::has`(1015)。
所以对一个**既有的、从未被加载过的** `.gd`,仅内容变化**不会**因重扫进入 `ResourceCache`;
"重扫一次就进缓存"只在新增/改名脚本、或编辑器已经加载过它(用户实际场景)时成立。

## 6. LSP 侧的刷新入口

**LSP 侧唯一入口是 `didSave`**(`gdscript_text_document.cpp:92-114`):
`ResourceLoader::load`(98)→ `load_source_code`(99)→ `is_tool()` 时 `reload_tool_script`,
否则 **`reload(true)`**(101-104)→ `update_exports()`(106)→ `reload_script()`(116-120):
`ScriptEditor::reload_scripts(true)`、`update_docs_from_script(...)`、`trigger_live_script_reload(...)`。
该处理函数**没有 didOpen 前置检查**,且**不读 `text` 字段**(只读 `dict["textDocument"]`,94-95),
所以对未 didOpen 的文件发 `didSave` 在引擎侧可行,也不必携带文本。

与之对照,`lsp_did_open`/`lsp_did_change`/`lsp_did_close`(`gdscript_language_protocol.cpp:455-522`)
只操作 LSP 自己的 parser(`parse_script` / `remove_cached_parser`),**不触碰引擎的脚本与缓存**。
LSP 侧也没有 `workspace/didChangeWatchedFiles`(全仓库 0 命中),所以外部文件变化不会自动触发。

两个容易误解的对照:

- **签名新、成员旧**:签名文本来自 LSP 自己的 `parse_script`,直接
  `FileAccess::get_file_as_string`(`gdscript_language_protocol.cpp:397`);非受管结果被标记
  `stale_parsers`(413-418,`clear_stale_parsers` 423-427)。实测
  `grep -rn "GDScriptCache::" modules/gdscript/language_server` 为 **0 命中**——LSP 不直接操作缓存池,
  它是经 `ExtendGDScriptParser::parse`(`gdscript_extend_parser.cpp:964-982`)内的分析器通过
  `depended_parsers` **间接**读到被钉住的旧树。
- **`CACHE_MODE_REPLACE` 不是重载**:对 GDScript,REPLACE 下 `ignoring=false`
  (`gdscript_resource_format.cpp:45-46`)→ `get_full_script(..., update_from_disk=false)`
  直接**返回缓存中的同一个对象**(`gdscript_cache.cpp:351-356`),因此 `resource_loader.cpp:583`
  的 `old_res != load_task.resource` 为假,**连 `copy_from`(591)都不会执行**。真正重建的是
  `CACHE_MODE_IGNORE`(`gdscript_resource_format.cpp:45-46` → `gdscript_cache.cpp:368-382` 重读源码、
  `388 reload(true)`、`393-400` 写回 full cache)。编辑器自身也用它重载打开着的脚本
  (`script_editor_plugin.cpp:2896-2899`)。

## 7. 实验证据

工具:临时脚本经 LSP 客户端连**用户正在运行的编辑器**(LSP 端口 6005),以及 addon 的重扫入口
(观察到 addon 实例绑定 **6090**;该端口是 6089 被占后向上走位得到的,不是第二个默认值)。
每轮实验的文件、`.uid`、日志在结束后删除,用户工程源文件不留改动。

### 7.1 结构

```
a      = 被改的脚本(含 class_name),两种状态:在编辑器脚本列表中 / 不在
b1     = 常驻引用方(引用 a 的成员,一直 didOpen 不关闭)—— 它提供的钉子
b2     = 新开引用方(引用 a 的新成员,每次关掉再打开,以取全新诊断)
```

两组实验**都以一次 rescan 开场**(用于注册类名),因此两次实验的 `ResourceCache` 前态相同;
唯一的变量是 **a 是否开在编辑器里**。

### 7.2 对照

| # | a 开在编辑器里 | 有常驻引用方 | 改 a 后新开 b2 | 发 rescan 后 |
|---|---|---|---|---|
| 1 | ❌ 否 | ✅ 是 | 2 错误(复现) | **0 错误** |
| 2 | ✅ 是 | ❌ 否 | **0 错误**(无从复现) | 0 错误 |
| 3 | ✅ **是** | ✅ **是** | 2 错误(复现) | **2 错误** ← 用户场景 |

三行合起来**支持**(不是"证明")两个条件都是必要的。第 3 组与第 1 组的唯一差别是 a 是否开在编辑器里,
故 rescan 失效可归因于 §5.2 的第 3 条闸门。

### 7.3 完整复现(第 3 组,逐步骤)

```text
① b1 didOpen(引用 ONE),此后一直不关闭           → 0 错误
② 改磁盘:a 新增 THREE
③ 新开 b2(引用 THREE)                            → 2 错误  ← 复现
     L4: Cannot find member "THREE" in base "DshCacheA".
     L4: Assigned value for constant "USE" isn't a constant expression.
④ 再新开 b2(不做任何刷新)                        → 2 错误  ← 稳定,不是时序问题
⑤ 发 rescan                                      → 2 错误  ← ❌ 没救回来
⑥ 对 a 发 didSave,再新开 b2                      → 0 错误  ← ✅ 救回来了
```

### 7.4 didSave 为什么有效

它**绕过 §5.2 的闸门**:`reload(true)` → `remove_parser` **递归移除反向依赖条目**
(`gdscript_cache.cpp:259-263`),所以持有旧树的引用方在下次分析时会重新取到新树。这正是
`Script::editor_can_reload_from_file()` 注释所列三条路径中的第二条("the LSP server when edited in a
connected external editor")。

★ 但**不要**把 `ScriptEditor::reload_scripts(true)` 也算作它的覆盖面:`p_refresh_only = true`
**不重载任何资源**——`script_editor_plugin.cpp:2882-2884` 只更新 `last_modified_time`,真正的
`CACHE_MODE_IGNORE` + `reload(true)` 在 `else` 分支(2896-2899),只有传 `false` 才走
(如磁盘变更对话框 `4408 ...bind(false)`)。`reload_script()` 里 `true` 的实际效果是后面
`2934-2938` 那句**无条件**的 `teb->reload_text()`。

### 7.5 本插件自己的检查为什么不复现

它每次检查都会 `didClose` 全部文件(`godot-lsp.mjs:892-894`),`lsp_did_close` →
`remove_cached_parser`(`gdscript_language_protocol.cpp:516`)随之释放钉子,于是引擎下次从磁盘重新
解析——**检查行为本身把问题掩盖了**。这解释了"用户看得到、插件测不出"。

### 7.6 证据强度与已知混杂

- 三组对照**每格 n=1**,且人在同一台机器上操作(Godot 窗口焦点事件可能发生),因此 §7.2 的结论
  是"支持"而非"证明"。
- **rescan 打到了哪个实例未能自证**:该实验当时依赖单槽的端口公布文件(此后已按 editor/engine 分槽,
  见 §9.2),且插件路径上显式端口优先级最高
  (`lib/index.js:418` → `lib/manager.js:350-353` → `godot-lsp.mjs:1245`),桥内部的
  `discoveredBridgePort`(`godot-lsp.mjs:226-240`)在该路径上是死代码;editor 模式的 host state
  记 `pid: 0`(`godot-lsp.mjs:502-506`、`567-571`),LSP 对端不告知 pid。本次实验是**手工指定
  6090** 完成的,故"rescan 到达了产生诊断的那个实例"由人工保证,**不是工具链保证的**。
- 若要事后复核,需要采集:运行实例中**实时**的 `get_open_scripts()`/`get_unsaved_scripts()` 与自身 pid、
  每步 a 的内容哈希与 mtime、窗口焦点时间线、每次 `publishDiagnostics` 的原始快照,以及一个
  **负对照**(只 touch mtime 不改内容)。现有清单缺这些量,其中"addon 实际端口"目前也不可持久采集
  (`plugin.gd` 只 `print_debug`,当时唯一的落盘物是那份会被覆盖的公布文件;此后桥在落盘编辑器 LSP 端口时
  还会写 `project.godot`,见 §9.2/§11)。

## 8. 方案评估

| 方案 | 做法 | 结论 |
|---|---|---|
| **A** | 在重扫**之前**,对**磁盘内容确实变化**的 `.gd` 发 `textDocument/didSave` | ✅ 采用;引擎注释把这条列为脚本的正式重载途径之一 |
| B | 扩展 addon 协议,让 Godot 侧直接 `reload` | ❌ 放弃;与 A 有**同一类**风险(见下),而 A 复用引擎既有入口 |
| C+ | 让引用方释放旧持有者(例如重开引用方文档) | ⚠ 机制上成立(§3),但需要插件能枚举"哪些引用方活着" |

★ **A 与 B 的真实差异不是"安全 vs 不安全"。**两者都会让磁盘内容覆盖编辑器缓冲:

- `didSave` 的 `reload_script()` 会调 `update_docs_from_script(...)`
  (`gdscript_text_document.cpp:118`),把脚本文本写回**打开的编辑器缓冲**;
- `ScriptEditor::_reload_scripts` 里 `2934-2938` 的 `teb->reload_text()` **无条件**执行,即使
  `p_refresh_only = true` 也会对**所有打开的标签页**重新取文本。

也就是说:**如果用户正在 Godot 里编辑、且尚未保存的那个文件,恰好是 AI 这轮改的那一个,`didSave`
会静默用磁盘内容覆盖其缓冲**,而且它**绕过**了编辑器自己的"文件已在磁盘上更新,要重新加载吗?"
确认弹窗(`script_editor_plugin.h` 的 `_test_script_times_on_disk` / `disk_changed` /
`pending_auto_reload`)。A 优于 B 的地方在于它复用引擎已有的入口、行为可预期,而不在于它不动缓冲。

因此 A 必须配一个前置守卫:

1. 发 `didSave` 前,先经 addon 查 `get_unsaved_scripts()`;命中的文件**跳过** didSave,改为**提示用户**
   ("X 有未保存改动,请 Ctrl+S");
2. 只对**内容真的变了**的文件发(§10 注 1);
3. 超时与失败策略独立于 rescan 的 120 秒失败冷却,不互相拖累;
4. `didSave` 的收益取决于 clientd 挂在谁身上:只有 `attachPolicy` 让会话落在用户编辑器上时,它才
   清得掉**用户的**钉子;走 headless 或命中 `badEditor` 黑名单时只影响 headless 自己的缓存。

## 9. 顺带发现的两处缺陷

### 9.1 `check_error` 被当成"检查过,0 错误"(四处)

引擎未在超时内推送诊断时,桥写 `check_error` 且 `errors: 0`(`godot-lsp.mjs:870-879`);而插件侧
把"没有诊断"与"诊断为空"合并计数。会因它产生假绿的**四处**:

1. `lib/index.js:2027` 的硬编码结论行(`- 结果：本次检查 0 错误` / `- 本结论来自引擎实时检查，
   无需为这些文件再次运行 LSP/编译检查。`),由 `:2000-2014` 的 `checked` 计数在零错误分支触发的
   `:2020-2034`;
2. `lib/index.js:1449-1453` `baselineDoneText`:只要 `summary.errors === 0` 就回"扫描 N 个文件,
   0 个编译错误";
3. `lib/tool.js:7-22` `renderDiagnostics`:面模型的输出只打印 `checked N file(s): 0 error(s)`;
4. `lib/client.js:414`:GUI 逐文件展示**跳过** `errs === 0 && warns === 0 && !engine_note` 的记录。

四处都要改,否则真实错误仍会被静默吞掉。

### 9.2 桥端口公布文件的实例身份(已修)

**当时的事实**:`<project>/.godot/dsh_echo_bridge.json` 只有一份,**任何**退出的实例按 pid 匹配就会删它,
于是"编辑器正在监听 6090"可能被一个已退出的 headless 实例抹掉。根因是**单槽文件 + 协议无实例身份**。

**现状**(2026-09-23,`STATE_VERSION` 3):文件按 editor/engine **分槽**写入,各方只写自己那一格,退出时
**不再删文件**(死掉的那一格由读取方按 pid 忽略),协议也补上了身份——`whoami` 回项目路径、`state` 回
pid/端口/版本,读取方据此校验。残留限制:同一种实例(两个 headless 引擎)仍共用一格,后写者覆盖先写者;
`discoverBridgePortAsync` 的端口探测是"身份不可得"时的兜底。相关实现分布(**当时**的行号,此后代码已有
变动,仅作历史参考):

- 读取该文件的**两处**:`checkers/godot-lsp/godot-lsp.mjs:226-240` 与 `lib/addon.js:34-48`
  (没有第三处);
- 端口**优先级**另有**三处**编码:`godot-lsp.mjs:1245`(flag/config/env > 公布文件 > 6089)、
  `lib/index.js:418` 与 `:938-939`(公布文件 > `engine.json` 的 6089,且总是以显式值下传,使桥内的
  发现逻辑在该路径失效)、`plugin.gd:48-63`(`DSH_ECHO_BRIDGE_PORT` > 6089 > 向上走位 16 个);
- 写入/删除方:`plugin.gd:148-154` / `plugin.gd:67-82`;协议说明文本在 `plugin.cfg:4`;
- `docs/design.md:199-200,212,242-244` 也描述了这个协议。

协议侧约束:客户端只接受整行的 `ok`,其它一律判为"未确认";addon 有 256 字节整行上限
(`plugin.gd:32`),超长行被清空并回 `err line too long`(111-113);若应答改成 `ok <done> <total>`
这类带参数形式,需要**三处匹配逻辑一起改**。正确的候选顺序是:先给协议加**实例身份**(公布文件带
pid/启动时间/项目路径,读方据此校验),只有身份不可得时才退回"探测端口"——在无身份的前提下探测,
有把 `rescan` 发给**别的项目**的 addon 的实际风险。

### 9.3 部署闭环(容易漏)

改 `plugin.gd` 或桥之后要生效,需要三步:改源码即可(profile 里是指回仓库的 junction,junction
本身不用重装;只有新增文件才需重跑 `install/install.ps1`)→ 重启
`dsh web`(`:110`)→ 对每个项目重跑"安装引擎桥"(`lib/addon.js:130-145` 把 addon 拷进工程)→
重启 Godot 编辑器(`lib/addon.js:9-11` 说明运行中的编辑器要等插件重载或重启)。`docs/` 不随安装复制。

## 10. 变更清单(实现方案 A 时)

| 文件 | 改动 |
|---|---|
| `lib/index.js` | 在 `contentStale` 重扫**之前**发起 didSave;把守卫的输入集合限定为"内容变化且无未保存改动"的 `.gd`;修正 §9.1 的四处假绿 |
| `lib/manager.js` | **必需**:`lib/index.js` 不持有 LSP socket,唯一的通道是 clientd 请求体 `{id, files, sweep}`(`:292-306`),必须新增字段把 didSave 集合带下去 |
| `checkers/godot-lsp/godot-lsp.mjs` | 在请求处理(`:1101-1137` `drain()`)里于 `collectDiagnostics` 之前发 `didSave`;并加 §8 守卫所需的 addon 查询;修正 `check_error` |
| `checkers/godot-lsp/addon/dsh_echo_bridge/plugin.gd` | 暴露 `get_unsaved_scripts()` 供守卫使用;公布文件带实例身份 |
| `checkers/godot-lsp/addon/dsh_echo_bridge/plugin.cfg` | 协议说明文本 |
| `lib/addon.js` | 端口发现与身份校验(与 `godot-lsp.mjs` 保持一致) |
| `lib/tool.js`、`lib/client.js` | §9.1 的另外两处假绿 |
| `docs/design.md`、`checkers/godot-lsp/README.md` | 同步"重扫能刷新什么"的表述、端口协议段落与实测数据 |

注 1:"磁盘内容确实变化"目前只有 **mtime** 作为输入(`lib/watcher.js:59-76` 的 `tick()` 只比
`mtimeMs`,`drain()` 还包含 `.gdshader`),因此既可能误开(touch 或重写同内容),也可能漏开
(内容变了而 mtime 未变/精度不足)。实现时应改用内容哈希,或明确接受该近似。

注 2:baseline 路径(`lib/index.js` 的 `startBaselineFor`,约 1850 行起)不看 watcher diff、直接全树 sweep,
因此"改完的第一轮恰好是 baseline 轮"时 didSave 没有输入集合,需要另行定义或接受该轮缺省。
