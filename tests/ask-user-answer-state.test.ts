import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage } from '../shared/schema.ts'
import { buildRenderableMessages } from '../src/components/chat-card-parsing.ts'
import {
  getAskUserAnsweredOption,
  getLatestUserAnswerAfterAskUserMessage,
  isAskUserKeyTargetEditable,
  pickAskUserKeyboardOwnerIndex,
  shouldAskUserIgnoreKey,
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

// 2026-11-20 审查：选择题卡在 window 上听 Enter/方向键，在输入框里打字按 Enter 会连带提交选项、
// 方向键被吞；同屏多张未答卡还会一起响应。
test('ask-user keyboard ignores keys typed into text fields, select and contenteditable', () => {
  assert.equal(isAskUserKeyTargetEditable({ tagName: 'TEXTAREA' }), true)
  assert.equal(isAskUserKeyTargetEditable({ tagName: 'INPUT', type: 'text' }), true)
  assert.equal(isAskUserKeyTargetEditable({ tagName: 'INPUT' }), true)
  assert.equal(isAskUserKeyTargetEditable({ tagName: 'SELECT' }), true)
  assert.equal(isAskUserKeyTargetEditable({ tagName: 'DIV', isContentEditable: true }), true)
  // 点选项后焦点落在隐藏的 radio 上，Enter 提交必须照旧可用。
  assert.equal(isAskUserKeyTargetEditable({ tagName: 'INPUT', type: 'radio' }), false)
  assert.equal(isAskUserKeyTargetEditable({ tagName: 'BUTTON' }), false)
  assert.equal(isAskUserKeyTargetEditable({ tagName: 'BODY' }), false)
  assert.equal(isAskUserKeyTargetEditable(null), false)
})

test('ask-user keyboard: Enter inside the card\'s own "other" input still submits, everything else typed into fields is ignored', () => {
  const key = (overrides: Partial<Parameters<typeof shouldAskUserIgnoreKey>[0]>) =>
    shouldAskUserIgnoreKey({
      key: 'Enter',
      isComposing: false,
      targetEditable: true,
      targetIsOwnOtherInput: false,
      ...overrides,
    })
  // 聊天输入框 / 别的卡的输入框：不响应。
  assert.equal(key({}), true)
  // 本卡「其他」输入框里按 Enter：照旧提交。
  assert.equal(key({ targetIsOwnOtherInput: true }), false)
  // 输入法上屏的 Enter、方向键移动光标：不响应。
  assert.equal(key({ targetIsOwnOtherInput: true, isComposing: true }), true)
  assert.equal(key({ targetIsOwnOtherInput: true, key: 'ArrowLeft' }), true)
  // 焦点不在可编辑控件上：照常响应。
  assert.equal(key({ targetEditable: false }), false)
  assert.equal(key({ targetEditable: false, key: 'ArrowRight' }), false)
})

test('ask-user keyboard: only one unanswered card responds, preferring the one holding focus', () => {
  const card = (overrides: Partial<{ answered: boolean; hidden: boolean; containsTarget: boolean }>) => ({
    answered: false,
    hidden: false,
    containsTarget: false,
    ...overrides,
  })
  assert.equal(pickAskUserKeyboardOwnerIndex([card({}), card({ containsTarget: true }), card({})]), 1)
  assert.equal(pickAskUserKeyboardOwnerIndex([card({}), card({}), card({ answered: true })]), 1)
  // 非活动 tab 里仍挂着的卡不抢按键。
  assert.equal(pickAskUserKeyboardOwnerIndex([card({}), card({ hidden: true })]), 0)
  assert.equal(pickAskUserKeyboardOwnerIndex([card({ answered: true })]), -1)
  assert.equal(pickAskUserKeyboardOwnerIndex([]), -1)
})
