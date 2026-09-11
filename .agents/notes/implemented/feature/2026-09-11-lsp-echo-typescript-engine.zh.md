# Agent Note: lsp-echo 的 TypeScript 引擎

Status: implemented

[English](2026-09-11-lsp-echo-typescript-engine.md) | 中文

## Problem

lsp-echo 此前只服务一种语言：注册表里只有一个引擎，其 marker 是 `project.godot`，扩展名是 GDScript 与着色器文件。于是 TypeScript 或 JavaScript 工作区——包括本仓库本身——没有任何自动编译诊断，尽管该插件的价值（在下一轮模型请求前注入一份 `文件:行:列` 错误清单）并不依赖具体语言。

注册表本就是为此设计的：引擎是 `checkers/` 下的一个目录，含一份 `engine.json` 声明与一个桥可执行文件，路由、管理与界面代码读取注册表而不写死某个引擎。缺的是一个可供读取的引擎。

## Decision

[`checkers/typescript/`](../../../../plugins/lsp-echo/checkers/typescript) 在 `tsserver` 的 stdio 协议之上实现与 Godot 引擎相同的桥约定。

它的 [`engine.json`](../../../../plugins/lsp-echo/checkers/typescript/engine.json) 声明 marker 为 `tsconfig.json`，扩展名为 `.ts`、`.tsx`、`.mjs`、`.cjs`、`.js`、`.jsx`，因此含 `tsconfig.json` 的工作区被该引擎认领，其文件按扩展名路由到这里。

`typescript-lsp.mjs` 实现 `host|status|stop|check|clientd`，即插件管理器为每个引擎调用的同一套命令，并产出相同的载荷：以项目相对路径为键的文件，每个含 `{errors, warnings, diagnostics}`，诊断项携带 `severity`、`severityName`、`message`、`source`、`code`、`line`、`column`、`file`。载荷相同正是管理器能把两个引擎的结果合并进同一个按项目快照而无需引擎专属分支的原因。

`tsserver` 可执行文件按以下顺序解析：`--ts-server`、机器配置 `typescript.config.json` 的 `tsServer`、项目自身的 `node_modules/typescript/lib/tsserver.js`，最后是环境变量 `TSSERVER_PATH`。这些都不存在时，桥以退出码 `2` 报出解析错误，而不会退回 `PATH` 上的 `tsserver`。锁定 TypeScript 版本的项目得到该版本的诊断；插件不自带编译器，也不引入依赖。

此处 TypeScript 没有可嵌入的图形宿主，因此该引擎没有编辑器 attach 模式：它不声明 [引擎桥 Note](2026-09-11-lsp-echo-godot-editor-bridge-rescan.zh.md) 所定义的 `rescan` 能力，且每条命令拥有一个 `tsserver` 会话。`clientd` 在请求之间保持一个会话存活，在 stdin 上使用 JSON 行——输入 `{id, files, sweep}`，输出 `{id, ok, payload}`——这正是管理器常驻进程路径对任何引擎的期望。该引擎读取 `id` 与 `files`，把每个请求都当作普通文件清单；`sweep` 标志在这里不产生效果，因为 TypeScript 的整程序答复本就覆盖了扫描会补上的文件。

## Alternatives considered

| 被否决 | 一句话理由 |
|---|---|
| 每次检查运行 `tsc --noEmit` | 报告整个项目而非被请求的文件，并且每轮都要付全程序编译 |
| 在插件进程内宿主 TypeScript 编译器 API | 插件以 ESM 文件、零依赖分发；内嵌编译器意味着把编译器随插件一起分发并锁定版本 |
| 要求安装 `typescript-language-server` | 为用户已有的 `typescript` 包所能提供的能力，额外增加一个需要用户安装并保持更新的工具 |
| 只报告编辑器改过的文件，不带项目上下文 | TypeScript 诊断依赖整个程序，单独检查一个文件会报出项目真实配置会消除的错误 |
| 把该引擎标为 `rescan: true` 并复用 Godot 的 addon 路径 | 该 addon 是 Godot 编辑器插件；TypeScript 工作区里没有任何东西能宿主它，那等于声明了一个没有实现的能力 |

## Consequences

在 lsp-echo 中注册的 TypeScript 或 JavaScript 工作区如今与 GDScript 一样，在同一个 pre-step 路径上获得自动编译诊断，而注册表关于引擎数量的假设也由第二个条目来检验：扩展名路由、按引擎启停、设置页的引擎卡片与多引擎合并路径都在一个真实引擎上运行，而不再是假设。

接受的代价：诊断取决于项目安装的 TypeScript 版本，因此两台机器对同一文件可能给出不同结果；该引擎每个桥会话启动一个 `tsserver`，首次使用有几百毫秒开销；载荷携带 tsserver 的严重级别映射，插件直接呈现而不把错误码翻译成自己的分类。
