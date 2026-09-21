# toast

仓库级、可复用的**浮动提示(Toast)静态插件**:任何正式功能(如 lsp-echo 的全量编译扫描)
需要"给用户弹一条提示"时,调用本插件,不各自写弹窗脚本。

- **逻辑脚本(Host 半)** `lib/index.js`:公共 API `toast.show/dismiss/list` + 事件长询路由;
- **GUI 脚本(浏览器半)** `lib/client.js`:注册进产品预留的 `shell.overlay` 全局浮层槽位,
  右上角渲染浮窗堆栈(四类型/自动消失/悬停暂停/可关闭)。
- **纯插件守则**:不改仓库任何产品/底层源码,不重建仓库产物,零构建(产物即源码),
  机器状态只落 `$DSH_HOME` 与进程内存。

## 其它插件怎么用

```js
// 宿主插件:声明后直接调用(provider 未装载时 cordis 会自动挂起等待)
export const inject = ['toast']
// apply(ctx) 内:
ctx.toast.show({ kind: 'info', body: '正在做首次全量编译诊断,约 1 分钟…' })
ctx.toast.show({ kind: 'success', body: '首次全量诊断完成:0 个编译错误' })
ctx.toast.dismiss()            // 清空
```

契约:show 的 `kind` ∈ info|success|warning|error;`title`/`body` 至少一项;`durationMs`
默认 4000(0 = 常驻);`closable` 默认 true;`id` 幂等(同 id 顶掉旧条)。详见
`docs/design.md` §4。

## 目录结构

```
plugins/toast/
├─ package.json            @dsh-user/toast(dsh.client{platform:'web'},零构建)
├─ README.md               本文件
├─ docs/design.md          设计文档(背景/架构/契约/transport/边界)
├─ lib/
│  ├─ index.js             Host 半(逻辑脚本):toast 服务 + 队列 + /toast/events 长询路由
│  └─ client.js            浏览器半(GUI 脚本):closure-factory,shell.overlay 浮窗 + fetch 长询
└─ install/
   ├─ install.ps1          装入 profile + 幂等加 patch 行
   ├─ uninstall.ps1        逆操作
   └─ patch.example.yml    行示例
```

## 安装(每台机器一次)

```powershell
powershell -ExecutionPolicy Bypass -File E:\Deepseek\deepseek_harness\plugins\toast\install\install.ps1
# 重启 dsh web 后生效
# 卸载:
powershell -ExecutionPolicy Bypass -File E:\Deepseek\deepseek_harness\plugins\toast\install\uninstall.ps1
```

install.ps1 会:
1. 把包复制到 `$DSH_HOME\profiles\node_modules\@dsh-user\toast\`;
2. 在 `$DSH_HOME\profiles\web\cordis.patch.yml` 幂等追加一行
   `- id: toast / name: '@dsh-user/toast'`(该行同时带起 Host 半与 GUI 半)。

## 验证

1. 装完重启后,浏览器打开任意工作区页面,页面应无报错;
2. 用浏览器开发者工具执行(或等 lsp-echo 接入后自然触发):
   ```js
   fetch('/toast/events?since=0').then(r => r.json()).then(console.log) // 空队列 → {events:[]}
   ```
3. 手工触发一条:让任一宿主插件 `ctx.toast.show({...})`,右上角应浮出提示并按时消失;
   或临时用模型工具/`curl` 打到任意宿主事件调试(见 docs/design.md §5)。

> 注意:先确保 `lib/client.js` 与 `lib/index.js` 已就位再重启(`lib/client.js` 缺失会导致
> Web 组合启动失败——fail-loud)。可运行 `npm run selfcheck` 做本地格式自检。

## 行为细节(2026-09-04/05 修)

- **dismiss 会真正"关掉"已显示的浮窗(含常驻条)**:移除必须以**新事件**下发,因为已显示的
  客户端早就 ack 了原 seq——Host 半追加一条带 `removedSeq:[原seq]` 的新事件并立即推给长询;
  浏览器半按 `removedSeq` 找到对应条(含 `durationMs:0` 常驻条)执行退出移除。
  同 id 顶替(show 同 id)也会先发一次 removedSeq 再发新条。
- **刷新浏览器不再重播旧弹窗**:浏览器半把已消费的最大 `seq` 记在 `sessionStorage`
  (`toast-last-seq`),页面刷新后从该位置续拉,host 内存队列里的事件不会重复弹出。
- **Host 重启自动续拉**:每次应答带 `maxSeq`;若 host 重启导致序列重置(小于客户端记忆值),
  客户端清掉记忆并重新从 0 同步(只重放 host 重启后的新队列)。

## 配置

无(全部行为走调用参数)。队列上限 200、长询空答超时 20s 等内部常量见 `lib/index.js`,如需
可配置化按需追加(遵循"无硬编码 tunable"约定)。
