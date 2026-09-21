# workspace-files 开发路线（纯插件，交接用）

> 供新对话续作。先读 `plugins/workspace-files/README.md` 与 `docs/feasibility.md`，再按本文件执行。
> 铁律：**不修改仓库任何 tracked 产品/底层源码**；本目录（`plugins/workspace-files/`）是所有自定义脚本/文档的单一归属。

## 0. 背景与已发生的事（会话历史摘要）

- 初始以动态 Cordis 插件（`ftree-1`）验证了需求：侧边栏抽屉内的「文件树 + 对话」折叠 + 拖拽把文件/文件夹拖进输入框插入引用。动态原型代码为内存态，**进程重启即失**（现已无留档），正式包按社区范式重写。
- 中途误将"开始实施"理解为改仓库产品源码，执行了 M1–M4 仓库改造；用户明确要求**纯插件**后，已全部回滚并复核（`git status` 相关路径无残留）。
- 可行性调研（`docs/feasibility.md`）确认：不改仓库源码可通过用户 profile 通道长期装载自定义 Web 客户端插件。**本机已在用该通道**（`@dsh-user/toast`、`@dsh-user/lsp-echo`、`@dsh-user/conversation-summary` 均经 `cordis.patch.yml` 装入，含浏览器半先例 toast/conversation-summary）。

## 1. 目标形态与验收

- 名称/包：`@dsh-user/workspace-files`（插件 id：`workspace-files`），源码在本目录。
- 浏览器 UI（与 ftree-1 行为一致）：
  1. 侧边栏底部（`sidebar.footer.action`）开关 + 浮层（`shell.overlay`）：可切换工作区，主体为「文件树 / 对话」两个可折叠子级；
  2. 文件树懒加载、隐藏/排除目录过滤、按 WorkspaceId 记忆展开态（localStorage）；
  3. 拖拽行到输入框（`conversation.input.overlay` 落点）→ 插入 `@相对路径` 文本（空格自动引号）；跨工作区降级绝对路径。
- 长期性验收：**dsh 重启 + 页面刷新后依然自动出现**，无需逐次批准。
- 边界（诚实声明）：拖拽插入是 `@路径` 文本（与模型侧语义一致），不是结构化 chip 高亮（那需要产品输入 seam，纯插件不做）；内置"工作区浏览区就地两分支"做不到，形态为旁挂浮层。

## 2. 装载通道与数据通道（均已实证）

- **装载**：本包作为 bundle 贡献 `cordis.patch.yml` 行（`- insert: {id: workspace-files, name: '@dsh-user/workspace-files'}`）；包本体经 `dsh plugin --profile web add` 链在 `C:\Users\kelei\.dsh\profiles\web\node_modules\@dsh-user\workspace-files\`（该路径是指回本仓库的 junction，不是副本）。`profiles\node_modules\@dsh-user\` 下那份是早期"复制包"脚本的遗留物，安装器不再使用。profile `patchReload: live`，但新装 client 模块需重启 `dsh web`（或至少重载页面）生效。
- **数据通道（§4.1/4.2 结论：自建同源 HTTP 路由）**：
  - 产品 Host→页面推送话题是**编译期白名单**（`API_REMOTE_FORWARDED_EVENTS`），运行期无注册口 → 不可用。
  - 社区范式（toast/conversation-summary 实证）：节点半 `ctx.webServer.register({kind:'exact', path, handler})` + 浏览器半同源 `fetch`。路径避让 `/api`、`/plugins`。
  - 本插件节点半路由：`GET /workspace-files/list?ws=<workspaceId>&path=<posix-rel|空>` → `workspaceRegistry.get(ws).path` 为根，`fs.resolve/listDir` 列一层，JSON `{path, rel, root, entries:[{name,type:'file'|'directory'|'other',size?}]}`（目录优先排序）；越界/未知 ws → 4xx。
  - 契约依据：`FsDirEntry{name,type,target,size?}`、`Workspace{id,path,title,sessionIds,...}`、`fs.contains/processPath/resolve/listDir`。
- **构建形态（零构建）**：跟随先例（toast/conversation-summary），`lib/*.js` 即最终产物：
  - `lib/index.js`：ESM named export `name/inject/apply`，不写 default export；
  - `lib/client.js`：`window.__ModuleLoader__.load({id:'@dsh-user/workspace-files', factory:(require)=>{...}})` 闭包工厂 CJS，id 必须等于包名，运行期只 `require('react')`（可加平台种子，见 feasibility 边界；不要 import 表外模块）；`exports.name/inject=['slots']/apply`；静态 ctx **没有** `timer` 服务 → 浏览器定时器 + `ctx.effect` 清理。

## 3. 实施步骤（每步含验收）

### Step 0（已完成）确认目标 profile 身份
- `DSH_HOME=C:\Users\kelei\.dsh`；正在跑 GUI = `profiles\web`（bundle dsh-base + dsh-web-app，patch 行含 time-context/lsp-echo/toast/conversation-summary，与本会话运行插件一致）；用户包经 `dsh plugin` 链在 `profiles\web\node_modules\@dsh-user\`（junction 指回各插件仓库）；`patchReload: live`。
- 重启窗口：安装后需用户重启 `dsh web`（会打断当前会话进程，会话持久可续），与用户对时。

### Step 1 包源码（本目录内，零构建）
- 结构：
  ```
  plugins/workspace-files/
    package.json          @dsh-user/workspace-files; dsh.client{platform:'web'}; exports{'.'→lib/index.js,'./client'→lib/client.js}
    README.md
    docs/feasibility.md
    docs/ROADMAP.md        (本文件)
    lib/
      index.js            Host 半(node):name/inject=['webServer','workspaceRegistry','fs']/apply → /workspace-files/list 路由(已完成)
      client.js           浏览器半:三洞注册(抽屉/树/拖拽) + fetch 列举(待写,依赖子代理产物)
    install/
      install.ps1 / uninstall.ps1 / patch.example.yml
  ```
- 浏览器半关键约束：`ctx.slots.inject(seat, () => slots.register({name: seat, id, order}, Comp))`；组件纯 props（静态 ctx 同产品 ctx 纪律：数据经 props/框架 hooks 到达）；样式内联 `<style>`，卸载移除；文案内联中文（用户插件不自注册产品 locale）。

### Step 2 安装
- 执行 `install\install.ps1`（幂等：`dsh plugin --profile web add` 链入 profile + 自检）。

### Step 3 重启验证
- 与用户对时后重启 `dsh web` → 验收：长期自动出现、开关/树/拖拽可用、刷新+重启均生效。
- 卸载方式写进 README（`uninstall.ps1`：`dsh plugin remove` + 删 profile patch 行；**不对 node_modules 做递归删除**，那是指回仓库的 junction）。

### Step 4 文档与清理
- 完成 README（安装/使用/卸载/配置）；
- 停用或删除对照原型 `ftree-1`（已随进程消失，无需清理）；
- 清理历史 Agent Note（`.agents/notes/proposed/feature/2026-09-04-web-workspace-file-trees.*`，迁移/删除，须用户同意）。

## 4. 开放问题（历史结论 + 遗留）

1. ~~数据通道~~ → **已定案**：自建同源 HTTP 路由（见 §2）。目录列举含文件 ✓；跨工作区由浏览器按 session→workspace 映射选择根。
2. ~~host RPC 可用性~~ → 不需要：数据走 webServer 路由，浏览器半 `fetch` 即可，与动态插件无关。
3. **工作区/会话的客户端数据来源**（浏览器半如何拿到 workspace 列表/当前会话/根映射）：待 R1/R2 子代理研究回报（store hooks 形状、session→workspace→root 映射字段）。
4. **输入插入接缝**：拖拽落点插入 `@相对路径` 的精确调用（setDraft/事件/编辑器句柄），`@` 语法引号规则：待 R2 回报后按其推荐的公开途径实现；无公开途径时采用原型验证过的 window-capture DROP 拦截。
5. 历史 Agent Note 三件套的去留：建议迁移摘要进本目录后删除（待用户同意）。

## 5. 新对话第一动作清单（本阶段）
1. 等 R1/R2 研究回报（座位 props cookbook / 输入插入+drop+@语法）；回报入库后依其写 `lib/client.js`；
2. `node --check` 两份 lib + selfcheck；与用户对时重启窗口；
3. 安装 → 重启 → 验收；README/uninstall 收尾。
