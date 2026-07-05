import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  getBoardWheelDisposition,
  type BoardWheelElement,
  type WheelStyleResolver,
} from '../src/board-wheel'

type FakeElementInit = {
  classes?: string[]
  overflowY?: string
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
  scrollWidth?: number
  clientWidth?: number
  insideCardShell?: boolean
  children?: FakeElement[]
}

class FakeElement implements BoardWheelElement {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  scrollWidth: number
  clientWidth: number
  parentElement: FakeElement | null = null
  overflowY: string
  private readonly classes: Set<string>
  private readonly insideCardShell: boolean
  private readonly children: FakeElement[]

  constructor(init: FakeElementInit = {}) {
    this.classes = new Set(init.classes ?? [])
    this.overflowY = init.overflowY ?? 'visible'
    this.scrollTop = init.scrollTop ?? 0
    this.scrollHeight = init.scrollHeight ?? 100
    this.clientHeight = init.clientHeight ?? 100
    this.scrollWidth = init.scrollWidth ?? 100
    this.clientWidth = init.clientWidth ?? 100
    this.insideCardShell = init.insideCardShell ?? false
    this.children = init.children ?? []
    for (const child of this.children) {
      child.parentElement = this
    }
  }

  get classList() {
    return { contains: (token: string) => this.classes.has(token) }
  }

  closest(selectors: string): unknown {
    if (selectors === '.card-shell') {
      if (this.insideCardShell || this.classes.has('card-shell')) {
        return this
      }
      return this.parentElement?.closest(selectors) ?? null
    }
    return null
  }

  querySelector(selectors: string): unknown {
    const token = selectors.replace(/^\./, '')
    for (const child of this.children) {
      if (child.classes.has(token)) {
        return child
      }
      const nested = child.querySelector(selectors)
      if (nested) {
        return nested
      }
    }
    return null
  }
}

const resolveFakeStyle: WheelStyleResolver = (node) => ({
  overflowY: (node as FakeElement).overflowY,
})

const chain = (...elements: FakeElement[]) => {
  for (let index = 0; index + 1 < elements.length; index += 1) {
    elements[index].parentElement = elements[index + 1]
  }
  return elements
}

const buildTabStripScene = ({ stripOverflowing }: { stripOverflowing: boolean }) => {
  const tabButton = new FakeElement({ classes: ['pane-tab'] })
  const tabStrip = new FakeElement({
    classes: ['pane-tab-strip'],
    scrollWidth: stripOverflowing ? 1600 : 400,
    clientWidth: 400,
  })
  const tabBar = new FakeElement({ classes: ['pane-tab-bar'], children: [tabStrip] })
  const paneView = new FakeElement({ classes: ['pane-view'] })
  const board = new FakeElement({ classes: ['board'] })
  chain(tabButton, tabStrip, tabBar, paneView, board)
  return { tabButton, tabStrip, tabBar, board }
}

test('board wheel passes on a horizontally overflowing pane tab strip', () => {
  const { tabButton, board } = buildTabStripScene({ stripOverflowing: true })

  const disposition = getBoardWheelDisposition(tabButton, board, 120, null, resolveFakeStyle)

  assert.deepEqual(disposition, { type: 'pass' })
})

test('board wheel passes when the pointer is on the tab bar chrome next to an overflowing strip', () => {
  const { tabBar, board } = buildTabStripScene({ stripOverflowing: true })

  const disposition = getBoardWheelDisposition(tabBar, board, -120, null, resolveFakeStyle)

  assert.deepEqual(disposition, { type: 'pass' })
})

test('board wheel still forwards when the tab strip has no horizontal overflow', () => {
  const { tabButton, board } = buildTabStripScene({ stripOverflowing: false })

  const disposition = getBoardWheelDisposition(tabButton, board, 120, null, resolveFakeStyle)

  assert.deepEqual(disposition, { type: 'forward' })
})

test('board wheel still routes card transcript regions to scroll-card', () => {
  const messageList = new FakeElement({
    overflowY: 'auto',
    scrollTop: 0,
    scrollHeight: 900,
    clientHeight: 300,
    insideCardShell: true,
  })
  const board = new FakeElement({ classes: ['board'] })
  chain(messageList, board)

  const disposition = getBoardWheelDisposition(messageList, board, 120, null, resolveFakeStyle)

  assert.equal(disposition.type, 'scroll-card')
})

test('board wheel still traps downward wheel at the bottom of a card transcript', () => {
  const messageList = new FakeElement({
    overflowY: 'auto',
    scrollTop: 600,
    scrollHeight: 900,
    clientHeight: 300,
    insideCardShell: true,
  })
  const board = new FakeElement({ classes: ['board'] })
  chain(messageList, board)

  const disposition = getBoardWheelDisposition(messageList, board, 120, null, resolveFakeStyle)

  assert.deepEqual(disposition, { type: 'trap' })
})
