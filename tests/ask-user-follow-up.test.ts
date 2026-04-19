import assert from 'node:assert/strict'
import test from 'node:test'

import { formatAskUserFollowUpPrompt } from '../src/components/ask-user-follow-up.ts'

test('leading hyphen ask-user answers are wrapped into a safe follow-up prompt', () => {
  assert.equal(
    formatAskUserFollowUpPrompt('-50%: 读条速度 ×0.5（沿用当前占位）', 'zh-CN'),
    '我选择：-50%: 读条速度 ×0.5（沿用当前占位）',
  )
  assert.equal(
    formatAskUserFollowUpPrompt('--dangerously-skip-permissions', 'en'),
    'My choice: --dangerously-skip-permissions',
  )
})

test('normal ask-user answers stay unchanged', () => {
  assert.equal(formatAskUserFollowUpPrompt('Fast path', 'en'), 'Fast path')
  assert.equal(formatAskUserFollowUpPrompt('减速 50%', 'zh-CN'), '减速 50%')
})
