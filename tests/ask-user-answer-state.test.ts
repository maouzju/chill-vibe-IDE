import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage } from '../shared/schema.ts'
import { buildRenderableMessages } from '../src/components/chat-card-parsing.ts'
import {
  getAskUserAnsweredOption,
  getLatestUserAnswerAfterAskUserMessage,
  shouldExitPlanModeForAskUserAnswer,
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

const planApproval = (id: string): ChatMessage =>
  message({
    id,
    role: 'assistant',
    meta: {
      kind: 'ask-user',
      provider: 'claude',
      itemId: id,
      structuredData: JSON.stringify({
        itemId: id,
        kind: 'ask-user',
        status: 'completed',
        planFile: 'plan.md',
        question: '是否批准这个计划？',
        header: '计划审批',
        multiSelect: false,
        options: [
          { label: '批准计划', description: '' },
          { label: '拒绝计划', description: '' },
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

test('plan approval card is not auto-answered by an unrelated following user message', () => {
  const approval = planApproval('approval-1')
  const messages = [
    message({ id: 'assistant-plan', role: 'assistant', content: 'here is the plan' }),
    approval,
    message({ id: 'user-unrelated', role: 'user', content: '继续' }),
    message({ id: 'assistant-after', role: 'assistant', content: 'working' }),
  ]

  assert.equal(getLatestUserAnswerAfterAskUserMessage(messages, approval), null)
  assert.equal(getAskUserAnsweredOption(messages, approval, {}), null)
})

test('plan approval card still resolves when the user actually picks an option', () => {
  const approval = planApproval('approval-1')
  const messages = [
    approval,
    message({ id: 'user-answer', role: 'user', content: '拒绝计划' }),
  ]

  assert.equal(getLatestUserAnswerAfterAskUserMessage(messages, approval), '拒绝计划')
})

test('ask-user card is not auto-answered by an unrelated following user message', () => {
  const firstAsk = askUser('ask-1')
  const messages = [
    firstAsk,
    message({ id: 'user-unrelated', role: 'user', content: '你看下这个文件' }),
  ]

  assert.equal(getLatestUserAnswerAfterAskUserMessage(messages, firstAsk), null)
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

const planApprovalWithFlag = (id: string, language: 'zh' | 'en' = 'zh'): ChatMessage =>
  message({
    id,
    role: 'assistant',
    meta: {
      kind: 'ask-user',
      provider: 'claude',
      itemId: id,
      structuredData: JSON.stringify({
        itemId: id,
        kind: 'ask-user',
        status: 'completed',
        planApproval: true,
        question: language === 'en' ? 'Plan is ready for review' : '计划已准备好，请审阅',
        header: language === 'en' ? 'Plan approval' : '计划审批',
        multiSelect: false,
        options:
          language === 'en'
            ? [
                { label: 'Approve plan', description: '' },
                { label: 'Reject plan', description: '' },
              ]
            : [
                { label: '批准计划', description: '' },
                { label: '拒绝计划', description: '' },
              ],
      }),
    },
  })

test('approving a pending plan-approval card exits plan mode', () => {
  const messages = [planApprovalWithFlag('approval-1')]

  assert.equal(shouldExitPlanModeForAskUserAnswer(messages, '批准计划'), true)
})

test('approve answer wrapped with a choice prefix still exits plan mode', () => {
  const messages = [planApprovalWithFlag('approval-1')]

  assert.equal(shouldExitPlanModeForAskUserAnswer(messages, '我选择：批准计划'), true)
})

test('English approve label exits plan mode', () => {
  const messages = [planApprovalWithFlag('approval-1', 'en')]

  assert.equal(shouldExitPlanModeForAskUserAnswer(messages, 'Approve plan'), true)
})

test('rejecting or free-form feedback keeps plan mode', () => {
  const messages = [planApprovalWithFlag('approval-1')]

  assert.equal(shouldExitPlanModeForAskUserAnswer(messages, '拒绝计划'), false)
  assert.equal(shouldExitPlanModeForAskUserAnswer(messages, '先把第三步改成分批迁移'), false)
})

test('legacy plan-approval card with only planFile still exits plan mode on approve', () => {
  const messages = [planApproval('approval-legacy')]

  assert.equal(shouldExitPlanModeForAskUserAnswer(messages, '批准计划'), true)
})

test('already-answered plan-approval card does not exit plan mode again', () => {
  const messages = [
    planApprovalWithFlag('approval-1'),
    message({ id: 'user-answer', role: 'user', content: '批准计划' }),
    message({ id: 'assistant-after', role: 'assistant', content: 'implementing' }),
  ]

  assert.equal(shouldExitPlanModeForAskUserAnswer(messages, '继续'), false)
})

test('a fresh plan-approval card after an earlier answered one can still be approved', () => {
  const messages = [
    planApprovalWithFlag('approval-1'),
    message({ id: 'user-answer-1', role: 'user', content: '批准计划' }),
    planApprovalWithFlag('approval-2'),
  ]

  assert.equal(shouldExitPlanModeForAskUserAnswer(messages, '批准计划'), true)
})

test('ordinary ask-user cards never exit plan mode', () => {
  const messages = [askUser('ask-1')]

  assert.equal(shouldExitPlanModeForAskUserAnswer(messages, 'Fast'), false)
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
