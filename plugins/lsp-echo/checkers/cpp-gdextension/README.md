# C++(GDExtension)编译检查 —— 拿项目自己的构建当引擎

## 为什么不用 LSP

`clangd` 那条路要先装第二套工具链、再生成 `compile_commands.json`,而且**只看单文件语法**,
链接错误(未定义符号、DLL 被占用、漏了库)一律看不见。这里反过来:**检查就是让项目编一次**——
SCons 增量构建只重编改动的 TU,报出来的错就是真构建会遇到的错,连链接阶段一起覆盖。

## 桥 CLI

```
node cpp-gdextension.mjs check <file...> --project <dir> [--sweep] [--out <json>] [--dir <dir>] [--toolchain auto|msvc|mingw] [--build-timeout-ms N]
node cpp-gdextension.mjs clientd --project <dir>      # 常驻 JSON-lines,与其它引擎同一协议
node cpp-gdextension.mjs host|status|stop [--project <dir>]
```

退出码:`0` 无错误 / `1` 有错误 / `2` **没能检查**(工具链缺失、超时、构建脚本自身失败)。

## 构建目录与入口(自动发现)

- **先看这次要查的文件**:从每个文件所在目录往上找到最近的构建入口,那才是它的构建目录 ——
  一个项目里有两个 GDExtension 时,改动属于哪个就编哪个,不会拿另一个的"编过"冒充;
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
`build did not finish within Xs (target); run it manually…` —— 抢在插件那边的 clientd 超时之前,
免得用户只看到一句"请求超时"。注意首次检查若撞上 godot-cpp 需要重编(改过依赖版本之后),
大概率超预算;手动跑一次 `build.ps1` 之后就是增量了。

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
# 诊断解析 / 协议 / 诚实性路径 / 每文件构建目录 + 真实 MSVC 端到端(41 项)
node E:\Deepseek\deepseek_harness\plugins\lsp-echo\checkers\cpp-gdextension\reference\probe.mjs --real-msvc

# evidence 绑定 + 快照合并/作用域语义(可指向任意真实 GDExtension 项目)
node E:\Deepseek\deepseek_harness\plugins\lsp-echo\checkers\cpp-gdextension\reference\binding-probe.mjs --project E:\GodotProject\dsh_goochen_assistant
```
