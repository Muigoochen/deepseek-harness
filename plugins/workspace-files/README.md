# workspace-files（纯插件）

Web 侧边栏**工作区文件树 + 拖拽引用**插件。

**路线承诺（用户要求，务必遵守）**
- 纯插件开发：**不修改仓库任何底层/产品源码与原始脚本**（历史误改的 M1–M4 已全部回滚并复核）。
- 本目录是所有相关脚本/文档的单一归属；其它插件各自放 `plugins/<name>/`。

## 这是什么

- 侧边栏底部开关（`sidebar.footer.action`）→ 浮出抽屉（`shell.overlay`）：
  - 顶部切换工作区；主体为「对话 / 文件树」两个可折叠子级；
  - 文件树**懒加载**、目录优先排序、按工作区独立记忆展开态（localStorage）；
  - 过滤开关：显示隐藏文件 / 含排除目录（`node_modules/.git/dist/build/…`）；
- 拖拽文件/目录行到输入框（`conversation.input.overlay` 落点）→ 在草稿末尾追加
  `@相对路径`（含空格自动加引号、目录带尾斜杠）；跨工作区/不可 mention 时降级为绝对路径文本。

**形态边界（诚实声明）**
- 内置「工作区浏览区」没有插件可用作"中部加区块"的座位，插件为旁挂浮层；
- 拖拽插入的是 `@路径` **文本**（模型侧语义与产品 `@` 语法一致）；结构化 chip 高亮需要产品输入 seam，纯插件不做。

## 实现形态（与仓库社区插件一致，零构建）

- `lib/index.js`（Host 半）：自建同源 HTTP 路由
  `GET /workspace-files/list?ws=<workspaceId>&path=<posix-rel|空>` →
  `workspaceRegistry` 取根 + `fs.resolve/listDir` 列一层，越界/未知工作区 4xx。
- `lib/client.js`（浏览器半）：`window.__ModuleLoader__.load` 闭包工厂 CJS，只 `require('react')`；
  三个插槽注册 + fetch 列举 + 窗口捕获层 drop 拦截（自定义 MIME `application/x-dsh-ftree` +
  落在 `[data-composer-card]` 内才截断）→ `inputActions.setDraft` 追加文本。
- 为什么不改产品源码：产品 Host→页面推送话题是编译期白名单、运行期无注册口；目录含文件
  的列举也无公开 client API → 用社区先例（toast/conversation-summary）的"节点半自建 webServer
  路由 + 浏览器半 fetch"通道。详见 `docs/feasibility.md` 与 `docs/ROADMAP.md`。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File plugins\workspace-files\install\install.ps1
# 然后刷新页面或重启 dsh web 生效(host 半经 patchReload:live 热载;client 半需页面重载)
```

install.ps1 用 DSH 官方方式安装本包（幂等）：① `dsh plugin --profile web add <本包路径>`，由它把包链入
profile 并登记为依赖与 bundle；**不再复制文件**，安装后 profile 通过 `link:` 指向本目录，改完源码直接生效；
② 自检：导入宿主半，并按浏览器半的规则解析 `lib/client.js`（浏览器半只能是脚本，`node --check` 直接检查
`.js` 会被 `"type": "module"` 放过）。

本包贡献的配置层在包根的 `cordis.patch.yml`（一行同时带来 Host 半与 client 模块，`dsh.client` 扫描同一行）；
profile 自己那份 `$DSH_HOME\profiles\web\cordis.patch.yml` 在同 id 上后应用、会覆盖它，机器本地设置写在那里。

## 使用

1. 点侧边栏底部的 📁 打开抽屉；
2. 顶部 chip 切换工作区；「对话」列出该工作区会话（点按打开）；「文件树」懒展开目录；
3. 勾选「显示隐藏 / 含排除目录」控制可见性；展开/切换状态自动记忆；
4. 拖拽任意文件或目录到下方输入框，松手即插入 `@相对路径` 引用。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File plugins\workspace-files\install\uninstall.ps1
# 重启 dsh web 生效
```

## 验证

```powershell
node --check plugins\workspace-files\lib\index.js
node --check plugins\workspace-files\lib\client.js
node plugins\workspace-files\tools\smoke.mjs   # 装载/插槽注册冒烟
```

## 状态与 TODO

- [x] 调研并确认用户级装载通道（`docs/feasibility.md`）
- [x] 数据通道定案：节点半自建 HTTP 路由列目录（含文件）
- [x] Host 半 `lib/index.js`；浏览器半 `lib/client.js`；安装/卸载脚本；冒烟
- [ ] 安装进 profile 并重启/刷新验证（长期自动出现 + 拖拽插入）
- [ ] 真人验收打磨（交互/样式/文案）
- 历史：原仓库产品化实施方案的 Agent Note 留档于 `.agents/notes/proposed/feature/2026-09-04-web-workspace-file-trees.*`（仅文档，待迁移/清理）。
