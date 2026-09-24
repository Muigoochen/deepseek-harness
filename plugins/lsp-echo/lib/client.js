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
      '.lspi-hint{padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));font-size:12px;line-height:1.5;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.08));opacity:.85;}',
      '.lspi-body{flex:1;min-height:0;overflow:auto;padding:6px 0 10px;}',
      '.lspi-status{padding:18px 14px;text-align:center;opacity:.65;font-size:13px;}',
      '.lspi-file{margin:4px 8px 0;}',
      '.lspi-enginenote{margin:6px 12px 0;font-size:12px;line-height:1.5;opacity:.8;}',
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
    // TRUST_HEADER: the host refuses project-writing actions without it, so a
    // cross-site page cannot make DSH write into a user's project.
    var TRUST_HEADER = 'x-dsh-lsp-echo'
    function httpGet(url) {
      if (typeof fetch === 'function') {
        var headers = {}
        headers[TRUST_HEADER] = '1'
        return fetch(url, { cache: 'no-store', headers: headers }).then(function (res) {
          return res.json()
        }).catch(function () { return null })
      }
      return new Promise(function (resolve) {
        try {
          var xhr = new XMLHttpRequest()
          xhr.open('GET', url)
          xhr.setRequestHeader(TRUST_HEADER, '1')
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
    // seat 可用性放外层判定:内层必须**无条件**调用 useSessions,否则 props 在
    // 两次渲染间从无到有会改变 hooks 数量,React 直接报错(Panel/PanelInner 同款手法)。
    function HeaderIcon(props) {
      if (typeof props.useSessions !== 'function' || !props.sessionId) return null
      return React.createElement(HeaderIconInner, props)
    }

    function HeaderIconInner(props) {
      var sessionId = props.sessionId
      // 订阅会话 cwd 快照:会话数据变化(切换/载入)时本组件重渲染,effect 随之重跑。
      var cwd = props.useSessions(function (s) { return s && s.byId && s.byId[sessionId] ? s.byId[sessionId].cwd : undefined })

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
      // 订阅语言:必须在下面任何 return 之前,否则 hooks 数量会随分支变化。
      var T = useT()
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
        title: T('overlay.title', { path: known.path }),
        'aria-label': T('overlay.aria', { path: known.path }),
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
      // 订阅语言:下面的分支众多,必须在任何 return 之前取出。
      var T = useT()
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

      // 引擎模式徽章:文案随语言走(T 在渲染路径里,语言一变换就会重算)
      var modeText = T('overlay.mode.engine')
      var modeCls = 'lspi-mode'
      var mode = st && st.mode ? st.mode : ''
      if (mode === 'editor') { modeText = T('overlay.mode.editor'); modeCls += ' lspi-editor' }
      else if (mode === 'headless') { modeText = T('overlay.mode.headless'); modeCls += ' lspi-headless' }
      else if (mode === 'off') { modeText = T('overlay.mode.off'); modeCls += ' lspi-off' }
      else if (mode === 'running') { modeText = T('overlay.mode.running'); }

      var summaryText = ''
      if (diag && !diag.empty && diag.summary) {
        summaryText = T('overlay.summary', {
          files: diag.summary.files_checked,
          err: diag.summary.errors,
          warn: diag.summary.warnings,
        })
      } else if (diag && diag.empty) {
        summaryText = T('overlay.notScanned')
      } else if (!diag) {
        summaryText = T('overlay.reading')
      }

      // 为什么还在用自己的引擎:状态里带回了编辑器端口/桥启用的事实,这里只给结论
      var hintText = ''
      if (mode === 'headless' && st) {
        var ed = st.editor || {}
        var br = st.bridge || {}
        var portText = String(ed.port || 6005)
        if (br.installed && !br.enabled) hintText = T('overlay.note.headless.bridgeOff')
        else if (ed.instance) hintText = T('overlay.note.headless.nextCheck')
        else if (ed.listening) hintText = T('overlay.note.headless.bridgeStale', { port: portText })
        else hintText = T('overlay.note.headless.portDead', { port: portText })
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
          // An extensionless key is engine-synthetic (the cpp checker's
          // link/build bucket): show what it stands for instead of a raw `<link>`.
          // The snapshot records which keys are synthetic, so this follows the
          // declaration rather than guessing from the name.
          var syntheticKeys = diag && Array.isArray(diag.synthetic_keys) ? diag.synthetic_keys : []
          var label = syntheticKeys.indexOf(rel) >= 0 ? T('overlay.row.synthetic') : rel
          fileRows.push({ rel: rel, label: label, rec: rec, errs: errs, warns: warns })
        }
      }

      var head = React.createElement('div', { key: 'head', className: 'lspi-head' }, [
        React.createElement('span', { key: 't', className: 'lspi-title', title: path }, path),
        React.createElement('span', { key: 'm', className: modeCls }, modeText),
        React.createElement('button', {
          key: 'x', type: 'button', className: 'lspi-x', title: T('overlay.close'),
          onClick: function () { panelSignal.set(null) },
        }, '\u00d7'),
      ])

      var tools = React.createElement('div', { key: 'tools', className: 'lspi-tools' }, [
        React.createElement('button', {
          key: 'refresh', type: 'button', className: 'lspi-btn',
          onClick: function () { refresh() },
        }, T('overlay.refresh')),
        React.createElement('button', {
          key: 'baseline', type: 'button', className: 'lspi-btn',
          disabled: busy !== '',
          onClick: function () {
            setBusy('baseline')
            apiGet('baseline', path).then(function () { setBusy(''); refresh() })
          },
        }, busy === 'baseline' ? T('overlay.rescanning') : T('overlay.rescan')),
        React.createElement('button', {
          key: 'host', type: 'button', className: 'lspi-btn',
          disabled: busy !== '',
          title: mode === 'editor' || mode === 'headless' ? T('overlay.start.running') : T('overlay.start.title'),
          onClick: function () {
            setBusy('host')
            apiGet('host', path).then(function () { setBusy(''); refresh() })
          },
        }, busy === 'host' ? T('overlay.starting') : T('overlay.start')),
        React.createElement('button', {
          key: 'stop', type: 'button', className: 'lspi-btn',
          disabled: busy !== '',
          title: mode === 'off' ? T('overlay.stop.off') : T('overlay.stop.title'),
          onClick: function () {
            setBusy('stop')
            apiGet('stop', path).then(function () { setBusy(''); refresh() })
          },
        }, busy === 'stop' ? T('overlay.stopping') : T('overlay.stop')),
        React.createElement('span', { key: 'sum', className: 'lspi-sum' }, summaryText),
      ])

      var body
      if (busy === 'baseline') {
        body = React.createElement('div', { className: 'lspi-status' }, T('overlay.scanning'))
      } else if (fileRows.length === 0) {
        body = React.createElement('div', { className: 'lspi-empty' },
          diag && diag.empty ? T('overlay.noSnapshot')
            : T('overlay.clean'),
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
              React.createElement('span', { key: 'p', className: 'lspi-fpath' }, fr.label),
              React.createElement('span', { key: 'n', className: 'lspi-fcount' },
                (fr.errs > 0 ? T('overlay.fileCount.error', { n: fr.errs }) : '')
                + (fr.errs > 0 && fr.warns > 0 ? ' · ' : '')
                + (fr.warns > 0 ? T('overlay.fileCount.warning', { n: fr.warns }) : '')),
            ]),
            items.length > 0 ? React.createElement('div', { key: 'i' }, items) : null,
          ])
        })
        body = React.createElement('div', { key: 'body', className: 'lspi-body' }, groups)
      }

      // 引擎自述(例如"这次构建没覆盖到哪几个文件"):不属于任何单个文件行,单独一行说清楚
      var engineNote = diag && diag.engine_note
        ? React.createElement('div', { key: 'en', className: 'lspi-note lspi-enginenote' }, diag.engine_note)
        : null

      return React.createElement('div', {
        ref: rootRef,
        className: 'lspi-panel',
        style: stylePos,
        role: 'dialog',
        'aria-label': T('overlay.label'),
      }, [head, tools, hintText ? React.createElement('div', { key: 'hint', className: 'lspi-hint' }, hintText) : null, engineNote, body])
    }

    // ============================================================
    // 组件 3:设置页(settings.section)—— 项目为主 + LSP chips(v2)
    // ============================================================
    // 来源标签:函数取值,调用时才翻译(语言切换后自然跟着变)
    function srcLabel(id) {
      if (id === 'config') return t('settings.source.config')
      if (id === 'manual') return t('settings.source.manual')
      return t('settings.source.workspace')
    }

    function SettingsPanel() {
      var state = React.useState({
        loaded: false, error: null,
        projects: [],        // [{path, source, engine, lsp:[ids], autoInject}]
        engines: [],         // [{id, name, marker, extensions}]
        autoInject: true,    // 全局自动注入开关
        autoAddon: true,     // 全局自动安装引擎桥(addon)开关
        bridgeInfo: {},      // path -> 检测引擎桥结果(就地显示在项目卡里,不必去页顶找提示)
        enginePorts: {},     // engineId -> 编辑器 LSP 端口(仅含显式覆盖)
        engPortDraft: {},    // 引擎卡端口输入草稿 engineId -> string|''
        skipDraft: {},       // 项目卡「跳过目录」输入草稿 path -> string
        busy: '',            // busy token(单飞行)
        note: null,
        newEngine: null,     // 添加项目引擎下拉
        candidates: [],      // DSH 工作区可登记项目 [{path,title,registered}]
        addSelPath: '',      // 登记下拉当前选中的项目 path
        addSel: {},          // 每卡「手动添加」下拉当前选值 path -> engineId
      })
      var s = state[0]
      var set = function (patch) { state[1](function (prev) { return Object.assign({}, prev, patch) }) }
      // 提示存 key + params,而不是当场算好的字符串:切换语言后已显示的提示也要
      // 跟着变。存字符串会一直重放旧语言的文本,直到用户再点一次按钮。
      function noteOf(key, params) { return { key: key, params: params } }
      // params 的值可以是 {key, params}:嵌在提示里的片段(「该项目」「该引擎」等)
      // 也必须跟着语言走,否则会拼出「壳是新语言、内嵌片段是旧语言」的混排句子。
      function noteParams(params) {
        if (!params) return params
        var out = {}
        for (var name in params) {
          if (!Object.prototype.hasOwnProperty.call(params, name)) continue
          var value = params[name]
          out[name] = (value && typeof value === 'object' && typeof value.key === 'string')
            ? t(value.key, noteParams(value.params))
            : value
        }
        return out
      }
      function noteText(note) {
        if (!note) return null
        if (typeof note === 'string') return note
        return T(note.key, noteParams(note.params))
      }
      // 订阅语言:Switch 语言或词典晚到时重渲染本卡。必须在任何 return 之前调用,
      // 否则「加载中/出错」分支会改变 hooks 数量。
      var T = useT()

      function reloadProjects() {
        apiGet('projects').then(function (d) { if (d && d.ok) set({ projects: d.projects || [] }) })
      }
      function loadCandidates() {
        apiGet('addCandidates').then(function (d) {
          if (d && d.ok && Array.isArray(d.candidates)) set({ candidates: d.candidates })
        })
      }
      // 自动安装引擎桥:开 = 发现项目缺 addon 就自动装上;关 = 只用手动按钮。
      function toggleAddon() {
        if (s.busy) return
        var next = s.autoAddon ? 0 : 1
        set({ busy: 'config:addon' })
        apiGet('config', null, { autoAddon: next }).then(function (d) {
          set({ busy: '' })
          if (d && d.ok) {
            set({
              autoAddon: !!d.autoAddon,
              note: d.autoAddon ? noteOf('settings.note.autoAddonOn') : noteOf('settings.note.autoAddonOff'),
            })
          }
        })
      }

      function loadAll() {
        apiGet('projects').then(function (d) {
          if (!d || d.ok !== true) { set({ loaded: true, error: noteOf('settings.error.projects') }); return }
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
                if (ep && ep.key) map[ep.key] = ep.port
              }
            }
            set({ autoInject: c.autoInject, autoAddon: c.autoAddon !== false, enginePorts: map })
          }
        })
        loadCandidates()
      }

      React.useEffect(function () { loadAll() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [])

      if (s.error) return React.createElement('div', { className: 'lspi-set' },
        React.createElement('div', { className: 'lspi-set-err' }, noteText(s.error)))
      if (!s.loaded || !s.newEngine) return React.createElement('div', { className: 'lspi-set' }, T('settings.loading'))

      var engineById = {}
      for (var i = 0; i < s.engines.length; i++) engineById[s.engines[i].id] = s.engines[i]

      // ---- actions ----
      function toggleGlobal() {
        var next = s.autoInject ? '0' : '1'
        apiGet('config', null, { autoInject: next }).then(function (d) {
          if (d && d.ok) set({ autoInject: d.autoInject, note: d.autoInject ? T('settings.note.autoInjectOn') : T('settings.note.autoInjectOff') })
        })
      }
      function doAddLsp(path, engineId) {
        if (s.busy) return
        set({ busy: 'addLsp:' + path })
        apiGet('addLsp', path, { engine: engineId }).then(function (d) {
          set({ busy: '' })
          reloadProjects()
          if (d && d.ok) set({ note: d.added ? noteOf('note.addLsp.ok', { engine: engineId }) : noteOf('note.addLsp.exists', { engine: engineId }) })
          else set({ note: noteOf('note.addLsp.fail') })
        })
      }
      function doDelLsp(path, engineId) {
        if (s.busy) return
        set({ busy: 'delLsp:' + path })
        apiGet('delLsp', path, { engine: engineId }).then(function (d) {
          set({ busy: '' })
          reloadProjects()
          if (d && d.ok) set({ note: d.removed ? noteOf('note.delLsp.ok', { engine: engineId }) : noteOf('note.delLsp.absent', { engine: engineId }) })
          else set({ note: noteOf('note.delLsp.fail') })
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
              ? noteOf('note.smart.applied', { list: (d.added || []).join(', ') })
              : (d.reason === 'user-configured; not overwritten' ? noteOf('note.smart.manual') : noteOf('note.smart.nothing')) })
          } else set({ note: noteOf('note.smart.fail') })
        })
      }
      function doRemoveManual(path) {
        if (s.busy) return
        set({ busy: 'delProject:' + path })
        apiGet('delProject', path).then(function (d) {
          set({ busy: '' })
          reloadProjects()
          if (d && d.ok) set({ note: d.removed ? noteOf('note.removeManual.ok', { path }) : noteOf('note.removeManual.absent', { path }) })
          else set({ note: noteOf('note.removeManual.fail') })
        })
      }
      function doReset(path) {
        if (s.busy) return
        set({ busy: 'reset:' + path })
        apiGet('resetProject', path).then(function (d) {
          set({ busy: '' })
          reloadProjects()
          if (d && d.ok) set({ note: d.reset ? noteOf('note.reset.ok', { path }) : noteOf('note.reset.absent') })
          else set({ note: noteOf('note.reset.fail') })
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
          if (d && d.ok) set({ note: noteOf('note.project.ok', { path: p, engine: s.newEngine }) })
          else set({ note: noteOf('note.project.fail') })
        })
      }
      function doSmartAll() {
        if (s.busy) return
        var pending = s.projects.filter(function (x) { return x.source !== 'manual' && x.path })
        if (!pending.length) { set({ note: noteOf('note.smartAll.none') }); return }
        set({ busy: 'smart-all:' + pending.length })
        var chain = Promise.resolve()
        pending.forEach(function (x) {
          chain = chain.then(function () { return apiGet('smart', x.path) })
        })
        chain.then(function () {
          set({ busy: '', note: null })
          reloadProjects()
          set({ note: noteOf('note.smartAll.done', { count: pending.length }) })
        })
      }

      // enginePorts 的键必须与 Host 的 portEntries 生成的完全一致:两边各写一份
      // 就会分叉(反斜杠 vs 正斜杠),保存进去的值落在另一个键上,重开设置页
      // 看起来就像没保存。规则:正斜杠 + 小写 + 去掉尾部斜杠。
      function portRowKey(engineId, projectPath) {
        return projectPath
          ? engineId + '::' + String(projectPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
          : engineId
      }
      // 项目卡「跳过目录」:逗号分隔(Host 只按逗号切;分号/换行都算同一项的一部分)。
      // 铁定跳过的目录(node_modules/.git/.godot 以及一切点目录)不进这个输入框
      // —— 它们由 Host 强制附加,写进来也会被剔除。
      function saveProjectSkip(path) {
        if (s.busy) return
        var drafts0 = s.skipDraft || {}
        if (!Object.prototype.hasOwnProperty.call(drafts0, path)) return
        var v = String(drafts0[path] || '')
        set({ busy: 'skip:' + path })
        apiGet('setSkipDirs', null, { project: path, skipDirs: v }).then(function (d) {
          if (d && d.ok) {
            var drafts = Object.assign({}, drafts0)
            delete drafts[path] // 保存完回到「未编辑」态:回显已存值
            // 保存会写一条 manual 覆盖,项目的 source 徽章随之变化,所以整列表重取。
            // 重取失败时至少用本次响应把这一项patch 成新值,否则输入框和「生效:」
            // 会退回保存前的旧值,而提示却说已保存。
            apiGet('projects').then(function (r) {
              var list
              if (r && r.ok && r.projects) list = r.projects
              else {
                list = s.projects.map(function (x) {
                  return x.path === d.project
                    ? Object.assign({}, x, { skipDirs: d.skipDirs, effectiveSkip: d.effective })
                    : x
                })
              }
              set({
                busy: '', skipDraft: drafts, projects: list,
                note: noteOf('note.skip.saved', { skip: d.skipDirs || noteOf('note.skip.none') }),
              })
            })
          } else set({ busy: '', note: (d && d.error) || noteOf('note.skip.fail') })
        })
      }

      function saveEnginePort(engineId, projectPath) {
        if (s.busy) return
        var key = portRowKey(engineId, projectPath)
        var drafts0 = s.engPortDraft || {}
        // 没编辑过的条目(输入框 = 已存值/占位),点了保存也不提交。
        if (!Object.prototype.hasOwnProperty.call(drafts0, key)) return
        var v = String(drafts0[key] || '').trim()
        set({ busy: 'enginePort:' + key })
        var query = { engine: engineId, port: v }
        if (projectPath) query.project = projectPath
        apiGet('enginePort', null, query).then(function (d) {
          set({ busy: '' })
          if (d && d.ok) {
            var map = Object.assign({}, s.enginePorts)
            var drafts = Object.assign({}, drafts0)
            if (d.port > 0) map[key] = d.port
            else delete map[key]
            delete drafts[key] // 保存完回到「未编辑」态:回显已存值 / 空 + 占位
            var where = projectPath
              ? noteOf('note.port.project', { name: String(projectPath).replace(/\\/g, '/').split('/').pop() })
              : noteOf('note.port.engine', { engine: engineId })
            set({
              enginePorts: map, engPortDraft: drafts,
              note: d.port > 0 ? noteOf('note.port.set', { where, port: d.port }) : noteOf('note.port.cleared', { where }),
            })
          } else set({ note: (d && d.error) || noteOf('note.port.fail') })        })
      }

      // 引擎桥:把 addons/dsh_echo_bridge 装进项目,让运行中的 Godot 引擎
      // (编辑器或 headless)可以被要求重扫文件系统 —— 新建脚本的 class_name
      // 因此立即可见,不必重启引擎。
      function doInstallAddon(path) {
        if (s.busy) { set({ note: noteOf('settings.note.busy', { busy: s.busy }) }); return }
        set({ busy: 'addon:' + path })
        apiGet('installAddon', path).then(function (d) {
          // 安装改变了桥的状态,上一次的检测结论作废
          var bi = Object.assign({}, s.bridgeInfo)
          delete bi[path]
          set({ busy: '', bridgeInfo: bi })
          if (d && d.ok) {
            set({ note: noteOf('note.bridge.installed', {
              path: path,
              enabled: d.enableChanged ? noteOf('note.bridge.enabled') : noteOf('note.bridge.alreadyEnabled'),
              restart: d.enabled
                ? (d.stoppedForRestart ? noteOf('note.bridge.stopped') : noteOf('note.bridge.restart'))
                : noteOf('note.bridge.notEnabled', { error: d.error || '' }),
            }) })
          } else set({ note: (d && d.error) || noteOf('note.bridge.fail') })
        })
      }
      // 检测结果的一行摘要:结论(能否被要求重扫)在前,细节在后。
      function bridgeInfoText(path) {
        var b = s.bridgeInfo[path]
        if (!b) return ''
        if (b.pending) return T('settings.card.bridge.checking')
        if (b.ok === false) return '\u274c ' + (b.error || T('settings.card.bridge.failed'))
        var installed = b.installed ? T('settings.card.bridge.installed') : T('settings.card.bridge.missing')
        if (b.online) return '\u2705 ' + T('settings.card.bridge.online', { port: b.port || '?', installed })
        if (b.declared === false) return '\u274c ' + T('settings.card.bridge.undeclared') + (b.error ? ':' + b.error : '')
        return '\u26a0\ufe0f ' + T('settings.card.bridge.unresponsive', { port: b.port || '?', installed }) + (b.error ? ' —— ' + b.error : '')
      }
      function doCheckBridge(path) {
        // 占用中也要给反馈:静默 return 会让按钮看起来是坏的
        if (s.busy) { set({ note: noteOf('settings.note.busy', { busy: s.busy }) }); return }
        set({ busy: 'bridge:' + path })
        var pending = Object.assign({}, s.bridgeInfo)
        pending[path] = { pending: true }
        set({ bridgeInfo: pending })
        apiGet('bridgeStatus', path).then(function (d) {
          var bi = Object.assign({}, s.bridgeInfo)
          if (d && d.ok) {
            var on = !!d.online
            bi[path] = {
              ok: true, port: d.port, installed: !!d.installed, online: on,
              declared: d.declared !== false, error: d.error || '',
            }
            set({ busy: '', bridgeInfo: bi,
              note: on ? noteOf('note.bridge.checkOnline', { port: d.port }) : noteOf('note.bridge.checkOffline') })
          } else {
            bi[path] = { ok: false, error: (d && d.error) || T('note.bridge.checkRequestFail') }
            set({ busy: '', bridgeInfo: bi, note: noteOf('note.bridge.checkFail') })
          }
        })
      }

      // ---- render helpers ----
      function chipFor(rec, engineId) {
        var info = engineById[engineId]
        var name = info ? info.name : engineId
        var ext = info && info.extensions ? info.extensions.join(' ') : ''
        // A project may bind an engine this plugin never registered (its config came
        // from elsewhere, or the engine directory is not installed). Such a binding
        // claims no extensions and produces no diagnostics, which is invisible
        // unless the chip says so.
        var chipTitle = info
          ? T('settings.card.claimExt', { ext: ext || '?' })
          : T('settings.card.unknownEngine')
        return React.createElement('span', { key: engineId, className: 'lspi-chip', title: chipTitle }, [
          React.createElement('span', { key: 'n', className: 'lspi-chip-name' }, name),
          ext ? React.createElement('span', { key: 'e', className: 'lspi-chip-ext' }, ext) : null,
          React.createElement('button', {
            key: 'x', type: 'button', className: 'lspi-chip-x', title: T('settings.card.removeLsp.title'),
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
            T('note.card.addPicker.empty', { list: s.engines.map(function (e) { return e.name }).join(', ') }))]
        } else {
          opts = [React.createElement('option', { key: '_ph', value: '', disabled: true },
            T('note.card.addPicker.placeholder'))].concat(available.map(function (e) {
            return React.createElement('option', { key: e.id, value: e.id },
              e.name + ' (' + e.extensions.join(' ') + ')')
          }))
        }
        var picker = React.createElement('select', {
          className: 'lspi-set-select',
          value: cur,
          disabled: !!s.busy || !canAdd,
          title: canAdd ? T('note.card.addPicker.title') : T('note.card.addPicker.empty.title'),
          onChange: function (ev) {
            var sel = Object.assign({}, s.addSel)
            sel[rec.path] = ev.target.value
            set({ addSel: sel })
          },
        }, opts)
        var addBtn = React.createElement('button', {
          type: 'button', className: 'lspi-set-btn', disabled: !!s.busy || !canAdd,
          title: T('note.card.add.title', { action: canAdd ? T('note.card.add.action') : T('note.card.add.noEngine') }),
          onClick: function () { doAddLsp(rec.path, cur) },
        }, s.busy === 'addLsp:' + rec.path ? T('note.card.adding') : T('note.card.add'))
        return [picker, addBtn]
      }

      // 引擎(LSP)卡的一行端口输入。projectPath 为空 = 引擎级兜底(所有未单独设置的项目)。
      // 键与后端 portEntries/查找侧一致:项目级 = 引擎 + 归一化项目路径。
      function portRow(e, projectPath, label) {
        var key = portRowKey(e.id, projectPath)
        var saved = s.enginePorts[key] // number | undefined
        var drafts = s.engPortDraft || {}
        // draft 有无(而非值)区分「未编辑」与「显式清空」:这样有覆盖值时
        // 也能清空输入并保存,真正恢复默认(否则永远回显已存值,清不掉)。
        var hasEdit = Object.prototype.hasOwnProperty.call(drafts, key)
        var inputVal = hasEdit ? drafts[key] : (saved ? String(saved) : '')
        var busyPort = s.busy === 'enginePort:' + key
        return React.createElement('div', { key: key, style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } }, [
          React.createElement('span', { key: 'lab', className: 'lspi-set-hint', style: { flex: 'none', minWidth: 128 } }, label),
          React.createElement('input', {
            key: 'port', className: 'lspi-set-input', type: 'number', min: 1, max: 65535,
            placeholder: projectPath ? T('note.engine.inherit') : '6005', style: { width: 76 },
            value: inputVal, disabled: !!s.busy,
            title: projectPath
              ? T('note.engine.port.project.title')
              : T('note.engine.port.fallback.title'),
            onChange: function (ev) {
              var nd = Object.assign({}, s.engPortDraft)
              nd[key] = ev.target.value
              set({ engPortDraft: nd })
            },
          }),
          React.createElement('button', {
            key: 'save', type: 'button', className: 'lspi-set-btn', disabled: !!s.busy || !hasEdit,
            title: hasEdit ? T('note.engine.save.title') : T('note.engine.save.needEdit'),
            onClick: function () { saveEnginePort(e.id, projectPath) },
          }, busyPort ? T('note.engine.saving') : T('note.engine.save')),
        ])
      }

      // 引擎(LSP)卡:一张引擎卡 = 引擎标识 + 引擎级端口行 + 每个绑定该引擎的项目一行端口。
      // 项目级必须能单独设置,因为两个 Godot 项目共用一个引擎 id:它们各有自己的编辑器、
      // 各占一个 LSP 端口,只留一条引擎级端口会让第二个项目的编辑器被当成"服务别的项目"而拒掉。
      function engineRow(e) {
        var bound = []
        for (var i = 0; i < s.projects.length; i++) {
          if ((s.projects[i].lsp || []).indexOf(e.id) >= 0) bound.push(s.projects[i])
        }
        var rows = [React.createElement('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } }, [
          React.createElement('span', { key: 'c', className: 'lspi-chip', title: 'marker:' + e.marker }, [
            React.createElement('span', { key: 'n', className: 'lspi-chip-name' }, e.name),
            React.createElement('span', { key: 'e', className: 'lspi-chip-ext' }, (e.extensions || []).join(' ')),
          ]),
        ])]
        rows.push(portRow(e, undefined, T('engine.fallbackRow')))
        for (var j = 0; j < bound.length; j++) {
          var np = String(bound[j].path).replace(/\\/g, '/').replace(/\/+$/, '')
          rows.push(portRow(e, bound[j].path, '└ ' + (np.slice(np.lastIndexOf('/') + 1) || bound[j].path)))
        }
        return React.createElement('div', { key: e.id, style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 } }, rows)
      }

      var cards = s.projects.map(function (p) {
        var lspList = p.lsp || []
        var chips = []
        for (var j = 0; j < lspList.length; j++) chips.push(chipFor(p, lspList[j]))
        var manualOverride = p.source === 'manual'
        var srcText = srcLabel(p.source) || p.source
        // 项目名 = 目录名(一般目录即项目);全路径小字放下面
        var normPath = String(p.path).replace(/\\/g, '/').replace(/\/+$/, '')
        var projName = normPath.slice(normPath.lastIndexOf('/') + 1) || p.path
        var injText = p.autoInject === false ? T('note.card.injectMuted') : (s.autoInject ? T('note.card.autoInject') : T('note.card.injectClosed'))
        var addPicker = addPickerFor(p)
        // 引擎桥按钮只对该项目绑定的、声明了 rescan 能力的引擎出现(否则点了只会报错)
        var canBridge = false
        for (var bi = 0; bi < lspList.length; bi++) {
          var bound = engineById[lspList[bi]]
          // Mirrors the host check (rescan + shipped addon), so the button never
          // appears for a project whose engine cannot serve it.
          if (bound && bound.rescan && bound.addon) { canBridge = true; break }
        }
        return React.createElement('div', { key: p.path, className: 'lspi-card' }, [
          React.createElement('div', { key: 'head', className: 'lspi-card-head' }, [
            React.createElement('span', { key: 't', className: 'lspi-card-title', title: T('note.card.source', { path: p.path, source: srcText }) }, projName),
            React.createElement('span', { key: 'inj', className: 'lspi-set-hint', style: { flex: 'none' } }, injText),
          ]),
          React.createElement('div', { key: 'sub', className: 'lspi-card-sub', title: p.path }, p.path),
          React.createElement('div', { key: 'lsp', className: 'lspi-chips' },
            chips.length ? chips : [React.createElement('span', { key: 'e', className: 'lspi-empty-lsp' }, T('settings.card.unbound'))]),
          React.createElement('div', { key: 'foot', className: 'lspi-card-foot' }, [
            addPicker ? React.createElement('span', { key: 'addbar', style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, [
              React.createElement('span', { key: 'l', className: 'lspi-set-hint' }, T('settings.card.manualAdd')),
              addPicker[0],
              addPicker[1],
            ]) : null,
            canBridge ? React.createElement('button', {
              type: 'button', className: 'lspi-set-btn', disabled: !!s.busy,
              title: T('settings.card.bridge.install.title'),
              onClick: function () { doInstallAddon(p.path) },
            }, s.busy === 'addon:' + p.path ? T('settings.busy') : T('settings.card.bridge.install')) : null,
            canBridge ? React.createElement('button', {
              type: 'button', className: 'lspi-set-btn', disabled: !!s.busy,
              title: T('settings.card.bridge.check.title'),
              onClick: function () { doCheckBridge(p.path) },
            }, s.busy === 'bridge:' + p.path ? T('settings.busy') : T('settings.card.bridge.check')) : null,
            React.createElement('button', {
              type: 'button', className: 'lspi-set-btn', disabled: !!s.busy,
              title: T('settings.card.smart.title'),
              onClick: function () { doSmart(p.path) },
            }, s.busy === 'smart:' + p.path ? T('settings.busy') : T('settings.card.smart')),
            manualOverride ? React.createElement('button', {
              type: 'button', className: 'lspi-set-btn danger', disabled: !!s.busy,
              title: T('settings.card.removeManual.title'),
              onClick: function () { doRemoveManual(p.path) },
            }, s.busy === 'delProject:' + p.path ? T('settings.busy') : T('settings.card.removeManual')) : React.createElement('button', {
              type: 'button', className: 'lspi-set-btn', disabled: !!s.busy,
              title: T('settings.card.reset.title'),
              onClick: function () { doReset(p.path) },
            }, s.busy === 'reset:' + p.path ? T('settings.busy') : T('settings.card.reset')),
          ]),
          React.createElement('div', { key: 'skip', className: 'lspi-card-foot' }, [
            React.createElement('span', { key: 'l', className: 'lspi-set-hint', style: { flex: 'none' } }, T('settings.card.skip.label')),
            React.createElement('input', {
              key: 'skipin', className: 'lspi-set-input', type: 'text',
              style: { flex: '1 1 200px', minWidth: 140 },
              placeholder: T('settings.card.skip.placeholder'),
              value: (function () {
                var d = s.skipDraft || {}
                if (Object.prototype.hasOwnProperty.call(d, p.path)) return d[p.path]
                return typeof p.skipDirs === 'string' ? p.skipDirs : ''
              })(),
              disabled: !!s.busy,
              title: T('settings.card.skip.title', {
                forced: ((p.forcedSkip || [])).join(', '),
                effective: ((p.effectiveSkip || [])).join(', ') || T('note.skip.none'),
              }),
              onChange: function (ev) {
                var nd = Object.assign({}, s.skipDraft)
                nd[p.path] = ev.target.value
                set({ skipDraft: nd })
              },
            }),
            React.createElement('button', {
              key: 'saveskip', type: 'button', className: 'lspi-set-btn',
              disabled: !!s.busy || !Object.prototype.hasOwnProperty.call(s.skipDraft || {}, p.path),
              title: T('settings.card.skip.save.title'),
              onClick: function () { saveProjectSkip(p.path) },
            }, s.busy === 'skip:' + p.path ? T('settings.busy') : T('settings.card.skip.save')),
            // 输入框只显示「这个项目自己设的值」,空框既可能是继承全局、也可能
            // 是显式清空,所以把当前实际生效的列表单独标出来。
            React.createElement('span', { key: 'skipnow', className: 'lspi-set-hint', style: { flex: 'none' } },
              T('settings.card.skip.effective', { list: ((p.effectiveSkip || [])).join(', ') || T('note.skip.none') })),
          ]),
          // 检测结果就地贴在这一行下面:按钮在哪,反馈就在哪
          (canBridge && s.bridgeInfo[p.path])
            ? React.createElement('div', {
              key: 'bridgeinfo', className: 'lspi-set-hint',
              style: {
                marginTop: 2,
                color: s.bridgeInfo[p.path].pending ? '#6b7280' : (s.bridgeInfo[p.path].online ? '#15803d' : '#b45309'),
              },
            }, bridgeInfoText(p.path))
            : null,
        ])
      })

      var addEngineOptions = s.engines.map(function (e) {
        return React.createElement('option', { key: e.id, value: e.id }, e.name + ' (' + e.extensions.join(' ') + ')')
      })
      // 登记下拉:DSH 工作区全部根 + 根下命中引擎的项目(已登记的在选项里禁用)
      var candidateOpts = (function () {
        var opts = []
        if (!s.candidates.length) {
          opts.push(React.createElement('option', { key: '_none', value: '', disabled: true }, T('settings.projects.none')))
        } else {
          opts.push(React.createElement('option', { key: '_ph', value: '', disabled: true }, T('settings.projects.choose')))
          for (var ci = 0; ci < s.candidates.length; ci++) {
            var cand = s.candidates[ci]
            opts.push(React.createElement('option', { key: cand.path, value: cand.path, disabled: !!cand.registered },
              (cand.title || cand.path) + (cand.registered ? T('settings.projects.registered') : '')))
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
            T('settings.global.autoInject.label'),
          ]),
          React.createElement('div', { key: 'hint', className: 'lspi-set-hint' }, renderParts('settings.global.autoInject.hint', null, 3)),
        ]),
        // 全局自动安装引擎桥(addon)开关
        React.createElement('div', { key: 'addon', className: 'lspi-global-row' }, [
          React.createElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontWeight: 600 } }, [
            React.createElement('input', {
              type: 'checkbox', checked: s.autoAddon,
              onChange: toggleAddon,
            }),
            T('settings.global.autoAddon.label'),
          ]),
          React.createElement('div', { key: 'hint', className: 'lspi-set-hint' }, renderParts('settings.global.autoAddon.hint', null, 4)),
        ]),
        // 操作结果提示:放整页顶部,引擎卡/项目卡的操作都能看到
        s.note ? React.createElement('p', { key: 'note', className: 'lspi-set-hint', style: { color: '#1d4ed8', margin: '0 0 6px' } }, noteText(s.note)) : null,
        // 说明(独立卡):项目 = 目录,含语言,每语言一个 LSP
        React.createElement('div', { key: 'about', className: 'lspi-set-card' }, [
          React.createElement('h3', null, T('settings.about.title')),
          React.createElement('div', { className: 'lspi-set-hint' }, renderParts('settings.about.body', null, 4)),
          React.createElement('div', { className: 'lspi-set-hint', style: { marginTop: 6 } }, renderParts('settings.about.config', null, 4)),
        ]),
        // 项目卡片(项目为主:一项目一卡)
        React.createElement('div', { key: 'projects', className: 'lspi-set-card' }, [
          React.createElement('h3', null, T('settings.projects.title')),
          cards.length ? React.createElement('div', { key: 'cards', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, cards) : null,
          React.createElement('div', { key: 'addrow', className: 'lspi-set-row', style: { marginTop: 10, borderBottom: 0 } }, [
            React.createElement('span', { key: 'lab', className: 'lspi-set-hint', style: { flex: 'none' } }, T('settings.projects.register')),
            React.createElement('select', {
              className: 'lspi-set-select', style: { maxWidth: 300 },
              value: s.addSelPath || '',
              disabled: !!s.busy || !s.candidates.length,
              title: T('settings.projects.register.title'),
              onChange: function (ev) { set({ addSelPath: ev.target.value }) },
            }, candidateOpts),
            React.createElement('select', {
              className: 'lspi-set-select', value: s.newEngine,
              onChange: function (ev) { set({ newEngine: ev.target.value }) },
            }, addEngineOptions),
            React.createElement('button', {
              type: 'button', className: 'lspi-set-btn', disabled: !!s.busy || !s.addSelPath,
              title: T('settings.projects.add.title'),
              onClick: doAddProject,
            }, s.busy.indexOf('add:') === 0 ? T('settings.projects.adding') : T('settings.projects.add')),
            React.createElement('button', {
              type: 'button', className: 'lspi-set-btn', disabled: !!s.busy,
              title: T('settings.projects.smartAll.title'),
              onClick: doSmartAll,
            }, s.busy.indexOf('smart-all') === 0 ? T('settings.projects.smartAlling') : T('settings.projects.smartAll')),
          ]),
        ]),
        // 引擎列表(每引擎一行:标识 + 编辑器 LSP 端口)
        React.createElement('div', { key: 'eng', className: 'lspi-set-card' }, [
          React.createElement('h3', null, T('settings.engines.title')),
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            s.engines.map(engineRow)),
          React.createElement('div', { className: 'lspi-set-hint', style: { marginTop: 8 } },
            renderParts('settings.engines.body', null, 4)),
        ]),
      ])
    }

    // ---------- i18n(本插件自带词典) ----------
    // 词典是 lib/locales/<lang>.json,由 Host 经 action=locales 提供:本文件是零构建
    // 产物,只能 require 'react',无法直接读 JSON。拿到后注册进 Client 的 `locale`
    // 服务,语言即跟随用户在 DSH 设置里选的那一项。`locale` 不存在时(极简组合)退回
    // 用 API 返回的当前语言词典,插件照常可用 —— 少一个服务不该让设置页变空。
    var I18N_NS = 'lsp-echo'
    var allDicts = {}        // lang -> dict(Host 发来的全部语言)
    var localDict = {}       // 当前语言的词典(locale 服务缺席时的兜底)
    var tFn = null           // locale.bind 返回的翻译函数
    var localeService = null
    var localeRevision = createSignal(0)
    var currentLang = 'zh'
    var reportedLang = null  // 已告知 Host 的语言;null = 还没报过

    function fillParams(text, params) {
      if (!params) return text
      return String(text).replace(/\{(\w+)\}/g, function (whole, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
      })
    }
    // 翻译。locale 服务未命中时原样返回 key,此时用本地词典再试一次。
    function t(key, params) {
      // 数组值(分段文案)一律本地处理:locale 服务的词典契约是 Record<string,
      // string>,它的 translate 在带 params 时会对值执行 template.replace,数组会
      // 抛 TypeError。分段文案本来就由 renderParts/tParts 呈现,不经过服务。
      var local = localDict[key]
      if (Array.isArray(local)) return local.map(function (x) { return fillParams(x, params) })
      if (tFn) {
        var hit = tFn(key, params)
        if (hit !== key) return hit
      }
      if (local !== undefined) return fillParams(local, params)
      // 产品对 'en' 的 fallback 链终止于自身(它的 FALLBACK_LOCALE),而 Host 侧
      // en 缺键时会回落到 zh。两边不一致的后果是:同一个键在 toast 里显示中文、
      // 在 GUI 里显示裸 key。这里补上同一层回落,让两侧行为一致。
      var source = allDicts.zh && allDicts.zh[key]
      if (source === undefined) return key
      return Array.isArray(source)
        ? source.map(function (x) { return fillParams(x, params) })
        : fillParams(source, params)
    }
    // 段落:值是多段说明时逐段取出,渲染成多行,而不是挤成一大段。
    function tParts(key, params) {
      var v = t(key, params)
      return Array.isArray(v) ? v : [v]
    }
    // 把段落渲染成一组块元素;首段无上边距,其余段之间留 gap。
    function renderParts(key, params, gap) {
      return tParts(key, params).map(function (line, i) {
        return React.createElement('div', { key: 'p' + i, style: i ? { marginTop: gap } : null }, line)
      })
    }
    function syncLocalDict() {
      localDict = allDicts[currentLang] || allDicts.zh || {}
    }
    // Host 发 toast 时没有语言信息,由这里告知;失败则下次重试,否则 toast 会一直
    // 停在 Host 的默认语言上,而 GUI 已经是另一种语言。走 apiGet 以复用信任头。
    function reportLocaleToHost() {
      if (reportedLang === currentLang) return
      reportedLang = currentLang
      apiGet('setLocale', null, { locale: currentLang }).then(function (d) {
        if (!d || d.ok !== true) reportedLang = null // 下一次注册/切换语言时再试
      })
    }
    // 语言变化:换本地词典并触发重渲染。上报独立于这一切 —— 语言没变时也要报,
    // 因为"没变"只是相对本模块的初值,Host 那边可能还不知道。
    function applyLocale() {
      if (localeService && typeof localeService.getLocale === 'function') {
        var snapshot
        try { snapshot = localeService.getLocale() } catch (e) { snapshot = null }
        var next = (snapshot && snapshot.active) || currentLang
        if (next !== currentLang) {
          currentLang = next
          if (typeof localeService.bind === 'function') tFn = localeService.bind(I18N_NS)
          syncLocalDict()
          localeRevision.set(localeRevision.get() + 1)
        }
      }
      reportLocaleToHost()
    }
    function installI18n(ctx) {
      var api = ctx.get('locale')
      if (api && typeof api.register === 'function') localeService = api
      // 词典注册是框架侧的可撤销贡献,而它在这里是异步完成的(词典来自 API)。
      // 把 disposer 收进 effect:重复 apply 或插件卸载时不会留下重复注册和累积订阅
      // —— 重复的 (ns, locale) 会直接抛,把后面的 bind/subscribe 全部跳过。
      var disposers = []
      ctx.effect(function () {
        return function () {
          // 定时器也要撤:插件停用后它还会去 register 词典,而那时 disposers 已经是
          // 死实例的数组,注册下来的东西再也撤不掉。
          if (loadRetryTimer) clearTimeout(loadRetryTimer)
          loadRetryTimer = null
          for (var i = 0; i < disposers.length; i++) {
            try { disposers[i]() } catch (e) { /* 已失效 */ }
          }
          disposers = []
        }
      })
      var attempt = 0
      var loadRetryTimer = null
      function loadDictionaries() {
        apiGet('locales').then(function (d) {
          if (!d || !d.ok || !d.locales) throw new Error('locales unavailable')
          allDicts = d.locales
          if (localeService) {
            var ids = Object.keys(allDicts)
            for (var i = 0; i < ids.length; i++) {
              // 只把字符串值交给服务:它的词典契约是 Record<string, string>,带 params
              // 时会对值执行 template.replace,数组会抛 TypeError。分段文案本来就由
              // renderParts/tParts 从本地词典取值,不进服务,少注册它们没有损失。
              var dict = allDicts[ids[i]] || {}
              var strings = {}
              for (var k in dict) {
                if (Object.prototype.hasOwnProperty.call(dict, k) && typeof dict[k] === 'string') strings[k] = dict[k]
              }
              // 单个语言注册失败(例如已被占用)不该拖垮其余语言
              try {
                var off = localeService.register(I18N_NS, ids[i], strings)
                if (typeof off === 'function') disposers.push(off)
              } catch (e) { /* 该语言已有归属,用现有词典继续 */ }
            }
            if (typeof localeService.bind === 'function') tFn = localeService.bind(I18N_NS)
            if (typeof localeService.subscribe === 'function') {
              var unsub = localeService.subscribe(applyLocale)
              if (typeof unsub === 'function') disposers.push(unsub)
            }
          }
          currentLang = d.active || currentLang
          syncLocalDict()
          applyLocale()
          localeRevision.set(localeRevision.get() + 1)
        }).catch(function () {
          // 词典是文案的唯一来源,拿不到就整站显示裸 key:退避重试几次,而不是
          // 永久停在 key 上(其它 API 有轮询兜底,这一条没有)。
          if (attempt++ >= 5) return
          loadRetryTimer = setTimeout(loadDictionaries, 2000 * attempt)
        })
      }
      loadDictionaries()
    }
    // 订阅语言:注册词典或切换语言都会 bump locale revision,组件因此重渲染。
    function useT() {
      useSignal(localeRevision)
      return t
    }

    // ============================================================
    // 装载
    // ============================================================
    function apply(ctx) {
      var slots = ctx.get('slots')
      if (!slots) return
      installI18n(ctx)
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
        // 设置页(侧栏设置 → LSP 诊断)。
        // label 是注册参数,由外壳在读数时经 resolveSlotLabel 调用;本插件的词典是
        // 异步取回的(零构建产物读不了 JSON,只能走 API),若在词典到达前注册,首帧
        // 的 label 会原样返回 key —— 导航里就会出现一个 settings.title。外壳确实会
        // 随 locale revision 重算,但那是把正确性外包给别人的时序。这里改为等词典
        // 就绪再注册:导航项晚出现几百毫秒,好过一个盯着用户看的英文键名。
        var removeSection = null
        var sectionOff = null
        function registerSection() {
          if (typeof removeSection === 'function') {
            try { removeSection() } catch (e) { /* 已失效 */ }
          }
          removeSection = slots.inject('settings.section', function () {
            return slots.register(
              { name: 'settings.section', id: 'lsp-echo', order: 30, label: function () { return t('settings.title') } },
              SettingsPanel,
            )
          })
          if (typeof removeSection === 'function') removers.push(removeSection)
        }
        // 词典始终取不到时(API 异常)也必须让设置页出现,否则用户连"这个插件坏了"
        // 都看不到 —— 超时后照样注册,标签退化成 key 是可接受的。
        function sectionDictionariesReady() { return Object.keys(allDicts).length > 0 }
        if (sectionDictionariesReady()) {
          registerSection()
        } else {
          var sectionTries = 0
          sectionOff = setInterval(function () {
            sectionTries += 1
            if (!sectionDictionariesReady() && sectionTries < 12) return
            clearInterval(sectionOff)
            sectionOff = null
            registerSection()
          }, 250)
          removers.push(function () { if (sectionOff) clearInterval(sectionOff) })
        }
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
    // `locale` is a hard injection: it is a product plugin that is always mounted,
    // and waiting for the service (rather than reading it once with ctx.get) is
    // what lets this plugin activate after it — otherwise ctx.get('locale') runs
    // before the service exists, and the whole UI silently falls back to keys.
    exports.inject = ['slots', 'locale']
    exports.apply = apply

    return module.exports
  },
})
