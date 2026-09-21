// toast — browser half. 浮动提示插件的“GUI 脚本”。
//
// 产物契约(dsh.client closure-factory,见 docs/design.md §7):
//   - 本文件即最终产物,零构建;id 必须精确等于包名 '@dsh-user/toast';
//   - 运行期只 require 平台种子 'react',不 import 模块表外的任何 @deepseek-ai 值;
//   - inject=['slots'](静态 ctx 没有 'timer' 服务,定时一律用浏览器 setTimeout)。
//
// 行为:
//   - 注册进 shell.overlay(list 槽,加性,root 级,当前无静态占用)渲染右上角浮窗堆栈;
//   - 经 fetch 长询 '/toast/events?since=<seq>' 拉取 Host 半队列:答完立刻重挂、seq 去重、
//     失败按退避重试 —— 这是可替换 transport 的浏览器端(见 docs/design.md §5);
//   - 自动消失(悬停暂停)、手动关闭、进出场动画、kind 取色(主题变量 + 回退值)。

window.__ModuleLoader__.load({
  id: '@dsh-user/toast',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')

    // ---------- 样式(插件自持,卸载即移除) ----------
    var STYLE_TEXT = [
      '.toast-stack{position:fixed;top:12px;right:12px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;max-width:min(360px,calc(100vw - 24px));}',
      '.toast-card{pointer-events:auto;box-sizing:border-box;width:320px;max-width:100%;display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;background:var(--dsw-color-bg-elevated,#ffffff);color:var(--dsw-color-text,#1f2328);box-shadow:0 4px 16px rgba(0,0,0,.14);font-size:13px;line-height:1.5;animation:toast-in .18s ease-out;}',
      '.toast-card.toast-leave{opacity:0;transform:translateX(16px);transition:opacity .2s ease,transform .2s ease;}',
      '.toast-dot{flex:none;width:8px;height:8px;margin-top:5px;border-radius:50%;}',
      '.toast-info .toast-dot{background:#3b82f6;}.toast-success .toast-dot{background:#22c55e;}.toast-warning .toast-dot{background:#f59e0b;}.toast-error .toast-dot{background:#ef4444;}',
      '.toast-content{flex:1;min-width:0;word-break:break-word;}',
      '.toast-title{font-weight:600;}',
      '.toast-body{opacity:.92;}',
      '.toast-close{flex:none;border:0;background:transparent;color:inherit;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;margin:-2px -4px 0 0;opacity:.6;border-radius:6px;}',
      '.toast-close:hover{opacity:1;background:rgba(128,128,128,.18);}',
      '@keyframes toast-in{from{opacity:0;transform:translateX(24px);}to{opacity:1;transform:translateX(0);}}',
      '@media (prefers-color-scheme: dark){.toast-card{background:var(--dsw-color-bg-elevated,#23262d);color:var(--dsw-color-text,#e8e8ea);box-shadow:0 4px 16px rgba(0,0,0,.5);}}',
      '@media (prefers-reduced-motion: reduce){.toast-card{animation:none;transition:none;}}',
    ].join('\n')

    function installStyles() {
      var el = document.createElement('style')
      el.setAttribute('data-toast-styles', 'true')
      el.textContent = STYLE_TEXT
      document.head.appendChild(el)
      return function removeStyles() {
        if (el.parentNode) el.parentNode.removeChild(el)
      }
    }

    // ---------- 条目存储(页面本地,负责自动消失/悬停/动画后移除) ----------
    function createStore() {
      var list = [] // {local, ev, leaving}
      var clock = {} // local -> {handle, expiresAt, remaining, paused}
      var listeners = []
      var nextLocal = 1

      function notify() {
        var snapshot = list.slice()
        for (var i = 0; i < listeners.length; i++) listeners[i](snapshot)
      }

      function clearTimer(local) {
        var c = clock[local]
        if (c && c.handle !== null) { clearTimeout(c.handle); c.handle = null }
      }

      function arm(local, ms) {
        var c = clock[local]
        if (!c) return
        clearTimer(local)
        c.paused = false
        c.remaining = ms
        c.expiresAt = Date.now() + ms
        c.handle = setTimeout(function autoClose() { dismiss(local) }, ms)
      }

      function add(ev) {
        var local = nextLocal++
        list.push({ local: local, seq: typeof ev.seq === 'number' ? ev.seq : undefined, ev: ev, leaving: false })
        clock[local] = { handle: null, expiresAt: 0, remaining: 0, paused: false }
        if (typeof ev.durationMs === 'number' && ev.durationMs > 0) arm(local, ev.durationMs)
        notify()
        return local
      }

      function pause(local) {
        var c = clock[local]
        if (!c || c.paused || c.handle === null) return
        c.remaining = Math.max(0, c.expiresAt - Date.now())
        clearTimer(local)
        c.paused = true
      }

      function resume(local) {
        var c = clock[local]
        if (!c || !c.paused) return
        var ms = c.remaining > 0 ? c.remaining : 0
        c.paused = false
        if (ms > 0) arm(local, ms)
        else dismiss(local)
      }

      function dismiss(local) {
        clearTimer(local)
        delete clock[local]
        var idx = -1
        for (var i = 0; i < list.length; i++) {
          if (list[i].local === local) { idx = i; break }
        }
        if (idx === -1) return
        if (list[idx].leaving) return
        list[idx].leaving = true
        notify()
        setTimeout(function removeAfterAnimation() {
          for (var j = 0; j < list.length; j++) {
            if (list[j].local === local) { list.splice(j, 1); break }
          }
          notify()
        }, 220)
      }

      // Host-side dismissal (persistent toasts included): remove by event seq.
      function dismissBySeq(seq) {
        if (typeof seq !== 'number') return
        for (var i = 0; i < list.length; i++) {
          if (list[i].seq === seq && !list[i].leaving) {
            dismiss(list[i].local)
            return
          }
        }
      }

      function dispose() {
        for (var local in clock) clearTimer(Number(local))
        clock = {}
        list = []
        listeners = []
      }

      return {
        getItems: function () { return list.slice() },
        subscribe: function (fn) {
          listeners.push(fn)
          return function unsubscribe() {
            var i = listeners.indexOf(fn)
            if (i !== -1) listeners.splice(i, 1)
          }
        },
        add: add,
        pause: pause,
        resume: resume,
        dismiss: dismiss,
        dismissBySeq: dismissBySeq,
        dispose: dispose,
      }
    }
    var store = createStore()

    // ---------- 组件 ----------
    function ToastStack() {
      var pair = React.useState(store.getItems())
      var items = pair[0]
      var setItems = pair[1]
      React.useEffect(function () {
        return store.subscribe(setItems)
      }, [])
      if (items.length === 0) return null
      var children = []
      for (var i = 0; i < items.length; i++) {
        var item = items[i]
        children.push(React.createElement(ToastCard, { key: String(item.local), item: item }))
      }
      return React.createElement('div', { className: 'toast-stack' }, children)
    }

    function ToastCard(props) {
      var item = props.item
      var ev = item.ev
      var cls = 'toast-card toast-' + ev.kind + (item.leaving ? ' toast-leave' : '')
      var closeButton = ev.closable === false ? null : React.createElement('button', {
        className: 'toast-close',
        type: 'button',
        'aria-label': '关闭',
        onClick: function () { store.dismiss(item.local) },
      }, '\u00d7')
      var title = typeof ev.title === 'string' ? React.createElement('div', { className: 'toast-title' }, ev.title) : null
      var body = typeof ev.body === 'string' ? React.createElement('div', { className: 'toast-body' }, ev.body) : null
      var content = React.createElement('div', { className: 'toast-content' }, [title, body])
      return React.createElement('div', {
        className: cls,
        role: ev.kind === 'error' ? 'alert' : 'status',
        onMouseEnter: function () { store.pause(item.local) },
        onMouseLeave: function () { store.resume(item.local) },
      }, [
        React.createElement('span', { className: 'toast-dot' }),
        content,
        closeButton,
      ])
    }

    // ---------- transport:fetch 长询(答完立刻重挂,失败退避) ----------
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
            try { resolvePromise(xhr.status >= 200 && xhr.status < 300 ? JSON.parse(xhr.responseText) : null) }
            catch (e) { resolvePromise(null) }
          }
          xhr.onerror = function () { resolvePromise(null) }
          xhr.send()
        } catch (e) { resolvePromise(null) }
      })
    }

    function startPolling() {
      var alive = true
      var timer = null
      var inflight = false
      var failures = 0
      var SEQ_KEY = 'toast-last-seq'
      // Persist across browser refreshes so a page reload does not replay the
      // host's whole in-memory queue; host restart (seq reset) re-syncs below.
      var lastSeq = 0
      try { lastSeq = Number(window.sessionStorage.getItem(SEQ_KEY) || '0') || 0 } catch (e) { lastSeq = 0 }

      function schedule(ms) {
        if (!alive) return
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(run, ms)
      }

      function stop() {
        alive = false
        if (timer !== null) clearTimeout(timer)
        timer = null
      }

      function persistSeq() {
        try { window.sessionStorage.setItem(SEQ_KEY, String(lastSeq)) } catch (e) { /* storage unavailable: keep in-memory only */ }
      }

      function run() {
        if (!alive || inflight) return
        inflight = true
        httpGet('/toast/events?since=' + lastSeq).then(function (data) {
          inflight = false
          if (!alive) return
          if (data && Array.isArray(data.events)) {
            failures = 0
            for (var i = 0; i < data.events.length; i++) {
              var ev = data.events[i]
              if (ev && typeof ev.seq === 'number' && ev.seq > lastSeq) {
                lastSeq = ev.seq
                if (Array.isArray(ev.removedSeq)) {
                  for (var k = 0; k < ev.removedSeq.length; k++) store.dismissBySeq(ev.removedSeq[k])
                } else {
                  store.add(ev)
                }
              }
            }
            if (typeof data.maxSeq === 'number') {
              if (data.maxSeq < lastSeq) {
                // Host restarted and its sequence reset below ours: drop the
                // stale watermark and resync from the fresh queue.
                lastSeq = 0
                try { window.sessionStorage.removeItem(SEQ_KEY) } catch (e) { /* ignore */ }
                schedule(0)
                return
              }
              lastSeq = Math.max(lastSeq, data.maxSeq)
            }
            persistSeq()
            schedule(0)
          } else {
            failures += 1
            schedule(Math.min(1000 * (1 + Math.floor(failures / 5)), 5000))
          }
        })
      }

      schedule(0)
      return stop
    }

    // ---------- 插件装载 ----------
    function apply(ctx) {
      var slots = ctx.get('slots')
      if (!slots) return
      ctx.effect(function () {
        var removeStyles = installStyles()
        var removeInjection = slots.inject('shell.overlay', function () {
          return slots.register(
            { name: 'shell.overlay', id: 'toast-stack', order: 100 },
            ToastStack,
          )
        })
        var stopPolling = startPolling()
        return function cleanup() {
          stopPolling()
          store.dispose()
          if (typeof removeInjection === 'function') removeInjection()
          if (typeof removeStyles === 'function') removeStyles()
        }
      })
    }

    exports.name = 'toast'
    exports.inject = ['slots']
    exports.apply = apply

    return module.exports
  },
})
