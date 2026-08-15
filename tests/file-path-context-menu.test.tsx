import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { FilePathContextMenu } from '../src/components/FilePathContextMenu.tsx'
import {
  FILE_PATH_CONTEXT_MENU_SELECTOR,
  buildFilePathContextMenuActions,
  clampFilePathContextMenuPosition,
  resolveFilePathContextMenuCopyValue,
  resolveFilePathContextMenuTarget,
} from '../src/components/file-path-context-menu.ts'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

type FakeElement = {
  attributes: Record<string, string>
  parent: FakeElement | null
  getAttribute: (name: string) => string | null
  closest: (selector: string) => FakeElement | null
}

const createFakeElement = (
  attributes: Record<string, string>,
  parent: FakeElement | null = null,
): FakeElement => {
  const element: FakeElement = {
    attributes,
    parent,
    getAttribute: (name) => attributes[name] ?? null,
    closest: (selector) => {
      const attributeName = selector.replace(/^\[/, '').replace(/\]$/, '')
      let current: FakeElement | null = element

      while (current) {
        if (current.attributes[attributeName] !== undefined) {
          return current
        }
        current = current.parent
      }

      return null
    },
  }

  return element
}

test('resolves the nearest openable file ancestor for a right-click target', () => {
  const row = createFakeElement({ 'data-open-file-path': 'docs/release-notes.md' })
  const label = createFakeElement({}, row)
  const inner = createFakeElement({}, label)

  assert.deepEqual(resolveFilePathContextMenuTarget(inner), {
    openPath: 'docs/release-notes.md',
  })
})

test('keeps the line hint when the openable element carries one', () => {
  const anchor = createFakeElement({
    'data-open-file-path': 'src/state.ts',
    'data-open-file-line': '2455',
  })

  assert.deepEqual(resolveFilePathContextMenuTarget(anchor), {
    openPath: 'src/state.ts',
    line: 2455,
  })
})

test('marks reveal-only targets so the menu can drop the in-editor entry', () => {
  const link = createFakeElement({
    'data-open-file-path': 'trash/feishu-card-export',
    'data-open-file-reveal-only': 'true',
  })

  assert.deepEqual(resolveFilePathContextMenuTarget(link), {
    openPath: 'trash/feishu-card-export',
    revealOnly: true,
  })
})

test('ignores right-clicks that land outside an openable file element', () => {
  const plain = createFakeElement({})
  const blank = createFakeElement({ 'data-open-file-path': '   ' })

  assert.equal(resolveFilePathContextMenuTarget(plain), null)
  assert.equal(resolveFilePathContextMenuTarget(blank), null)
  assert.equal(resolveFilePathContextMenuTarget(null), null)
})

test('the selector matches the attribute already emitted by openable file rows', () => {
  assert.equal(FILE_PATH_CONTEXT_MENU_SELECTOR, '[data-open-file-path]')
})

test('always offers showing the file location, in both languages', () => {
  const zh = buildFilePathContextMenuActions({ language: 'zh-CN', canOpenInEditor: true })
  const en = buildFilePathContextMenuActions({ language: 'en', canOpenInEditor: true })

  assert.deepEqual(zh.map((action) => action.key), ['open', 'reveal', 'copy-path'])
  assert.equal(zh.find((action) => action.key === 'reveal')?.label, '打开文件位置')
  assert.equal(en.find((action) => action.key === 'reveal')?.label, 'Show File Location')
})

test('drops the in-editor open entry when the card cannot open files', () => {
  const actions = buildFilePathContextMenuActions({ language: 'zh-CN', canOpenInEditor: false })

  assert.deepEqual(actions.map((action) => action.key), ['reveal', 'copy-path'])
})

test('drops the in-editor open entry for a reveal-only target', () => {
  const actions = buildFilePathContextMenuActions({
    language: 'zh-CN',
    canOpenInEditor: true,
    revealOnly: true,
  })

  assert.deepEqual(actions.map((action) => action.key), ['reveal', 'copy-path'])
})

test('keeps the menu inside the viewport when the click lands near an edge', () => {
  const clamped = clampFilePathContextMenuPosition({
    x: 1270,
    y: 700,
    width: 200,
    height: 120,
    viewportWidth: 1280,
    viewportHeight: 720,
  })

  assert.deepEqual(clamped, { left: 1072, top: 592 })
})

test('never pushes the menu off the top-left corner on tiny viewports', () => {
  const clamped = clampFilePathContextMenuPosition({
    x: 4,
    y: 2,
    width: 400,
    height: 400,
    viewportWidth: 320,
    viewportHeight: 240,
  })

  assert.deepEqual(clamped, { left: 8, top: 8 })
})

test('copy-path hands back something pasteable, not a bare workspace-relative row', () => {
  assert.equal(
    resolveFilePathContextMenuCopyValue('D:\\Git\\chill-vibe', 'docs/release-notes.md'),
    'D:\\Git\\chill-vibe\\docs\\release-notes.md',
  )
  assert.equal(
    resolveFilePathContextMenuCopyValue('/home/dev/app', 'docs/release-notes.md'),
    '/home/dev/app/docs/release-notes.md',
  )
  assert.equal(
    resolveFilePathContextMenuCopyValue('D:\\Git\\chill-vibe', 'C:/Users/demo/MEMORY.md'),
    'C:/Users/demo/MEMORY.md',
  )
  assert.equal(
    resolveFilePathContextMenuCopyValue('D:\\Git\\chill-vibe', 'file:///D:/Git/notes.md'),
    'file:///D:/Git/notes.md',
  )
})

test('renders the menu with the shared context-menu chrome', () => {
  const markup = renderToStaticMarkup(
    React.createElement(FilePathContextMenu, {
      position: { left: 120, top: 240 },
      actions: buildFilePathContextMenuActions({ language: 'zh-CN', canOpenInEditor: true }),
      onSelect: () => undefined,
    }),
  )

  assert.match(markup, /pane-tab-context-menu/)
  assert.match(markup, /role="menu"/)
  assert.match(markup, /打开文件位置/)
  assert.match(markup, /left:120px/)
  assert.match(markup, /top:240px/)
})
