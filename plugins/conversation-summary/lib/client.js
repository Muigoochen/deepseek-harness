// conversation-summary — browser half. 设置页「会话压缩」配置驾驶舱。
//
// 产物契约(dsh.client closure-factory, 同 toast):
//   - 本文件即最终产物, 零构建; id 必须精确等于包名 '@dsh-user/conversation-summary';
//   - 运行期只 require 平台种子 'react', 不 import 模块表外的任何 @deepseek-ai 值;
//   - inject=['slots']。
//
// 行为:
//   - 注册进 settings.section(加性 list, root 级)渲染一个完整设置页;
//   - GET  /conversation-summary/config   读宿主当前生效配置(只读真源);
//   - POST /conversation-summary/policy   把当前草稿渲染成策略文案预览(文案单源在宿主);
//   - 所有开关/数值都是"草稿" -> 实时生成 YAML 片段供复制到 cordis.patch.yml;
//   - 宿主配置保存即热应用(live); 新装/本界面自身需刷新或重启 dsh web 后出现。

window.__ModuleLoader__.load({
  id: '@dsh-user/conversation-summary',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')

    // ---------- 样式(插件自持, 卸载即移除) ----------
    var STYLE_TEXT = [
      '.cs-panel{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;color:var(--dsw-color-text,#1f2328);}',
      '.cs-meta{display:flex;flex-wrap:wrap;gap:8px;}',
      '.cs-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12px;background:rgba(128,128,128,.12);}',
      '.cs-chip.cs-warn{color:#b45309;}',
      '.cs-card{border:1px solid var(--dsw-color-border,rgba(128,128,128,.25));border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;}',
      '.cs-card h3{margin:0;font-size:13px;font-weight:600;}',
      '.cs-card p{margin:0;color:var(--dsw-color-text-secondary,rgba(31,35,40,.75));font-size:12px;}',
      '.cs-row{display:flex;align-items:center;justify-content:space-between;gap:12px;}',
      '.cs-row .cs-lbl{flex:1;min-width:0;}',
      '.cs-row .cs-lbl b{display:block;font-weight:500;}',
      '.cs-row .cs-lbl span{display:block;color:var(--dsw-color-text-secondary,rgba(31,35,40,.7));font-size:12px;}',
      '.cs-field{display:flex;align-items:center;gap:6px;}',
      '.cs-num{width:110px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-color-border,rgba(128,128,128,.35));background:var(--dsw-color-bg-elevated,#fff);color:inherit;font-size:12px;}',
      '.cs-seg{display:inline-flex;border:1px solid var(--dsw-color-border,rgba(128,128,128,.35));border-radius:8px;overflow:hidden;}',
      '.cs-seg button{border:0;background:transparent;color:inherit;padding:4px 12px;font-size:12px;cursor:pointer;}',
      '.cs-seg button.cs-on{background:rgba(59,130,246,.16);color:#1d4ed8;}',
      '.cs-switch{position:relative;width:36px;height:20px;flex:none;}',
      '.cs-switch input{position:absolute;inset:0;opacity:0;cursor:pointer;}',
      '.cs-switch .cs-track{position:absolute;inset:0;border-radius:999px;background:rgba(128,128,128,.3);transition:background .15s ease;}',
      '.cs-switch .cs-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.3);}',
      '.cs-switch input:checked + .cs-track{background:#3b82f6;}',
      '.cs-switch input:checked + .cs-track + .cs-thumb{transform:translateX(16px);}',
      '.cs-text{width:100%;box-sizing:border-box;min-height:64px;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-color-border,rgba(128,128,128,.35));background:var(--dsw-color-bg-elevated,#fff);color:inherit;font-size:12px;font-family:inherit;resize:vertical;}',
      '.cs-code{width:100%;box-sizing:border-box;min-height:120px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-color-border,rgba(128,128,128,.25));background:rgba(128,128,128,.08);color:inherit;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;overflow:auto;}',
      '.cs-btn{padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-color-border,rgba(128,128,128,.4));background:var(--dsw-color-bg-elevated,#fff);color:inherit;font-size:12px;cursor:pointer;}',
      '.cs-btn.cs-primary{background:#3b82f6;border-color:#3b82f6;color:#fff;}',
      '.cs-error{color:#dc2626;font-size:12px;}',
      '@media (prefers-color-scheme: dark){.cs-num,.cs-text,.cs-code{background:#23262d;color:#e8e8ea;}}',
    ].join('\n')

    function installStyles() {
      var el = document.createElement('style')
      el.setAttribute('data-conversation-summary-styles', 'true')
      el.textContent = STYLE_TEXT
      document.head.appendChild(el)
      return function removeStyles() {
        if (el.parentNode) el.parentNode.removeChild(el)
      }
    }

    // ---------- 与宿主通信 ----------
    function httpJson(url, method, body) {
      return fetch(url, {
        method: method || 'GET',
        cache: 'no-store',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(function (res) {
        return res.json().catch(function () { return null })
      }).catch(function () { return null })
    }

    function readConfig() {
      return httpJson('/conversation-summary/config', 'GET').then(function (data) {
        return data && data.ok ? data : null
      })
    }

    function renderPolicy(draft) {
      return httpJson('/conversation-summary/policy', 'POST', draft).then(function (data) {
        return data && data.ok ? data.text : null
      })
    }

    function saveConfig(draft) {
      return httpJson('/conversation-summary/config', 'POST', draft)
    }

    // ---------- YAML 片段生成(草稿 -> 可粘贴 patch 行; 文案未改则省略=用默认) ----------
    function buildYaml(d, base) {
      var lines = []
      lines.push('- insert:')
      lines.push('    - id: conversation-summary')
      lines.push("      name: '@dsh-user/conversation-summary'")
      lines.push('      config:')
      lines.push('        absoluteBudgetTokens: ' + d.budget)
      lines.push('        retainTokens: ' + d.retain)
      lines.push('        budgetScope: ' + d.budgetScope)
      lines.push('        mode: ' + d.mode)
      lines.push('        hintEnabled: ' + d.hintEnabled)
      lines.push('        planExit: ' + d.planExit)
      lines.push('        freeform: ' + d.freeform)
      lines.push('        toolEnabled: ' + d.toolEnabled)
      lines.push('        promptEnabled: ' + d.promptEnabled)
      lines.push('        promptOrder: ' + d.promptOrder)
      lines.push('        logDecisions: ' + d.logDecisions)
      var copyKeys = ['askOverBudget', 'askPlanExit', 'askFreeform', 'autoFreeform']
      for (var i = 0; i < copyKeys.length; i += 1) {
        var key = copyKeys[i]
        var val = d[key] || ''
        if (typeof base === 'object' && base !== null && base[key] === val) continue
        lines.push('        ' + key + ': ' + JSON.stringify(val))
      }
      lines.push(d.policyText.trim().length > 0
        ? '        policyText: ' + JSON.stringify(d.policyText)
        : '        # policyText: ""  // 留空 = 按上方开关与文案自动拼装')
      return lines.join('\n')
    }

    // ---------- 小组件 ----------
    function Switch(props) {
      return React.createElement('label', { className: 'cs-switch' }, [
        React.createElement('input', {
          key: 'in',
          type: 'checkbox',
          checked: props.checked,
          onChange: props.onChange,
        }),
        React.createElement('span', { key: 'track', className: 'cs-track' }),
        React.createElement('span', { key: 'thumb', className: 'cs-thumb' }),
      ])
    }

    function Seg(props) {
      var buttons = []
      for (var i = 0; i < props.options.length; i += 1) {
        var opt = props.options[i]
        buttons.push(React.createElement('button', {
          key: opt.value,
          type: 'button',
          className: props.value === opt.value ? 'cs-on' : '',
          onClick: function (value) {
            return function () { props.onChange(value) }
          }(opt.value),
        }, opt.label))
      }
      return React.createElement('div', { className: 'cs-seg' }, buttons)
    }

    function Row(props) {
      var label = React.createElement('div', { className: 'cs-lbl' }, [
        React.createElement('b', { key: 't' }, props.title),
        React.createElement('span', { key: 'd' }, props.desc),
      ])
      return React.createElement('div', { className: 'cs-row' }, [label, props.control])
    }

    // ---------- 设置页 ----------
    function initialDraft(effective) {
      return {
        budget: effective.budget,
        retain: effective.retain,
        budgetScope: effective.budgetScope,
        mode: effective.mode,
        hintEnabled: effective.hintEnabled,
        planExit: effective.planExit,
        freeform: effective.freeform,
        toolEnabled: effective.toolEnabled,
        promptEnabled: effective.promptEnabled,
        promptOrder: effective.promptOrder,
        logDecisions: effective.logDecisions,
        policyText: effective.policyText || '',
        askOverBudget: effective.askOverBudget || '',
        askPlanExit: effective.askPlanExit || '',
        askFreeform: effective.askFreeform || '',
        autoFreeform: effective.autoFreeform || '',
      }
    }

    function PolicyPanel() {
      var state = React.useState({ loaded: false, error: null, draft: null, base: null, preview: '', yaml: '', copied: false, saving: '' })
      var set = function (patch) { state[1](function (s) { return Object.assign({}, s, patch) }) }

      // 装载: 读宿主当前生效配置
      React.useEffect(function () {
        var alive = true
        readConfig().then(function (data) {
          if (!alive) return
          if (data === null) {
            set({ loaded: true, error: '读取宿主配置失败(插件未激活? 需重启 dsh web)' })
            return
          }
          var draft = initialDraft(data.effective)
          set({ loaded: true, draft: draft, base: data.effective, error: null })
        })
        return function () { alive = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // 草稿变化 -> 防抖渲染策略预览(带过期/卸载护栏)
      React.useEffect(function () {
        var s = state[0]
        if (!s.loaded || !s.draft) return
        var alive = true
        var timer = setTimeout(function () {
          renderPolicy(s.draft).then(function (text) {
            if (!alive) return
            set({ preview: text === null ? '(预览渲染失败)' : text })
          })
        }, 120)
        return function () { alive = false; clearTimeout(timer) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [state[0].loaded, state[0].draft])

      // 自动保存: 草稿变化 -> 防抖写 cordis.patch.yml(宿主热应用, 无需重启)。
      // 首帧装载不算改动; 保存成功后把 base 同步为新 effective, 避免把未改的文案当自定义写回。
      var firstDraft = React.useRef(true)
      React.useEffect(function () {
        var st = state[0]
        if (!st.loaded || !st.draft) return
        if (firstDraft.current) { firstDraft.current = false; return }
        var alive = true
        var timer = setTimeout(function () {
          set({ saving: 'saving' })
          saveConfig(st.draft).then(function (data) {
            if (!alive) return
            if (data === null || !data.ok) {
              var msg = (data && data.error) || '未知错误'
              set({ saving: 'error:' + msg })
              return
            }
            set({ base: data.effective || st.draft, saving: 'saved' })
            setTimeout(function () { if (alive) set({ saving: '' }) }, 1600)
          })
        }, 450)
        return function () { alive = false; clearTimeout(timer) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [state[0].loaded, state[0].draft])

      var s = state[0]
      if (s.error) {
        return React.createElement('div', { className: 'cs-panel' },
          React.createElement('div', { className: 'cs-error' }, s.error))
      }
      if (!s.loaded || !s.draft) {
        return React.createElement('div', { className: 'cs-panel' }, '加载中…')
      }
      var d = s.draft
      var patch = function (p) {
        set({ draft: Object.assign({}, d, p), copied: false })
      }
      var yaml = buildYaml(d, s.base)
      var budgetOk = Number.isSafeInteger(d.budget) && d.budget > 0
      var retainOk = Number.isSafeInteger(d.retain) && d.retain >= 0 && d.retain < d.budget
      var draftValid = budgetOk && retainOk
      var invalidNote = !budgetOk
        ? '预算须为正整数(>0)；当前输入非法。'
        : '保留尾部须为 ≥0 且小于预算；当前输入非法。'
      var saveChip = s.saving === 'saving'
        ? React.createElement('span', { key: 's', className: 'cs-chip' }, '自动保存中…')
        : s.saving === 'saved'
          ? React.createElement('span', { key: 's', className: 'cs-chip' }, '已自动保存生效 ✓')
          : s.saving && s.saving.indexOf('error:') === 0
            ? React.createElement('span', { key: 's', className: 'cs-chip cs-warn' }, '自动保存失败：' + s.saving.slice(6))
            : null
      var meta = React.createElement('div', { className: 'cs-meta' }, [
        React.createElement('span', { key: 'g', className: 'cs-chip' }, '全局生效(所有会话)'),
        React.createElement('span', { key: 'a', className: 'cs-chip' }, '改动即自动保存+热应用(无需重启)'),
        saveChip,
        React.createElement('span', { key: 'w', className: 'cs-chip cs-warn' }, '本界面代码更新后需刷新页面一次'),
      ])

      function copyYaml() {
        if (!draftValid) return
        function done() { set({ copied: true }); setTimeout(function () { set({ copied: false }) }, 1500) }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(yaml).then(done, done)
        } else {
          try {
            var ta = document.createElement('textarea')
            ta.value = yaml
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            document.body.removeChild(ta)
            done()
          } catch (e) { done() }
        }
      }

      return React.createElement('div', { className: 'cs-panel' }, [
        meta,
        React.createElement('p', { key: 'intro', style: { margin: 0 } },
          '本页是会话压缩(总结)插件的配置驾驶舱：只统计"对话本体"(checkpoint 总结 + 未总结历史，不含系统提示与动态注入)。'
          + '任何改动都会在 0.5 秒内自动保存到 ~/.dsh/profiles/web/cordis.patch.yml 并热应用(无需重启 dsh web)，'
          + '面板关掉再开也保持你的设置。下方 YAML 为当前生效片段的参考/手动备份。'),

        React.createElement('div', { key: 'budget', className: 'cs-card' }, [
          React.createElement('h3', null, '预算口径与数值'),
          Row({
            title: 'absoluteBudgetTokens（跨过即触发）',
            desc: '对话内容估算 ≥ 该值进入"超预算"状态。',
            control: React.createElement('input', {
              className: 'cs-num', type: 'number', step: 1000, min: 1000,
              value: String(d.budget),
              onChange: function (e) { patch({ budget: Number(e.target.value) }) },
            }),
          }),
          Row({
            title: 'retainTokens（压缩后保留的最近尾部）',
            desc: '必须小于预算。尾部内的内容不会被压缩。',
            control: React.createElement('input', {
              className: 'cs-num', type: 'number', step: 1000, min: 0,
              value: String(d.retain),
              onChange: function (e) { patch({ retain: Number(e.target.value) }) },
            }),
          }),
          Row({
            title: 'budgetScope（预算口径）',
            desc: 'conversation=对话本体(默认)；envelope=完整请求信封(含系统提示/工具/动态注入)。',
            control: Seg({
              value: d.budgetScope,
              onChange: function (v) { patch({ budgetScope: v }) },
              options: [
                { value: 'conversation', label: 'conversation(推荐)' },
                { value: 'envelope', label: 'envelope' },
              ],
            }),
          }),
        ]),

        React.createElement('div', { key: 'mode', className: 'cs-card' }, [
          React.createElement('h3', null, '处理方式（先问还是直接压）'),
          React.createElement('p', null, 'mode 决定"超过预算/plan 结束"怎么处理：先询问你（hint），还是由插件直接压缩（auto，不经 AI）。"自由讨论收尾"两种 mode 下都需要 agent 参与。'),
          Row({
            title: 'mode',
            desc: 'hint=到点先询问你、你同意才压；auto=到点直接压，不再询问。',
            control: Seg({
              value: d.mode,
              onChange: function (v) { patch({ mode: v }) },
              options: [
                { value: 'hint', label: 'hint 先询问' },
                { value: 'auto', label: 'auto 直接压' },
              ],
            }),
          }),
          Row({
            title: 'hintEnabled（询问提醒）',
            desc: '选"先询问"时有效：到点时把该时机的"先询问文案"注入给 agent 让它来问你；每轮最多提醒一次，压缩后重置。',
            control: Switch({
              checked: d.hintEnabled,
              onChange: function (e) { patch({ hintEnabled: e.target.checked }) },
            }),
          }),
          Row({
            title: 'toolEnabled（compact_conversation 工具）',
            desc: '压缩/算账工具：estimate 看能省多少 / auto 直接压 / ask 先征求你。你直接说"总结一下"也走它。',
            control: Switch({
              checked: d.toolEnabled,
              onChange: function (e) { patch({ toolEnabled: e.target.checked }) },
            }),
          }),
          Row({
            title: 'logDecisions（诊断日志）',
            desc: '默认关：宿主日志不打印判定过程（要排查时打开，能看到每次判定与跳过原因；GET /conversation-summary/diagnostics 始终可用，不受此开关影响）。',
            control: Switch({
              checked: d.logDecisions,
              onChange: function (e) { patch({ logDecisions: e.target.checked }) },
            }),
          }),
        ]),

        React.createElement('div', { key: 'over', className: 'cs-card' }, [
          React.createElement('h3', null, '对话内容超过预算（始终触发）'),
          React.createElement('p', null, '选"直接压(auto)"时，由插件在下一步开始前直接压缩，压缩引擎会自己产出 checkpoint 文案——无需 agent 话术，所以这里只有"先询问"文案。'),
          React.createElement('label', null, [
            '先询问文案（mode=hint 时注入给 agent，让它来问你；留空 = 用默认文案）',
            React.createElement('textarea', {
              key: 'o1', className: 'cs-text', rows: 2,
              value: d.askOverBudget,
              onChange: function (e) { patch({ askOverBudget: e.target.value }) },
            }),
          ]),
        ]),

        React.createElement('div', { key: 'planexit', className: 'cs-card' }, [
          React.createElement('h3', null, 'plan 模式结束时触发'),
          React.createElement('p', null, '选"直接压(auto)"时由插件直接压缩（不经 AI），这里同样只有"先询问"文案。'),
          Row({
            title: '启用（planExit）',
            desc: '用 plan 模式做计划时：退出 plan 模式（批准、取消、关闭都算）就当作这轮计划讨论结束，按上方 mode 先问你或直接压；对话量没到预算也会触发。',
            control: Switch({
              checked: d.planExit,
              onChange: function (e) { patch({ planExit: e.target.checked }) },
            }),
          }),
          React.createElement('label', null, [
            '先询问文案（mode=hint 时注入给 agent，让它来问你；留空 = 用默认文案）',
            React.createElement('textarea', {
              key: 'p1', className: 'cs-text', rows: 2,
              value: d.askPlanExit,
              onChange: function (e) { patch({ askPlanExit: e.target.value }) },
            }),
          ]),
        ]),

        React.createElement('div', { key: 'freeform', className: 'cs-card' }, [
          React.createElement('h3', null, '自由讨论收尾时触发'),
          Row({
            title: '启用（freeform）',
            desc: '没用 plan 模式、对话量也还没到预算时：方向/细节聊完、准备给实现方案的那一刻，可把前面的讨论整理压缩。收尾时刻没有自动信号，由 agent 判断，再按上方 mode 先问你或直接压。',
            control: Switch({
              checked: d.freeform,
              onChange: function (e) { patch({ freeform: e.target.checked }) },
            }),
          }),
          React.createElement('label', null, [
            '先询问文案（mode=hint：agent 判断到收尾时按此先问你；留空 = 用默认文案）',
            React.createElement('textarea', {
              key: 'f1', className: 'cs-text', rows: 2,
              value: d.askFreeform,
              onChange: function (e) { patch({ askFreeform: e.target.value }) },
            }),
          ]),
          React.createElement('label', null, [
            '直接压文案（mode=auto：agent 判断到收尾时按此直接压；留空 = 用默认文案）',
            React.createElement('textarea', {
              key: 'f2', className: 'cs-text', rows: 2,
              value: d.autoFreeform,
              onChange: function (e) { patch({ autoFreeform: e.target.value }) },
            }),
          ]),
        ]),

        React.createElement('div', { key: 'prompt', className: 'cs-card' }, [
          React.createElement('h3', null, '常驻策略提示词（写进每次请求的话术）'),
          React.createElement('p', null, '默认按当前 mode 自动拼装：hint=超预算、plan 结束、自由收尾各一条（都让 agent 先问你）；auto=超预算与 plan 结束由插件直接压（固定说明，不经 AI），自由收尾用"直接压"指引。可用 policyText 整段替换。'),
          Row({
            title: 'promptEnabled（注入到每次请求）',
            desc: '把处理方式与文案写进每次模型请求，让 agent 按设定行事；关掉则不注入。',
            control: Switch({
              checked: d.promptEnabled,
              onChange: function (e) { patch({ promptEnabled: e.target.checked }) },
            }),
          }),
          Row({
            title: 'promptOrder（排序值）',
            desc: '越大越靠后；与其它动态上下文冲突时再调。',
            control: React.createElement('input', {
              className: 'cs-num', type: 'number', step: 100,
              value: String(d.promptOrder),
              onChange: function (e) { patch({ promptOrder: Number(e.target.value) }) },
            }),
          }),
          React.createElement('label', null, [
            'policyText（整段自定义；一旦填写就完全替代上方自动拼装。占位符：{budget} {retain} {mode} {planExit} {freeform}，后两个替换为 开启/关闭）',
            React.createElement('textarea', {
              key: 't', className: 'cs-text', rows: 3,
              placeholder: '留空 = 自动拼装',
              value: d.policyText,
              onChange: function (e) { patch({ policyText: e.target.value }) },
            }),
          ]),
          React.createElement('label', null, [
            '实时预览（当前草稿会注入的文案）',
            React.createElement('pre', {
              key: 'p', className: 'cs-code', rows: 8,
            }, s.preview === '' ? '（计算中…）' : s.preview),
          ]),
        ]),

        React.createElement('div', { key: 'yaml', className: 'cs-card' }, [
          React.createElement('h3', null, '当前生效配置片段（自动保存已开启；复制仅作手动备份/迁移用）'),
          !draftValid
            ? React.createElement('div', { key: 'verr', className: 'cs-error' }, invalidNote + ' 已禁用复制。')
            : null,
          React.createElement('pre', { className: 'cs-code', rows: 12 }, yaml),
          React.createElement('div', { key: 'btns', className: 'cs-row' }, [
            React.createElement('button', {
              className: 'cs-btn cs-primary', type: 'button',
              disabled: !draftValid,
              onClick: copyYaml,
            }, s.copied ? '已复制 ✓' : '复制 YAML'),
            React.createElement('span', { style: { fontSize: 12 } },
              '宿主配置保存即生效(live)；新装/客户端界面需重启或刷新页面。'),
          ]),
        ]),

        React.createElement('p', { key: 'note', style: { margin: 0, fontSize: 12, opacity: .75 } },
          '说明：宿主级插件对所有会话生效（含子代理会话），无法按单个会话单独开关；'
          + '压缩本体走原生 compaction 引擎，checkpoint 模板暂为内置英文结构。'),
      ])
    }

    // ---------- 插件装载 ----------
    function apply(ctx) {
      var slots = ctx.get('slots')
      if (!slots) return
      ctx.effect(function () {
        var removeStyles = installStyles()
        var removeInjection = slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'conversation-summary', order: 25, label: function () { return '会话压缩' } },
            PolicyPanel,
          )
        })
        return function cleanup() {
          if (typeof removeInjection === 'function') removeInjection()
          if (typeof removeStyles === 'function') removeStyles()
        }
      })
    }

    exports.name = 'conversation-summary'
    exports.inject = ['slots']
    exports.apply = apply

    return module.exports
  },
})
