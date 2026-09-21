# toast 设计文档

仓库级、可复用的**浮动提示(浮窗/Toast)静态插件**。任何正式功能(如 lsp-echo 的全量编译扫描)
需要"弹一条提示给用户"时,直接调用本插件提供的 API,不各自写弹窗脚本。

## 1. 背景与需求

- 痛点:产品 GUI 没有浮窗提示能力;各功能要提示就得自己造轮子(如 lsp-echo 目前用
  "往对话里塞消息"代替,既不浮层也不美观)。
- 目标:
  1. **一个可复用浮窗设施**:GUI(浏览器半)渲染 + 逻辑(Host 半)提供调用 API;
  2. **其它插件拿来即用**:`lsp-echo` 的"首次全量扫描开始/完成"改成浮窗提示;
  3. **稳定分界**:GUI 与公共 API 长期不变;只有"Host→页面 传输方式"允许后期替换。
- 约束(纯插件守则):不改仓库任何产品/底层源码;不重建仓库产物;机器状态落 `$DSH_HOME`;
  装载走用户 profile 层(patch 行),同 lsp-echo 范式。

## 2. 为什么是"双半区 + 一条自建传输"而不是产品推送

- 产品唯一的 Host→页面主动推送是 **Remote Event 转发**,且话题是仓库内**编译期白名单**
  (`packages/api/remotes/src/remote-events.ts` 的 `API_REMOTE_FORWARDED_EVENTS`,18 项,
  `as const`)。运行期**没有注册新话题的接口**,加话题 = 改仓库源码 + 重建。禁止。
- 因此本插件在两半之间**自建一条事件长询通道**(见 §5),零仓库改动即可获得"近似推送"体验;
  该通道是**插件内部细节**,GUI 与公共 API 不感知。

## 3. 架构总览

```
【稳定层:调用方】lsp-echo 等宿主插件
   toast.show({kind,title,body,...}) / toast.dismiss(id?)      ← 公共 API 永不改
                 │(Host 半区 ctx.provide('toast', api))
                 ▼
【稳定层:逻辑】toast Host 半 lib/index.js
   事件队列(seq 递增) + dismiss + list
                 │  transport(可替换,见 §5)
                 ▼
【稳定层:GUI】toast 浏览器半 lib/client.js
   注册 shell.overlay(id: 'toast-stack') → 右上角堆叠浮窗
   长询取队列 → 渲染 → 自动消失/悬停暂停/手动关闭
```

分界原则:**调用方只认识 `toast.show/dismiss`;GUI 只消费"队列条目";两半之间只依赖
一条抽象传输**。将来产品开放正式推送口时,只换传输两端实现,其余不动。

## 4. 公共 API 契约(Host 半区服务 `toast`)

```ts
// 其它宿主插件:inject: ['toast'] 或 ctx.get('toast') 后调用
toast.show(request: {
  kind?: 'info' | 'success' | 'warning' | 'error'   // 默认 'info'
  title?: string
  body?: string              // title/body 至少一项
  durationMs?: number        // 默认 4000;0 = 常驻(不自动消失)
  closable?: boolean         // 默认 true;悬停暂停倒计时
  id?: string                // 幂等:同 id 顶掉旧条目
}): { seq: number }          // 入队序号(JSON)

toast.dismiss(id?: string): { dismissed: number }   // 缺省 = 清空
toast.list(): { events: Array<...> }                // 只读查看(调试/测试)
```

约束:入队成功才返回;队列只在"有浏览器在等"时被消费,无页面打开时条目不丢
(有界,见 §5)。API 面与 UI 之间只传 JSON 叶子字段。

## 5. transport(唯一允许后期替换的层)

现状 = **HTTP 事件长询**(伪推送):

```
Host 半:webServer.register({kind:'exact', path:'/toast/events', handler})
        handler:队列非空 → 立即应答 JSON;为空 → 挂起等待,事件到达/超时(约25s)再答
Client 半:fetch('/toast/events?since=<lastSeq>') 循环 —— 答完立刻重挂
        应答:200 {"events":[ {seq,kind,title,body,durationMs,closable,id} ... ]}
        seq 去重;空闲空答/断网 → 稍候(≤1s)自动重挂
```

- 证据(已核实):`ctx.webServer.register` 接受任意绝对 pathname;handler 拥有完整响应
  生命周期、**可挂起**(类型 JSDoc 点名 SSE),无服务端超时层;不同 path 多插件并存;
  `inject: ['webServer']` 直接可用。静态 client 模块以经典 `<script>` 跑在页面作用域,
  `fetch`/`setInterval` 全可用、无 CSP;静态 ctx **没有** `timer` 服务 → 用浏览器定时器 +
  `ctx.effect` 清理。
- 挂起连接用集合管理,`res.on('close')` 移除;插件卸载时 destroy 全部挂起连接(ctx.effect 清理)。
- 路径避让 `/api`(connection 独占)与 `/plugins`(modules 前缀表),不带头尾斜杠。
- 未来替换(预留,不实现):产品若开放 allowlist 推送,transport 换成 `$on` 订阅,契约不变。

## 6. GUI 规格

- 注册:`slots.inject('shell.overlay', () => slots.register({name:'shell.overlay', id:'toast-stack', order:…}, Comp))`。
  `shell.overlay` 为 root 级 list 槽(加性、点击穿透,条目自开交互),当前无静态占用。
- 位置:右上角纵向堆叠;卡片 ~320px;容器 `pointer-events:none`,卡片 `auto`。
- 类型四色:info/success/warning/error,用主题 CSS 变量取色(不硬编码 hex)。
- 行为:进入动画;自动消失倒计时(悬停暂停);手动关闭按钮;`role=status`(error 用 `role=alert`)。
- 样式:插件自持 `<style>` 标签,卸载时移除;组件一律 `React.createElement`。
- 不引入 action 按钮等复杂交互(V1);需要时在 GUI 内扩展,API 加 `action:{label}`。

## 7. 目录结构与文件清单(零构建)

产物格式自包含(closure-factory CJS),**无需 tsdown/仓库工具链**,源码即最终文件:

```
plugins/toast/
├─ package.json            @dsh-user/toast;dsh.client{platform:'web'};exports{'.'→lib/index.js,'./client'→lib/client.js}
├─ README.md
├─ docs/design.md          本文件
├─ lib/
│  ├─ index.js             Host 半(node):name/inject=['webServer','tools']/apply → 队列+toast 服务+长询路由
│  └─ client.js            浏览器半:closure-factory(window.__ModuleLoader__.load({id:'@dsh-user/toast',factory}))
│                          inject=['slots'] → shell.overlay 注册 + fetch 长询 + 渲染
└─ install/
   ├─ install.ps1          用 `dsh plugin` 链入 profile + 自检
   ├─ uninstall.ps1        逆操作
   └─ patch.example.yml    profile 层覆盖行示例
```

浏览器半规则(已核实):`load({id})` 的 id **必须等于包名**;运行时只 `require('react')`
(平台种子),零 `@deepseek-ai/*` value import;不 import 表外模块;source map 省略(有
identity 兜底)。Host 半不写 default export(会丢 inject)。

## 8. 装载(长期)

```powershell
powershell -ExecutionPolicy Bypass -File ...\plugins\toast\install\install.ps1
# 重启 dsh web 生效
```

install.ps1 只有一步:`dsh plugin --profile web add <本包路径>` 把包链到
`$DSH_HOME\profiles\web\node_modules\@dsh-user\toast`(指回本仓库的 junction),并把包登记进
profile 的 `dsh.profile.bundles`。插件行由包根的 `cordis.patch.yml` 作为 bundle 层提供,
一行同时带来 Host 半与 client 模块(dsh.client 扫描同一行);机器本地覆盖写
`$DSH_HOME\profiles\web\cordis.patch.yml`(同 id 后应用、覆盖 bundle 层)。

**先本地验证再上 patch 行**:client.js 格式/缺包会 fail-loud(整棵 Web 树启动失败),故
先在本机 profile 外手动核对产物与包名,确认无误再执行安装/重启。

## 9. 与 lsp-echo 的对接(契约)

lsp-echo 侧(后续单独做):
- 首次全量扫描开始:`toast.show({kind:'info', body:'正在做首次全量编译诊断(约1分钟),完成后会提示。'})`;
- 完成:`toast.show({kind: 有错?'warning':'success', body:'首次全量诊断完成:…'})`;
- 其 pre-step "塞消息"播报停用,改为上述调用(注意:模型侧如需保留扫描结果可见,
  可在注入层另行保留最小摘要——属 lsp-echo 自己的设计决策)。

## 10. 已知边界 / 待办

- transport 为插件内部实现,后期可换(§5);GUI/API 不动。
- 多开页面:每个页面独立挂长询,Host 扇出同一批事件到所有挂起连接。
- 无页面打开期间的条目:有界保留(如最近 50 条),首个页面挂上即补发。
- action 按钮、位置/主题可配置、settings 面板:按需追加。
- 生产化时若放弃"零构建",可改用 tsdown 复刻产物契约(配方见调研),本目录现以手写为准。
