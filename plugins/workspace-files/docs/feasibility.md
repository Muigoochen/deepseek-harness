# 可行性调研结论：不改仓库源码长期装载 Web 客户端插件

调研于 2026-09-04 对本仓库源码只读完成。结论：**可行**，推荐"用户 profile 层"装载，零 tracked 源码改动。

## 结论要点

- **动态插件（ftree-1）不能当长期方案**：宿主定义仅存进程内存（dsh 重启即清）、页面激活不写盘、刷新不恢复、每次运行需人工批准。
- **可行通道（首选）**：在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加一行 `dsh.client` 插件，包名指向装在 `$DSH_HOME/profiles/web/node_modules` 的自有 npm 包；client-modules 节点半增量扫描后把该行编入 `__DSH_BOOT__.plugins`，浏览器引导自动装载其 `lib/client.js`，与产品插件同待遇（启动即装、无需批准）。
- **次选（旁挂）**：profile 内一个宿主 node 插件经 `ctx.webServer.register` + `webserver/index-inject` 注入自包含 `<script>`；但拿不到壳内 react/cordis，无法注册产品 slot。
- **不可行（不改仓库）**：替换 boot/index 入口、给冻结模块表加种子词、把外部代码静态并入 shell chunk——这三类需求才需要动仓库。
- **复用边界**：浏览器半只能 `require` 模块表种子（react 家族、cordis、client-store、ui-slots、ui-primitives）与图内其它行；跨功能产品包值导入本来就不开放。UI 协作走产品公开 slot 与 ctx 服务。

## 启用步骤（全部落在 DSH_HOME / plugins 目录）

1. 源码放本目录 `plugins/workspace-files/`（集中管理），构建产物是一个自定义 npm 包：
   - `package.json`：`name`（如 `@dsh-user/workspace-files`）、`dsh: { client: { platform: 'web' } }`、`exports['./client']`；
   - node 半 `lib/index.js`：空 `apply`（宿主 loader 行必须可导入激活）；
   - 浏览器半 `lib/client.js`：工厂形 CJS（`window.__ModuleLoader__.load({ id, factory })`），外部化 8 个种子词 + cordis。
2. 装入用户 profile：`$DSH_HOME/profiles/web/node_modules/@dsh-user/workspace-files/`（复制或 pnpm 安装）。
3. `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：
   ```yaml
   - insert:
     - id: workspace-files
       name: '@dsh-user/workspace-files'
   ```
4. 重启 `dsh web`（或热改 patch 后刷新页面）。此后每次启动即长期装载。

本机环境：`DSH_HOME = C:\Users\kelei\.dsh`，已存在 `profiles\web\`。

## 实施 TODO
- [ ] 把 `ftree-1` 原型代码转写为正式 dsh.client 包源码（挂已实证的三洞：footer action / overlay / input overlay）
- [ ] 构建工厂形 `lib/client.js`（含 seeds 外部化）
- [ ] 安装到 `profiles/web/node_modules` + patch 行
- [ ] 重启 `dsh web` 验证长期装载与拖拽插入
- [ ] 编写 install/使用说明（README）

边界说明：拖拽插入为 `@相对路径` 文本（模型侧语义一致）；结构化 chip 高亮需产品输入 seam，纯插件不做。
