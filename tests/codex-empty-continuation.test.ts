import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCodexAppServerInput } from '../server/providers.ts'
import { chatRequestSchema } from '../shared/schema.ts'

const makeRequest = (overrides: Record<string, unknown>) =>
  chatRequestSchema.parse({
    provider: 'codex',
    workspacePath: 'D:/workspace',
    ...overrides,
  })

test('empty continuation on a resumed codex session sends a neutral continue nudge', () => {
  const input = buildCodexAppServerInput(
    makeRequest({ prompt: '', sessionId: 'codex-session-1' }),
    [],
  )

  assert.equal(input.length, 1)
  assert.equal(input[0]?.type, 'text')
  assert.equal(input[0]?.text, 'Please continue.')
})

test('a non-empty codex prompt is forwarded verbatim', () => {
  const input = buildCodexAppServerInput(
    makeRequest({ prompt: 'keep going on the refactor', sessionId: 'codex-session-1' }),
    [],
  )

  assert.equal(input.length, 1)
  assert.equal(input[0]?.text, 'keep going on the refactor')
})
