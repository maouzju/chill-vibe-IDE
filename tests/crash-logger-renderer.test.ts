import assert from 'node:assert/strict'
import test from 'node:test'

import { createDefaultState } from '../shared/default-state.ts'
import { installRendererCrashLogger } from '../src/crash-logger-renderer.ts'
import { trimStateForRendererCrashCapture } from '../src/renderer-crash-state.ts'

type MockRendererWindow = {
  onerror: ((...args: unknown[]) => unknown) | null
  onunhandledrejection: ((event: { reason: unknown }) => unknown) | null
}

test('installRendererCrashLogger logs and captures fatal renderer failures', async () => {
  const logged: Array<{ level: string; message: string; meta: unknown }> = []
  const captured: Array<{ source: string; message: string; stack?: string }> = []
  let previousOnErrorCalls = 0
  let previousUnhandledRejectionCalls = 0

  const target: MockRendererWindow = {
    onerror: () => {
      previousOnErrorCalls += 1
      return false
    },
    onunhandledrejection: () => {
      previousUnhandledRejectionCalls += 1
    },
  }

  installRendererCrashLogger(target as unknown as Window, {
    sendLogFn: (level, message, meta) => {
      logged.push({ level, message, meta })
    },
    captureFatalRendererCrashFn: async (payload) => {
      captured.push(payload)
      return null
    },
  })

  const crash = new Error('boom')
  target.onerror?.('boom', 'App.tsx', 42, 7, crash)

  const rejection = new Error('broken promise')
  await target.onunhandledrejection?.({ reason: rejection })

  assert.equal(previousOnErrorCalls, 1)
  assert.equal(previousUnhandledRejectionCalls, 1)
  assert.equal(logged[0]?.level, 'error')
  assert.equal(logged[0]?.message, 'Uncaught error: boom')
  assert.equal(logged[1]?.message, 'Unhandled rejection: broken promise')
  assert.deepEqual(captured, [
    {
      source: 'window-error',
      message: 'boom',
      stack: crash.stack ?? '',
    },
    {
      source: 'unhandled-rejection',
      message: 'broken promise',
      stack: rejection.stack ?? '',
    },
  ])
})

test('trimStateForRendererCrashCapture keeps crash payload bounded without dropping current chats', () => {
  const state = createDefaultState('D:/crash-trim')
  const firstColumn = state.columns[0]
  const firstCardId = firstColumn?.layout.type === 'pane'
    ? firstColumn.layout.activeTabId
    : ''

  if (!firstColumn || !firstCardId) {
    throw new Error('Expected default state to include an active card.')
  }

  firstColumn.cards[firstCardId] = {
    ...firstColumn.cards[firstCardId]!,
    status: 'streaming',
    messages: Array.from({ length: 240 }, (_, index) => ({
      id: `live-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: index === 239 ? 'x'.repeat(40_000) : `message ${index}`,
      createdAt: '2026-05-03T11:00:00.000Z',
      meta: index === 238
        ? {
            kind: 'command',
            structuredData: JSON.stringify({
              output: 'y'.repeat(40_000),
            }),
          }
        : undefined,
    })),
  }
  state.sessionHistory = Array.from({ length: 30 }, (_, index) => ({
    id: `history-${index}`,
    title: `History ${index}`,
    provider: 'codex',
    model: 'gpt-5.5',
    workspacePath: 'D:/crash-trim',
    messages: [
      {
        id: `history-message-${index}`,
        role: 'assistant',
        content: 'archived',
        createdAt: '2026-05-03T11:00:00.000Z',
      },
    ],
    messageCount: 1,
    archivedAt: '2026-05-03T11:00:00.000Z',
  }))

  const trimmed = trimStateForRendererCrashCapture(state)
  const trimmedCard = trimmed.columns[0]?.cards[firstCardId]

  assert.equal(trimmedCard?.messages.length, 160)
  assert.equal(trimmedCard?.messageCount, 240)
  assert.ok((trimmedCard?.messages.at(-1)?.content.length ?? 0) < 8_000)
  assert.ok((trimmedCard?.messages.at(-2)?.meta?.structuredData?.length ?? 0) < 8_000)
  assert.equal(trimmed.sessionHistory.length, 20)
  assert.equal(trimmed.sessionHistory[0]?.messages.length, 0)
  assert.equal(trimmed.sessionHistory[0]?.messagesPreview, true)
})
