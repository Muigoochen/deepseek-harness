// lsp-echo — browser half. 项目诊断的 GUI 脚本(零构建,toast/workspace-files 同款静态插件)。
//
// 产物契约(dsh.client closure-factory):
//   - 本文件即最终产物,零构建;id 必须精确等于包名 '@dsh-user/lsp-echo';
//   - 运行期只 require 平台种子 'react',不 import 模块表外的任何 @deepseek-ai 值;
//   - inject=['slots'];静态 ctx 没有 'timer' 服务 → 定时一律用浏览器 setTimeout;
//   - 组件是纯 props;会话级槽(conversation.session.header.utilities)会给标准 seats:
//     sessionId + useSessions(byId[id].cwd 即会话目录),workspace-files 同款用法已实测;
//   - 跨洞共享状态(浮层开关/当前项目)用 module 级 signal,与 workspace-files 一致;
//   - 与 Host 半通信用 fetch('/lsp-echo/api?action=…'),host 路由已实现(projects/status/
//     host/stop/baseline/diagnostics)。
//
// 行为:
//   - 会话头部 utilities 加 lsp-echo 图标:当前会话 cwd 命中已注册项目时显示,
//     角标 = 该项目最近一次诊断的错误数(红)或 0(绿),hover 显路径;
//   - 点图标 → shell.overlay 弹项目诊断浮层:标题+引擎状态徽章+工具条(刷新/全量重扫/
//     停启引擎),主区按文件分组列出 error/warning(gdshader 带 engine_note 角标);
//   - 浮层打开期间每 3s 静默刷新摘要(角标与列表保持一致);手动刷新立刷。
//
// React 纪律:条件渲染拆「外层订阅 + 内层实体」,保证每个挂载组件每次渲染 hooks 数一致。

window.__ModuleLoader__.load({
  id: '@dsh-user/lsp-echo',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    try { console.log('[lsp-echo] client half loaded at', new Date().toISOString()) } catch (e) { /* ignore */ }

    var React = require('react')

    // ---------- 常量 ----------
    var API = '/lsp-echo/api'
    var REFRESH_MS = 3000

    // ---------- module 级 signal(多洞共享) ----------
    function createSignal(initial) {
      var value = initial
      var subs = []
      return {
        get: function () { return value },
        set: function (next) {
          if (next === value) return
          value = next
          var list = subs.slice()
          for (var i = 0; i < list.length; i++) list[i](value)
        },
        subscribe: function (fn) {
          subs.push(fn)
          return function () {
            var i = subs.indexOf(fn)
            if (i !== -1) subs.splice(i, 1)
          }
        },
      }
    }
    // { path } — 当前打开的浮层项目;点击图标时记录按钮锚点用于定位
    var panelSignal = createSignal(null)
    var panelAnchor = { left: 0, top: 0, right: 0, bottom: 0 } // 最后一次打开的图标 rect

    function useSignal(signal) {
      var pair = React.useState(signal.get())
      var value = pair[0]
      var setValue = pair[1]
      React.useEffect(function () { return signal.subscribe(setValue) }, [signal])
      return value
    }

    // ---------- 样式 ----------
    var STYLE_TEXT = [
      // 会话头部图标
      '.lspi-trigger{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:inherit;cursor:pointer;padding:3px 5px;border-radius:6px;line-height:1;position:relative;font-size:13px;}',
      '.lspi-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));}',
      '.lspi-glyph{font-style:normal;font-weight:700;font-size:12px;opacity:.9;}',
      '.lspi-badge{position:absolute;top:-5px;right:-7px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:#ef4444;color:#fff;font-size:9px;font-weight:700;line-height:14px;text-align:center;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1,#fff);}',
      '.lspi-badge.lspi-ok{background:#22c55e;}',
      '.lspi-badge.lspi-none{display:none;}',
      // 浮层
      '.lspi-panel{position:fixed;width:440px;max-width:calc(100vw - 16px);max-height:calc(100vh - 24px);display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.18);font-size:13px;line-height:1.5;z-index:2147483001;overflow:hidden;margin:0;}',
      '.lspi-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));}',
      '.lspi-title{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.lspi-mode{flex:none;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));}',
      '.lspi-mode.lspi-editor{border-color:#22c55e;color:#15803d;}',
      '.lspi-mode.lspi-headless{border-color:#3b82f6;color:#1d4ed8;}',
      '.lspi-mode.lspi-off{opacity:.6;}',
      '.lspi-x{flex:none;border:0;background:transparent;color:inherit;cursor:pointer;font-size:16px;line-height:1;padding:2px 5px;border-radius:6px;opacity:.65;}',
      '.lspi-x:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));}',
      '.lspi-tools{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));flex-wrap:wrap;}',
      '.lspi-btn{flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;color:inherit;cursor:pointer;font-size:12px;padding:3px 9px;border-radius:7px;}',
      '.lspi-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
      '.lspi-btn:disabled{opacity:.5;cursor:default;}',
      '.lspi-sum{flex:1;min-width:0;text-align:right;font-size:12px;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.lspi-body{flex:1;min-height:0;overflow:auto;padding:6px 0 10px;}',
      '.lspi-status{padding:18px 14px;text-align:center;opacity:.65;font-size:13px;}',
      '.lspi-file{margin:4px 8px 0;}',
      '.lspi-fname{display:flex;align-items:center;gap:6px;padding:4px 6px;font-weight:600;border-radius:6px;cursor:pointer;}',
      '.lspi-fname:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.lspi-fcaret{flex:none;width:10px;text-align:center;opacity:.55;font-size:10px;}',
      '.lspi-fpath{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;}',
      '.lspi-fcount{flex:none;font-size:11px;opacity:.6;}',
      '.lspi-item{display:flex;gap:8px;padding:3px 6px 3px 22px;border-radius:6px;align-items:flex-start;}',
      '.lspi-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));}',
      '.lspi-dot{flex:none;width:7px;height:7px;margin-top:6px;border-radius:50%;}',
      '.lspi-dot.lspi-err{background:#ef4444;}',
      '.lspi-dot.lspi-warn{background:#f59e0b;}',
      '.lspi-msg{flex:1;min-width:0;word-break:break-word;}',
      '.lspi-msg .lspi-loc{opacity:.55;font-size:11px;margin-right:4px;}',
      '.lspi-note{margin:4px 8px 0 22px;padding:4px 8px;font-size:11px;border-radius:6px;background:rgba(128,128,128,.08);opacity:.75;}',
      '.lspi-empty{padding:24px 16px;text-align:center;opacity:.65;}',
      // 设置页
      '.lspi-set{display:flex;flex-direction:column;gap:14px;padding:16px;font-size:13px;line-height:1.5;}',
      '.lspi-set h3{margin:0 0 6px;font-size:13px;font-weight:600;}',
      '.lspi-set p{margin:0;}',
      '.lspi-set-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;padding:12px;}',
      '.lspi-set-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));}',
      '.lspi-set-row:last-child{border-bottom:0;}',
      '.lspi-set-path{flex:1;min-width:0;font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;}',
      '.lspi-set-src{flex:none;font-size:11px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));}',
      '.lspi-set-btn{flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:transparent;color:inherit;cursor:pointer;font-size:12px;padding:2px 8px;border-radius:6px;}',
      '.lspi-set-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
      '.lspi-set-btn:disabled{opacity:.5;cursor:default;}',
      '.lspi-set-btn.danger{color:#dc2626;}',
      '.lspi-set-input{flex:1;min-width:0;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font-size:12px;}',
      '.lspi-set-select{padding:3px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font-size:12px;}',
      '.lspi-set-hint{font-size:12px;opacity:.7;}',
      '.lspi-set-err{color:#dc2626;font-size:12px;}',
      // 设置页 v2:项目卡片 + LSP chips
      '.lspi-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}',
      '.lspi-card-head{display:flex;align-items:center;gap:8px;min-width:0;}',
      '.lspi-card-title{flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;}',
      '.lspi-card-sub{font-size:11px;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,Consolas,monospace;direction:rtl;text-align:left;margin-left:0;}',
      '.lspi-src{flex:none;font-size:11px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));}',
      '.lspi-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}',
      '.lspi-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));border-radius:999px;padding:2px 8px;font-size:12px;max-width:100%;}',
      '.lspi-chip-name{font-weight:600;}',
      '.lspi-chip-ext{opacity:.6;font-size:11px;}',
      '.lspi-chip-x{border:0;background:transparent;color:inherit;cursor:pointer;opacity:.55;padding:0 1px;font-size:13px;line-height:1;}',
      '.lspi-chip-x:hover{opacity:1;color:#dc2626;}',
      '.lspi-chip-add{display:inline-flex;align-items:center;gap:3px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.25));background:transparent;border-radius:999px;padding:2px 8px;font-size:12px;cursor:pointer;color:inherit;}',
      '.lspi-chip-add:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
      '.lspi-chip-add.sel{border-style:solid;border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.35));}',
      '.lspi-card-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.lspi-empty-lsp{font-size:12px;opacity:.55;font-style:italic;}',
      '.lspi-global-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));}',
    ].join('\n')

    function installStyles() {
      var el = document.createElement('style')
      el.setAttribute('data-lspi-styles', 'true')
      el.textContent = STYLE_TEXT
      document.head.appendChild(el)
      return function removeStyles() {
        if (el.parentNode) el.parentNode.removeChild(el)
      }
    }

    // ---------- transport ----------
    function httpGet(url) {
      if (typeof fetch === 'function') {
        return fetch(url, { cache: 'no-store' }).then(function (res) {
          return res.json()
        }).catch(function () { return null })
      }
      return new Promise(function (resolve) {
        try {
          var xhr = new XMLHttpRequest()
          xhr.open('GET', url)
          xhr.onload = function () {
            try { resolve(xhr.status >= 200 && xhr.status < 300 ? JSON.parse(xhr.responseText) : null) }
            catch (e) { resolve(null) }
          }
          xhr.onerror = function () { resolve(null) }
          xhr.send()
        } catch (e) { resolve(null) }
      })
    }
    function apiGet(action, project, extra) {
      var q = API + '?action=' + encodeURIComponent(action)
      if (project) q += '&project=' + encodeURIComponent(project)
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) q += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(String(extra[k]))
        }
      }
      return httpGet(q)
    }

    // 判定 cwd 是否落在某已注册项目内(取最近匹配的 project 记录)。
    function resolveProjectForCwd(cwd, onDone) {
      if (!cwd) { onDone(null); return }
      apiGet('projects').then(function (data) {
        if (!data || data.ok !== true || !Array.isArray(data.projects)) { onDone(null); return }
        var normalized = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        var best = null
        var bestLen = -1
        for (var i = 0; i < data.projects.length; i++) {
          var p = data.projects[i]
          if (!p || !p.path) continue
          var pp = String(p.path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
          if (normalized === pp || normalized.indexOf(pp + '/') === 0) {
            if (pp.length > bestLen) { best = p; bestLen = pp.length }
          }
        }
        onDone(best ? { path: best.path, engine: best.engine || 'godot-lsp', source: best.source } : null)
      })
    }

    // 拉取一个项目的诊断摘要(可能 empty)。
    function loadDiagnostics(project, onDone) {
      if (!project) { onDone(null); return }
      apiGet('diagnostics', project).then(function (d) {
        if (!d || d.ok !== true) { onDone(null); return }
        onDone(d) // {summary, files, updated_at, empty}
      })
    }

    // 扁平错误计数(供角标):summary 优先,files 兜底。
    function errorCount(data) {
      if (!data) return -1 // 未知
      if (data.empty) return 0
      if (data.summary && typeof data.summary.errors === 'number') return data.summary.errors
      return 0
    }

    // ============================================================
    // 组件 1:会话头部图标(当前会话 cwd 命中项目时显示)
    // ============================================================
    function HeaderIcon(props) {
      var sessionId = props.sessionId
      // 标准订阅 hook(useSessions)必须在渲染顶层调用:订阅会话 cwd 快照,
      // 会话数据变化(切换/载入)时本组件自动重渲染,effect 随之重跑。
      var cwd = undefined
      try {
        if (props.useSessions && sessionId && typeof props.useSessions === 'function') {
          cwd = props.useSessions(function (s) { return s && s.byId ? s.byId[sessionId].cwd : undefined })
        }
      } catch (e) { cwd = undefined }

      var pair = React.useState(null) // {path, engine} | null
      var known = pair[0]
      var setKnown = pair[1]
      var diagPair = React.useState(null) // diagnostics payload
      var diag = diagPair[0]
      var setDiag = diagPair[1]

      // cwd → 项目判定 + 首次拉诊断
      React.useEffect(function () {
        setKnown(null)
        setDiag(null)
        resolveProjectForCwd(cwd, function (hit) {
          setKnown(hit)
          if (hit) loadDiagnostics(hit.path, setDiag)
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [cwd])

      // 项目已知后,定期刷新角标摘要(轻量)
      var knownPath = known ? known.path : null
      React.useEffect(function () {
        if (!knownPath) return
        var timer = setInterval(function () {
          loadDiagnostics(knownPath, setDiag)
        }, REFRESH_MS)
        return function () { clearInterval(timer) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [knownPath])

      if (!known) return null
      var count = errorCount(diag)
      var badgeCls = 'lspi-badge'
      if (count > 0) badgeCls += ''
      else if (count === 0) badgeCls += ' lspi-ok'
      else badgeCls += ' lspi-none'
      var badge = count > 0 ? React.createElement('span', { className: badgeCls }, count > 99 ? '99+' : String(count))
        : count === 0 ? React.createElement('span', { className: badgeCls }, '\u2713')
          : null
      return React.createElement('button', {
        type: 'button',
        className: 'lspi-trigger',
        title: 'LSP 诊断 · ' + known.path,
        'aria-label': 'LSP 诊断面板(' + known.path + ')',
        onClick: function (ev) {
          // 记录图标当前位置,浮层据此定位(头部下方右对齐)
          try {
            var r = ev.currentTarget.getBoundingClientRect()
            panelAnchor.left = r.left; panelAnchor.top = r.top
            panelAnchor.right = r.right; panelAnchor.bottom = r.bottom
          } catch (e) { /* ignore */ }
          panelSignal.set(panelSignal.get() === known.path ? null : known.path)
        },
      }, [
        React.createElement('span', { className: 'lspi-glyph', 'aria-hidden': true }, '\u25a6'),
        badge,
      ])
    }

    // ============================================================
    // 组件 2:诊断浮层(shell.overlay;绑定项目,不绑会话)
    // ============================================================
    function Panel(props) {
      var openPath = useSignal(panelSignal)
      if (!openPath) return null
      return React.createElement(PanelInner, { path: openPath, anchor: panelAnchor })
    }

    function PanelInner(props) {
      var path = props.path
      // 定位:头部下方、左对齐锚点图标(像下拉菜单向右展开);窗口太窄则贴左缘
      var PANEL_W = 440
      var stylePos = { top: 8, left: 8 }
      try {
        var a = props.anchor
        var vw = window.innerWidth
        stylePos = {
          top: (a && a.bottom ? a.bottom + 8 : 52),
          left: Math.max(8, Math.min(a && typeof a.left === 'number' ? a.left : 8, vw - PANEL_W - 8)),
        }
      } catch (e) { stylePos = { top: 52, left: 8 } }
      var diagPair = React.useState(null) // {summary, files, updated_at, empty}
      var diag = diagPair[0]
      var setDiag = diagPair[1]
      var stPair = React.useState(null) // status payload
      var st = stPair[0]
      var setSt = stPair[1]
      var busyPair = React.useState('') // '' | 'baseline' | 'host' | 'stop'
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var openFiles = React.useState({})
      var fileOpen = openFiles[0]
      var setFileOpen = openFiles[1]
      var timerRef = React.useRef(null)

      function refresh() {
        loadDiagnostics(path, function (d) { setDiag(d) })
        apiGet('status', path).then(function (s) { if (s && s.ok) setSt(s) })
      }

      React.useEffect(function () {
        refresh()
        timerRef.current = setInterval(refresh, REFRESH_MS)
        return function () {
          if (timerRef.current) clearInterval(timerRef.current)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [path])

      // 浮层开着时 ECS 关闭
      React.useEffect(function () {
        function onKey(e) {
          if (e.key === 'Escape') panelSignal.set(null)
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [])

      // 点外部关闭(浮层自身区域内的点按不关)
      var rootRef = React.useRef(null)
      React.useEffect(function () {
        function onDocMouseDown(e) {
          var el = rootRef.current
          if (el && e.target && el.contains(e.target)) return
          panelSignal.set(null)
        }
        // 延时挂载避免点击触发按钮的同一次 mousedown 立即关闭
        var t = setTimeout(function () {
          document.addEventListener('mousedown', onDocMouseDown)
        }, 0)
        return function () {
          clearTimeout(t)
          document.removeEventListener('mousedown', onDocMouseDown)
        }
      }, [])

      var modeText = 'engine …'
      var modeCls = 'lspi-mode'
      var mode = st && st.mode ? st.mode : ''
      if (mode === 'editor') { modeText = 'editor attach'; modeCls += ' lspi-editor' }
      else if (mode === 'headless') { modeText = 'headless'; modeCls += ' lspi-headless' }
      else if (mode === 'off') { modeText = 'off'; modeCls += ' lspi-off' }
      else if (mode === 'running') { modeText = 'running'; }

      var summaryText = ''
      if (diag && !diag.empty && diag.summary) {
        summaryText = diag.summary.files_checked + ' files · ' + diag.summary.errors + ' err · ' + diag.summary.warnings + ' warn'
      } else if (diag && diag.empty) {
        summaryText = '尚未扫描'
      } else if (!diag) {
        summaryText = '读取中…'
      }

      // 组装按文件分组的行
      var fileRows = []
      if (diag && diag.files) {
        var keys = Object.keys(diag.files).sort(function (a, b) { return a.localeCompare(b) })
        for (var i = 0; i < keys.length; i++) {
          var rel = keys[i]
          var rec = diag.files[rel]
          if (!rec) continue
          var errs = 0
          var warns = 0
          if (Array.isArray(rec.diagnostics)) {
            for (var j = 0; j < rec.diagnostics.length; j++) {
              var dm = rec.diagnostics[j]
              if (dm.severity === 1 || (dm.severityName || '').toLowerCase() === 'error') errs++
              else warns++
            }
          }
          if (errs === 0 && warns === 0 && !rec.engine_note) continue // 无内容不展示
          fileRows.push({ rel: rel, rec: rec, errs: errs, warns: warns })
        }
      }

      var head = React.createElement('div', { key: 'head', className: 'lspi-head' }, [
        React.createElement('span', { key: 't', className: 'lspi-title', title: path }, path),
        React.createElement('span', { key: 'm', className: modeCls }, modeText),
        React.createElement('button', {
          key: 'x', type: 'button', className: 'lspi-x', title: '关闭',
          onClick: function () { panelSignal.set(null) },
        }, '\u00d7'),
      ])

      var tools = React.createElement('div', { key: 'tools', className: 'lspi-tools' }, [
        React.createElement('button', {
          key: 'refresh', type: 'button', className: 'lspi-btn',
          onClick: function () { refresh() },
        }, '刷新'),
        React.createElement('button', {
          key: 'baseline', type: 'button', className: 'lspi-btn',
          disabled: busy !== '',
          onClick: function () {
            setBusy('baseline')
            apiGet('baseline', path).then(function () { setBusy(''); refresh() })
          },
        }, busy === 'baseline' ? '扫描中…' : '全量重扫'),
        React.createElement('button', {
          key: 'host', type: 'button', className: 'lspi-btn',
          disabled: busy !== '',
          title: mode === 'editor' || mode === 'headless' ? '引擎已在运行' : '启动引擎',
          onClick: function () {
            setBusy('host')
            apiGet('host', path).then(function () { setBusy(''); refresh() })
          },
        }, busy === 'host' ? '启动中…' : '启动引擎'),
        React.createElement('button', {
          key: 'stop', type: 'button', className: 'lspi-btn',
          disabled: busy !== '',
          title: mode === 'off' ? '引擎未在运行' : '停止引擎(headless)',
          onClick: function () {
            setBusy('stop')
            apiGet('stop', path).then(function () { setBusy(''); refresh() })
          },
        }, busy === 'stop' ? '停止中…' : '停止'),
        React.createElement('span', { key: 'sum', className: 'lspi-sum' }, summaryText),
      ])

      var body
      if (busy === 'baseline') {
        body = React.createElement('div', { className: 'lspi-status' }, '全量扫描中…(几百个文件约 5s)')
      } else if (fileRows.length === 0) {
        body = React.createElement('div', { className: 'lspi-empty' },
          diag && diag.empty ? '还没有诊断快照 — 点「全量重扫」生成。'
            : '✓ 无错误、无警告。',
        )
      } else {
        var groups = fileRows.map(function (fr) {
          var isOpen = !!fileOpen[fr.rel]
          var caret = React.createElement('span', { key: 'c', className: 'lspi-fcaret' }, isOpen ? '\u25be' : '\u25b8')
          var items = []
          if (isOpen && Array.isArray(fr.rec.diagnostics)) {
            for (var k = 0; k < fr.rec.diagnostics.length; k++) {
              var it = fr.rec.diagnostics[k]
              var sev = (it.severityName || (it.severity === 1 ? 'error' : 'warning')).toLowerCase()
              var dotCls = sev === 'error' ? 'lspi-dot lspi-err' : 'lspi-dot lspi-warn'
              var loc = (typeof it.line === 'number' ? it.line + ':' + (typeof it.column === 'number' ? it.column : 1) : '')
              items.push(React.createElement('div', { key: 'd' + k, className: 'lspi-item' }, [
                React.createElement('span', { key: 'dot', className: dotCls }),
                React.createElement('div', { key: 'm', className: 'lspi-msg' }, [
                  React.createElement('span', { key: 'loc', className: 'lspi-loc' }, loc),
                  it.message || '',
                ]),
              ]))
            }
          }
          if (fr.rec.engine_note) {
            items.push(React.createElement('div', { key: 'note', className: 'lspi-note' }, fr.rec.engine_note))
          }
          return React.createElement('div', { key: fr.rel, className: 'lspi-file' }, [
            React.createElement('div', {
              key: 'f', className: 'lspi-fname',
              title: fr.rel,
              onClick: function (rel) {
                return function () {
                  var next = Object.assign({}, fileOpen)
                  if (next[rel]) delete next[rel]
                  else next[rel] = true
                  setFileOpen(next)
                }
              }(fr.rel),
            }, [
              caret,
              React.createElement('span', { key: 'p', className: 'lspi-fpath' }, fr.rel),
              React.createElement('span', { key: 'n', className: 'lspi-fcount' },
                (fr.errs > 0 ? fr.errs + ' error' : '') + (fr.errs > 0 && fr.warns > 0 ? ' · ' : '') + (fr.warns > 0 ? fr.warns + ' warning' : '')),
            ]),
            items.length > 0 ? React.createElement('div', { key: 'i' }, items) : null,
          ])
        })
        body = React.createElement('div', { key: 'body', className: 'lspi-body' }, groups)
      }

      return React.createElement('div', {
        ref: rootRef,
        className: 'lspi-panel',
        style: stylePos,
        role: 'dialog',
        'aria-label': 'LSP 诊断',
      }, [head, tools, body])
    }

    // ============================================================
    // 组件 3:设置页(settings.section)—— 项目为主 + LSP chips(v2)
    // ============================================================
    var SRC_LABEL = { config: 'DSH 配置', manual: '手动添加', workspace: '自动发现' }

    function SettingsPanel() {
      var state = React.useState({
        loaded: false, error: null,
        projects: [],        // [{path, source, engine, lsp:[ids], autoInject}]
        engines: [],         // [{id, name, marker, extensions}]
        autoInject: true,    // 全局自动注入开关
        enginePorts: {},     // engineId -> 编辑器 LSP 端口(仅含显式覆盖)
        engPortDraft: {},    // 引擎卡端口输入草稿 engineId -> string|''
        busy: '',            // busy token(单飞行)
        note: null,
        newEngine: null,     // 添加项目引擎下拉
        candidates: [],      // DSH 工作区可登记项目 [{path,title,registered}]
        addSelPath: '',      // 登记下拉当前选中的项目 path
        addSel: {},          // 每卡「手动添加」下拉当前选值 path -> engineId
      })
      var s = state[0]
      var set = function (patch) { state[1](function (prev) { return Object.assign({}, prev, patch) }) }

      function reloadProjects() {
        apiGet('projects').then(function (d) { if (d && d.ok) set({ projects: d.projects || [] }) })
      }
      function loadCandidates() {
        apiGet('addCandidates').then(function (d) {
          if (d && d.ok && Array.isArray(d.candidates)) set({ candidates: d.candidates })
        })
      }
      function loadAll() {
        apiGet('projects').then(function (d) {
          if (!d || d.ok !== true) { set({ loaded: true, error: '读取项目失败(插件未激活? 需重启 dsh web)' }); return }
          set({ loaded: true, projects: d.projects || [] })
        })
        apiGet('engines').then(function (e) {
          if (e && e.ok && Array.isArray(e.engines)) {
            var detail = e.engines
            set({ engines: detail, newEngine: (detail[0] && detail[0].id) || 'godot-lsp' })
          }
        })
        apiGet('config').then(function (c) {
          if (c && c.ok && typeof c.autoInject === 'boolean') {
            var map = {}
            if (Array.isArray(c.enginePorts)) {
              for (var i = 0; i < c.enginePorts.length; i++) {
                var ep = c.enginePorts[i]
                if (ep && ep.engine) map[ep.engine] = ep.port
              }
            }
            set({ autoInject: c.autoInject, enginePorts: map })
          }
        })
        loadCandidates()
      }

      React.useEffect(function () { loadAll() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [])

      if (s.error) return React.createElement('div', { className: 'lspi-set' },
        React.createElement('div', { className: 'lspi-set-err' }, s.error))
      if (!s.loaded || !s.newEngine) return React.createElement('div', { className: 'lspi-set' }, '加载中…')

      var engineById = {}
      for (var i = 0; i < s.engines.length; i++) engineById[s.engines[i].id] = s.engines[i]

      // ---- actions ----
      function toggleGlobal() {
        var next = s.autoInject ? '0' : '1'
        apiGet('config', null, { autoInject: next }).then(function (d) {
          if (d && d.ok) set({ autoInject: d.autoInject, note: d.autoInject ? '已开启自动注入:新项目加入 DSH 会自动配置并反馈' : '已关闭自动注入:新项目需手动配置' })
        })
      }
      function doAddLsp(path, engineId) {
        if (s.busy) return
        set({ busy: 'addLsp:' + path })
        apiGet('addLsp', path, { engine: engineId }).then(function (d) {
          set({ busy: '' })
          reloadProjects()
          if (d && d.ok) set({ note: d.added ? '已为项目添加 LSP:' + engineId : engineId + ' 已在项目中' })
          else set({ note: '添加 LSP 失败' })
        })
      }
      function doDelLsp(path, engineId) {
        if (s.busy) return
        set({ busy: 'delLsp:' + path })
        apiGet('delLsp', path, { engine: engineId }).then(function (d) {
          set({ busy: '' })
          reloadProjects()
          if (d && d.ok) set({ note: d.removed ? '已移除 LSP:' + engineId : '该项目没有 ' + engineId })
          else set({ note: '移除 LSP 失败' })
        })
      }
      function doSmart(path) {
        if (s.busy) return
        set({ busy: 'smart:' + path })
        apiGet('smart', path).then(function (d) {
          set({ busy: '' })
          reloadProjects()
          if (d && d.ok) {
            set({ note: d.applied
              ? '智能配置完成,新增 LSP:' + (d.added || []).join(', ') + '(补充不覆盖)'
              : (d.reason === 'user-configured; not overwritten' ? '该项目的 LSP 是手动配置,智能配置不覆盖' : '该项目已包含建议的 LSP,无需补充') })
          } else set({ note: '智能配置失败' })
        })
      }
      function doRemoveManual(path) {
        if (s.busy) return
        set({ busy: 'delProject:' + path })
        apiGet('delProject', path).then(function (d) {
          set({ busy: '' })
          reloadProjects()
          if (d && d.ok) set({ note: d.removed ? '已移除手动配置:' + path : path + ' 不是手动配置' })
          else set({ note: '移除失败' })
        })
      }
      function doReset(path) {
        if (s.busy) return
        set({ busy: 'reset:' + path })
        apiGet('resetProject', path).then(function (d) {
          set({ busy: '' })
          reloadProjects()
          if (d && d.ok) set({ note: d.reset ? '已还原为配置种子:' + path : '无手动覆盖,无需还原' })
          else set({ note: '还原失败' })
        })
      }
      function doAddProject() {
        var p = s.addSelPath
        if (!p || s.busy) return
        set({ busy: 'add:' + p })
        apiGet('setProject', p, { engine: s.newEngine }).then(function (d) {
          set({ busy: '', addSelPath: '' })
          reloadProjects()
          loadCandidates()
          if (d && d.ok) set({ note: '已登记项目 ' + p + '(绑定 LSP:' + s.newEngine + ')' })
          else set({ note: '登记失败' })
        })
      }
      function doSmartAll() {
        if (s.busy) return
        var pending = s.projects.filter(function (x) { return x.source !== 'manual' && x.path })
        if (!pending.length) { set({ note: '没有待智能配置的项目(手动配置的不会被覆盖)' }); return }
        set({ busy: 'smart-all:' + pending.length })
        var chain = Promise.resolve()
        pending.forEach(function (x) {
          chain = chain.then(function () { return apiGet('smart', x.path) })
        })
        chain.then(function () {
          set({ busy: '', note: null })
          reloadProjects()
          set({ note: '已对 ' + pending.length + ' 个非手动项目执行智能配置(补充缺失 LSP,不动手动配置)' })
        })
      }

      function saveEnginePort(engineId) {
        if (s.busy) return
        var drafts0 = s.engPortDraft || {}
        // 没编辑过的引擎(输入框 = 已存值/占位),点了保存也不提交。
        if (!Object.prototype.hasOwnProperty.call(drafts0, engineId)) return
        var v = String(drafts0[engineId] || '').trim()
        set({ busy: 'enginePort:' + engineId })
        apiGet('enginePort', null, { engine: engineId, port: v }).then(function (d) {
          set({ busy: '' })
          if (d && d.ok) {
            var map = Object.assign({}, s.enginePorts)
            var drafts = Object.assign({}, drafts0)
            if (d.port > 0) map[engineId] = d.port
            else delete map[engineId]
            delete drafts[engineId] // 保存完回到「未编辑」态:回显已存值 / 空 + 占位
            set({
              enginePorts: map, engPortDraft: drafts,
              note: d.port > 0 ? '引擎 ' + engineId + ' 的编辑器端口已设为 ' + d.port : '引擎 ' + engineId + ' 已恢复默认端口(自动探测)',
            })
          } else set({ note: (d && d.error) || '保存端口失败' })
        })
      }

      // ---- render helpers ----
      function chipFor(rec, engineId) {
        var info = engineById[engineId]
        var name = info ? info.name : engineId
        var ext = info && info.extensions ? info.extensions.join(' ') : ''
        return React.createElement('span', { key: engineId, className: 'lspi-chip', title: '认领扩展名:' + (ext || '?') }, [
          React.createElement('span', { key: 'n', className: 'lspi-chip-name' }, name),
          ext ? React.createElement('span', { key: 'e', className: 'lspi-chip-ext' }, ext) : null,
          React.createElement('button', {
            key: 'x', type: 'button', className: 'lspi-chip-x', title: '移除该 LSP',
            disabled: !!s.busy,
            onClick: function () { doDelLsp(rec.path, engineId) },
          }, '\u2715'),
        ])
      }
      // 常驻「手动添加引擎」控件 = [下拉] + [添加] 按钮,始终都显示。
      // 下拉:列出该项目尚未绑定的引擎(已绑定的不重复加,故不进下拉)。
      // 没有任何可加引擎时,下拉占位与按钮都禁用(disabled),但不隐藏。
      function addPickerFor(rec) {
        if (!s.engines.length) return null // 插件没装任何引擎(空表)
        var bound = rec.lsp || []
        var available = s.engines.filter(function (e) { return bound.indexOf(e.id) < 0 })
        var cur = (s.addSel && s.addSel[rec.path]) || ''
        if (available.length && available.every(function (e) { return e.id !== cur })) {
          cur = available[0].id // 默认选第一个未绑定引擎
        }
        var canAdd = available.length > 0 && !!cur
        var opts
        if (!available.length) {
          opts = [React.createElement('option', { key: '_none', value: '', disabled: true },
            '已装引擎都已加入此项目')]
        } else {
          opts = [React.createElement('option', { key: '_ph', value: '', disabled: true },
            '添加引擎…')].concat(available.map(function (e) {
            return React.createElement('option', { key: e.id, value: e.id },
              e.name + ' (' + e.extensions.join(' ') + ')')
          }))
        }
        var picker = React.createElement('select', {
          className: 'lspi-set-select',
          value: cur,
          disabled: !!s.busy || !canAdd,
          title: '选择要手动添加到该项目的引擎',
          onChange: function (ev) {
            var sel = Object.assign({}, s.addSel)
            sel[rec.path] = ev.target.value
            set({ addSel: sel })
          },
        }, opts)
        var addBtn = React.createElement('button', {
          type: 'button', className: 'lspi-set-btn', disabled: !!s.busy || !canAdd,
          title: '手动添加引擎:' + (canAdd ? '把下拉选中的引擎加入项目' : '没有可添加的引擎(已全部加入)'),
          onClick: function () { doAddLsp(rec.path, cur) },
        }, s.busy === 'addLsp:' + rec.path ? '添加中…' : '添加')
        return [picker, addBtn]
      }

      // 引擎(LSP)卡的一行:引擎标识 + 编辑器 LSP 端口输入(空 = 默认自动)
      function engineRow(e) {
        var saved = s.enginePorts[e.id] // number | undefined
        var drafts = s.engPortDraft || {}
        // draft 有无(而非值)区分「未编辑」与「显式清空」:这样有覆盖值时
        // 也能清空输入并保存,真正恢复默认(否则永远回显已存值,清不掉)。
        var hasEdit = Object.prototype.hasOwnProperty.call(drafts, e.id)
        var inputVal = hasEdit ? drafts[e.id] : (saved ? String(saved) : '')
        var busyPort = s.busy === 'enginePort:' + e.id
        return React.createElement('div', { key: e.id, style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } }, [
          React.createElement('span', { key: 'c', className: 'lspi-chip', title: 'marker:' + e.marker }, [
            React.createElement('span', { key: 'n', className: 'lspi-chip-name' }, e.name),
            React.createElement('span', { key: 'e', className: 'lspi-chip-ext' }, (e.extensions || []).join(' ')),
          ]),
          React.createElement('span', { key: 'lab', className: 'lspi-set-hint', style: { flex: 'none' } }, '编辑器 LSP 端口'),
          React.createElement('input', {
            key: 'port', className: 'lspi-set-input', type: 'number', min: 1, max: 65535,
            placeholder: '6005', style: { width: 76 },
            value: inputVal, disabled: !!s.busy,
            title: 'attach 你打开的 Godot 编辑器时探测的端口。默认 6005;若你在 编辑器设置 → Network → Language Server → Remote Port 改过端口,在这里填并保存,插件就不再盲找 6005。',
            onChange: function (ev) {
              var nd = Object.assign({}, s.engPortDraft)
              nd[e.id] = ev.target.value
              set({ engPortDraft: nd })
            },
          }),
          React.createElement('button', {
            key: 'save', type: 'button', className: 'lspi-set-btn', disabled: !!s.busy || !hasEdit,
            title: hasEdit ? '保存端口设置(留空 = 恢复默认)' : '先修改端口再保存',
            onClick: function () { saveEnginePort(e.id) },
          }, busyPort ? '保存中…' : '保存'),
        ])
      }

      var cards = s.projects.map(function (p) {
        var lspList = p.lsp || []
        var chips = []
        for (var j = 0; j < lspList.length; j++) chips.push(chipFor(p, lspList[j]))
        var manualOverride = p.source === 'manual'
        var srcText = SRC_LABEL[p.source] || p.source
        // 项目名 = 目录名(一般目录即项目);全路径小字放下面
        var normPath = String(p.path).replace(/\\/g, '/').replace(/\/+$/, '')
        var projName = normPath.slice(normPath.lastIndexOf('/') + 1) || p.path
        var injText = p.autoInject === false ? '已静音' : (s.autoInject ? '自动注入' : '注入关闭')
        var addPicker = addPickerFor(p)
        return React.createElement('div', { key: p.path, className: 'lspi-card' }, [
          React.createElement('div', { key: 'head', className: 'lspi-card-head' }, [
            React.createElement('span', { key: 't', className: 'lspi-card-title', title: p.path + '\n来源:' + srcText }, projName),
            React.createElement('span', { key: 'inj', className: 'lspi-set-hint', style: { flex: 'none' } }, injText),
          ]),
          React.createElement('div', { key: 'sub', className: 'lspi-card-sub', title: p.path }, p.path),
          React.createElement('div', { key: 'lsp', className: 'lspi-chips' },
            chips.length ? chips : [React.createElement('span', { key: 'e', className: 'lspi-empty-lsp' }, '未绑定 LSP(编辑时不注入诊断)')]),
          React.createElement('div', { key: 'foot', className: 'lspi-card-foot' }, [
            addPicker ? React.createElement('span', { key: 'addbar', style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, [
              React.createElement('span', { key: 'l', className: 'lspi-set-hint' }, '手动添加引擎'),
              addPicker[0],
              addPicker[1],
            ]) : null,
            React.createElement('button', {
              type: 'button', className: 'lspi-set-btn', disabled: !!s.busy,
              title: '智能配置:探测项目语言,自动补上缺失的 LSP —— 只追加,绝不覆盖你手动删的',
              onClick: function () { doSmart(p.path) },
            }, s.busy === 'smart:' + p.path ? '…' : '智能配置'),
            manualOverride ? React.createElement('button', {
              type: 'button', className: 'lspi-set-btn danger', disabled: !!s.busy,
              title: '移除该手动配置(项目将从列表消失)',
              onClick: function () { doRemoveManual(p.path) },
            }, s.busy === 'delProject:' + p.path ? '…' : '移除手动配置') : React.createElement('button', {
              type: 'button', className: 'lspi-set-btn', disabled: !!s.busy,
              title: '删除手动覆盖,还原为 config/自动发现种子',
              onClick: function () { doReset(p.path) },
            }, s.busy === 'reset:' + p.path ? '…' : '还原种子'),
          ]),
        ])
      })

      var addEngineOptions = s.engines.map(function (e) {
        return React.createElement('option', { key: e.id, value: e.id }, e.name + ' (' + e.extensions.join(' ') + ')')
      })
      // 登记下拉:DSH 工作区全部根 + 根下命中引擎的项目(已登记的在选项里禁用)
      var candidateOpts = (function () {
        var opts = []
        if (!s.candidates.length) {
          opts.push(React.createElement('option', { key: '_none', value: '', disabled: true }, 'DSH 没有可登记的工作区项目'))
        } else {
          opts.push(React.createElement('option', { key: '_ph', value: '', disabled: true }, '选择工作区项目…'))
          for (var ci = 0; ci < s.candidates.length; ci++) {
            var cand = s.candidates[ci]
            opts.push(React.createElement('option', { key: cand.path, value: cand.path, disabled: !!cand.registered },
              (cand.title || cand.path) + (cand.registered ? '(已登记)' : '')))
          }
        }
        return opts
      })()

      return React.createElement('div', { className: 'lspi-set' }, [
        // 全局自动注入开关
        React.createElement('div', { key: 'global', className: 'lspi-global-row' }, [
          React.createElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontWeight: 600 } }, [
            React.createElement('input', {
              type: 'checkbox', checked: s.autoInject,
              onChange: toggleGlobal,
            }),
            '自动注入(全局)',
          ]),
          React.createElement('span', { className: 'lspi-set-hint' },
            '开:项目第一次加入 DSH 时自动智能配置 LSP,并在编辑后把编译错误反馈给 AI。'
            + '关:新项目只登记不自动注入,需手动配置。'),
        ]),
        // 操作结果提示:放整页顶部,引擎卡/项目卡的操作都能看到
        s.note ? React.createElement('p', { key: 'note', className: 'lspi-set-hint', style: { color: '#1d4ed8', margin: '0 0 6px' } }, s.note) : null,
        // 说明(独立卡):项目 = 目录,含语言,每语言一个 LSP
        React.createElement('div', { key: 'about', className: 'lspi-set-card' }, [
          React.createElement('h3', null, '工作原理'),
          React.createElement('p', { className: 'lspi-set-hint' },
            '一个项目(目录)可含多种语言(如 GDScript + C#),每种语言配一个 LSP;'
            + '该语言的 LSP 认领自己的扩展名,在文件编译/编辑变化时把诊断反馈给 AI。'),
          React.createElement('p', { className: 'lspi-set-hint', style: { marginTop: 6 } },
            '「智能配置」扫描项目自动补上缺失的 LSP —— 只补充,绝不覆盖你手动删的。'
            + '你改过的项目以「手动」来源显示,可随时还原为配置种子。'),
        ]),
        // 项目卡片(项目为主:一项目一卡)
        React.createElement('div', { key: 'projects', className: 'lspi-set-card' }, [
          React.createElement('h3', null, '项目'),
          cards.length ? React.createElement('div', { key: 'cards', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, cards) : null,
          React.createElement('div', { key: 'addrow', className: 'lspi-set-row', style: { marginTop: 10, borderBottom: 0 } }, [
            React.createElement('span', { key: 'lab', className: 'lspi-set-hint', style: { flex: 'none' } }, '登记 DSH 项目'),
            React.createElement('select', {
              className: 'lspi-set-select', style: { maxWidth: 300 },
              value: s.addSelPath || '',
              disabled: !!s.busy || !s.candidates.length,
              title: '选择要登记的 DSH 工作区项目(含无 GDScript 的项目;登记不产生引擎文件的项目只是占位,无诊断)',
              onChange: function (ev) { set({ addSelPath: ev.target.value }) },
            }, candidateOpts),
            React.createElement('select', {
              className: 'lspi-set-select', value: s.newEngine,
              onChange: function (ev) { set({ newEngine: ev.target.value }) },
            }, addEngineOptions),
            React.createElement('button', {
              type: 'button', className: 'lspi-set-btn', disabled: !!s.busy || !s.addSelPath,
              title: '把选中的 DSH 项目登记到列表(绑定所选引擎)',
              onClick: doAddProject,
            }, s.busy.indexOf('add:') === 0 ? '添加中…' : '添加项目'),
            React.createElement('button', {
              type: 'button', className: 'lspi-set-btn', disabled: !!s.busy,
              title: '对没有手动配置的项目自动探测并补 LSP',
              onClick: doSmartAll,
            }, s.busy.indexOf('smart-all') === 0 ? '配置中…' : '全部智能配置'),
          ]),
        ]),
        // 引擎列表(每引擎一行:标识 + 编辑器 LSP 端口)
        React.createElement('div', { key: 'eng', className: 'lspi-set-card' }, [
          React.createElement('h3', null, '引擎(LSP)'),
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            s.engines.map(engineRow)),
          React.createElement('p', { className: 'lspi-set-hint', style: { marginTop: 8 } },
            '引擎(LSP)即 checkers/ 下注册的语言服务器;添加新引擎 = 在插件 checkers/ 加目录(自动出现)。'
            + '「编辑器 LSP 端口」是 attach 你已打开的 Godot 编辑器时探测的端口(默认 6005)。'
            + '若你的 Godot 在 编辑器设置 → Network → Language Server → Remote Port 改过端口,'
            + '在这里填上并保存即可,插件 attach 时用你填的端口,不再盲找。清空后保存 = 恢复默认。'),
        ]),
      ])
    }

    // ============================================================
    // 装载
    // ============================================================
    function apply(ctx) {
      var slots = ctx.get('slots')
      if (!slots) return
      ctx.effect(function () {
        var removeStyles = installStyles()
        var removers = []
        function injectSeat(seat, id, order, Comp) {
          var remove = slots.inject(seat, function () {
            return slots.register({ name: seat, id: id, order: order }, Comp)
          })
          if (typeof remove === 'function') removers.push(remove)
        }
        // 会话头部 action 槽(标题旁):排在 agent-preset(-10,创造模式)右侧,
        // 避开右上角 toast 浮窗区(utilities 在 toast 下方会被短暂遮挡)。
        injectSeat('conversation.session.header.actions', 'lsp-echo-diag', -5, HeaderIcon)
        injectSeat('shell.overlay', 'lsp-echo-panel', 60, Panel)
        // 设置页(侧栏设置 → LSP 诊断)
        var removeSection = slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'lsp-echo', order: 30, label: function () { return 'LSP 诊断' } },
            SettingsPanel,
          )
        })
        if (typeof removeSection === 'function') removers.push(removeSection)
        return function () {
          for (var i = 0; i < removers.length; i++) {
            try { removers[i]() } catch (e) { /* ignore */ }
          }
          if (typeof removeStyles === 'function') removeStyles()
          panelSignal.set(null)
        }
      })
    }

    exports.name = 'lsp-echo'
    exports.inject = ['slots']
    exports.apply = apply

    return module.exports
  },
})
