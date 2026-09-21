// smoke.mjs — 装载冒烟:在 Node 内模拟 window/document/react 后,
// 载入 lib/client.js 的闭包工厂,校验 exports 形状与 apply 注册的三个插槽。
// 用法:node tools/smoke.mjs
// 说明:不渲染组件(那需要真实浏览器/产品壳);只抓"顶层/apply 期"的引用错误。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const srcPath = join(here, '..', 'lib', 'client.js')
const source = readFileSync(srcPath, 'utf8')

let registration = null
const fakeWindow = {
  __ModuleLoader__: {
    load(reg) { registration = reg },
  },
}
// document 桩:installStyles() 需要
fakeWindow.document = {
  createElement(tag) {
    return {
      tagName: tag,
      attrs: {},
      parentNode: null,
      setAttribute(k, v) { this.attrs[k] = v },
      appendChild() {},
      removeChild() {},
    }
  },
  head: null,
}
fakeWindow.document.head = { appendChild() {} }
fakeWindow.localStorage = undefined

// react 桩:模块初始化与 apply 不调用组件,仅需模块级引用存在
const fakeReact = {
  createElement() { throw new Error('render smoke not covered') },
  useState() { throw new Error('render smoke not covered') },
  useEffect() { throw new Error('render smoke not covered') },
  useRef() { throw new Error('render smoke not covered') },
  Fragment: Symbol('Fragment'),
}

const sandbox = {
  window: fakeWindow,
  document: fakeWindow.document,
  localStorage: undefined,
  require(spec) {
    if (spec === 'react') return fakeReact
    throw new Error('unexpected require: ' + spec)
  },
  console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: srcPath })

if (!registration) throw new Error('smoke: __ModuleLoader__.load was never called')
if (registration.id !== '@dsh-user/workspace-files') {
  throw new Error('smoke: factory id mismatch: ' + registration.id)
}
const plugin = registration.factory((spec) => {
  if (spec === 'react') return fakeReact
  throw new Error('unexpected runtime require: ' + spec)
})
if (!plugin || plugin.name !== 'workspace-files' || typeof plugin.apply !== 'function') {
  throw new Error('smoke: bad exports: ' + JSON.stringify(plugin && plugin.name))
}
if (!Array.isArray(plugin.inject) || plugin.inject.indexOf('slots') === -1) {
  throw new Error('smoke: inject should list slots: ' + JSON.stringify(plugin.inject))
}

// apply:mock ctx,捕获 effect 后手动执行以校验三洞注册
const seenSeats = []
const ctx = {
  get(name) {
    if (name === 'slots') {
      return {
        inject(seat, callback) {
          seenSeats.push(seat)
          const remove = callback()
          return typeof remove === 'function' ? remove : () => {}
        },
        register(opts, Comp) {
          if (!opts || opts.name == null || opts.id == null) throw new Error('bad register opts')
          if (typeof Comp !== 'function') throw new Error('register without component')
          return () => {}
        },
      }
    }
    if (name === 'sessions') return undefined
    return undefined
  },
  effect(fn) {
    this._effects = this._effects || []
    this._effects.push(fn)
    return () => {}
  },
}
plugin.apply(ctx)
if (!ctx._effects || ctx._effects.length !== 1) throw new Error('smoke: expected exactly one ctx.effect')
ctx._effects[0]() // 执行 effect → 三洞 inject 走一遍
const expect = ['sidebar.footer.action', 'shell.overlay', 'conversation.input.overlay']
for (const seat of expect) {
  if (seenSeats.indexOf(seat) === -1) throw new Error('smoke: seat not registered: ' + seat)
}
console.log('smoke OK: id=%s, name=%s, inject=%j, seats=%j', registration.id, plugin.name, plugin.inject, seenSeats)
