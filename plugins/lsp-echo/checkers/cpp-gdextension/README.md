# C++(GDExtension)编译检查 —— 两级:先语法,再构建

**两个阶段,回答两个不同的问题**:

| 阶段 | 问题 | 手段 | 实测耗时(本项目 `dsh_proc.cpp`) |
|---|---|---|---|
| `syntax` | "我刚改的这个文件还编得过吗?" | 项目**自己的编译器** + 项目自己的 flags,`-fsyntax-only` / `cl /Zs`,不构建 | **1.14 s** |
| `build` | "真的能编出 DLL 吗?"(链接、构建脚本、依赖库) | 让项目**真编一次**(`build.ps1` / SCons),报出来的错就是真构建的错 | 4.3–4.6 s(增量);godot-cpp 需要重编时 110 s+ |

自动检查(pre-step)发的是 `auto`:优先 `syntax`(跑得动就 1 秒给答案,一轮对话不再为一个语法错付一次
构建、更不会付一次 godot-cpp 重编),本机没法驱动语法阶段时退回 `build` —— 退的是"慢一点",不是
"没结论"。`build` 保留给按需检查与后台构建,因为**链接错误只有构建看得见** —— syntax 阶段因此从不产生
`<link>` 记录,也从不覆盖构建留下的那条。

## 为什么语法阶段用项目自己的编译器,而不是 clangd

2026-09-25 实测(同一个真实文件、同一套 godot-cpp 头文件):

| | 项目自己的编译器 | clangd 22.1.6 |
|---|---|---|
| 额外安装 | **0**(构建本来就要它) | 92.5 MB(解压后) |
| 单文件耗时 | 1.14 s | ~1.4 s(冷启,含标准库索引;`--check` 模式墙钟 2.94 s) |
| 内存 | 即用即走 | 峰值 104 MB |
| 结论可信度 | **与构建同一个编译器**:报的错就是构建会报的错 | **第二个编译器**:可以接受 g++ 拒绝的代码,也可能拒绝 g++ 接受的(它连标准库索引都会"incomplete due to errors") |
| 配错时 | 没有额外配置可配错 | **满屏假错误**:实测一次配错报出 24 条(找不到 `windows.h` → `HANDLE`/`DWORD`/模板全是"错误")。要同时满足三件事:CDB 里编译器写成**绝对路径**、`--query-driver` 指到它、它的 bin 在子进程 PATH 上(MinGW 的 g++ 不在 PATH 上会**静默 exit 1**) |
| 当检查器用 | 退出码就是结论 | `--check` 的退出码**不可用**:干净文件也报 `All checks completed, 5 errors` + `exit 3`(那 5 条是 clangd 自己的代码动作自测失败,不是诊断) |

想用 clangd 的补全/跳转/重构这类 IDE 能力,和本插件不冲突:profile 里已安装的 `dsh-lsp-actions`
(默认未启用)提供 `lsp_diagnostics` 等工具,启用后给它配一个 clangd server 就行 —— 但那是
"模型按需问语言服务器",不是"改完自动告诉你",也不是"能编出 DLL 吗"。

## 桥 CLI

```
node cpp-gdextension.mjs check <file...> --project <dir> [--stage auto|syntax|build] [--sweep] [--out <json>] [--dir <dir>] [--toolchain auto|msvc|mingw] [--build-timeout-ms N] [--no-wait] [--kill-on-timeout] [--flags <file|dir>] [--print-flags]
node cpp-gdextension.mjs clientd --project <dir>      # 常驻 JSON-lines,与其它引擎同一协议
node cpp-gdextension.mjs host|status|stop [--project <dir>]
```

`--stage` 默认 `build`(与历史行为一致);`syntax` 明确要语法阶段(跑不了就报 exit 2,不悄悄改跑构建);
`auto` 优先 syntax,项目工具链没法驱动时(MSVC 没有 `vcvars64.bat`、也找不到别的编译器)退回 build ——
**不把"跑不了的阶段"变成"没问题的结论"**。插件的自动检查发的是 `auto`。

`clientd` 的每条请求可以带 `budgetMs`(这次检查的预算)、`noWait`(构建目录正忙时立刻回答、不排队等)
与 `stage`;插件把它用来把"自动检查"限在 40 秒内,而模型显式要求检查时走 110s/190s。`syntax`/`auto`
的请求先走**独立的语法通道**:它不取锁、不写构建目录,所以不必排在正在跑的构建后面(否则一步的快速
检查要等一个可能跑几分钟的后台构建);`auto` 在语法阶段跑不了、要退回构建时,按 `noWait` 那条规矩办
(构建目录正忙就立刻回忙,而不是排进队列等宿主超时)。

退出码:`0` 无错误 / `1` 有错误 / `2` **没能检查**(工具链缺失、超时、构建脚本自身失败)。

## 语法阶段(syntax):flags 从哪来,以及它保证什么

**flags 来源,按可信度从高到低**(用了哪个会写进 payload 的 `build.flagsFrom`,并作为中文
`engine_note` 的一部分进到注入给模型的那句话里;`flagsFrom` 字段本身在 `--out` 的 JSON 里。
一轮里多个文件来源不同时写成「X 等 N 种来源」,不假装整轮都用了最后一个):

1. **显式**:`--flags <file|dir>` 指到的 `compile_commands.json`(取该文件那条 —— 精确路径优先,退而
   求其次要求**同目录**同名,别人的同名文件不算;`-o/-c/-MD/-MF…` 一律剥掉)或 `compile_flags.txt`
   (每行一个参数)。CDB 里那个编译器与**将要运行的编译器**家族不同时(MSVC 的 `/I` 喂给 g++)会被
   忽略并记录原因 —— 那不是"没找到 flags",那是会把假错误灌进来的输入;
2. **构建目录 / 项目根**里的同名文件(项目自己发布过 CDB 时自动用上);
3. **上一次成功构建学到的**:桥从构建输出里读出项目自己的编译命令行(SCons 会打印),
   把 flags 记在 `$DSH_HOME/lsp-echo-runtime/cpp-flags-<项目哈希>.json` —— **绝不写进项目树**。
   只有**整轮构建全部 exit 0** 才学;记录按**编译器家族**记账(`cl` = MSVC,其余 = MinGW,由那行命令里的
   编译器自己决定,而不是由产物推断出的标签决定),并带签名(构建入口的路径+大小+mtime + 家族 +
   godot-cpp 的 `SConstruct`/`tools/godotcpp.py`),任一项变了就作废、回到布局推断。语法阶段按**它将要
   运行的那个编译器**的家族去读,所以"产物判定为 MSVC、实际退回 MinGW"的机器也照样用得上。
   **注意**:一次**没有实际编译任何文件**的构建(工程已是最新)什么都不教 —— 这时语法阶段用布局推断,
   等下一次真的有文件要编时自然就学到了(记录按签名存活,之后一直有效)。想让它一开始就精确,项目可以
   自己发布 `compile_commands.json`(SCons 的 `compilation_db` 工具)或 `compile_flags.txt`;
4. **GDExtension 布局推断**:`godot-cpp` 的 `include`/`gen/include`/`gdextension` + 构建目录 +
   项目根 + `-std=c++17`。故意**不发明 `-D`** —— 编出来的宏会变假错误,缺宏只是精度差一点。

**编译器从哪来**:`CXX` → `MINGW_BIN` → **项目自己的构建脚本里写死的路径**(实测本项目
`build.ps1` 里的 `E:\Programs\mingw64-gcc14\mingw64\bin` 就是这样找到的 —— 项目脚本比 harness 的
PATH 更懂它自己) → PATH。`CXX`/`MINGW_BIN` 只在**家族与项目一致**时被采纳(否则会出现"MSVC 的 flags
配 MinGW 的编译器"这种两边都不可信的配对)。MSVC 项目按 `cl` → **vcvars64.bat 带来的 cl**(项目自己的
环境优先)→ 机器上有的 g++(前两者都不行时才连 flags 一起切到 MinGW,并在 `engine_note` 里说明)挑选;
都找不到就 **exit 2 报"语法阶段跑不了"**,并提示设 `CXX`/`MINGW_BIN`,或先跑一次构建让它学到。
MSVC 那条路要经过 `cmd.exe`:Node 默认给参数加的反斜杠转义 cmd 不认,所以桥用
`windowsVerbatimArguments` 把命令行原样递过去 —— 少了这一步,`cl /Zs` 会"跑了但什么都没说"(实测)。

**保证**(都有探针用例):

- **不写构建目录、不取锁**:`-fsyntax-only` 不产出文件,`-o` 之类参数已剥掉;探针在跑检查前后对
  整个构建目录做指纹(文件名+大小+mtime)并要求逐字相同,也不会出现 `cpp-build-*.lock`;
- **不产生、不覆盖 `<link>`**:payload 的 `syntheticKeys` 是空数组,插件的快照合并因此保留构建阶段
  写下的那条链接错误记录(这是"没检查"与"没有链接错误"的区别);反过来,一次**干净**的构建
  (payload 声明拥有 `<link>` 却没产出它)会把它清掉 —— 否则修好的链接错误会永远赖在快照里;
- **跑不了就说跑不了**:编译器缺失、起不来、超时、或**退出码非 0 却解析不出一条能归到源文件的诊断**
  (不认的 flag、坏掉的工具链、`cl` 没被 vcvars 备好),一律 exit 2 且**不写 payload**,绝不回一个
  0 错误的结果。退出码按各家的约定收:`cl` 出错退 2、gcc 退 1,两者都算"编译器跑过了",由诊断决定结论;
- **带调用方的预算**:`budgetMs`(clientd 请求)或 `--build-timeout-ms` 会变成整个阶段的截止时间,
  超了就以 exit 2 如实报告跑到第几个文件,不会拖过宿主的超时;
- **只认这个构建目录的文件**:和构建阶段一样,解析到另一个 GDExtension 构建目录的文件不会被
  打个"0 错误"了事,而是计进 `engine_note` 的"本次没有检查";
- **明确写出覆盖范围**:`engine_note` 每次都声明"语法检查(未构建)…链接错误与构建脚本/依赖库的问题
  不在本次范围内";
- `--print-flags` 打印这次会用的构建目录/工具链/编译器/flags 与来源,不编译任何东西(自检用);
  它用**和真正运行同一个**解析器,连不上编译器时以 exit 2 收场,不会把"跑不了"报成"能用"。

## 构建目录与入口(自动发现)

- **先看这次要查的文件**:从每个文件所在目录往上找到最近的构建入口,那才是它的构建目录 ——
  一个项目里有两个 GDExtension 时,改动属于哪个就编哪个,不会拿另一个的"编过"冒充;
- **只有构建入口、没有 `*.gdextension` 的目录不算这个项目的构建**:项目里 vendored 的依赖检出
  (典型是 `godot-cpp`,它自带 `SConstruct`)就是这种形状 —— 拿它当构建入口会去编别人的源码,并在
  `api_version` 上直接失败。这种情况继续往上找带 `.gdextension` 的扩展目录;真找不到才退回最近的入口。
  落在构建目录**之外**的文件因此**永远不会被报成"检查通过"**:payload 的 `engine_note` 会说明"有 N 个
  文件没被这次构建覆盖";
- **一次检查里出现两个扩展目录时,只有第一个文件选中的那个构建会跑**:另一个扩展的文件若恰好落在它的
  目录**之内**(根级 `.gdextension` + `addons/inner/.../native`),也会被同样排除并写进 `engine_note`。
  落在构建目录**之内**、但项目构建其实没编的文件无法区分 —— SCons 不逐个报告,所以那种文件的
  "0 错误"只意味着"本次构建没有关于它的诊断",不意味着它一定被编过;
- 没有可用文件时才走遍历:从项目根往下找(深度 ≤ 6;跳过
  `.git/.godot/node_modules/.venv/dist/build/bin/obj/godot-cpp` 等);
- **同目录里既有构建入口、又有 `*.gdextension`** = 命中,立刻用;找不到这样的目录时退而使用
  第一个构建入口(`.gdextension` 放在别处的布局);
- `--dir <dir>` 直接指定构建目录(必须含构建入口,否则报错退出);
- 入口优先 `<dir>/build.ps1` → `powershell -Command` 里调用 `build.ps1 -Target debug|both`:
  项目自己的脚本里有本机知识(`py -m SCons`、`GODOT_API_VERSION`、MinGW 路径),桥不去重复它;
- 没有 `build.ps1` 才回退到 `py -m SCons platform=<os> target=template_<debug|release> -j<N>`,
  `GODOT_API_VERSION` 取自 `.gdextension` 的 `compatibility_minimum`。

## 编码

SCons 是 Python:stdout 接管道时按本机 ANSI 代码页编码,编译器输出里只要有一个该代码页表示不了的
字符,整份报告就以 `UnicodeEncodeError` 收场、对象被判"失败",**真正的错因反而看不见**。桥给子进程
设 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`,并走 `powershell -Command` 先把控制台输出编码抬到
UTF-8(Windows PowerShell 5.1 默认按 ANSI 解码子进程输出,会把非 ASCII 诊断弄成乱码)。

## 工具链(MSVC / MinGW)自动判定

`build.ps1` 的默认是 MSVC;但一台机器上**只有一套工具链能编**是常态(本机就是:VS BuildTools 装了、
却没装 Windows SDK,`cl` 连 `stddef.h` 都找不到;能编的是 MinGW)。所以桥按**项目自己的产物**判定:

- 只看工具链独有的扩展名:`.a` = MinGW,`.lib`/`.obj` = MSVC(`.o`/`.dll` 两边都会产生,不作证据);
- 位置:`<构建目录>/bin`、`<构建目录>/src`、`<项目根>/godot-cpp/bin`;**取最新的那个**,
  于是换过工具链的项目会跟随;
- 判定为 MinGW 时:有 `build.ps1` 就加 `-MinGW`(MinGW 路径发现与 GCC 变通都留在项目脚本里),
  裸 SCons 则加 `use_mingw=yes`;
- 什么都没编过 → 用入口默认值(MSVC);`--toolchain auto|msvc|mingw` 可显式覆盖,
  非法值或漏写值都直接报错退出(2)。`status` 会报告它选的工具链。

## target 策略

- 每次改动检查:**只编 debug** —— 编辑器实际加载的就是这个 DLL,反馈最快;
- `--sweep`(全量重扫):debug + **release** 都编 —— release 独有的失败(关掉 `DEV_ENABLED`、
  满优化触发编译器自身 bug)只有它能查出来。

## 时间预算

插件给一次检查 120s(main)/ 200s(baseline);桥用 **110s / 190s** 的预算先作答,超时就回
`build did not finish within Xs (target)…` —— 抢在插件那边的 clientd 超时之前,免得用户只看到
一句"请求超时"。**自动检查(pre-step 通道)另有一份 40 秒的预算**(`engine.json` 的 `budgetMs`),
因为一次冷启动重编可能好几分钟,不该把用户的一轮对话卡在那里;模型显式调用 `lsp_echo check` 时
才用 110s/190s。

**这条预算今天约束的是语法阶段**:pre-step 发 `auto`,跑得动就是一次约 1 秒的语法检查;只有本机驱动
不了语法阶段时它才落到构建上 —— 那时这 40 秒仍按上面那条规矩保护一轮对话(超预算的构建继续在后台跑,
改动文件下一步重试)。`--stage build` 与 `--sweep` 的预算按上面这张表。

**超时不再杀构建**(默认):杀掉 SCons 会扔掉它已做完的工作、并把 `.sconsign.dblite` 留在半写状态,
于是**下一次检查要重编更多** —— 实测过一个 21MB 签名库被打断后,下一次要重编 1119 个 godot-cpp
对象(112 秒)。所以超时后桥把锁交给那个构建(记成"孤儿"记录)、立刻回答
`… the build is still running (pid N) and the next check waits for it`;下一次检查只要 4 秒。
"构建在后台继续跑完"是**常驻 `clientd` 通道**的保证:那个进程还活着,继续读构建输出。一次性
`check` 交出孤儿记录后就自己退出(摘掉构建子进程的 stdio 监听并 `unref`,好带着已打印的结论按时
退出),它的构建在父进程退出后若还要写输出,可能因管道关闭而中断 —— 所以插件优先走 clientd,
一次性路径只是 clientd 起不来时的退路。要真的杀掉(例如测试清理)显式加 `--kill-on-timeout`;
`--no-wait` 则让检查在构建目录正忙时立刻回答而不是排队等 —— **clientd 里的 `noWait` 请求不排队**
(`auto` 退回构建时同样按这条办):正有一个检查在跑时立刻回"另一个检查正在构建",而不是挤进队列等到
宿主的短超时把整个 clientd 退休(那会连在跑的那个请求一起失败)。

注意首次检查若撞上 godot-cpp 需要重编(改过依赖版本、或被中断过),会超预算;等它在后台跑完、
或手动跑一次 `build.ps1` 之后就是增量。

## 并发(同一构建目录)

一个构建目录可能被不止一个检查进程碰到:宿主在 clientd 超时后会退回一次性 `check`,或者第二个 DSH
实例正在查同一个项目。同目录里两个 SCons 会互相抢 object 文件与输出 DLL,所以每次构建先取锁
(`$DSH_HOME/lsp-echo-runtime/cpp-build-<hash>.lock`,**不写进项目树**):拿不到就等,等到自己的预算
用完就如实回"另一个检查正在构建 `<dir>`"(exit 2,不假装通过)。

锁记录**取锁进程 pid 与构建子进程 pid**:杀掉检查进程并不会杀掉它启动的编译器,所以**任一 pid 还活着
就当作有人在构建** —— 否则重试会跟那个"孤儿构建"同时跑。记录读不出来时按 5 秒宽限当作被持有
(创建与写入之间有个窗口),接管陈旧锁用 rename 保证只有一个等待者抢到;跑完自动释放,记录超过
24 小时也按陈旧处理(pid 被复用时不至于永远等下去),拒绝时报出的信息里带上锁文件路径,方便手动清。

**等待与构建共用同一份预算**:`--build-timeout-ms`(默认 110s/190s)是这一次检查的总预算,等锁花掉的
时间从里面扣;只有等到剩余不足 3 秒才提前拒绝 —— 短窗口照样编,因为桥会在自己的预算内给出结论,
拒绝等于拿"可能成功"换"一定失败"。预算到点默认**不杀**构建(见上),只有 `--kill-on-timeout` 才杀:
Windows `taskkill /T /F`,POSIX 整组 SIGKILL,失败再直接 kill;被杀的子进程若仍握着继承来的管道,
5 秒后也照样作答(**预算 + 最多 5 秒**,仍在宿主的
120s/200s 之内)。这时锁会留成"孤儿构建"记录(只记 `childPid`、不带取锁 pid,因为那个进程正是还活着的
检查自己),下一次检查会等它或如实报它,而不是并排再开一个 SCons。

已知边界:锁只覆盖共享同一个 `DSH_HOME` 的进程;两个项目共用一份 `godot-cpp` 检出时,各编各的扩展仍可能在依赖目录里互相踩
(按构建目录分锁、不做全局串行,是刻意的取舍)。

## 诚实性规则

- 构建退出码非 0、却解析不出任何源码诊断 → 当作**检查失败**(exit 2),**不写 payload**:
  没有 payload 就不会被当成"检查过、0 错误";
- 链接/构建系统错误(MSVC `LNK####`、`undefined reference`、`collect2`、`scons: ***`)
  挂到合成条目 `<link>`,绝不丢;归属在两处声明 —— `engine.json` 的 `syntheticKeys`(插件侧:
  只在 C++ 轮次里展示、别的引擎的快照合并不挤掉它)与 payload 的 `syntheticKeys`(宿主侧:
  只有写它的引擎能替换这个键);它计入错误数,但**不算一个"检查过的文件"**;
- 超出这次实际构建目录的文件**不写进 payload**:没编过就不算"查过",宁可少报也不假装通过
  (同时用 `engine_note` 说明哪几个文件没被这次构建覆盖);
- 报错文件在项目外(依赖库头文件)时用 `../` 相对路径如实保留,不假装它不属于这次检查;
- `check_error` / `engine_note` 的语义沿用 godot 桥:不确定就说不确定。

## 自检

```powershell
# 诊断解析 / 协议 / 诚实性路径 / 每文件构建目录 / 依赖检出排除 / 并发构建锁 + 真实 MSVC 端到端
node E:\Deepseek\deepseek_harness\plugins\lsp-echo\checkers\cpp-gdextension\reference\probe.mjs --real-msvc

# evidence 绑定 + 快照合并/作用域语义(可指向任意真实 GDExtension 项目)
node E:\Deepseek\deepseek_harness\plugins\lsp-echo\checkers\cpp-gdextension\reference\binding-probe.mjs --project E:\GodotProject\dsh_goochen_assistant
```
