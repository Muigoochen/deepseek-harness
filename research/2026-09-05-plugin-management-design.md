# 插件管理/生命周期设计笔记（两轮评审后事实沉淀）

> 日期：2026-09-05。主题：小助手（tools/dsh-offline-installer）插件管理区的概念模型、机制事实与设计评审结论。
> 关联：`tools/dsh-offline-installer/docs/插件管理-设计.md`（方案正文 + v0.2/v0.3/v0.4 修订节，**v0.4 起为唯一有效方案**）。
> 非官方权威；引用前以当时源码为准。

## 1. 概念模型（下载→安装→使用，已与用户对齐）

- 下载 = 产物进入项目/离线资产（产品无感知）；安装 = 注册进组合层（组合清单出现该插件行）且包可解析；启用 = 装载运行（apply 注册）；停用 = disabled:true；卸载 = 删行。
- 关键澄清："文件在项目里 ≠ 产品认识它"，必须有组合行；组合行与可解析位是两件事，缺一启动即报错。

## 2. 机制事实（两轮评审代码核实）

- 层序与后层覆盖：`bundles < profiles/<p>/cordis.patch.yml < $DSH_HOME/cordis.patch.yml < --patch overlay`，后层可 disable/config 前层同一 id 的行（applyEntryPatches）。
- web profile 热应用：`patchReload='live'`，cordis.patch.yml 保存即被 watcher 热应用；**新行引用从未解析过的包也能运行期挂载**（Entry._init 在 create/update 时 import，无启动白名单；前提=刷新瞬间目录已可解析）；**已装载插件同路径代码升级不重载**（config-only HMR + ESM loadCache）→ 需重启；热应用失败软失败（旧树保留，文件与运行树分叉）；客户端半需刷新页面。
- 冷启动补丁解析失败 = 硬失败（boot 抛错退出）。
- `dsh web --dump-config`：存在、免启动、覆盖 bundle+profile+home+--patch，与装载共用 entryListSchema；**但不 eval `!!js`、不 import 模块、不捕获"未命中 id 覆盖行"的 warn** → 只算"结构门"，拦不住"可解析但装不起来"。
- 用户补丁清单可含第一方行（现网已有 `@deepseek-ai/dsh-time-context`）与 id-target override；可管理单元收窄为"顶层无 id 的 `- insert:` 且子条目 `name=='@dsh-user/<目录名>'`"；flow/别名/引号/`!!js`/group 嵌套/注释归属都是识别与解析的边界（fail-loud 拒改）。
- `@dsh-user` 共享目录是各 profile/home 解析锚（有的内含运行态）；`--patch` overlay 路径静态不可枚举 → 卸载引用扫描有残余盲区（保守规则：疑似引用即保留）。
- 卸载删目录顺序：先删行（等热应用）→ 停 web → 删目录。
- 校验正确姿势：结构门（写后 dump + .bak 回滚）+ 激活门（重启 + 健康检查 + 回滚重启）；"先校验后热应用"时序不存在（watcher 在 rename 瞬间触发），回滚本身也是一次热应用。

## 3. 评审结论时间线（供后查）

- 一轮评审：带条件 Go；推翻"重启才生效"（web live）、"整份清单可接管"（第一方行/override）、"纯文本行编辑安全"等假设 → v0.3 节。
- 二轮评审：带条件批准；修正 dump-config 被高估为激活闸门、卸载扫描盲区、热应用边界、状态判定冲突、识别算法边界、分层文档残留 → v0.4 节 + 本文件。
- 开工前 must-fix 6 条与合并版大纲（§0-§9）见设计文档 v0.4。

## 4. 尚不落地的部分（按用户要求"不着急落地"）

- 小助手插件区实现、下载中心、config 深度编辑、外部"接管"、产品内管理插件，均待后续确认后分阶段实施（v0.1→v0.3 见设计文档）。

## 5. 专项调查：插件"启用"路径风险边界（2026-09-05，代码逐段核实）

> 由子代理对 识别→校验→装载→apply→运行→停用/卸载→热应用→client可见 全路径产出 19 项风险 R1-R19 与信号/对策（详细证据表与逐项策略见设计文档 v0.5 与当轮报告文本）。

- **关键发现(区别于前两轮)**：
  - 热应用失败=整世代回滚(软)，同批正确改动陪葬；热路径 inject 缺失行=**静默 PENDING**、disable 提供者→依赖者**静默级联停摆**（热路径无审计，冷启动才有 `N entries did not activate`）——这是"用户以为启用、实际没跑"的主要静默盲区。
  - 补丁目标未命中(id 不符/name 不匹配)=**仅 warn 静默跳过**（R3），但 `--dump-config` 走同一算法会打 warn → 可把 dump 当 R3 探测门。
  - 同路径宿主代码升级不热载(config-only HMR + ESM loadCache)→必须重启；改 lib/client.js 可走 client-hmr 但需页面已开且该行已存在。
  - client 半免构建直服 lib/client.js；新 client 行需整页刷新才可见；缺 client.js 冷启动聚合硬失败。
  - `!!js` disabled/config = `with(ctx) eval`；插件=任意本地代码执行，无签名/完整性校验——信任即边界（R17）。
- **策略落点**：已并入 `tools/dsh-offline-installer/docs/插件管理-设计.md` v0.5（风险×对策表 19 项 + 健康检查信号规范 + P0/P1/P2 护栏 + 待实测清单）。实施时 plugin_store/UI/DOC 各自承接，产品缺口（R9/R5/R11 热态、R15、R16、R17）如实标注、不假装在助手层解决。
