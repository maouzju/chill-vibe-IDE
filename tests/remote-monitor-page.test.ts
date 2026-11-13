// 手机监工页（server/remote-monitor-page.ts）内联脚本的行为层测试。
//
// 这是什么：页面逻辑全在一段 ES5 风格的内联 <script> 里（IIFE + var/function），一个函数都
// 没导出，只能把整段脚本真跑起来，再看它对页面做了什么。这里从 renderRemoteMonitorPage()
// 的 HTML 里抠出脚本正文，用 node:vm 在沙箱里执行；测试扮演服务端：假 fetch 回快照 / 历史，
// 假 EventSource 由测试手动喂 stream 事件，然后断言标题、震动、提示条、徽章、详情页状态块、
// 停止按钮。重点守的是：App 在上下文快满时自己发的压缩回合（负载带 origin: 'auto-compact'）
// 结束时不打扰人，而普通回合照常提醒。
//
// 为什么要假 DOM：仓库没有 jsdom 之类的依赖，而脚本只碰一小撮 DOM API，手写够用。按页面
// <body> 的静态标记建一棵假元素树，getElementById / createElement / classList / textContent
// 等照浏览器语义实现，顺手记账：标题改过几次、提示条弹过几次、弹的是什么。setTimeout 由
// 虚拟时钟驱动，只记录不自动触发，且返回递增正整数（返回 undefined 的话 scheduleSnapshot
// 的 `if (snapshotTimer) return` 拦不住重复调度）。不给 Notification / AudioContext——页面
// 自己会判断有没有；系统通知和提示音因此观测不到，由同在 notifyFinished 里的「标题 / 震动 /
// 提示条」代表「提醒了没有」。
//
// 吞错的大坑：connect() 里是 `try { handleStreamEvent(JSON.parse(event.data)) } catch (e) {}`，
// loadSnapshot() 末尾还有 `.catch(function () {})`。假 DOM 缺个方法时，脚本抛的 TypeError 会被
// 悄悄吞掉，表现为「什么都没发生」——恰好让「不提醒」类断言假绿。所以：
//   1. 执行前把脚本副本里的空 catch 插桩成上报（只改测试里执行的那份字符串，不碰生产代码），
//      console.error / console.warn 一并收集，每条用例结尾断言一个都没有；
//   2. 装置自检：喂一帧坏 JSON、让快照解析失败，两处被吞的错都必须看得见；
//   3. 基线：普通流 done 必须真的提醒（标题 / 震动 / 提示条）、徽章变「已完成」，证明这套
//      假环境跑得通页面主路径，「没提醒」的断言才有分量。
import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import type { RemoteMonitorSnapshot } from '../server/remote-monitor.ts'
import { renderRemoteMonitorPage } from '../server/remote-monitor-page.ts'

type FakeEvent = { type: string; [key: string]: unknown }
type Listener = (event: FakeEvent) => void

const decodeEntities = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

const toCamelCase = (name: string) =>
  name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())

const describeError = (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'stack' in error && typeof error.stack === 'string') {
    return error.stack
  }
  return String(error)
}

// ---------------------------------------------------------------------------
// 假 DOM
// ---------------------------------------------------------------------------

class FakeClassList {
  private readonly owner: FakeElement

  constructor(owner: FakeElement) {
    this.owner = owner
  }

  add(...names: string[]) {
    for (const name of names) {
      if (!this.owner.classNames.includes(name)) {
        this.owner.classNames.push(name)
      }
    }
  }

  remove(...names: string[]) {
    this.owner.classNames = this.owner.classNames.filter((name) => !names.includes(name))
  }

  contains(name: string) {
    return this.owner.classNames.includes(name)
  }

  toggle(name: string, force?: boolean) {
    const next = force === undefined ? !this.contains(name) : Boolean(force)
    if (next) {
      this.add(name)
    } else {
      this.remove(name)
    }
    return next
  }
}

class FakeElement {
  readonly tagName: string
  readonly isTextNode: boolean
  readonly classList: FakeClassList
  id = ''
  classNames: string[] = []
  children: FakeElement[] = []
  parentNode: FakeElement | null = null
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  hidden = false
  disabled = false
  open = false
  value = ''
  type = ''
  scrollHeight = 0
  scrollTop = 0
  clientHeight = 0
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Listener[]>()
  // 每次写 textContent 记一笔：提示条弹了几次、弹的是什么，都靠它数。
  readonly textHistory: string[] = []
  private ownText = ''

  constructor(tagName: string, isTextNode = false) {
    this.tagName = isTextNode ? '#text' : tagName.toUpperCase()
    this.isTextNode = isTextNode
    this.classList = new FakeClassList(this)
  }

  static textNode(text: string) {
    const node = new FakeElement('#text', true)
    node.ownText = text
    return node
  }

  get className() {
    return this.classNames.join(' ')
  }

  set className(value: unknown) {
    this.classNames = String(value ?? '').split(/\s+/).filter(Boolean)
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('')
  }

  set textContent(value: unknown) {
    this.detachChildren()
    this.ownText = value === null || value === undefined ? '' : String(value)
    this.textHistory.push(this.ownText)
  }

  get innerText(): string {
    return this.textContent
  }

  set innerText(value: unknown) {
    this.textContent = value
  }

  get innerHTML(): string {
    return this.textContent
  }

  // 页面约定绝不用 innerHTML 插值 agent 输出；这里只按「清空后写纯文本」处理。
  set innerHTML(value: unknown) {
    this.textContent = String(value ?? '').replace(/<[^>]*>/g, '')
  }

  get childNodes() {
    return this.children
  }

  get firstChild() {
    return this.children[0] ?? null
  }

  get lastChild() {
    return this.children[this.children.length - 1] ?? null
  }

  get firstElementChild(): FakeElement | null {
    return this.children.find((child) => !child.isTextNode) ?? null
  }

  get lastElementChild(): FakeElement | null {
    return this.children.findLast((child) => !child.isTextNode) ?? null
  }

  get childElementCount() {
    return this.children.filter((child) => !child.isTextNode).length
  }

  get parentElement() {
    return this.parentNode
  }

  // 只给静态标记建树用：不记进 textHistory。
  appendText(text: string) {
    this.ownText += text
  }

  appendChild(child: FakeElement) {
    return this.insertBefore(child, null)
  }

  insertBefore(child: FakeElement, reference: FakeElement | null) {
    child.remove()
    const index = reference ? this.children.indexOf(reference) : -1
    if (index < 0) {
      this.children.push(child)
    } else {
      this.children.splice(index, 0, child)
    }
    child.parentNode = this
    return child
  }

  append(...nodes: unknown[]) {
    for (const node of nodes) {
      this.appendChild(toNode(node))
    }
  }

  prepend(...nodes: unknown[]) {
    const first = this.children[0] ?? null
    for (const node of nodes) {
      this.insertBefore(toNode(node), first)
    }
  }

  replaceChildren(...nodes: unknown[]) {
    this.detachChildren()
    this.ownText = ''
    this.append(...nodes)
  }

  removeChild(child: FakeElement) {
    const index = this.children.indexOf(child)
    if (index < 0) {
      throw new Error('假 DOM：removeChild 传进来的不是本元素的子节点')
    }
    this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  remove() {
    this.parentNode?.removeChild(this)
  }

  contains(node: unknown) {
    return isInside(node, this)
  }

  setAttribute(name: string, value: unknown) {
    const text = String(value)
    this.attributes.set(name, text)
    if (name === 'id') {
      this.id = text
    } else if (name === 'class') {
      this.className = text
    } else if (name === 'hidden') {
      this.hidden = true
    } else if (name === 'disabled') {
      this.disabled = true
    } else if (name === 'open') {
      this.open = true
    } else if (name === 'type') {
      this.type = text
    } else if (name === 'value') {
      this.value = text
    } else if (name.startsWith('data-')) {
      this.dataset[toCamelCase(name.slice(5))] = text
    }
  }

  getAttribute(name: string) {
    if (name === 'id') {
      return this.id || null
    }
    if (name === 'class') {
      return this.className || null
    }
    if (name === 'hidden') {
      return this.hidden ? '' : null
    }
    if (name === 'disabled') {
      return this.disabled ? '' : null
    }
    if (name.startsWith('data-')) {
      return this.dataset[toCamelCase(name.slice(5))] ?? null
    }
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string) {
    return this.getAttribute(name) !== null
  }

  removeAttribute(name: string) {
    this.attributes.delete(name)
    if (name === 'class') {
      this.classNames = []
    } else if (name === 'hidden') {
      this.hidden = false
    } else if (name === 'disabled') {
      this.disabled = false
    } else if (name === 'open') {
      this.open = false
    } else if (name.startsWith('data-')) {
      delete this.dataset[toCamelCase(name.slice(5))]
    }
  }

  toggleAttribute(name: string, force?: boolean) {
    const next = force === undefined ? !this.hasAttribute(name) : Boolean(force)
    if (next) {
      this.setAttribute(name, '')
    } else {
      this.removeAttribute(name)
    }
    return next
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener))
  }

  dispatchEvent(event: FakeEvent) {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      listener(event)
    }
    return true
  }

  // 测试专用：模拟一次用户操作。没有命中测试，调用方自己保证语义（比如别去点看不见的按钮）。
  fire(type: string) {
    this.dispatchEvent({ type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} })
  }

  click() {
    this.fire('click')
  }

  focus() {}

  blur() {}

  scrollIntoView() {}

  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }

  matches(selector: string) {
    return matchesSelector(this, selector)
  }

  closest(selector: string) {
    return closestOf(this, selector)
  }

  querySelectorAll(selector: string) {
    return descendantsOf(this).filter((element) => matchesSelector(element, selector))
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  private detachChildren() {
    for (const child of this.children) {
      child.parentNode = null
    }
    this.children = []
  }
}

const toNode = (node: unknown) => (node instanceof FakeElement ? node : FakeElement.textNode(String(node)))

const isInside = (node: unknown, container: FakeElement) => {
  for (let cursor = node instanceof FakeElement ? node : null; cursor; cursor = cursor.parentNode) {
    if (cursor === container) {
      return true
    }
  }
  return false
}

const descendantsOf = (root: FakeElement) => {
  const found: FakeElement[] = []
  const walk = (node: FakeElement) => {
    for (const child of node.children) {
      if (!child.isTextNode) {
        found.push(child)
        walk(child)
      }
    }
  }
  walk(root)
  return found
}

// 只支持「标签 / #id / .class 的组合」加后代组合符，够脚本和测试用；碰到别的直接报错，
// 报错会被吞错插桩收集到，不会悄悄当成「没匹配到」。
const matchesCompound = (element: FakeElement, compound: string) => {
  const parsed = /^([a-zA-Z][\w-]*|\*)?((?:[#.][\w-]+)*)$/.exec(compound)
  if (!parsed) {
    throw new Error(`假 DOM 不支持这个选择器：${compound}（需要的话扩展本测试的 matchesCompound）`)
  }
  const [, tag, rest] = parsed
  if (element.isTextNode) {
    return false
  }
  if (tag && tag !== '*' && element.tagName !== tag.toUpperCase()) {
    return false
  }
  return (rest.match(/[#.][\w-]+/g) ?? []).every((part) =>
    part.startsWith('#') ? element.id === part.slice(1) : element.classList.contains(part.slice(1)),
  )
}

const matchesSelector = (element: FakeElement, selector: string): boolean =>
  selector.split(',').some((single) => {
    const parts = single.trim().split(/\s+/)
    if (!matchesCompound(element, parts[parts.length - 1])) {
      return false
    }
    let cursor = element.parentNode
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      while (cursor && !matchesCompound(cursor, parts[index])) {
        cursor = cursor.parentNode
      }
      if (!cursor) {
        return false
      }
      cursor = cursor.parentNode
    }
    return true
  })

const closestOf = (element: FakeElement, selector: string) => {
  for (let cursor: FakeElement | null = element; cursor; cursor = cursor.parentNode) {
    if (matchesSelector(cursor, selector)) {
      return cursor
    }
  }
  return null
}

const VOID_TAGS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

// 把页面 <body> 的静态标记（去掉 <script>）建成假元素树：初始的 hidden / class / id 都照抄
// 真实标记，getElementById 找到的就是标记里那个元素，不会「凭空造一个」。
const buildStaticDom = (html: string) => {
  const bodyMatch = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)
  assert.ok(bodyMatch, '页面里找不到 <body>')
  const markup = bodyMatch[1].replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
  const documentElement = new FakeElement('html')
  const body = documentElement.appendChild(new FakeElement('body'))
  const stack: FakeElement[] = [body]
  for (const token of markup.matchAll(/<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g)) {
    const [, closingTag, openingTag, rawAttributes, text] = token
    const parent = stack[stack.length - 1]
    if (closingTag) {
      const index = stack.findLastIndex((element) => element.tagName === closingTag.toUpperCase())
      if (index > 0) {
        stack.length = index
      }
    } else if (openingTag) {
      const element = parent.appendChild(new FakeElement(openingTag))
      for (const attribute of rawAttributes.matchAll(/([^\s="'/]+)(?:\s*=\s*"([^"]*)")?/g)) {
        element.setAttribute(attribute[1], decodeEntities(attribute[2] ?? ''))
      }
      const selfClosing = /\/\s*$/.test(rawAttributes)
      if (!selfClosing && !VOID_TAGS.has(openingTag.toLowerCase())) {
        stack.push(element)
      }
    } else if (text && text.trim()) {
      parent.appendText(decodeEntities(text.trim()))
    }
  }
  return { documentElement, body }
}

// ---------------------------------------------------------------------------
// 吞错插桩：把空 catch（允许里面只有注释）改成上报。只改测试里执行的那份字符串。
// ---------------------------------------------------------------------------

const EMPTY_BLOCK = String.raw`\{(?:\s|//[^\n]*|/\*[\s\S]*?\*/)*\}`
const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`
const EMPTY_PROMISE_CATCH = new RegExp(
  String.raw`\.catch\(\s*(?:function\s*\(\s*(?:${IDENTIFIER})?\s*\)|\(\s*(?:${IDENTIFIER})?\s*\)\s*=>|${IDENTIFIER}\s*=>)\s*` +
    EMPTY_BLOCK +
    String.raw`\s*\)`,
  'g',
)
const EMPTY_TRY_CATCH = new RegExp(String.raw`catch\s*(?:\(\s*(${IDENTIFIER})\s*\))?\s*` + EMPTY_BLOCK, 'g')

const instrumentSwallowedErrors = (source: string) =>
  source
    .replace(EMPTY_PROMISE_CATCH, '.catch(function (__swallowed) { __reportSwallowed(__swallowed) })')
    .replace(EMPTY_TRY_CATCH, (_match, name: string | undefined) => {
      const binding = name ?? '__swallowed'
      return `catch (${binding}) { __reportSwallowed(${binding}) }`
    })

// ---------------------------------------------------------------------------
// 跑页面的装置
// ---------------------------------------------------------------------------

type StreamPayload = {
  streamId: string
  cardId?: string
  origin?: string
  event: string
  data?: unknown
}

type PendingTimer = { id: number; due: number; every: number; callback: () => void }

const CARD_ID = 'card-1'
const CARD_TITLE = '修复登录'

const buildSnapshot = (): RemoteMonitorSnapshot => ({
  generatedAt: 1,
  columns: [
    {
      id: 'col-1',
      title: '工作区 A',
      provider: 'claude',
      cards: [
        {
          id: CARD_ID,
          title: CARD_TITLE,
          provider: 'claude',
          model: 'claude-fable-5',
          // 故意是 idle：徽章若显示「运行中 / 已完成 / 出错」，只可能来自页面自己跟踪的流状态。
          status: 'idle',
        },
      ],
    },
  ],
})

// App 在上下文快满时自己发的 /compact 压缩回合。
const autoCompactEvent = (streamId: string, event: string, data: unknown = {}): StreamPayload => ({
  streamId,
  cardId: CARD_ID,
  origin: 'auto-compact',
  event,
  data,
})

// 普通回合（用户发的需求），负载里没有 origin。
const userTurnEvent = (streamId: string, event: string, data: unknown = {}): StreamPayload => ({
  streamId,
  cardId: CARD_ID,
  event,
  data,
})

// 用测试进程真的 setImmediate 冲干净微任务（沙箱里的 setTimeout 是假的）。
const flush = async () => {
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

const bootMonitorPage = async (options: { failSnapshot?: boolean } = {}) => {
  const html = renderRemoteMonitorPage()
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1])
  assert.ok(scripts.length > 0, '页面里找不到内联 <script>')
  const baseTitle = decodeEntities(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '')
  assert.ok(baseTitle, '页面里找不到 <title>')
  const { documentElement, body } = buildStaticDom(html)

  // 被吞掉的错误 + console.error / console.warn：每条用例结尾都要求为空。
  const pageErrors: string[] = []
  const reportPageError = (error: unknown) => {
    pageErrors.push(describeError(error))
  }

  const findById = (id: string) => descendantsOf(body).find((element) => element.id === id) ?? null
  const byId = (id: string) => {
    const element = findById(id)
    assert.ok(element, `页面里找不到 #${id}`)
    return element
  }

  // 标题：每次被写都记一笔，「改了几次、改成了什么」一目了然。
  const titleHistory: string[] = []
  let title = baseTitle
  const documentListeners = new Map<string, Listener[]>()
  const fakeDocument = {
    documentElement,
    body,
    hidden: false,
    visibilityState: 'visible',
    get title() {
      return title
    },
    set title(value: string) {
      title = String(value)
      titleHistory.push(title)
    },
    createElement: (tagName: string) => new FakeElement(tagName),
    createTextNode: (text: string) => FakeElement.textNode(String(text)),
    getElementById: findById,
    querySelector: (selector: string) => documentElement.querySelector(selector),
    querySelectorAll: (selector: string) => documentElement.querySelectorAll(selector),
    addEventListener: (type: string, listener: Listener) => {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener])
    },
    removeEventListener: (type: string, listener: Listener) => {
      documentListeners.set(type, (documentListeners.get(type) ?? []).filter((item) => item !== listener))
    },
    hasFocus: () => true,
  }

  // 虚拟时钟：定时器只记录，测试用 advance() 推进时间时才按到期顺序触发。
  let clock = 0
  let nextTimerId = 0
  const timers = new Map<number, PendingTimer>()
  const schedule = (callback: unknown, delay: unknown, repeat: boolean) => {
    nextTimerId += 1
    const wait = Math.max(0, Number(delay) || 0)
    timers.set(nextTimerId, {
      id: nextTimerId,
      due: clock + wait,
      every: repeat ? Math.max(1, wait) : 0,
      callback: typeof callback === 'function' ? () => callback() : () => {},
    })
    return nextTimerId
  }
  const cancel = (id: unknown) => {
    timers.delete(Number(id))
  }
  const advance = async (ms: number) => {
    const target = clock + ms
    await flush()
    for (let guard = 0; guard < 500; guard += 1) {
      let next: PendingTimer | undefined
      for (const timer of timers.values()) {
        if (timer.due <= target && (!next || timer.due < next.due)) {
          next = timer
        }
      }
      if (!next) {
        break
      }
      clock = next.due
      if (next.every > 0) {
        next.due += next.every
      } else {
        timers.delete(next.id)
      }
      next.callback()
      await flush()
    }
    clock = target
    await flush()
  }

  // 假服务端：/api/snapshot 回快照，/api/history 回空历史，/api/actions 一律 202。
  const respond = (status: number, readBody: () => Promise<unknown>) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: readBody,
      text: async () => JSON.stringify(await readBody()),
    })
  const fakeFetch = (input: unknown) => {
    const url = new URL(String(input), 'http://192.168.1.2:8791')
    if (url.pathname === '/api/snapshot') {
      if (options.failSnapshot) {
        return respond(200, () => Promise.reject(new Error('坏快照：JSON 解析失败')))
      }
      const snapshot = buildSnapshot()
      return respond(200, () => Promise.resolve(snapshot))
    }
    if (url.pathname === '/api/history') {
      return respond(200, () => Promise.resolve({ messages: [] }))
    }
    if (url.pathname === '/api/actions') {
      return respond(202, () => Promise.resolve({ accepted: true }))
    }
    return respond(404, () => Promise.resolve({ message: 'Not found.' }))
  }

  const eventSources: FakeEventSource[] = []
  class FakeEventSource {
    readonly url: string
    readonly listeners = new Map<string, Listener[]>()
    readyState = 1
    onopen: Listener | null = null
    onerror: Listener | null = null
    onmessage: Listener | null = null

    constructor(url: string) {
      this.url = String(url)
      eventSources.push(this)
    }

    addEventListener(type: string, listener: Listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
    }

    removeEventListener(type: string, listener: Listener) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener))
    }

    close() {
      this.readyState = 2
    }
  }

  const vibrations: unknown[] = []
  const windowListeners = new Map<string, Listener[]>()
  const sandbox: Record<string, unknown> = {
    document: fakeDocument,
    location: {
      search: '?token=t',
      pathname: '/',
      origin: 'http://192.168.1.2:8791',
      href: 'http://192.168.1.2:8791/?token=t',
    },
    URL,
    URLSearchParams,
    navigator: {
      userAgent: 'node-test',
      vibrate: (pattern: unknown) => {
        vibrations.push(pattern)
        return true
      },
    },
    fetch: fakeFetch,
    EventSource: FakeEventSource,
    setTimeout: (callback: unknown, delay?: unknown) => schedule(callback, delay, false),
    clearTimeout: cancel,
    setInterval: (callback: unknown, delay?: unknown) => schedule(callback, delay, true),
    clearInterval: cancel,
    requestAnimationFrame: (callback: unknown) => schedule(callback, 16, false),
    cancelAnimationFrame: cancel,
    innerHeight: 800,
    innerWidth: 390,
    scrollY: 0,
    pageYOffset: 0,
    scrollTo: () => {},
    scrollBy: () => {},
    addEventListener: (type: string, listener: Listener) => {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener])
    },
    removeEventListener: (type: string, listener: Listener) => {
      windowListeners.set(type, (windowListeners.get(type) ?? []).filter((item) => item !== listener))
    },
    console: {
      log: () => {},
      info: () => {},
      debug: () => {},
      warn: (...args: unknown[]) => reportPageError(`console.warn: ${args.map(describeError).join(' ')}`),
      error: (...args: unknown[]) => reportPageError(`console.error: ${args.map(describeError).join(' ')}`),
    },
    __reportSwallowed: reportPageError,
  }
  sandbox.window = sandbox
  sandbox.self = sandbox

  runInNewContext(instrumentSwallowedErrors(scripts.join('\n;\n')), sandbox, {
    filename: 'remote-monitor-page.inline.js',
  })
  await flush() // 等首屏 /api/snapshot 回来、列表画出来

  const emitRaw = (data: string) => {
    const listeners = eventSources.flatMap((source) => source.listeners.get('stream') ?? [])
    assert.ok(listeners.length > 0, '页面没有订阅 stream 事件')
    for (const listener of listeners) {
      listener({ type: 'stream', data })
    }
  }

  const cardButtonOf = (cardTitle: string) => {
    const listView = byId('listView')
    assert.equal(listView.hidden, false, '列表页没在显示：先回到列表再看徽章')
    const matches = listView
      .querySelectorAll('.card')
      .filter((card) => card.querySelectorAll('.card-title').some((element) => element.textContent === cardTitle))
    assert.equal(matches.length, 1, `列表里应恰好有一张「${cardTitle}」卡，实际 ${matches.length} 张`)
    return matches[0]
  }

  const noticeTexts = () => byId('notice').textHistory.filter((text) => text !== '')

  return {
    baseTitle,
    document: fakeDocument,
    pageErrors,
    titleHistory,
    vibrations,
    eventSourceUrls: () => eventSources.map((source) => source.url),
    byId,
    noticeTexts,
    emitRaw,
    emit: (payload: StreamPayload) => emitRaw(JSON.stringify(payload)),
    // 过 1.5 秒：够触发 1.2 秒后的重拉快照，不够触发提示条 4 秒后的自动收起。
    settle: () => advance(1500),
    badgeOf: (cardTitle: string) => {
      const badges = cardButtonOf(cardTitle).querySelectorAll('.badge')
      assert.equal(badges.length, 1, `「${cardTitle}」卡上应恰好有一个状态徽章`)
      return badges[0].textContent
    },
    openCard: async (cardTitle: string) => {
      cardButtonOf(cardTitle).click()
      await flush() // 等 /api/history 回来、详情页重绘
      assert.equal(byId('detailView').hidden, false, `点了「${cardTitle}」却没进详情页`)
    },
    backToList: async () => {
      byId('backBtn').click()
      await flush()
      assert.equal(byId('listView').hidden, false, '点了返回却没回到列表')
    },
    detailText: () => {
      const detailView = byId('detailView')
      assert.equal(detailView.hidden, false, '详情页没打开')
      return detailView.textContent
    },
    assertNotNotified: (context: string) => {
      assert.deepEqual(titleHistory, [], `${context}：不该改标题，实际改成了 ${JSON.stringify(titleHistory)}`)
      assert.equal(fakeDocument.title, baseTitle)
      assert.equal(vibrations.length, 0, `${context}：不该震动，实际震了 ${vibrations.length} 次`)
      assert.deepEqual(noticeTexts(), [], `${context}：不该弹提示条`)
      assert.equal(byId('notice').classList.contains('show'), false, `${context}：提示条不该处于显示状态`)
    },
    assertNoPageErrors: () => {
      assert.equal(
        pageErrors.length,
        0,
        `页面脚本有被吞掉的错误（多半是假 DOM 缺了什么，或页面脚本本身抛错）：\n${pageErrors.join('\n---\n')}`,
      )
    },
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('装置自检：脚本里吞错的 catch 已插桩，坏帧和坏快照抛的错都看得见', async () => {
  const page = await bootMonitorPage()
  page.assertNoPageErrors()
  assert.deepEqual(page.eventSourceUrls(), ['/api/events?token=t'])

  page.emitRaw('{坏帧')
  assert.equal(
    page.pageErrors.length,
    1,
    '坏 JSON 帧抛的 SyntaxError 没被看见：stream 监听器里吞错的 catch 没插桩上，「不提醒」类断言会假绿',
  )
  assert.match(page.pageErrors[0], /SyntaxError/)

  const brokenSnapshot = await bootMonitorPage({ failSnapshot: true })
  assert.equal(brokenSnapshot.pageErrors.length, 1, 'loadSnapshot 里被吞的错没被看见：它的空 .catch 没插桩上')
  assert.match(brokenSnapshot.pageErrors[0], /坏快照/)
})

test('基线：普通流 done → 提醒一次（标题 / 震动 / 提示条）、徽章「已完成」、详情页「✅ 本轮已完成」', async () => {
  const page = await bootMonitorPage()
  assert.equal(page.badgeOf(CARD_TITLE), '空闲')

  page.emit(userTurnEvent('s-user', 'user_message', { content: '修一下登录' }))
  page.emit(userTurnEvent('s-user', 'delta', { content: '正在修…' }))
  await page.settle()
  assert.equal(page.badgeOf(CARD_TITLE), '运行中')
  page.assertNotNotified('普通流还在跑')

  page.emit(userTurnEvent('s-user', 'assistant_message', { itemId: 'm-1', content: '登录修好了' }))
  page.emit(userTurnEvent('s-user', 'done', {}))
  assert.equal(page.document.title, `✅ 1 个跑完 · ${page.baseTitle}`)
  assert.deepEqual(page.titleHistory, [`✅ 1 个跑完 · ${page.baseTitle}`])
  assert.equal(page.vibrations.length, 1)
  assert.deepEqual(page.noticeTexts(), [`${CARD_TITLE} 跑完了`])
  assert.equal(page.byId('notice').classList.contains('show'), true)
  assert.equal(page.badgeOf(CARD_TITLE), '已完成')

  await page.settle()
  assert.equal(page.badgeOf(CARD_TITLE), '已完成')
  await page.openCard(CARD_TITLE)
  assert.match(page.detailText(), /✅ 本轮已完成/)
  assert.match(page.detailText(), /登录修好了/)
  assert.equal(page.byId('stopBtn').hidden, true)
  page.assertNoPageErrors()
})

// ---------------------------------------------------------------------------
// 自动压缩回合（负载带 origin: 'auto-compact'）
// ---------------------------------------------------------------------------

type MonitorPage = Awaited<ReturnType<typeof bootMonitorPage>>

const COMPACT_STREAM_ID = 's-compact'
const USER_STREAM_ID = 's-user'

// 自动压缩回合到了手机上是这个样子：服务端不广播它的 user_message（/compact 不是用户说的话，
// 见 server/chat-manager.ts 的 buildUserMessageEnvelope），所以先到的是 session；压缩成功会有
// 一条 compaction 活动；最后是 done / error。每条事件都带 origin。
const startAutoCompact = (page: MonitorPage) =>
  page.emit(autoCompactEvent(COMPACT_STREAM_ID, 'session', { sessionId: 'session-1' }))

const emitCompactionActivity = (page: MonitorPage) =>
  page.emit(
    autoCompactEvent(COMPACT_STREAM_ID, 'activity', { itemId: 'compact-1', kind: 'compaction', status: 'completed' }),
  )

test('自动压缩流进行中：徽章「运行中」、详情页停止按钮可见、不提醒', async () => {
  const page = await bootMonitorPage()
  assert.equal(page.badgeOf(CARD_TITLE), '空闲')

  startAutoCompact(page)
  await page.settle()
  assert.equal(page.badgeOf(CARD_TITLE), '运行中')

  await page.openCard(CARD_TITLE)
  assert.equal(page.byId('stopBtn').hidden, false, '自动压缩还在跑，停止按钮应该可见')
  emitCompactionActivity(page)
  assert.match(page.detailText(), /上下文已压缩/)
  assert.equal(page.byId('stopBtn').hidden, false, '还没 done，停止按钮应该一直可见')
  page.assertNotNotified('自动压缩流还在跑')
  page.assertNoPageErrors()
})

test('自动压缩流 done：不提醒、徽章回退到快照状态「空闲」、详情页不落「✅ 本轮已完成」', async () => {
  const page = await bootMonitorPage()
  startAutoCompact(page)
  await page.settle()
  assert.equal(page.badgeOf(CARD_TITLE), '运行中', '前提：压缩进行中徽章是「运行中」')

  emitCompactionActivity(page)
  page.emit(autoCompactEvent(COMPACT_STREAM_ID, 'done', {}))
  page.assertNotNotified('自动压缩流 done')
  assert.equal(
    page.badgeOf(CARD_TITLE),
    '空闲',
    '已结束的自动压缩流不该把徽章变成「已完成」，应回退到快照里的 idle',
  )

  await page.settle() // done 会安排重拉快照；拉回来以后也还是快照里的状态
  assert.equal(page.badgeOf(CARD_TITLE), '空闲')
  page.assertNotNotified('自动压缩流 done 之后重拉快照')

  await page.openCard(CARD_TITLE)
  const text = page.detailText()
  assert.match(text, /上下文已压缩/, '前提：详情页确实渲染了这条自动压缩流')
  assert.doesNotMatch(text, /本轮已完成/)
  assert.equal(page.byId('stopBtn').hidden, true, '压缩已结束、快照里卡是 idle，停止按钮应隐藏')
  page.assertNoPageErrors()
})

test('自动压缩流 error：不提醒、详情页不落「❌ 本轮出错结束」、停止按钮和徽章回退到快照状态', async () => {
  const page = await bootMonitorPage()
  await page.openCard(CARD_TITLE)
  startAutoCompact(page)
  assert.equal(page.byId('stopBtn').hidden, false, '前提：压缩进行中停止按钮可见')

  page.emit(autoCompactEvent(COMPACT_STREAM_ID, 'error', { message: 'compact failed' }))
  page.assertNotNotified('自动压缩流 error')
  assert.equal(page.byId('stopBtn').hidden, true, '压缩已出错结束、快照里卡是 idle，停止按钮应隐藏')
  assert.doesNotMatch(page.detailText(), /本轮出错结束/)

  await page.settle()
  page.assertNotNotified('自动压缩流 error 之后重拉快照')
  assert.equal(page.byId('stopBtn').hidden, true)
  assert.doesNotMatch(page.detailText(), /本轮出错结束/)

  await page.backToList()
  assert.equal(
    page.badgeOf(CARD_TITLE),
    '空闲',
    '已结束的自动压缩流不该把徽章变成「出错」，应回退到快照里的 idle',
  )
  page.assertNoPageErrors()
})

test('自动压缩流被停（done + stopped）：详情页照常落「⏹ 已停止」，但不提醒', async () => {
  const page = await bootMonitorPage()
  await page.openCard(CARD_TITLE)
  startAutoCompact(page)
  assert.equal(page.byId('stopBtn').hidden, false, '前提：压缩进行中停止按钮可见')

  page.emit(autoCompactEvent(COMPACT_STREAM_ID, 'done', { stopped: true }))
  assert.match(page.detailText(), /⏹ 已停止/)
  assert.equal(page.byId('stopBtn').hidden, true)
  page.assertNotNotified('自动压缩流被停')

  await page.settle()
  assert.match(page.detailText(), /⏹ 已停止/)
  page.assertNotNotified('自动压缩流被停之后重拉快照')
  page.assertNoPageErrors()
})

test('自动压缩结束后，同卡紧接着的普通流 done：照常提醒且只算这一次（「✅ 1 个跑完」）', async () => {
  const page = await bootMonitorPage()
  startAutoCompact(page)
  emitCompactionActivity(page)
  page.emit(autoCompactEvent(COMPACT_STREAM_ID, 'done', {}))
  await page.settle()
  page.assertNotNotified('自动压缩流 done')

  page.emit(userTurnEvent(USER_STREAM_ID, 'user_message', { content: '修一下登录' }))
  page.emit(userTurnEvent(USER_STREAM_ID, 'assistant_message', { itemId: 'm-1', content: '登录修好了' }))
  page.emit(userTurnEvent(USER_STREAM_ID, 'done', {}))
  assert.deepEqual(
    page.titleHistory,
    [`✅ 1 个跑完 · ${page.baseTitle}`],
    '标题只该改一次，且计数只算普通流这一次',
  )
  assert.equal(page.vibrations.length, 1)
  assert.deepEqual(page.noticeTexts(), [`${CARD_TITLE} 跑完了`])
  assert.equal(page.badgeOf(CARD_TITLE), '已完成')

  await page.settle()
  assert.equal(page.badgeOf(CARD_TITLE), '已完成')
  await page.openCard(CARD_TITLE)
  const text = page.detailText()
  assert.match(text, /上下文已压缩/)
  assert.match(text, /登录修好了/)
  assert.equal(text.match(/本轮已完成/g)?.length ?? 0, 1, '只有最后一轮（普通流）落「✅ 本轮已完成」')
  page.assertNoPageErrors()
})
