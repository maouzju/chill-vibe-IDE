import assert from 'node:assert/strict'
import test from 'node:test'

import { installRendererCrashLogger } from '../src/crash-logger-renderer.ts'

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
