import assert from 'node:assert/strict'
import test from 'node:test'

import { getAutoSizedTextareaLayout, syncComposerTextareaHeight } from '../src/components/chat-composer-textarea.ts'

test('multiline chat drafts grow the composer instead of forcing an internal scrollbar', () => {
  const layout = getAutoSizedTextareaLayout({
    scrollHeight: 118,
    minHeight: 32,
    maxHeight: 160,
  })

  assert.deepEqual(layout, {
    height: 118,
    overflowY: 'hidden',
  })
})

test('chat composer falls back to an internal scrollbar only after hitting its max height', () => {
  const layout = getAutoSizedTextareaLayout({
    scrollHeight: 224,
    minHeight: 32,
    maxHeight: 160,
  })

  assert.deepEqual(layout, {
    height: 160,
    overflowY: 'auto',
  })
})

test('chat composer shrinks back to its minimum height after multiline content is cleared', () => {
  const globalWithWindow = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis
  }
  const originalWindow = globalWithWindow.window
  let scrollHeight = 118
  const fakeNode = {
    style: {
      height: '',
      maxHeight: '',
      overflowY: '',
    },
    value: 'initial multiline draft',
    clientWidth: 320,
  } as unknown as HTMLTextAreaElement

  Object.defineProperty(fakeNode, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })

  globalWithWindow.window = {
    getComputedStyle: () =>
      ({
        minHeight: '32px',
        height: fakeNode.style.height || '32px',
        lineHeight: '18px',
        paddingTop: '7px',
        paddingBottom: '7px',
      }) as CSSStyleDeclaration,
  } as unknown as Window & typeof globalThis

  try {
    syncComposerTextareaHeight(fakeNode)
    assert.equal(fakeNode.style.height, '118px')

    scrollHeight = 32
    fakeNode.value = ''
    syncComposerTextareaHeight(fakeNode)

    assert.equal(fakeNode.style.height, '32px')
    assert.equal(fakeNode.style.overflowY, 'hidden')
  } finally {
    globalWithWindow.window = originalWindow
  }
})

test('an empty composer ignores a stale inflated scrollHeight and pins to its minimum height', () => {
  const globalWithWindow = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis
  }
  const originalWindow = globalWithWindow.window
  const fakeNode = {
    style: {
      height: '',
      maxHeight: '',
      overflowY: '',
    },
    value: '',
    clientWidth: 320,
  } as unknown as HTMLTextAreaElement

  Object.defineProperty(fakeNode, 'scrollHeight', {
    configurable: true,
    // 瞬态布局（面板拖拽/隐藏期测量）可以让空 textarea 报出虚高 scrollHeight
    get: () => 118,
  })

  globalWithWindow.window = {
    getComputedStyle: () =>
      ({
        minHeight: '32px',
        height: fakeNode.style.height || '32px',
        lineHeight: '18px',
        paddingTop: '7px',
        paddingBottom: '7px',
      }) as CSSStyleDeclaration,
  } as unknown as Window & typeof globalThis

  try {
    syncComposerTextareaHeight(fakeNode)

    assert.equal(fakeNode.style.height, '32px')
    assert.equal(fakeNode.style.overflowY, 'hidden')
  } finally {
    globalWithWindow.window = originalWindow
  }
})

test('chat composer reuses cached metrics for repeated height syncs on the same textarea', () => {
  const globalWithWindow = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis
  }
  const originalWindow = globalWithWindow.window
  let scrollHeight = 52
  let computedStyleReads = 0
  const fakeNode = {
    style: {
      height: '',
      maxHeight: '',
      overflowY: '',
    },
    value: 'short',
    clientWidth: 320,
  } as unknown as HTMLTextAreaElement

  Object.defineProperty(fakeNode, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })

  globalWithWindow.window = {
    getComputedStyle: () => {
      computedStyleReads += 1
      return ({
        minHeight: '32px',
        height: fakeNode.style.height || '32px',
        lineHeight: '18px',
        paddingTop: '7px',
        paddingBottom: '7px',
      }) as CSSStyleDeclaration
    },
  } as unknown as Window & typeof globalThis

  try {
    syncComposerTextareaHeight(fakeNode)
    scrollHeight = 84
    fakeNode.value = 'short\nand longer'
    syncComposerTextareaHeight(fakeNode)

    assert.equal(computedStyleReads, 1)
    assert.equal(fakeNode.style.height, '84px')
  } finally {
    globalWithWindow.window = originalWindow
  }
})

test('chat composer skips DOM writes when autosize layout is already current', () => {
  const globalWithWindow = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis
  }
  const originalWindow = globalWithWindow.window
  const fakeStyleValues = {
    height: '',
    maxHeight: '',
    overflowY: '',
  }
  const styleWrites: string[] = []
  const style = {} as CSSStyleDeclaration

  Object.defineProperty(style, 'height', {
    configurable: true,
    get: () => fakeStyleValues.height,
    set: (value) => {
      fakeStyleValues.height = value
      styleWrites.push(`height:${value}`)
    },
  })
  Object.defineProperty(style, 'maxHeight', {
    configurable: true,
    get: () => fakeStyleValues.maxHeight,
    set: (value) => {
      fakeStyleValues.maxHeight = value
      styleWrites.push(`maxHeight:${value}`)
    },
  })
  Object.defineProperty(style, 'overflowY', {
    configurable: true,
    get: () => fakeStyleValues.overflowY,
    set: (value) => {
      fakeStyleValues.overflowY = value
      styleWrites.push(`overflowY:${value}`)
    },
  })

  const fakeNode = {
    style,
    value: 'stable draft',
    clientWidth: 320,
    scrollHeight: 52,
  } as unknown as HTMLTextAreaElement

  globalWithWindow.window = {
    getComputedStyle: () =>
      ({
        minHeight: '32px',
        height: fakeStyleValues.height || '32px',
        lineHeight: '18px',
        paddingTop: '7px',
        paddingBottom: '7px',
      }) as CSSStyleDeclaration,
  } as unknown as Window & typeof globalThis

  try {
    syncComposerTextareaHeight(fakeNode)
    styleWrites.length = 0

    syncComposerTextareaHeight(fakeNode)

    assert.deepEqual(styleWrites, [])
  } finally {
    globalWithWindow.window = originalWindow
  }
})
