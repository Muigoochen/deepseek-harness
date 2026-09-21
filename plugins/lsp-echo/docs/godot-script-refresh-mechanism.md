# Godot 脚本刷新的三层数据与"改完不生效"的成因(2026-09-21 实测定稿)

本文回答一个具体问题:**外部程序(本插件/AI)改了 `.gd` 之后,Godot 引擎什么时候才认得这次改动**;
以及为什么本插件现有的「重扫文件系统」在用户的真实编辑器里**经常救不回来**。

结论先给出:

> 引擎里与脚本有关的数据分成**三层**。本插件的 `rescan` 只可靠地刷新第一层;
> 第三层(语义诊断真正读取的那一层)**只在三种情况下被清掉**,而其中最常见的两种在用户的
> 日常编辑器状态下都会被跳过。因此**语义级陈旧只能由 `textDocument/didSave` 可靠消除**。

## 1. 现象与复现条件

用户侧现象:AI 改完某个脚本后,检查报出的错误是**上一次**的状态——
新增的成员说"找不到",已删的成员仍然"存在"。重启 Godot 编辑器可暂时消除,改几次之后复发。

复现需要**同时**满足两个条件(§7 有对照实验,三者缺一即不复现):

1. **被改的脚本在脚本编辑器的脚本列表里**——即用户打开过、且没有手动关闭它。
   Godot 会把它记在 `<project>/.godot/editor/script_editor_cache.cfg` 里,重启编辑器后自动恢复,
   因此这个条件**一旦满足就长期成立**。实测用户工程该文件有 **347 个条目,其中 331 个 `.gd`**。
2. **存在一个常驻的"引用方"**——另一个脚本引用了被改脚本的类/常量/成员,并且它**仍然活着**
   (编辑器里开着,或作为 LSP 文档处于 didOpen 状态)。它在内存里的解析树会**钉住**被引用脚本的
   **旧**解析树(§3)。

二者同时成立时:引用方解析时用到的被引用脚本成员表是**旧**的,于是诊断报出陈旧结论;
而 §5 的 `rescan` 恰好会跳过这样的被改脚本。

## 2. 三层数据

| 层 | 内容 | 位置 | `rescan` 是否刷新 |
|---|---|---|---|
| A 文件树 + 全局类表 | 文件条目、mtime、`class_name` 注册表(字符串) | `EditorFileSystem`、`ScriptServer` | ✅ 刷新 |
| B 已加载资源 | `Resource` 对象(含 `GDScript` 实例) | `ResourceCache` | ⚠ **有条件**刷新(§5.2) |
| C 解析树 | `GDScriptParser` 语法/语义树 | `GDScriptCache` | ❌ 基本不刷新(§3、§4) |

**语义诊断读的是 C,不是 B、也不是 `GDScript::member_indices`。**证据:

- 全局类的元类型解析:`gdscript_analyzer.cpp` 的 `make_global_class_meta_type`
  → 取被依赖脚本的 **parser**(`parser->get_depended_parser_for(...)`,`gdscript_parser.cpp`),
  → `GDScriptCache::get_parser`(`gdscript_cache.cpp`)。
- 成员存在性判定落在 parser 树的 **`ClassNode::members_indices`**(`gdscript_parser.h`)及其
  `has_member` 上;`grep -n member_indices modules/gdscript/gdscript_analyzer.cpp` 为 **0 命中**
  (该文件里出现的是 `members_indices`),即分析器**从不**查 `GDScript` 对象的成员表。
- 用户看到的 `Cannot find member "X" in base "Y".` 来自 `reduce_subscript` 分支
  (`gdscript_analyzer.cpp`);带 `Did you mean "%s"?` 的是内建基类那组分支,不是本条。

A 层的全局类表本身**只存字符串**:`GlobalScriptClass { language, path, base, is_abstract, is_tool }`
(`modules/gdscript/script_language.h`),不含任何成员信息。所以"类还在"不代表"成员是新的"。

## 3. C 层的生命周期:不是"永不失效",而是"被活着的引用方钉住"

**这一点容易判错**:`GDScriptCache::parser_map` 存的是**裸指针**(`gdscript_cache.h`),
条目由**引用计数**决定生死——最后一个持有者释放时,`~GDScriptParserRef` 会把条目从 map 里擦除
(`gdscript_cache.cpp`)。所以正确的表述是:

> 解析树条目**没有一个自主的失效机制**,但它的寿命 = **活着的 `Ref` 持有者的寿命**。
> 一旦引用归零,它立刻消失,下次分析会**重新从磁盘解析**——这恰恰是"改完就好了"的来源。

由此得到真正的成因:**陈旧不是"缓存不失效",而是"有一个仍然活着的引用方把旧树钉住了"**。

- 引用方解析树在自己的 `depended_parsers` 里持有被引用脚本的 parser ref
  (`gdscript_parser.cpp`)。只要引用方这棵树活着,被引用脚本的**旧**条目就不会被擦除。
- 唯一的长期持有者就是**活着的解析树本身**——编辑器里开着的脚本、以及处于 didOpen 的 LSP 文档。
  一旦引用方被关闭/重新解析,钉子消失,后续分析就会看到新内容(§7 的 ② / ③ 对照)。

这条修正也**放大了可行方案的范围**:除了让引擎强制重载,让"引用方释放旧持有者"在机制上同样成立
(§8 的方案 C 系列正是基于这一点)。

## 4. 清除 C 层的全部站点

| 站点 | 位置 | 效果 | 生产调用者 |
|---|---|---|---|
| `remove_parser` | `gdscript_cache.cpp` | 移除该脚本条目,**并递归移除其反向依赖条目** | `GDScript::reload()`、`move_script` |
| `move_script` | `gdscript_cache.cpp` | 换路径时调用 `remove_parser(p_from)` | `GDScript::set_path`(`gdscript.cpp`)——仅此一处 |
| `remove_script` | `gdscript_cache.cpp` | 移除脚本相关条目 | **无生产调用者**,仅 `tests/gdscript_test_runner.cpp` |
| `clear` | `gdscript_cache.cpp` | 整池清空 | 仅 `GDScriptLanguage::finish()`(`gdscript.cpp`),即**引擎退出**时 |

**运行时唯一会清 C 层的生产路径是 `GDScript::reload()`**:

- `reload()` 先比对 `source_hash`(`get_parser` → `has_parser` → 计算 hash),不一致才
  `remove_parser`;随后仍会**全量重新 parse**。
- `reload()` 开头有一处保护:`if (!p_keep_state && has_instances) return ERR_ALREADY_IN_USE;`
  ——脚本有活实例且未要求保状态时**直接拒绝**。`reload(true)` 绕过它,编辑器与
  `GDScriptCache::get_full_script` 走的都是 `reload(true)`。

## 5. `rescan` 到底做了什么

本插件的 `rescan` → 编辑器 addon → `EditorFileSystem::scan_changes`
(`editor_file_system.cpp`)。它**不直接碰 C 层**:`grep -rn "GDScriptCache::" editor/` 为 **0 命中**。

### 5.1 A 层:每次都刷新

扫描动作里与脚本有关的两条:

- **全局类表**:`_update_script_classes()`——只重新登记 `path` 字符串,并发出
  `script_classes_updated`(仅在真正变化时)。它**从不**加载资源、也不碰解析树。
- **脚本文档**:`_process_update_pending()` → `_update_script_documentation()`,其中会
  `ResourceLoader::load(path)`。★ 这一步有个**副作用值得记住**:它把脚本**放进 `ResourceCache`**,
  从而让**下一次** `rescan` 有可能重载它(见 5.2)。
- 信号方面:`sources_changed` 在两条扫描路径末尾都会发,但其 bool 参数**恒为 false**;
  纯内容改动不会触发 `filesystem_changed`(`ACTION_FILE_RELOAD` 不置 `fs_changed`)。

### 5.2 B/C 层:取决于三道闸门,因此**不是"每次都刷新"**

内容变化的文件会产生 `ACTION_FILE_RELOAD`,但它**只对已经在 `ResourceCache` 里的资源**生效
(`ResourceCache::has` 判定);随后 `resources_reload` → `EditorNode::_resources_changed()` →
`Script::reload_from_file()` → `GDScriptLanguage::reload_scripts(scripts)` →
`load_source_code` + **`reload(true)`**(`gdscript.cpp`)——到这里 C 层才真的被清。

`reload_scripts` **本身不看"是否在编辑器里打开"**(它只要求脚本在 `script_list` 里且是根脚本),
所以**能不能重载,取决于更前面的一道闸门** `_should_reload_script()`
(`editor_file_system.cpp`),它在三种情况下返回 false:

1. **首次扫描**(`first_scan`);
2. **目标脚本不在 `ResourceCache` 里**;
3. ★ **目标脚本正开在脚本编辑器里**(`ScriptEditor::get_singleton()->get_open_scripts().has(scr)`)
   ——意思是"交给脚本编辑器自己处理"。

第 3 条是用户场景的命门:脚本编辑器只在窗口获得焦点、`Ctrl+S` 之类的时机才检查磁盘,
所以在用户一直开着那些脚本的情况下,`rescan` **永远不会**重载它们。

**`rescan` 有效的两种情形**(都在 §7 的对照里出现过):

- 目标脚本**没开在编辑器里**(第 3 条不触发),并且**已经在 `ResourceCache` 里**
  (第 2 条不触发)——而 5.1 的 `ResourceLoader::load` 副作用使这一条**很容易满足**:
  **只要重扫过一次,目标脚本就进了 `ResourceCache`**,之后的重扫就能真的重载它。
- 目标脚本没有任何活着的引用方——此时它本来就不是陈旧的(§3)。

## 6. LSP 侧的刷新入口

**唯一入口是 `didSave`**(`gdscript_text_document.cpp`):

`ResourceLoader.load` → `load_source_code` → **`reload(true)`** → `reload_script()`,
后者还会调 `ScriptEditor::reload_scripts(true)`、`update_docs_from_script` 与
`trigger_live_script_reload`。LSP 侧**没有** `workspace/didChangeWatchedFiles`
(该文件的 `initialize` 能力声明里没有它),所以外部文件变化不会自动触发这条路径。

两个容易误解的对照:

- **签名是新的,成员是旧的**:**签名文本**来自 LSP 自己的 `parse_script`
  (`gdscript_language_protocol.cpp`,直接 `FileAccess::get_file_as_string`),与被钉住的缓存无关;
  非受管解析结果会被标记为 `stale_parsers` 丢弃。所以补全/签名看起来"跟得上",
  而成员判定仍可能陈旧。另:`grep -rn "GDScriptCache::" modules/gdscript/language_server` 为 **0 命中**
  ——LSP 不直接操作缓存池,它通过分析器的 `depended_parsers` 间接读到被钉住的旧树。
- **`CACHE_MODE_REPLACE` 不是重载**:`resource_loader.cpp` 在 REPLACE 下走
  `old_res->copy_from(new)` 并**返回旧对象**,不会重建解析树。真正重建的是
  `CACHE_MODE_IGNORE`(`gdscript_resource_format.cpp` → `gdscript_cache.cpp`
  的 `get_full_script(..., update_from_disk=true)`:重读源码、`reload(true)`、写回 full cache)。
  编辑器自身也用它重载开着的脚本(`script_editor_plugin.cpp`)。

## 7. 实验证据

工具:临时脚本经 LSP 客户端连**用户正在运行的编辑器**(端口 6005),以及 addon 的重扫入口(6090)。
每轮实验的文件、`.uid`、日志在结束后删除,用户工程源文件不留改动。

### 7.1 结构

```
a      = 被改的脚本(含 class_name)
b1     = 常驻引用方(引用 a 的成员,一直 didOpen 不关闭)
b2     = 新开引用方(引用 a 的新成员,每次关掉再打开,以取全新诊断)
```

### 7.2 三组对照(决定性的因果证据)

| # | a 开在编辑器里 | 有常驻引用方 | 改 a 后新开 b2 | 发 rescan 后 | 结论 |
|---|---|---|---|---|---|
| 1 | ❌ 否 | ✅ 是 | 2 错误(复现) | **0 错误** | rescan **有效** |
| 2 | ✅ 是 | ❌ 否 | **0 错误**(无从复现) | 0 错误 | 没有钉子就没有陈旧 |
| 3 | ✅ **是** | ✅ **是** | 2 错误(复现) | **2 错误** | ★ rescan **无效** = 用户场景 |

三行合起来证明:**两个条件都是必要的**,缺任何一个 `rescan` 都不再是问题所在。

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

### 7.4 由此确认的两个事实

- **`didSave` 是完整解**:它经 `reload(true)` 强制重建解析树,而 `remove_parser` 会**递归移除反向
  依赖条目**,所以"钉住者"也一并被清;它连锁触发的 `ScriptEditor::reload_scripts(true)` 还会把
  编辑器里开着的引用方一起重载。这正是"重启编辑器能治好"的日常等价操作。
- **本插件自己的常规检查从不复现此问题**,原因很具体:它每次检查都会 `didClose` 所有文件
  (`godot-lsp.mjs`),钉子随之脱落,于是引擎下次从磁盘重新解析——**检查行为本身把问题掩盖了**。
  这也解释了为什么"用户看得到、插件测不出"。

### 7.5 记录口径

本节结论的可得性依赖以下事实,复核时应一并采集:编辑器进程身份(pid 与启动时间)、
addon 实际监听的端口、LSP 端口、`script_editor_cache.cfg` 的条目数与被改脚本是否在其中、
以及每次 `publishDiagnostics` 的原始快照。缺其中任一项,实验结论无法与"编辑器自动重载"等
其它解释区分开(§7.2 的第 1、2 组正是为此而设)。

## 8. 方案评估

| 方案 | 做法 | 结论 |
|---|---|---|
| **A(推荐)** | 桥在重扫**之前**,对**磁盘内容确实变化**的 `.gd` 发 `textDocument/didSave` | ✅ 采用。实测消除陈旧;只覆盖变化文件,不碰未保存缓冲 |
| B | 扩展 addon 协议,让 Godot 侧直接 `reload` | ❌ 放弃。会覆盖用户**未保存**的编辑器缓冲;且与 §9.1 的 `check_error` 假绿叠加放大风险 |
| C+ | 让引用方释放旧持有者(例如重开引用方文档) | ⚠ 机制上成立(§3),但需要插件能枚举"哪些引用方活着",成本高于 A |

方案 A 的注意点:

- 只发**内容真的变了**的文件(不是反向依赖),与既有 `rescannedThisRound` 去重共用;
- **超时与失败策略要和 rescan 分开**:rescan 有 120s 失败冷却,D 的 `didSave` 不该被它拖住;
- 它等价于编辑器自身对打开脚本的处理方式,不引入编辑器不会做的副作用。

## 9. 顺带发现的两处缺陷

### 9.1 `check_error` 会被当成"检查过,0 错误"

引擎未在超时内推送诊断时,桥会写出 `check_error` 且 `errors: 0`;而插件侧把"没有诊断"
与"诊断为空"合并计数,于是**一次失败被记成一次干净通过**。同一轮里还可能同时出现
"编译通过,0 错误…无需再次检查"的硬编码结论行——目前**没有任何通道**能把这种降级说明
传达给模型。两者都要修。

### 9.2 桥端口公布文件是单槽的,且协议没有实例身份

`<project>/.godot/dsh_echo_bridge.json` 只有一份,**任何**退出的引擎实例都会按 pid 匹配删除它,
于是"用户编辑器正在监听 6090"可能被一个已经退出的 headless 实例清掉,插件随后回退到默认端口。
这是**结构性缺陷**:单槽文件 + 协议里没有实例身份。修这个缺陷时以下三处必须同步:

- `checkers/godot-lsp/addon/dsh_echo_bridge/plugin.gd`(公布/删除、`MAXIMUM_REQUEST_LENGTH`
  的行缓冲上限、整行匹配协议);
- `checkers/godot-lsp/godot-lsp.mjs`(读公布文件、默认端口回退);
- `lib/addon.js`(probe 时的端口发现——**这是第二份独立实现**,与上一处必须同时改);
- `checkers/godot-lsp/addon/dsh_echo_bridge/plugin.cfg` 的说明文本(它目前只列 `ping`/`rescan`)。

协议侧的具体约束:客户端只接受整行的 `ok`,其它一律判为"未确认";addon 有 256 字节的整行上限,
超长行会被清空并回 `err line too long`;若把应答改成 `ok <done> <total>` 这种带参数形式,
需要**三处匹配逻辑一起改**。因此候选方案的正确顺序是:

1. **先给协议加实例身份**(公布文件里带 pid/启动时间/项目路径,读方据此校验),让"发现端口"
   这件事本身可验证;
2. 只有在身份不可得时,才退回到"探测端口"这类猜测式回退——在没有身份的前提下探测,
   有把 `rescan` 发给**别的项目**的 addon 的实际风险。

## 10. 变更清单(实现方案 A 时)

| 文件 | 改动 |
|---|---|
| `lib/index.js` | 重扫前对内容变化的 `.gd` 发 `didSave`;修正 `check_error` 的计数口径与结论行 |
| `checkers/godot-lsp/godot-lsp.mjs` | `didSave` 客户端、超时/失败策略、端口发现与身份校验 |
| `checkers/godot-lsp/addon/dsh_echo_bridge/plugin.gd` | 公布文件带实例身份 |
| `checkers/godot-lsp/addon/dsh_echo_bridge/plugin.cfg` | 协议说明文本 |
| `lib/addon.js` | 端口发现(与上一处保持一致) |
| `docs/design.md`、`checkers/godot-lsp/README.md` | 同步"重扫能刷新什么"的表述与实测数据 |
