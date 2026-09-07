# session-preset-migrate（会话预设迁移工具）

把**已开始的旧会话**指向另一个 agent preset（例如把 cordis 会话迁到 `cordis-director`，让旧会话的压缩座位变 director、获得引擎热切能力）。

## 原则（按用户要求钉死）

- **只备份/只修改文件，绝不整目录**。会碰到的只有：
  1. `<DSH_HOME>/sessions/<workspace>/<id>/session.jsonl.zstd` —— 仅第 0 帧（header 帧）里的 `agentPreset`；其余帧字节原样不动，第 0 帧用与产品相同参数（带校验和）重压；
  2. `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`（存在时）—— 仅 `agentPreset.val`。
- 会话目录里其它任何文件一概不读不写不备份。
- 每次注入先备份上述两个文件到 `<DSH_HOME>/_session-preset-backup/<时间戳>--<id>/`（含 manifest.json），可 `restore` 还原。
- 非产品支持路径：属数据手术，操作前请备份整个 profile（可选），并先在**不重要的会话**上实验。

## 用法（Node ^22.19 或 >=24，node:zlib 自带 zstd，零依赖）

```powershell
node migrate.mjs list                      # 列出会话 + 各自 header/cache 里的 preset（只读）
node migrate.mjs inject <sessionId> <presetId> --dry-run   # 预览：将改哪些值、备份哪些文件
node migrate.mjs inject <sessionId> <presetId>             # 正式：备份 -> 注入两处 -> 自校验
node migrate.mjs verify <sessionId>                        # 复查当前两处取值
node migrate.mjs restore <备份目录>                        # 从某次备份把两个文件拷回
```

注入后：**重启 dsh web**，该会话会按新 header 重新挂载到目标 preset（恢复路径无锁校验）。

## 前置

目标 preset 必须已存在且可被 roster 发现（本地副本放 `<DSH_HOME>/.agent-presets/<id>/`）。
示例目标：`cordis-director`（shipped cordis 的本地副本，压缩组引擎行换成 `@dsh-user/compaction-director`）。

## 并入小助手（离线安装器）规划

该能力拟作为 tools/dsh-offline-installer 小助手「插件页」的一个动作：列出本机会话 -> 选择目标 preset -> 一键「备份 + 注入 + 校验」+ 提示重启；因小助手不依赖 DSH 运行时，可在 DSH 停止时操作。
本目录的 `migrate.mjs` 即其执行内核（纯 Node、无 DSH 依赖）。

## 已知边界

- session id 跨 workspace 重名时拒绝并提示。
- header 无 `agentPreset` 或缓存无对应条目时中止（不猜测）。
- 改完若产品侧投影/校验与手改缓存不符，产品会以日志重建——此时值仍收敛到新 preset；如遇异常，`restore` 一键还原。
