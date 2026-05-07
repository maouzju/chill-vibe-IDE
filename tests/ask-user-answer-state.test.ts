import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage } from '../shared/schema.ts'
import { buildRenderableMessages } from '../src/components/chat-card-parsing.ts'
import {
  getAskUserAnsweredOption,
  getLatestUserAnswerAfterAskUserMessage,
} from '../src/components/ask-user-answer-state.ts'

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
  role: overrides.role ?? 'assistant',
  content: overrides.content ?? '',
  createdAt: overrides.createdAt ?? new Date().toISOString(),
  meta: overrides.meta,
})

const askUser = (id: string): ChatMessage =>
  message({
    id,
    role: 'assistant',
    meta: {
      kind: 'ask-user',
      provider: 'codex',
      itemId: id,
      structuredData: JSON.stringify({
        itemId: id,
        kind: 'ask-user',
        status: 'completed',
        question: 'Choose?',
        header: 'Need choice',
        multiSelect: false,
        options: [
          { label: 'Fast', description: '' },
          { label: 'Deep', description: '' },
        ],
      }),
    },
  })

test('restored ask-user answer state resolves the user reply after the question', () => {
  const firstAsk = askUser('ask-1')
  const messages = [
    message({ id: 'assistant-before', role: 'assistant', content: 'before' }),
    firstAsk,
    message({ id: 'user-answer', role: 'user', content: 'Fast' }),
    message({ id: 'assistant-after', role: 'assistant', content: 'continuing' }),
  ]

  assert.equal(getLatestUserAnswerAfterAskUserMessage(messages, firstAsk), 'Fast')
})

test('restored ask-user answer state stops at the next ask-user question', () => {
  const firstAsk = askUser('ask-1')
  const secondAsk = askUser('ask-2')
  const messages = [
    firstAsk,
    secondAsk,
    message({ id: 'user-answer', role: 'user', content: 'Deep' }),
  ]

  assert.equal(getLatestUserAnswerAfterAskUserMessage(messages, firstAsk), null)
  assert.equal(getLatestUserAnswerAfterAskUserMessage(messages, secondAsk), 'Deep')
})

test('ask-user answered option falls back to restored transcript answers', () => {
  const firstAsk = askUser('ask-1')
  const messages = [
    firstAsk,
    message({ id: 'user-answer', role: 'user', content: 'Fast' }),
  ]

  assert.equal(getAskUserAnsweredOption(messages, firstAsk, {}), 'Fast')
})

test('ask-user answered option prefers the current in-memory selection', () => {
  const firstAsk = askUser('ask-1')
  const messages = [
    firstAsk,
    message({ id: 'user-answer', role: 'user', content: 'Fast' }),
  ]

  assert.equal(
    getAskUserAnsweredOption(messages, firstAsk, {
      'ask-1:ask-1:{"question":"Choose?","header":"Need choice","multiSelect":false,"options":["Fast","Deep"]}': 'Deep',
    }),
    'Deep',
  )
})

test('restored merged ask-user answer state resolves the reply after consecutive questions', () => {
  const firstAsk = askUser('ask-1')
  const secondAsk = askUser('ask-2')
  const messages = [
    firstAsk,
    secondAsk,
    message({
      id: 'user-answer',
      role: 'user',
      content: '[1] Choose? -> Fast\n[2] Choose? -> Deep',
    }),
    message({ id: 'assistant-after', role: 'assistant', content: 'continuing' }),
  ]
  const renderableMessages = buildRenderableMessages(messages)
  const mergedAskUser = renderableMessages[0]?.type === 'message'
    ? renderableMessages[0].message
    : null

  assert.ok(mergedAskUser, 'consecutive ask-user messages should render as one merged card')
  assert.equal(
    getAskUserAnsweredOption(messages, mergedAskUser, {}),
    '[1] Choose? -> Fast\n[2] Choose? -> Deep',
  )
})
