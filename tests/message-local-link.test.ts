import assert from 'node:assert/strict'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { createMessage } from '../shared/default-state.ts'
import { openMessageLocalLink } from '../src/api.ts'
import {
  getStreamingLabel,
  handleMessageLinkClick,
  isLocalMessageLinkHref,
} from '../src/components/chat-card-rendering.tsx'
import { resolveMessageLocalLinkTarget } from '../electron/message-local-link.ts'

type ElectronBridgeWindow = Window & typeof globalThis & {
  electronAPI?: {
    openMessageLocalLink?: (href: string, workspacePath?: string) => Promise<void>
    openExternalLink?: (href: string) => Promise<void>
  }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

const restoreGlobals = () => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }
}

const setWindow = (value: ElectronBridgeWindow | undefined) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: value as unknown,
  })
}

beforeEach(() => {
  setWindow(undefined)
})

afterEach(() => {
  restoreGlobals()
})

test('classifies workspace file links as local message links', () => {
  assert.equal(isLocalMessageLinkHref('dist/release-20260410-234915'), true)
  assert.equal(isLocalMessageLinkHref('win-unpacked'), true)
  assert.equal(isLocalMessageLinkHref('Chill Vibe-0.1.0-win.zip'), true)
  assert.equal(isLocalMessageLinkHref('D:/Git/chill-vibe/dist/release-20260410-234915'), true)
  assert.equal(isLocalMessageLinkHref('file:///D:/Git/chill-vibe/dist/release-20260410-234915'), true)
  assert.equal(isLocalMessageLinkHref('https://example.com/releases/latest'), false)
  assert.equal(isLocalMessageLinkHref('mailto:dev@example.com'), false)
  assert.equal(isLocalMessageLinkHref('#details'), false)
})

test('resolves relative message links against the active workspace', () => {
  assert.equal(
    resolveMessageLocalLinkTarget('dist/release-20260410-234915', 'D:/Git/chill-vibe'),
    path.resolve('D:/Git/chill-vibe', 'dist/release-20260410-234915'),
  )
  assert.equal(
    resolveMessageLocalLinkTarget('win-unpacked', 'D:/Git/chill-vibe'),
    path.resolve('D:/Git/chill-vibe', 'win-unpacked'),
  )
  assert.equal(
    resolveMessageLocalLinkTarget(
      'file:///D:/Git/chill-vibe/dist/release-20260410-234915',
      'D:/Git/chill-vibe',
    ),
    path.resolve('D:/Git/chill-vibe', 'dist/release-20260410-234915'),
  )
  assert.equal(
    resolveMessageLocalLinkTarget('https://example.com/releases/latest', 'D:/Git/chill-vibe'),
    null,
  )
})

test('resolves slash-prefixed Windows file links and ignores line fragments', () => {
  assert.equal(
    resolveMessageLocalLinkTarget('/D:/Git/chill-vibe/AGENTS.md', 'D:/Git/chill-vibe'),
    path.resolve('D:/Git/chill-vibe/AGENTS.md'),
  )
  assert.equal(
    resolveMessageLocalLinkTarget('/D:/Git/chill-vibe/AGENTS.md#L74', 'D:/Git/chill-vibe'),
    path.resolve('D:/Git/chill-vibe/AGENTS.md'),
  )
})

test('routes local message link clicks through the Electron bridge', async () => {
  const opened: Array<{ href: string; workspacePath?: string }> = []
  let prevented = 0

  setWindow({
    electronAPI: {
      openMessageLocalLink: async (href, workspacePath) => {
        opened.push({ href, workspacePath })
      },
    },
  } as ElectronBridgeWindow)

  const handled = await handleMessageLinkClick(
    {
      preventDefault: () => {
        prevented += 1
      },
    },
    'dist/release-20260410-234915',
    'D:/Git/chill-vibe',
  )

  assert.equal(handled, true)
  assert.equal(prevented, 1)
  assert.deepEqual(opened, [
    {
      href: 'dist/release-20260410-234915',
      workspacePath: 'D:/Git/chill-vibe',
    },
  ])
})

test('leaves normal web links to the default anchor behavior', async () => {
  let prevented = 0

  const handled = await handleMessageLinkClick(
    {
      preventDefault: () => {
        prevented += 1
      },
    },
    'https://example.com/releases/latest',
    'D:/Git/chill-vibe',
  )

  assert.equal(handled, false)
  assert.equal(prevented, 0)
})

test('routes external message link clicks through the Electron bridge', async () => {
  const opened: string[] = []
  let prevented = 0

  setWindow({
    electronAPI: {
      openExternalLink: async (href) => {
        opened.push(href)
      },
    },
  } as ElectronBridgeWindow)

  const handled = await handleMessageLinkClick(
    {
      preventDefault: () => {
        prevented += 1
      },
    },
    'https://example.com/releases/latest',
    'D:/Git/chill-vibe',
  )

  assert.equal(handled, true)
  assert.equal(prevented, 1)
  assert.deepEqual(opened, ['https://example.com/releases/latest'])
})

test('openMessageLocalLink requires the Electron bridge', async () => {
  await assert.rejects(
    () => openMessageLocalLink('win-unpacked', 'D:/Git/chill-vibe'),
    /Electron desktop bridge is unavailable/,
  )
})

test('shows generic writing copy before the current turn emits new activity', () => {
  const messages = [
    createMessage('user', 'first turn'),
    createMessage('assistant', '', { kind: 'command', provider: 'codex', itemId: 'old', structuredData: '{}' }),
    createMessage('user', 'follow up'),
  ]

  assert.equal(getStreamingLabel(messages, 'zh-CN'), '生成中')
  assert.equal(getStreamingLabel(messages, 'en'), 'Writing')
})

test('uses only current-turn activity when choosing the streaming label', () => {
  const messages = [
    createMessage('user', 'first turn'),
    createMessage('assistant', '', { kind: 'command', provider: 'codex', itemId: 'old', structuredData: '{}' }),
    createMessage('user', 'follow up'),
    createMessage('assistant', 'drafting reply'),
  ]

  assert.equal(getStreamingLabel(messages, 'zh-CN'), '生成中')
  assert.equal(getStreamingLabel(messages, 'en'), 'Writing')
})

test('prefers current-turn structured activity over the generic writing placeholder', () => {
  const messages = [
    createMessage('user', 'first turn'),
    createMessage('assistant', '', { kind: 'command', provider: 'codex', itemId: 'old', structuredData: '{}' }),
    createMessage('user', 'follow up'),
    createMessage('assistant', '', { kind: 'reasoning', provider: 'codex', itemId: 'new', structuredData: '{}' }),
  ]

  assert.equal(getStreamingLabel(messages, 'zh-CN'), '思考中')
  assert.equal(getStreamingLabel(messages, 'en'), 'Thinking')
})
