import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage } from '../shared/schema.ts'
import { evaluateAutoUrge, getNextAutoUrgeToggleState, resolveEffectiveAutoUrge } from '../src/components/chat-auto-urge.ts'

let messageSequence = 0

const createChatMessage = (role: ChatMessage['role'], content: string): ChatMessage => ({
  id: `msg-${++messageSequence}`,
  role,
  content,
  createdAt: '2026-04-12T00:00:00.000Z',
})

const createAssistantMessage = (content: string): ChatMessage => createChatMessage('assistant', content)

const createUserMessage = (content: string): ChatMessage => createChatMessage('user', content)

const createAskUserMessage = (content: string): ChatMessage => ({
  ...createAssistantMessage(content),
  meta: {
    kind: 'ask-user',
    structuredData: JSON.stringify({
      itemId: 'ask-user-1',
      kind: 'ask-user',
      header: '确认',
      question: content,
      options: [{ label: '继续', description: '继续验证。' }],
    }),
  },
})

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

test('manual activation ignores old success keywords so turning auto urge back on stays enabled', () => {
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
    kind: 'send',
    message: 'Keep verifying until the fix is proven.',
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


test('stream completion sends an empty urge message as a continuation nudge', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: '   ',
      successKeyword: 'YES',
      messages: [createAssistantMessage('I only have a guess so far.')],
    },
  )

  assert.deepEqual(result, {
    kind: 'send',
    message: '',
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

test('stream completion ignores success keywords inside ask-user questions', () => {
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
        createUserMessage('Fix the bug and verify it.'),
        createAssistantMessage('I still need confirmation before continuing.'),
        createAskUserMessage('If the problem is solved, reply YES; otherwise do not stop.'),
      ],
    },
  )

  assert.deepEqual(result, {
    kind: 'send',
    message: 'Keep verifying until the fix is proven.',
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

test('resolveEffectiveAutoUrge prefers the card own urge over the global urge', () => {
  const result = resolveEffectiveAutoUrge({
    cardAutoUrgeActive: true,
    cardAutoUrgeProfileId: 'profile-card',
    globalUrgeActive: true,
    globalUrgeProfileId: 'profile-global',
    isToolCard: false,
  })

  assert.deepEqual(result, { active: true, profileId: 'profile-card', source: 'card' })
})

test('resolveEffectiveAutoUrge applies the global urge to cards without their own urge', () => {
  const result = resolveEffectiveAutoUrge({
    cardAutoUrgeActive: false,
    cardAutoUrgeProfileId: 'profile-card',
    globalUrgeActive: true,
    globalUrgeProfileId: 'profile-global',
    isToolCard: false,
  })

  assert.deepEqual(result, { active: true, profileId: 'profile-global', source: 'global' })
})

test('resolveEffectiveAutoUrge never applies the global urge to tool cards', () => {
  const result = resolveEffectiveAutoUrge({
    cardAutoUrgeActive: false,
    cardAutoUrgeProfileId: 'profile-card',
    globalUrgeActive: true,
    globalUrgeProfileId: 'profile-global',
    isToolCard: true,
  })

  assert.deepEqual(result, { active: false, profileId: 'profile-card', source: 'none' })
})

test('resolveEffectiveAutoUrge stays inactive when neither the card nor the global urge is on', () => {
  const result = resolveEffectiveAutoUrge({
    cardAutoUrgeActive: false,
    cardAutoUrgeProfileId: 'profile-card',
    globalUrgeActive: false,
    globalUrgeProfileId: 'profile-global',
    isToolCard: false,
  })

  assert.deepEqual(result, { active: false, profileId: 'profile-card', source: 'none' })
})
