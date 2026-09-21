# compaction-director（引擎总机）— P0 spike 说明

座 `ctx.compaction` 的派发器：按会话把压缩委托给官方摘要引擎（basic）或即时无损引擎（instant，VCC 编译）。

## 挂载形态（唯一合法形态）

作为 preset 压缩组的引擎行安装，包名用**本人命名空间**：

```yaml
# 在某个 preset（通常复制一份本地 preset）的压缩组 isolate 内：
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-director
      name: '@dsh-user/compaction-director'   # 替换原 '@deepseek-ai/dsh-compaction-basic' 行
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

行 config 支持 `defaultEngine` / `engines`（sessionId→'basic'|'instant'）/ `debug`；其它键（官方引擎遗留键）被静默忽略，避免带配置的 preset 挂载失败。

安装 = 把包放进 `profiles/node_modules/@dsh-user/compaction-director`（本人命名空间）。官方引擎由代码 `import('@deepseek-ai/dsh-compaction-basic')` 直接按名导入——它解析到共享镜像的官方 junction，无需改名副本、不会自递归。

> ⚠️ 从 shipped `cordis` 复制预设时，**删掉其中的 `tool-cordis`（@deepseek-ai/dsh-tool-cordis）裸行**再改引擎行。该行把 inspect provider 注册进进程全局 realm，第二个 cordis 系会话（本副本或 shipped cordis）与已在跑的 cordis 会话并存时会撞车：`failed to apply loader entry tool-cordis … inspect provider "Service" is already registered`，并且曾表现为浏览器 `commands/list` 无限刷新的报错风暴。engine 实验不需要动态 cordis 工具；要用 cordis 工具请回 plain `cordis` 预设（同一进程只开一个 cordis 系会话）。

## 运行时热切换（无需重启）

写 `$DSH_HOME/compaction-director.json`（本机：`C:\Users\<you>\.dsh\compaction-director.json`），每次派发实时读取：

```json
{ "default": "basic", "engines": { "<session-id>": "instant" } }
```

- `default`：全局默认；`engines`：按会话覆盖（优先级最高）。
- 不建文件 = 全部 basic；删除某会话条目即回默认。

## ⚠️ 事故记录（2026-09-06，必须遵守）

- **禁止**手工往 `profiles/node_modules/@deepseek-ai/*` 写入实体包目录（包括"改名副本"与"占位回滚"）。该目录是 boot **自愈的共享模块 fallback 镜像**：每次 profile 装配（`composeProfile` → `healProfilesModuleFallback`）会把闭包内的包恢复成 junction / `dsh.moduleFallback` proxy；遇到既非 junction 又无标记的实体目录会 **fail-loud 抛错**（`…exists and is not a symlink or dsh-managed module proxy; remove it…`），导致 `dsh web` 启动失败。
- 踩坑记录：把 director alias 放到官方名、把官方复制为 `-official` → 启动与结构门双双报错；现场已由 boot 自愈修复（官方名重建 junction），残留备份在 `C:\Users\kelei\.dsh\_spike_backup_20260906\`。
- 回滚/修复一律走：**删掉 `@deepseek-ai` 下的实体占位 → 重启让 boot 重建 junction**；不要手动 rename/复制回填。
- 若某天要"顶替官方名"，只能走**受管安装**（`dsh plugin`，由安装器决定 junction/proxy 形态），且与镜像自愈的兼容性需先实测——不作为默认路线。

## 仓库参考文件

- `presets/director-test.agent.cordis.yml`：standard 副本示例（压缩组引擎行换成 director），供建本地测试预设用。
- 代码 `lib/index.js` 只 import `@deepseek-ai/dsh-compaction`（基类）并在运行期按名导入两个子引擎包——不写任何 `@deepseek-ai` 实体。

## P0 记录

- ✅ 子引擎 `auto:false`；Service 同名注册用 `ctx.isolate('compaction', label)` 隔离。
- ✅ 官方 basic（按名导入）与 instant（`dsh-compaction-instant`）从运行位可解析。
- ⏳ 运行态待验（走 director-test 本地 preset 的新会话）：preset 引擎行挂载 director 成功；basic 子引擎委托可压缩；`compaction-director.json` 热切到 instant；checkpoint 形态差异。
- ❌ 形态 2「别名占位官方包名」已废弃（共享镜像机制不允许手工占位）。
