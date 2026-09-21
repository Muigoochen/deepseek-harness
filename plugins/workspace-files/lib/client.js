// workspace-files — browser half. 工作区文件树插件的“GUI 脚本”。
//
// 产物契约(dsh.client closure-factory,见 plugins/workspace-files/docs):
//   - 本文件即最终产物,零构建;id 必须精确等于包名 '@dsh-user/workspace-files';
//   - 运行期只 require 平台种子 'react'(模块表:react 家族/cordis/store/ui-slots/ui-primitives);
//   - inject=['slots'];静态 ctx 没有 'timer' 服务 → 一律用浏览器定时器 + ctx.effect 清理;
//   - 组件是纯 props;跨洞共享 UI 状态(抽屉开关/拖拽提示)经本插件 module 级信号同步。
//
// 行为:
//   - sidebar.footer.action:侧栏底部开关,切换左侧浮出抽屉(openSignal);
//   - shell.overlay:抽屉 —— 顶部工作区切换,主体「对话 / 文件树」两个可折叠子级;
//     文件树经 fetch GET /workspace-files/list?ws=<workspaceId>&path=<posix-rel> 懒加载单层,
//     目录优先、隐藏/排除目录过滤、按工作区记忆展开(写 localStorage);
//   - conversation.input.overlay:拖放落点提示;窗口捕获层 drop 拦截(仅当载荷为
//     application/x-dsh-ftree 且目标落在 [data-composer-card] 内) → inputActions.setDraft
//     在草稿末尾追加 '@相对路径'(空格自动引号,目录带尾斜杠;跨工作区降级绝对路径)。
//     插入语义 = @文本(与模型侧一致);结构化 chip 需产品输入 seam,不做。
//
// React 纪律:条件渲染必须拆成「外层订阅 + 内层实体」,保证每个挂载组件每次渲染
// 的 hooks 数量一致。

window.__ModuleLoader__.load({
  id: '@dsh-user/workspace-files',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')

    // ---------- 常量 ----------
    var FTREE_MIME = 'application/x-dsh-ftree'
    var UI_KEY = 'dsh-workspace-files.ui'
    var EXCLUDED_DIRS = [
      'node_modules', '.git', 'dist', 'build', 'coverage', '.venv', '__pycache__',
      '.next', '.cache', '.idea', 'out', 'target',
    ]
    var LIST_ROUTE = '/workspace-files/list'

    // ---------- 极简信号(module 级;多洞共享 UI 状态) ----------
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
    var openSignal = createSignal(false)
    var dragSignal = createSignal(null) // {label,kind} | null

    /** 组件内订阅 module 信号(React.useState + useEffect subscribe)。 */
    function useSignal(signal) {
      var pair = React.useState(signal.get())
      var value = pair[0]
      var setValue = pair[1]
      React.useEffect(function () {
        return signal.subscribe(setValue)
      }, [signal])
      return value
    }

    // ---------- 样式(插件自持,卸载即移除) ----------
    var STYLE_TEXT = [
      '.wsf-drawer{position:absolute;top:0;bottom:0;left:0;width:308px;max-width:calc(100vw - 96px);display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,#fff);border-right:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));color:var(--dsw-alias-label-primary,#1f2328);box-shadow:8px 0 24px rgba(0,0,0,.14);z-index:5;font-size:13px;line-height:1.5;}',
      '.wsf-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));}',
      '.wsf-title{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.wsf-iconbtn{flex:none;border:0;background:transparent;color:inherit;cursor:pointer;font-size:15px;line-height:1;padding:4px 6px;border-radius:6px;opacity:.7;}',
      '.wsf-iconbtn:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
      '.wsf-wsbar{display:flex;gap:4px;padding:8px;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));}',
      '.wsf-wschip{flex:none;max-width:170px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:transparent;color:inherit;cursor:pointer;font-size:12px;padding:3px 8px;border-radius:999px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.wsf-wschip.wsf-on{background:var(--dsw-alias-state-business-primary,#4176e6);border-color:transparent;color:#fff;}',
      '.wsf-body{flex:1;min-height:0;overflow:auto;padding:6px 0 12px;}',
      '.wsf-sec{margin:6px 0 0;}',
      '.wsf-sechead{display:flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;color:inherit;cursor:pointer;text-align:left;padding:6px 12px;font-size:13px;border-radius:6px;}',
      '.wsf-sechead:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.wsf-caret{flex:none;width:12px;text-align:center;opacity:.6;font-size:11px;}',
      '.wsf-secname{flex:1;font-weight:600;}',
      '.wsf-seccount{flex:none;opacity:.55;font-size:12px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.wsf-chips{display:flex;gap:4px;padding:2px 12px 6px;}',
      '.wsf-chip{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:transparent;color:inherit;cursor:pointer;font-size:11px;padding:1px 7px;border-radius:999px;opacity:.8;}',
      '.wsf-chip.wsf-on{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));}',
      '.wsf-sess{padding:4px 12px 4px 30px;cursor:pointer;border-radius:6px;display:flex;align-items:center;gap:6px;min-width:0;}',
      '.wsf-sess:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.wsf-sessname{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.wsf-run{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);}',
      '.wsf-empty{padding:6px 12px 6px 30px;opacity:.55;}',
      '.wsf-row{display:flex;align-items:center;gap:4px;padding:2px 6px 2px 0;border-radius:5px;cursor:default;white-space:nowrap;min-width:0;}',
      '.wsf-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.wsf-tgl{flex:none;width:14px;text-align:center;color:inherit;background:transparent;border:0;cursor:pointer;font-size:11px;opacity:.65;padding:0;}',
      '.wsf-ic{flex:none;opacity:.9;}',
      '.wsf-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;}',
      '.wsf-name.wsf-dir{font-weight:500;}',
      '.wsf-name.wsf-hid{opacity:.55;}',
      '.wsf-load{color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.wsf-err{color:var(--dsw-alias-state-error-primary,#ec1313);padding:4px 12px;font-size:12px;word-break:break-all;}',
      '.wsf-hint{position:absolute;left:8px;right:8px;top:0;transform:translateY(-100%);pointer-events:none;background:var(--dsw-alias-bg-layer-3,#fff);border:1px dashed var(--dsw-alias-state-business-primary,#4176e6);color:var(--dsw-alias-label-primary,#1f2328);border-radius:8px;padding:5px 10px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.12);z-index:3;}',
    ].join('\n')

    function installStyles() {
      var el = document.createElement('style')
      el.setAttribute('data-wsf-styles', 'true')
      el.textContent = STYLE_TEXT
      document.head.appendChild(el)
      return function removeStyles() {
        if (el.parentNode) el.parentNode.removeChild(el)
      }
    }

    // ---------- 小工具 ----------
    function httpGet(url) {
      if (typeof fetch === 'function') {
        return fetch(url, { cache: 'no-store' }).then(function (res) {
          if (!res.ok) return null
          return res.json()
        }).catch(function () { return null })
      }
      return new Promise(function (resolvePromise) {
        try {
          var xhr = new XMLHttpRequest()
          xhr.open('GET', url)
          xhr.onload = function () {
            try {
              resolvePromise(xhr.status >= 200 && xhr.status < 300 ? JSON.parse(xhr.responseText) : null)
            } catch (e) { resolvePromise(null) }
          }
          xhr.onerror = function () { resolvePromise(null) }
          xhr.send()
        } catch (e) { resolvePromise(null) }
      })
    }

    function loadJSON(key) {
      try {
        var raw = window.localStorage.getItem(key)
        if (raw === null) return null
        return JSON.parse(raw)
      } catch (e) { return null }
    }
    function saveJSON(key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)) } catch (e) { /* ignore */ }
    }

    /** 规范化路径比较(Windows 盘符大小写不敏感;去尾部分隔)。 */
    function normPath(p) {
      var s = String(p == null ? '' : p).replace(/[\\/]+$/, '')
      if (/^[A-Za-z]:/.test(s)) return s.toLowerCase()
      return s
    }
    function samePath(a, b) { return normPath(a) === normPath(b) }
    function isInside(abs, root) {
      var a = normPath(abs)
      var r = normPath(root)
      if (a === r) return true
      return a.indexOf(r + '\\') === 0 || a.indexOf(r + '/') === 0
    }
    function relFromAbs(abs, cwd) {
      var a = String(abs)
      var c = normPath(cwd)
      if (a.toLowerCase().indexOf(c) !== 0) return null
      return a.slice(c.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    }
    /** 路径可否按产品 @ 语法 mention(含 " 或控制字符 → 不可)。 */
    function canMention(rel) {
      if (rel === '') return false
      for (var i = 0; i < rel.length; i++) {
        var code = rel.charCodeAt(i)
        if (rel[i] === '"' || code < 0x20 || code === 0x7f) return false
      }
      return true
    }
    /** 空格自动引号(平衡引号;目录在引号内带尾斜杠)。 */
    function quoteMention(rel, isDir) {
      var s = isDir ? rel + '/' : rel
      return /\s/.test(s) ? '"' + s + '"' : s
    }
    /**
     * 由拖拽载荷构建插入文本,优先级:
     *   1) 载荷根 == 会话 cwd 或 == 会话所属工作区根 → '@相对路径'(目录带尾斜杠/空格引号);
     *   2) 载荷绝对路径落在会话 cwd 之内 → 以 cwd 为根的 '@相对路径';
     *   3) 否则(跨工作区/不可 mention)→ 绝对路径纯文本降级。
     * @param {object} payload  {root,rel,abs,kind}
     * @param {string|undefined} cwd 当前会话 cwd(可能缺失)
     * @param {string|undefined} sessionWsRoot 当前会话所属工作区根路径(可能缺失)
     */
    function buildInsertText(payload, cwd, sessionWsRoot) {
      if (!payload || typeof payload.rel !== 'string' || payload.rel === '') return null
      var isDir = payload.kind === 'directory'
      var sameRootAsCwd = !!(cwd && payload.abs && samePath(payload.root, cwd))
      var sameRootAsSession = !!(sessionWsRoot && payload.root && samePath(payload.root, sessionWsRoot))
      if (sameRootAsCwd || sameRootAsSession) {
        return canMention(payload.rel) ? '@' + quoteMention(payload.rel, isDir) : payload.abs
      }
      if (cwd && payload.abs && isInside(payload.abs, cwd)) {
        var rel = relFromAbs(payload.abs, cwd)
        if (rel !== null && canMention(rel)) return '@' + quoteMention(rel, isDir)
      }
      return payload.abs && payload.abs !== '' ? payload.abs : null
    }
    function endsWithSpace(s) { return /\s$/.test(s) }
    /** 目标是否为可编辑文本框(textarea/input/contenteditable)。 */
    function isEditable(el) {
      if (!el || !el.tagName) return false
      var tag = el.tagName.toUpperCase()
      if (tag === 'TEXTAREA' || tag === 'INPUT') return true
      return el.isContentEditable === true
    }
    /** 原生光标处插入(input/textarea 走 value+事件;contenteditable 走 execCommand)。 */
    function insertAtCaret(el, text) {
      try {
        var tag = el.tagName.toUpperCase()
        if (tag === 'TEXTAREA' || tag === 'INPUT') {
          var start = typeof el.selectionStart === 'number' ? el.selectionStart : (el.value || '').length
          var end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start
          var value = el.value || ''
          el.value = value.slice(0, start) + text + value.slice(end)
          try { el.setSelectionRange(start + text.length, start + text.length) } catch (err) { /* ignore */ }
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        }
        if (el.isContentEditable) {
          var ok = document.execCommand('insertText', false, text)
          if (!ok) {
            var sel = window.getSelection()
            if (sel && sel.rangeCount > 0) {
              var range = sel.getRangeAt(0)
              range.deleteContents()
              var node = document.createTextNode(text)
              range.insertNode(node)
              range.setStartAfter(node)
              range.collapse(true)
              sel.removeAllRanges()
              sel.addRange(range)
            }
          }
          return true
        }
      } catch (err) { /* 插入失败则交给默认 */ }
      return false
    }

    // ---------- 打开会话(apply 注入 ctx;点击时惰性取服务,避免激活时序问题) ----------
    var openSessionCall = null

    // ============================================================
    // 组件 1:sidebar.footer.action 开关
    // ============================================================
    function FooterToggle(props) {
      var open = useSignal(openSignal)
      var label = props.wide
        ? (open ? '收起文件树' : '文件树')
        : '\uD83D\uDCC1'
      return React.createElement('button', {
        type: 'button',
        title: open ? '收起工作区文件树' : '打开工作区文件树',
        'aria-pressed': open,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6,
          border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer',
          fontSize: 12, padding: '4px 6px', borderRadius: 6, maxWidth: '100%',
        },
        onClick: function () { openSignal.set(!openSignal.get()) },
      }, label)
    }

    // ============================================================
    // 组件 2:shell.overlay 抽屉(外层订阅开关;内层为挂载后才渲染的实体)
    // ============================================================
    function Drawer(props) {
      var open = useSignal(openSignal)
      if (!open) return null
      return React.createElement(DrawerPanel, props)
    }

    function DrawerPanel(props) {
      // ---- 框架数据(纯 props hooks) ----
      var sessionsState = props.useSessions(function (s) { return s }) // SessionListState
      var workspacesState = props.useWorkspaces(function (s) { return s }) // WorkspaceSnapshot
      var workspaces = (workspacesState && workspacesState.items) || []
      var byId = (sessionsState && sessionsState.byId) || {}
      var currentSessionId = sessionsState ? sessionsState.current : undefined

      // ---- 本地 UI 状态 + localStorage 持久化 ----
      var persisted = loadJSON(UI_KEY) || {}
      var statePair = React.useState(function () {
        return {
          wsId: persisted.selectedWsId || null,
          convOpen: persisted.convOpen !== false,
          treeOpen: persisted.treeOpen !== false,
          showHidden: !!persisted.showHidden,
          showExcluded: !!persisted.showExcluded,
          expanded: persisted.expanded || {},   // wsId -> [relPosix,...]
          byDir: {},                             // `${wsId}::${rel}` -> {entries|error}
          loading: {},                           // `${wsId}::${rel}` -> true
        }
      })
      var state = statePair[0]
      var setState = statePair[1]

      React.useEffect(function () {
        saveJSON(UI_KEY, {
          selectedWsId: state.wsId,
          convOpen: state.convOpen,
          treeOpen: state.treeOpen,
          showHidden: state.showHidden,
          showExcluded: state.showExcluded,
          expanded: state.expanded,
        })
      }, [state.wsId, state.convOpen, state.treeOpen, state.showHidden, state.showExcluded, state.expanded])

      // 默认选中:当前会话所在工作区,否则按 cwd 匹配,再退第一个
      React.useEffect(function () {
        if (workspaces.length === 0 || state.wsId) return
        var pick = null
        if (currentSessionId) {
          for (var i = 0; i < workspaces.length; i++) {
            var ws = workspaces[i]
            if (ws.sessionIds && ws.sessionIds.indexOf(currentSessionId) !== -1) { pick = ws; break }
          }
        }
        if (!pick && currentSessionId) {
          var sum = byId[currentSessionId]
          var cwd = sum ? sum.cwd : undefined
          if (cwd) {
            for (var j = 0; j < workspaces.length; j++) {
              if (workspaces[j].path && samePath(workspaces[j].path, cwd)) { pick = workspaces[j]; break }
            }
          }
        }
        if (!pick) pick = workspaces[0]
        if (pick) {
          setState(function (prev) { return prev.wsId ? prev : Object.assign({}, prev, { wsId: pick.workspaceId }) })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [workspaces, currentSessionId, byId, state.wsId])

      var selected = null
      for (var k = 0; k < workspaces.length; k++) {
        if (workspaces[k].workspaceId === state.wsId) { selected = workspaces[k]; break }
      }
      var wsId = selected ? selected.workspaceId : null
      var wsPath = selected ? selected.path : null
      var rootKey = wsId ? wsId + '::' : null

      // ---- 文件树:目录列举 ----
      var loadDir = function (rel) {
        if (!wsId) return
        var key = wsId + '::' + rel
        setState(function (prev) {
          if (prev.byDir[key] || prev.loading[key]) return prev
          var loading = Object.assign({}, prev.loading)
          loading[key] = true
          return Object.assign({}, prev, { loading: loading })
        })
        var url = LIST_ROUTE + '?ws=' + encodeURIComponent(wsId) + '&path=' + encodeURIComponent(rel)
        httpGet(url).then(function (data) {
          setState(function (prev) {
            var next = Object.assign({}, prev)
            var loading = Object.assign({}, next.loading)
            delete loading[key]
            next.loading = loading
            var byDir = Object.assign({}, next.byDir)
            if (data && Array.isArray(data.entries)) {
              byDir[key] = { entries: data.entries }
            } else {
              byDir[key] = { entries: null, error: (data && data.error) || 'load-failed' }
            }
            next.byDir = byDir
            return next
          })
        })
      }

      // 选中工作区且树区展开且根层未载 → 触发根列举
      var rootLoaded = rootKey ? state.byDir[rootKey] : undefined
      React.useEffect(function () {
        if (wsId && state.treeOpen && !rootLoaded && !state.loading[rootKey]) loadDir('')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [wsId, state.treeOpen, rootKey, rootLoaded, state.loading])

      var toggleDir = function (rel) {
        setState(function (prev) {
          var expanded = Object.assign({}, prev.expanded)
          var list = (expanded[wsId] || []).slice()
          var idx = list.indexOf(rel)
          if (idx !== -1) list.splice(idx, 1)
          else {
            list.push(rel)
            var key = wsId + '::' + rel
            if (!prev.byDir[key] && !prev.loading[key]) {
              // 异步补载该层
              setTimeout(function () { loadDir(rel) }, 0)
            }
          }
          expanded[wsId] = list
          return Object.assign({}, prev, { expanded: expanded })
        })
      }
      var isExpanded = function (rel) {
        var list = (state.expanded[wsId] || [])
        return list.indexOf(rel) !== -1
      }
      var passes = function (entry, isDir) {
        if (!state.showHidden && /^\./.test(entry.name)) return false
        if (isDir && !state.showExcluded && EXCLUDED_DIRS.indexOf(entry.name) !== -1) return false
        return true
      }

      var sepOf = function (p) { return p && p.indexOf('\\') !== -1 ? '\\' : '/' }
      var makeAbs = function (rootPath, rel) {
        if (!rel) return rootPath
        return String(rootPath).replace(/[\\/]+$/, '') + sepOf(rootPath) + rel.split('/').join(sepOf(rootPath))
      }

      // ---- 行组件(无自持状态;数据全在 DrawerPanel) ----
      function TreeRow(rowProps) {
        var label = rowProps.name
        var isDir = rowProps.isDir
        var abs = makeAbs(wsPath, rowProps.rel)
        var hidden = /^\./.test(label)
        return React.createElement('div', {
          className: 'wsf-row',
          style: { paddingLeft: 14 + rowProps.depth * 16 },
          draggable: true,
          onDragStart: function (e) {
            var payload = JSON.stringify({
              v: 1, root: wsPath, rel: rowProps.rel,
              abs: abs, name: label, kind: isDir ? 'directory' : 'file',
            })
            try {
              e.dataTransfer.setData(FTREE_MIME, payload)
              e.dataTransfer.setData('text/plain', abs)
              e.dataTransfer.effectAllowed = 'copy'
            } catch (err) { /* 忽略 */ }
            dragSignal.set({ label: label, kind: isDir ? 'directory' : 'file' })
          },
          onDragEnd: function () { dragSignal.set(null) },
          title: abs,
        }, [
          React.createElement('span', {
            key: 'tg', className: 'wsf-tgl', style: { visibility: isDir ? 'visible' : 'hidden' },
            onClick: function (e) {
              e.stopPropagation()
              if (isDir) rowProps.onToggle()
            },
          }, isDir ? (rowProps.expanded ? '▾' : '▸') : ''),
          React.createElement('span', { key: 'ic', className: 'wsf-ic' },
            isDir ? '\uD83D\uDCC1' : '\uD83D\uDCC4'),
          React.createElement('span', {
            key: 'nm', className: 'wsf-name' + (isDir ? ' wsf-dir' : '') + (hidden ? ' wsf-hid' : ''),
          }, label),
        ])
      }

      // ---- 树行递归 ----
      var renderRows = function (rel, depth) {
        var key = wsId + '::' + rel
        var data = state.byDir[key]
        if (data && Array.isArray(data.entries)) {
          var rows = []
          for (var i = 0; i < data.entries.length; i++) {
            var entry = data.entries[i]
            var isDir = entry.type === 'directory'
            if (!passes(entry, isDir)) continue
            var fullRel = rel === '' ? entry.name : rel + '/' + entry.name
            var expanded = isDir && isExpanded(fullRel)
            rows.push(React.createElement(TreeRow, {
              key: fullRel,
              name: entry.name,
              rel: fullRel,
              isDir: isDir,
              depth: depth,
              expanded: expanded,
              onToggle: function (r) {
                return function () { toggleDir(r) }
              }(fullRel),
            }))
            if (expanded) rows = rows.concat(renderRows(fullRel, depth + 1))
          }
          return rows
        }
        if (state.loading[key]) {
          return [React.createElement('div', {
            key: key + '-loading', className: 'wsf-load',
            style: { paddingLeft: 18 + depth * 16 },
          }, '…')]
        }
        if (data && data.error) {
          return [React.createElement('div', {
            key: key + '-error', className: 'wsf-err',
            style: { paddingLeft: 18 + depth * 16 },
          }, '加载失败: ' + data.error)]
        }
        return []
      }

      // ---- 组装 ----
      var sessionIds = (selected && selected.sessionIds) || []
      var convItems = sessionIds.map(function (sid) {
        var sum = byId[sid]
        return {
          id: sid,
          title: (sum && (sum.displayTitle || sum.title)) || sid,
          running: !!(sum && sum.running),
        }
      }).sort(function (a, b) { return a.title < b.title ? -1 : a.title > b.title ? 1 : 0 })

      var wsChips = workspaces.map(function (ws) {
        return React.createElement('button', {
          key: ws.workspaceId,
          type: 'button',
          className: 'wsf-wschip' + (ws.workspaceId === wsId ? ' wsf-on' : ''),
          title: ws.path || '',
          onClick: function () { setState(function (prev) { return Object.assign({}, prev, { wsId: ws.workspaceId }) }) },
        }, ws.title || ws.path || ws.workspaceId)
      })

      var treeBody = null
      if (rootLoaded && Array.isArray(rootLoaded.entries)) {
        treeBody = renderRows('', 0)
        if (treeBody.length === 0) {
          treeBody = React.createElement('div', { className: 'wsf-empty', style: { paddingLeft: 18 } }, '（空目录）')
        }
      } else if (rootLoaded && rootLoaded.error) {
        treeBody = React.createElement('div', { className: 'wsf-err', style: { paddingLeft: 18 } }, '加载失败: ' + rootLoaded.error)
      } else if (wsId && state.loading[rootKey]) {
        treeBody = React.createElement('div', { className: 'wsf-load', style: { paddingLeft: 18 } }, '加载中…')
      } else if (!wsId) {
        treeBody = React.createElement('div', { className: 'wsf-empty', style: { paddingLeft: 18 } }, '无可用工作区')
      }

      var treeSection = React.createElement('div', { key: 'tree', className: 'wsf-sec' }, [
        React.createElement('button', {
          key: 'h', type: 'button', className: 'wsf-sechead',
          onClick: function () { setState(function (p) { return Object.assign({}, p, { treeOpen: !p.treeOpen }) }) },
        }, [
          React.createElement('span', { key: 'c', className: 'wsf-caret' }, state.treeOpen ? '▾' : '▸'),
          React.createElement('span', { key: 'n', className: 'wsf-secname' }, '文件树'),
          React.createElement('span', { key: 'r', className: 'wsf-seccount' }, wsPath || ''),
        ]),
        state.treeOpen ? React.createElement('div', { key: 'chips', className: 'wsf-chips' }, [
          React.createElement('button', {
            key: 'h', type: 'button', className: 'wsf-chip' + (state.showHidden ? ' wsf-on' : ''),
            onClick: function () { setState(function (p) { return Object.assign({}, p, { showHidden: !p.showHidden }) }) },
          }, '显示隐藏'),
          React.createElement('button', {
            key: 'e', type: 'button', className: 'wsf-chip' + (state.showExcluded ? ' wsf-on' : ''),
            onClick: function () { setState(function (p) { return Object.assign({}, p, { showExcluded: !p.showExcluded }) }) },
          }, '含排除目录'),
        ]) : null,
        state.treeOpen ? React.createElement('div', { key: 'rows', style: { minHeight: 24, padding: '0 4px' } }, treeBody) : null,
      ])

      var convSection = React.createElement('div', { key: 'conv', className: 'wsf-sec' }, [
        React.createElement('button', {
          key: 'h', type: 'button', className: 'wsf-sechead',
          onClick: function () { setState(function (p) { return Object.assign({}, p, { convOpen: !p.convOpen }) }) },
        }, [
          React.createElement('span', { key: 'c', className: 'wsf-caret' }, state.convOpen ? '▾' : '▸'),
          React.createElement('span', { key: 'n', className: 'wsf-secname' }, '对话'),
          React.createElement('span', { key: 't', className: 'wsf-seccount' }, String(convItems.length)),
        ]),
        state.convOpen
          ? (convItems.length === 0
            ? React.createElement('div', { className: 'wsf-empty' }, '（暂无对话）')
            : convItems.map(function (item) {
              return React.createElement('div', {
                key: item.id,
                className: 'wsf-sess',
                title: item.id,
                onClick: function () { if (openSessionCall) openSessionCall(item.id) },
              }, [
                item.running ? React.createElement('span', { key: 'r', className: 'wsf-run' }) : null,
                React.createElement('span', { key: 'n', className: 'wsf-sessname' }, item.title),
              ])
            }))
          : null,
      ])

      var bodyChildren = [convSection, treeSection]

      return React.createElement('div', {
        className: 'wsf-drawer',
        role: 'complementary',
        'aria-label': '工作区文件树',
      }, [
        React.createElement('div', { key: 'head', className: 'wsf-head' }, [
          React.createElement('span', { key: 't', className: 'wsf-title' }, '工作区文件'),
          React.createElement('button', {
            key: 'x', type: 'button', className: 'wsf-iconbtn', title: '关闭',
            onClick: function () { openSignal.set(false) },
          }, '\u00d7'),
        ]),
        wsChips.length > 0
          ? React.createElement('div', { key: 'ws', className: 'wsf-wsbar' }, wsChips)
          : null,
        React.createElement('div', { key: 'body', className: 'wsf-body' }, bodyChildren),
      ])
    }

    // ============================================================
    // 组件 3:conversation.input.overlay 拖放落点 + 拦截插入
    // ============================================================
    function DropHint(props) {
      var drag = useSignal(dragSignal)
      var sessionId = props.sessionId

      // 当前输入态/会话 cwd;值同步进 ref 供事件处理器取最新
      var inputState = typeof props.useInput === 'function'
        ? props.useInput(function (s) { return s })
        : undefined
      var cwd = typeof props.useSessions === 'function'
        ? props.useSessions(function (s) {
          return s.byId[sessionId] ? s.byId[sessionId].cwd : undefined
        })
        : undefined
      // 会话所属工作区根路径(useWorkspaces 为全局 hook,会话洞同样可用):
      // cwd 缺失时仍能判定"同工作区 → 用 @相对路径"。
      var wsItems = typeof props.useWorkspaces === 'function'
        ? props.useWorkspaces(function (s) {
          return s.items || []
        })
        : undefined
      var sessionWsRoot = undefined
      if (Array.isArray(wsItems) && sessionId) {
        for (var wi = 0; wi < wsItems.length; wi++) {
          var wrow = wsItems[wi]
          if (wrow.sessionIds && wrow.sessionIds.indexOf(sessionId) !== -1) { sessionWsRoot = wrow.path; break }
        }
      }
      var draftRef = React.useRef('')
      var phaseRef = React.useRef('plain')
      var actionsRef = React.useRef(null)
      draftRef.current = (inputState && inputState.draft) || ''
      phaseRef.current = (inputState && inputState.phase) || 'plain'
      actionsRef.current = props.inputActions || null

      // 窗口捕获层 drop 拦截(编辑器自身不处理文本 drop;React onDrop 在兄弟锚点不触发)
      React.useEffect(function () {
        function hasType(dt, mime) {
          var types = dt.types
          if (!types) return false
          for (var i = 0; i < types.length; i++) {
            var t = types[i]
            if (t === mime || String(t).toLowerCase() === mime) return true
          }
          return false
        }
        function insert(text) {
          var actions = actionsRef.current
          if (!actions || typeof actions.setDraft !== 'function') return
          var phase = phaseRef.current
          if (phase === 'submitting' || phase === 'adjudicating') return
          var cur = draftRef.current
          var lead = cur !== '' && !endsWithSpace(cur) ? ' ' : ''
          actions.setDraft(cur + lead + text + ' ')
        }
        function onDrop(e) {
          var target = e.target
          var dt = e.dataTransfer
          if (!dt || !hasType(dt, FTREE_MIME)) return
          var inComposer = !!(target && target.closest && target.closest('[data-composer-card]'))
          var editableTarget = inComposer ? null : (isEditable(target) ? target : null)
          if (!inComposer && !editableTarget) return
          e.preventDefault()
          e.stopPropagation()
          dragSignal.set(null)
          var raw = null
          try { raw = dt.getData(FTREE_MIME) } catch (err) { raw = null }
          if (!raw) return
          var payload = null
          try { payload = JSON.parse(raw) } catch (err) { payload = null }
          if (!payload) return
          var text = buildInsertText(payload, cwd, sessionWsRoot)
          if (!text) return
          if (inComposer) {
            insert(text)
          } else {
            insertAtCaret(editableTarget, text)
          }
        }
        window.addEventListener('drop', onDrop, true)
        return function () { window.removeEventListener('drop', onDrop, true) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [cwd, sessionWsRoot])

      if (!drag) return null
      return React.createElement('div', {
        className: 'wsf-hint',
        role: 'status',
      }, '松开以插入引用: ' + drag.label + (drag.kind === 'directory' ? '/' : ''))
    }

    // ============================================================
    // 装载
    // ============================================================
    function apply(ctx) {
      var slots = ctx.get('slots')
      if (!slots) return
      // 会话打开:点击时惰性取服务(ui-session 提供可能晚于本插件激活)
      openSessionCall = function (sessionId) {
        var sessionsService = ctx.get('sessions')
        if (sessionsService && typeof sessionsService.open === 'function') {
          sessionsService.open(sessionId)
        }
      }

      ctx.effect(function () {
        var removeStyles = installStyles()
        var removers = []
        function injectSeat(seat, id, order, Comp) {
          var remove = slots.inject(seat, function () {
            return slots.register({ name: seat, id: id, order: order }, Comp)
          })
          if (typeof remove === 'function') removers.push(remove)
        }
        injectSeat('sidebar.footer.action', 'workspace-files-toggle', 60, FooterToggle)
        injectSeat('shell.overlay', 'workspace-files-drawer', 10, Drawer)
        injectSeat('conversation.input.overlay', 'workspace-files-drop', 30, DropHint)
        return function () {
          for (var i = 0; i < removers.length; i++) {
            try { removers[i]() } catch (e) { /* ignore */ }
          }
          if (typeof removeStyles === 'function') removeStyles()
          openSignal.set(false)
          dragSignal.set(null)
          openSessionCall = null
        }
      })
    }

    exports.name = 'workspace-files'
    exports.inject = ['slots']
    exports.apply = apply

    return module.exports
  },
})
