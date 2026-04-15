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
    syncComposerTextareaHeight(fakeNode)

    assert.equal(computedStyleReads, 1)
    assert.equal(fakeNode.style.height, '84px')
  } finally {
    globalWithWindow.window = originalWindow
  }
})
