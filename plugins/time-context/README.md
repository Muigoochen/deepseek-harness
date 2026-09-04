# time-context（Web 时钟上下文，纯插件）

让 Web GUI 的模型在每轮/每个模型请求步骤前收到**当前系统时间读数**（含浏览器时区）。
底层能力来自出厂插件 `@deepseek-ai/dsh-time-context`，本项目只做「组合层启用 + 文档 + 回归证据」，**零仓库底层/产品源码改动**。

**路线承诺（用户要求，务必遵守）**
- 纯插件开发：不修改仓库任何底层/产品源码、脚本与逻辑（产品**配置文件**可按需改动，如 `apps/cli/config/examples/` 配置示例）。
- 本目录是本次项目脚本/文档的单一归属；`plugins/<name>/` 每插件一个目录。
- 仓库树保持纯净：曾临时放入仓库的 README 改动、examples 示例与 packages 测试均已**回滚/移除**。

**结构**
```
plugins/time-context/
├─ README.md                     本卡
├─ cordis.patch.yml              overlay patch：insert dsh-time-context，timeZone: Asia/Shanghai
├─ docs/
│  ├─ time-context-clock-feature.md   功能笔记：目标/决策/机制/落地/验证
│  └─ harness-source-reference.md     本次读过的原生源码速查（作用+主要方法/属性）
└─ reference/                    原仓库 e2e 回归证据（未接入仓库 vitest，仅参考/可临时放回）
   ├─ time-context-web-example.e2e.ts
   ├─ web-example-driver.ts
   └─ web-example.patch.yml
```

**启用（长期推荐：profile 层）**
- 本机：把下列内容写入 `$DSH_HOME/profiles/web/cordis.patch.yml`（web profile `patchReload: live`，保存即热生效，重启/任何启动方式均生效）：

```yaml
- insert:
    - id: time-context
      name: '@deepseek-ai/dsh-time-context'
      config:
        timeZone: Asia/Shanghai
```

- 命令行临时：`dsh web --patch plugins/time-context/cordis.patch.yml`
- launcher（`start-dsh-web.bat` / `tools/dsh-offline-installer/installer.py`）已指向本目录 patch 作兜底，并在 profile 层已启用时自动跳过（防双挂）。

**现状 / 验证记录**
- 已在真实 Web 会话验证：每步模型请求前出现 durable 读数，浏览器时区正确解析（Asia/Shanghai），多步骤逐步注入、耗时基线正常；细节与读数示例见 `docs/time-context-clock-feature.md`。
- 回归证据原为仓库 keyless loader-smoke e2e（headless shipped profile + mock LLM：浏览器时区优先 + 回退 Asia/Shanghai），现存放于 `reference/`；如需在仓库内复跑，按原布局临时放回 `packages/context/time-context/tests/` 后执行 `pnpm exec vitest run --config vitest.e2e.config.ts time-context`（跑完记得清理）。

**注意**
- 上游刻意默认不挂（披露/历史成本属组合策略），本项目不修改任何 shipped 组合。
- 每步注入历史成本可后续用 `refreshIntervalMs` 节流。
