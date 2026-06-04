import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldStopStreamForAskUserActivity } from '../src/components/deferred-send-queue.ts'
import type { StreamAskUserActivity } from '../shared/schema.ts'

const askUserActivity = (overrides: Partial<StreamAskUserActivity> = {}): StreamAskUserActivity => ({
  itemId: overrides.itemId ?? 'ask-1',
  kind: 'ask-user',
  status: 'completed',
  question: overrides.question ?? 'Choose?',
  header: overrides.header ?? 'Need choice',
  multiSelect: overrides.multiSelect ?? false,
  options: overrides.options ?? [
    { label: 'Approve plan', description: '' },
    { label: 'Reject plan', description: '' },
  ],
  ...(overrides.questions ? { questions: overrides.questions } : {}),
  ...(overrides.planFile ? { planFile: overrides.planFile } : {}),
})

test('Claude plan approval ask-user activity stops the active stream until the user answers', () => {
  assert.equal(
    shouldStopStreamForAskUserActivity(askUserActivity({ planFile: 'C:/Users/demo/.claude/plans/test.md' })),
    true,
  )
})

test('ordinary ask-user activity does not force-stop the active stream', () => {
  assert.equal(shouldStopStreamForAskUserActivity(askUserActivity({ planFile: undefined })), false)
})
