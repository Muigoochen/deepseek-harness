# C++(GDExtension)编译检查 —— 拿项目自己的构建当引擎

## 为什么不用 LSP

`clangd` 那条路要先装第二套工具链、再生成 `compile_commands.json`,而且**只看单文件语法**,
链接错误(未定义符号、DLL 被占用、漏了库)一律看不见。这里反过来:**检查就是让项目编一次**——
SCons 增量构建只重编改动的 TU,报出来的错就是真构建会遇到的错,连链接阶段一起覆盖。

## 桥 CLI

```
node cpp-gdextension.mjs check <file...> --project <dir> [--sweep] [--out <json>] [--dir <dir>] [--toolchain auto|msvc|mingw] [--build-timeout-ms N] [--no-wait] [--kill-on-timeout]
node cpp-gdextension.mjs clientd --project <dir>      # 常驻 JSON-lines,与其它引擎同一协议
node cpp-gdextension.mjs host|status|stop [--project <dir>]
```

`clientd` 的每条请求可以带 `budgetMs`(这次构建的预算)与 `noWait`(构架目录正忙时立刻回答、不排队等);
插件的 pre-step 通道就是用它把"自动检查"限在 40 秒内,而模型显式要求检查时走 110s/190s。

退出码:`0` 无错误 / `1` 有错误 / `2` **没能检查**(工具链缺失、超时、构建脚本自身失败)。

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

**超时不再杀构建**(默认):杀掉 SCons 会扔掉它已做完的工作、并把 `.sconsign.dblite` 留在半写状态,
于是**下一次检查要重编更多** —— 实测过一个 21MB 签名库被打断后,下一次要重编 1119 个 godot-cpp
对象(112 秒)。所以超时后桥把锁交给那个构建(记成"孤儿"记录)、立刻回答
`… the build is still running (pid N) and the next check waits for it`;下一次检查只要 4 秒。
"构建在后台继续跑完"是**常驻 `clientd` 通道**的保证:那个进程还活着,继续读构建输出。一次性
`check` 交出孤儿记录后就自己退出(摘掉构建子进程的 stdio 监听并 `unref`,好带着已打印的结论按时
退出),它的构建在父进程退出后若还要写输出,可能因管道关闭而中断 —— 所以插件优先走 clientd,
一次性路径只是 clientd 起不来时的退路。要真的杀掉(例如测试清理)显式加 `--kill-on-timeout`;
`--no-wait` 则让检查在构建目录正忙时立刻回答而不是排队等 —— **clientd 里的 `noWait` 请求不排队**:
正有一个检查在跑时立刻回"另一个检查正在构建",而不是挤进队列等到宿主的短超时把整个 clientd
退休(那会连在跑的那个请求一起失败)。

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
