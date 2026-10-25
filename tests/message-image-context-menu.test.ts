import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildImageContextMenuActions,
  resolveImageContextMenuTarget,
} from '../src/components/file-path-context-menu.ts'
import { isCopyableImageSrc } from '../shared/local-image-protocol.ts'

type FakeNode = {
  tag: string
  attributes: Record<string, string>
  parent: FakeNode | null
  getAttribute: (name: string) => string | null
  closest: (selector: string) => FakeNode | null
}

const createFakeNode = (
  tag: string,
  attributes: Record<string, string> = {},
  parent: FakeNode | null = null,
): FakeNode => {
  const node: FakeNode = {
    tag,
    attributes,
    parent,
    getAttribute: (name) => attributes[name] ?? null,
    closest: (selector) => {
      const wantsSrc = selector === 'img[src]'
      let current: FakeNode | null = node

      while (current) {
        if (current.tag === 'img' && (!wantsSrc || current.attributes.src !== undefined)) {
          return current
        }
        current = current.parent
      }

      return null
    },
  }

  return node
}

test('right-clicking a message image resolves its src', () => {
  const img = createFakeNode('img', {
    src: 'chill-vibe-local-image://local/?src=D%3A%5Cshot.png',
  })

  assert.deepEqual(resolveImageContextMenuTarget(img), {
    src: 'chill-vibe-local-image://local/?src=D%3A%5Cshot.png',
  })
})

test('ignores right-clicks that are not on an image or on an image without a src', () => {
  const paragraph = createFakeNode('p')
  const emptyImg = createFakeNode('img', { src: '   ' })

  assert.equal(resolveImageContextMenuTarget(paragraph), null)
  assert.equal(resolveImageContextMenuTarget(emptyImg), null)
  assert.equal(resolveImageContextMenuTarget(null), null)
})

test('the image menu offers a single copy-image entry, in both languages', () => {
  assert.deepEqual(buildImageContextMenuActions('zh-CN'), [
    { key: 'copy-image', label: '复制图片' },
  ])
  assert.deepEqual(buildImageContextMenuActions('en'), [
    { key: 'copy-image', label: 'Copy Image' },
  ])
})

test('only protocol-served, web and data images may be fetched for the clipboard', () => {
  assert.equal(isCopyableImageSrc('chill-vibe-local-image://local/?src=a.png'), true)
  assert.equal(isCopyableImageSrc('chill-vibe-attachment://x/abc'), true)
  assert.equal(isCopyableImageSrc('https://example.com/a.png'), true)
  assert.equal(isCopyableImageSrc('data:image/png;base64,AAAA'), true)
  assert.equal(isCopyableImageSrc('file:///D:/secret.txt'), false)
  assert.equal(isCopyableImageSrc('D:\\secret.txt'), false)
  assert.equal(isCopyableImageSrc(''), false)
})
