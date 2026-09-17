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
  // Session history entries become tiny previews (messages emptied), so the
  // crash payload must keep every index entry: captureRendererCrash persists
  // this state verbatim, and a sliced index permanently drops the older
  // archived sessions from state.json (real data loss on 2026-07-04).
  assert.equal(trimmed.sessionHistory.length, 30)
  assert.ok(trimmed.sessionHistory.every((entry) => entry.messages.length === 0))
  assert.ok(trimmed.sessionHistory.every((entry) => entry.messagesPreview === true))
})

test('installRendererCrashLogger does not archive a crash for Monaco cancellation rejections', async () => {
  // 2026-09-03/09-14/09-16 main.log: `Unhandled rejection: Canceled` thrown by
  // editor.restoreViewState while the app kept running fine. Each one wrote
  // state.crash-recovery.json, so the next launch (usually a freshly packaged
  // build) greeted the user with the "本次崩溃记录" dialog.
  const logged: Array<{ level: string; message: string }> = []
  const captured: Array<{ source: string; message: string }> = []
  const target: MockRendererWindow = { onerror: null, onunhandledrejection: null }

  installRendererCrashLogger(target as unknown as Window, {
    sendLogFn: (level, message) => {
      logged.push({ level, message })
    },
    captureFatalRendererCrashFn: async (payload) => {
      captured.push(payload)
      return null
    },
  })

  const canceled = new Error('Canceled')
  canceled.name = 'Canceled'
  target.onunhandledrejection?.({ reason: canceled })
  await Promise.resolve()

  assert.equal(logged.length, 1, 'cancellation is still logged for forensics')
  assert.equal(logged[0]?.level, 'warn')
  assert.deepEqual(captured, [], 'cancellation must not be archived as a renderer crash')
})

test('a genuine crash that merely says Canceled is still archived', () => {
  // 2026-09-17 审计：过滤条件曾写成 `name === 'Canceled' || message === 'Canceled'`，
  // 比 Monaco 自己的 isCancellationError 更宽 —— 后者要求 name 和 message 同时相等
  // （monaco-editor/esm/vs/base/common/errors.js: CancellationError 把 name 设成 message）。
  // 宽出来的那一半会把普通 `new Error('Canceled')` 的真实崩溃静默降级成 warn。
  const logged: Array<{ level: string; message: string }> = []
  const captured: Array<{ source: string; message: string }> = []
  const target: MockRendererWindow = { onerror: null, onunhandledrejection: null }

  installRendererCrashLogger(target as unknown as Window, {
    sendLogFn: (level, message) => {
      logged.push({ level, message })
    },
    captureFatalRendererCrashFn: async (payload) => {
      captured.push(payload)
      return null
    },
  })

  // name 仍是默认的 'Error'，不是取消语义。
  target.onunhandledrejection?.({ reason: new Error('Canceled') })

  assert.equal(logged[0]?.level, 'error')
  assert.equal(captured.length, 1, 'a real crash must still be archived')
})
