import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage } from '../shared/schema.ts'
import { evaluateAutoUrge, getNextAutoUrgeToggleState } from '../src/components/chat-auto-urge.ts'

let messageSequence = 0

const createChatMessage = (role: ChatMessage['role'], content: string): ChatMessage => ({
  id: `msg-${++messageSequence}`,
  role,
  content,
  createdAt: '2026-04-12T00:00:00.000Z',
})

const createAssistantMessage = (content: string): ChatMessage => createChatMessage('assistant', content)

const createUserMessage = (content: string): ChatMessage => createChatMessage('user', content)

test('manual activation sends the selected urge immediately when the chat is idle', () => {
  const result = evaluateAutoUrge(
    {
      type: 'manual-activation',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [createAssistantMessage('I still need more evidence.')],
    },
  )

  assert.deepEqual(result, {
    kind: 'send',
    message: 'Keep verifying until the fix is proven.',
  })
})

test('manual activation disables auto urge when the latest assistant reply already contains the success keyword', () => {
  const result = evaluateAutoUrge(
    {
      type: 'manual-activation',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [createAssistantMessage('Verified. YES')],
    },
  )

  assert.deepEqual(result, {
    kind: 'disable',
  })
})

test('manual activation does not send while the chat is still streaming', () => {
  const result = evaluateAutoUrge(
    {
      type: 'manual-activation',
      status: 'streaming',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [createAssistantMessage('Still checking.')],
    },
  )

  assert.deepEqual(result, {
    kind: 'skip',
  })
})

test('stream completion still sends the urge when verification is not finished', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [createAssistantMessage('I only have a guess so far.')],
    },
  )

  assert.deepEqual(result, {
    kind: 'send',
    message: 'Keep verifying until the fix is proven.',
  })
})

test('stream completion disables auto urge when the latest assistant turn contains the success keyword before a trailing assistant summary card', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [
        createUserMessage('Please keep checking until you are sure.'),
        createAssistantMessage('The fix is verified. YES'),
        createAssistantMessage(''),
      ],
    },
  )

  assert.deepEqual(result, {
    kind: 'disable',
  })
})

test('stream completion does not reuse a success keyword from an older assistant turn', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [
        createUserMessage('Fix the first problem.'),
        createAssistantMessage('That one is verified. YES'),
        createUserMessage('Now fix the second problem.'),
        createAssistantMessage('I still need more evidence for this one.'),
      ],
    },
  )

  assert.deepEqual(result, {
    kind: 'send',
    message: 'Keep verifying until the fix is proven.',
  })
})

test('composer toggle can re-enable auto urge for the current chat after the global feature was turned off', () => {
  const result = getNextAutoUrgeToggleState({
    featureEnabled: false,
    chatActive: false,
    status: 'idle',
  })

  assert.deepEqual(result, {
    featureEnabled: true,
    chatActive: true,
    shouldSendImmediately: true,
  })
})

test('composer toggle turns off only the current chat when auto urge is already available', () => {
  const result = getNextAutoUrgeToggleState({
    featureEnabled: true,
    chatActive: true,
    status: 'idle',
  })

  assert.deepEqual(result, {
    featureEnabled: true,
    chatActive: false,
    shouldSendImmediately: false,
  })
})
