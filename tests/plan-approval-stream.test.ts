import assert from 'node:assert/strict'
import test from 'node:test'

import {
  shouldStopStreamForAskUserActivity,
  shouldSuppressStreamOutputAfterAskUserActivity,
} from '../src/components/deferred-send-queue.ts'
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
  ...(overrides.nativeTool ? { nativeTool: true } : {}),
})

test('Claude plan approval ask-user activity stops the active stream until the user answers', () => {
  assert.equal(
    shouldStopStreamForAskUserActivity(askUserActivity({ planFile: 'C:/Users/demo/.claude/plans/test.md' })),
    true,
  )
})

test('native AskUserQuestion tool activity stops the active stream until the user answers', () => {
  // The headless CLI auto-answers its own AskUserQuestion tool call, so the
  // stream must be stopped or Claude keeps working past the rendered card.
  assert.equal(
    shouldStopStreamForAskUserActivity(askUserActivity({ nativeTool: true })),
    true,
  )
})

test('text-convention ask-user activity does not force-stop the active stream', () => {
  // XML-convention ask-user is plain assistant text: the turn ends naturally,
  // so stopping the stream would be redundant and risky.
  assert.equal(
    shouldStopStreamForAskUserActivity(askUserActivity({ planFile: undefined, nativeTool: undefined })),
    false,
  )
})

test('native ask-user follow-up output is suppressed until the user answers', () => {
  assert.equal(
    shouldSuppressStreamOutputAfterAskUserActivity(askUserActivity({ nativeTool: true })),
    true,
  )
})

test('text-convention ask-user follow-up output is not suppressed by the stop gate', () => {
  assert.equal(
    shouldSuppressStreamOutputAfterAskUserActivity(askUserActivity({ planFile: undefined, nativeTool: undefined })),
    false,
  )
})
