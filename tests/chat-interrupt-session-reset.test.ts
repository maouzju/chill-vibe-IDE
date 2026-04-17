import assert from 'node:assert/strict'
import test from 'node:test'

import { createMessage } from '../shared/default-state.ts'
import type { ChatMessage } from '../shared/schema.ts'
import { createStoppedRunMessage } from '../src/app-helpers.ts'
import { buildSeededChatPrompt, collectSeededChatAttachments, hasSeededChatTranscript } from '../src/chat-request-seeding.ts'

test('clearing a stale session after a user interrupt re-seeds the queued follow-up from chat history', () => {
  const messages: ChatMessage[] = [
    createMessage('user', '手持类远程的combat icon 的实际的预制体显示 需要加一个sprite outline 的组件 显示3px的外边框'),
    createStoppedRunMessage('zh-CN', 'user-interrupt'),
  ]

  assert.equal(
    hasSeededChatTranscript({
      sessionId: undefined,
      messages,
    }),
    true,
  )

  const prompt = buildSeededChatPrompt({
    language: 'zh-CN',
    prompt: '手持类远程的combat icon 的实际的预制体显示 需要加一个sprite outline 的组件 显示3px的外描边',
    attachments: [],
    messages,
    provider: 'codex',
    status: 'idle',
  })

  assert.match(prompt, /sprite outline/i)
  assert.match(prompt, /外边框/)
  assert.match(prompt, /外描边/)
  assert.doesNotMatch(prompt, /用户打断|这次运行已停止/)

  assert.deepEqual(
    collectSeededChatAttachments({
      messages,
      attachments: [],
      provider: 'codex',
      status: 'idle',
    }),
    [],
  )
})
