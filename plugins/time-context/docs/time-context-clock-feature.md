# Web GUI 时钟上下文（time-context）启用功能笔记

> 记录本次「把当前系统时间注入模型上下文」从调研、方案到落地与真机验证的全过程，供后续开发或其它功能参考。
> 项目资产单一归属 `plugins/time-context/`（纯插件开发：不碰仓库底层/产品源码、脚本与逻辑），本文件是其 `docs/`。

## 1. 目标与背景

用户在使用 Web GUI 时发现模型不知道「现在几点」。要求：**每轮（或每个模型请求步骤）前，把当前系统时间注入模型上下文**，让模型能解释未限定时间的问句（如「现在几点」「下周五开会」）。最初疑问是「harness 有没有给我发系统时间」——结论：默认没发。

## 2. 关键结论（调研产出）

- **功能早已存在**：`@deepseek-ai/dsh-time-context`（`packages/context/time-context/`）就是标准实现，durable（持久化）、带来源、可重建。
- **上游刻意默认不开**：设计笔记 `.agents/notes/implemented/feature/2026-07-16-durable-per-step-time-context.md`（仓库内路径）明确把「默认挂载」列为否决项（披露/新鲜度/历史 token 成本属于组合策略）。仓库约定也是 opt-in 不进 shipped 默认。
- **官方启用姿势 = overlay patch**：Schedule 产品就是先例（`apps/cli/config/examples/schedule/cordis.yml` + `dsh web --patch …`）；长期装载推荐 `$DSH_HOME/profiles/web/cordis.patch.yml`（web profile `patchReload: live`，零仓库源码改动）。
- **浏览器时区来源**：Web GUI 每次 prompt 会上报 `clientTimeZone`（在 `user-rpc` 消息源上，见会话控制器类型 `MessageSourceMap['user-rpc'] = { kind:'user'; rpcId; clientTimeZone? }`），插件据此把读数格式化成「用户所在时区」，缺失/混合时走配置回退并提示澄清。

## 3. 方案决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 启用路径 | 组合层 overlay 启用（profile patch / `--patch`），不碰底层 | 纯插件原则；零出货默认偏离、可测、可分发 |
| 资产归属 | 全部收进 `plugins/time-context/`，仓库树回滚纯净 | 项目单一归属；仓库可改范围仅限产品配置文件（如需） |
| 注入频率 | 插件默认（**每个进入的模型步骤**注入一条） | 时间最新鲜（Schedule overlay 同款）；历史成本可后续用 `refreshIntervalMs` 节流 |
| 回退时区 | 显式 `timeZone: Asia/Shanghai` | 面向国内用户；请求自带浏览器时区时优先于它 |
| 不变量 | 不改 system prompt / `request/header`；读数作为 user 消息持久化 | 满足「模型可见 ⟺ 已记录」，重启/回放可重建 |

## 4. 机制原理（为什么合规）

`dsh-time-context` 注册一个 **`agent/pre-step` listener（prepend + 先 delegate）**：下游决策进入 step 时，组合该 step 的候选消息与当前 turn 内已落库的 user 消息，追加一条三行读数作为 **user 消息**，来源为 `{ kind:'plugin', plugin:'time-context', form:'snapshot', sections:[{name:'time-context', text}] }`：

```text
Time sampled while preparing turn <N>, step <M>: 2026-09-04T10:19:57+08:00[Asia/Shanghai]
Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.
Elapsed since the preceding model-visible message: 1m 58s.
```

- 读数在 `step/start` 之后、请求推导之前写入日志 → 持久、可重建；**不参与** system prompt 或 request header（那是被否决过的「实时替换系统提示词」方案，会破坏历史请求重建）。
- step 1 基线 = 上一条模型可见消息；后续步骤基线 = 本 turn 上一次 time-context 读数；缺失报 `unavailable`，墙钟回退钳到 0。
- 并发/多轮安全：浏览器时区**绑定到那条 user-rpc 消息**，不落到 Session/连接默认值上，旅行/多标签不会互相污染。
- 配套 invariant 伴生插件校验读数格式、位置、来源与重建出的浏览器策略是否一致。

## 5. 落地产物

**插件项目（单一归属 `plugins/time-context/`）**
- `cordis.patch.yml` —— overlay：`insert` 挂载 time-context，`config.timeZone: Asia/Shanghai`（insert 项可带 `config`，与 bundle patch 同构）。同时是 launcher 的兜底 patch。
- `README.md` —— 项目卡：纯插件承诺、结构、启用方式、验证记录。
- `docs/` —— 本功能笔记 + 原生源码速查（`harness-source-reference.md`）。
- `reference/` —— 原仓库 keyless loader-smoke e2e 回归证据（e2e + driver + companion patch，见下）；未接入仓库 vitest，仅参考。

**运行态 / 本机接线（不在仓库）**
- `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` —— 本机 profile 持久启用（`patchReload: live`，写文件即热生效，**重启/任何启动方式都生效**）。
- `start-dsh-web.bat` / `tools/dsh-offline-installer/installer.py` —— 启动兜底：当 home patch 未启用 time-context 时，用 `--patch` 挂 `plugins/time-context/cordis.patch.yml`（存在性 + 已启用双保护，避免双挂）。

**仓库现状**：曾临时放入仓库的改动已全部回滚/移除——上游 README 三件套（`README.md/zh/i18n.yaml`）已 `git restore`，`apps/cli/config/examples/time-context/` 示例与 `packages/context/time-context/tests/` 三个测试文件已移出。tracked 树干净。若未来希望给产品提供官方示例，可按「产品配置文件可改」原则放回 `apps/cli/config/examples/`（仓库内路径），再同步 launcher 指向。

## 6. 启用 / 验证方式

```sh
# 命令行临时启用（本插件项目内）
dsh web --patch plugins/time-context/cordis.patch.yml
# 长期：写入 %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml（同 insert 内容）
```

真机验证步骤与要点：
1. **重启进程后检查命令行**是否带 `--patch`（曾出现「重启了但没生效」= 从改动前就开着的安装器窗口启动，走的旧代码，命令行无 `--patch`）。
2. 本机 profile 支持 **live HMR**：写 `cordis.patch.yml` 后下一轮即生效，无需重启；改动前开着旧窗口也不影响。
3. 让模型回答「现在几点」：生效时模型上下文会出现上面的三行读数，且第二行是解析出的浏览器时区（真实页面 prompt 才带时区；自动化 goal 步骤无 zone，会显示 unavailable + ask-to-clarify——属预期）。
4. 关键诊断：`netstat -ano | findstr 3080` 拿 PID → 查该进程命令行确认启动参数。

回归 e2e（参考）说明：原始证据测试在真实会话与仓库 keyless loader-smoke 中都通过；代码存于 `reference/`。若要在仓库内复跑：把 `reference/` 三件 + 依赖的 `mock-llm.ts` 按原布局临时放回 `packages/context/time-context/tests/`，再 `pnpm exec vitest run --config vitest.e2e.config.ts time-context`（跑完清理）。

## 7. 约束与注意（后续开发复用）

- **模型可见 ⟺ 已记录**：新加到模型请求的内容必须是日志可重建的；time-context 用「持久化 user 消息」而非「每次实时渲染进 system prompt」就是这个原因。
- 每步一条读数的历史成本会累计到 compaction；嫌多再开 `refreshIntervalMs`（正数=同会话最小间隔）。
- **去重规则**：同一插件 id 别既在 profile patch 又在 `--patch` overlay 里 insert（会双挂）。launcher 现在按「home patch 已含 `dsh-time-context` 就跳过 `--patch`」互斥。
- 出厂默认组合不动：如需让所有小白开箱即得，应改为在 `packages/bundle/web-app/cordis.patch.yml` 里 shipped-disabled 一行（参照 `ui-schedule` 模式），再让 overlay 只翻 `disabled: false`——这属于产品决策，需另行拍板（会动大量 web 快照）。
- 分发：重打包 `source.tar.gz` 前确认 **`plugins/time-context/` 目录**在内（含 `cordis.patch.yml`），否则新机器 launcher 会静默跳过（存在性保护，不报错）。

## 8. 关联入口

- 项目卡：`plugins/time-context/README.md`
- 原生源码速查：见 [harness-source-reference.md](harness-source-reference.md)（同目录）
- 上游插件：`packages/context/time-context/README.md`（已回滚，仓库不再引用本项目）
- 设计决策（仓库内）：`.agents/notes/implemented/feature/2026-07-16-durable-per-step-time-context.md`
- Schedule 先例：`docs/user/guide/schedule.md`、`apps/cli/config/examples/schedule/cordis.yml`
