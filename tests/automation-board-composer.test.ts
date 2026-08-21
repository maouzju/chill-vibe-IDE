import assert from 'node:assert/strict'
import test from 'node:test'

import { createAutomationBoardItemCard } from '../shared/default-state.ts'
import {
  canSubmitAutomationBoardDraft,
  insertNewlineIntoDraft,
} from '../src/components/automation-board-view.ts'

test('an empty composer cannot create a requirement', () => {
  assert.equal(canSubmitAutomationBoardDraft('', 0), false)
  assert.equal(canSubmitAutomationBoardDraft('   \n  ', 0), false)
})

test('text alone can create a requirement', () => {
  assert.equal(canSubmitAutomationBoardDraft('把这块改掉', 0), true)
})

// 需求经常整个就是一张截图，一个字都不想打。发送按钮不能因为文本为空就锁死。
test('images alone can create a requirement', () => {
  assert.equal(canSubmitAutomationBoardDraft('', 1), true)
  assert.equal(canSubmitAutomationBoardDraft('   ', 2), true)
})

test('text plus images can create a requirement', () => {
  assert.equal(canSubmitAutomationBoardDraft('看这张图', 1), true)
})

// 纯图片项的需求文本是空的，标题必然落到兜底文案上 —— 那句兜底得跟着界面语言走。
test('an image-only item falls back to a localized title', () => {
  const zh = createAutomationBoardItemCard({
    requirement: '',
    provider: 'codex',
    model: 'gpt-5.5',
    language: 'zh-CN',
  })
  const en = createAutomationBoardItemCard({
    requirement: '',
    provider: 'codex',
    model: 'gpt-5.5',
    language: 'en',
  })

  assert.equal(zh.title, '新会话')
  assert.equal(en.title, 'New chat')
})

// Ctrl+回车在 textarea 里没有"插入换行"的原生行为（只有 Shift+回车有），
// 所以放行默认行为等于什么都不做。换行必须自己插。
test('ctrl+enter inserts a newline at the caret', () => {
  assert.deepEqual(insertNewlineIntoDraft('把这块改掉', 5, 5), {
    value: '把这块改掉\n',
    caret: 6,
  })
  assert.deepEqual(insertNewlineIntoDraft('abcd', 2, 2), {
    value: 'ab\ncd',
    caret: 3,
  })
})

// 选中一段文字再按 Ctrl+回车，与打字一样：选区被换行替掉。
test('ctrl+enter replaces the current selection with a newline', () => {
  assert.deepEqual(insertNewlineIntoDraft('abcdef', 1, 4), {
    value: 'a\nef',
    caret: 2,
  })
})

// textarea 的 selectionStart/End 在极端时序下可能落在文本范围外（受控值刚被
// 外部改写），越界的切片会算出错位的光标，宁可夹回边界。
test('out-of-range selections are clamped instead of corrupting the draft', () => {
  assert.deepEqual(insertNewlineIntoDraft('abc', 99, 99), { value: 'abc\n', caret: 4 })
  assert.deepEqual(insertNewlineIntoDraft('abc', -3, -3), { value: '\nabc', caret: 1 })
  assert.deepEqual(insertNewlineIntoDraft('abc', 2, 1), { value: 'ab\nc', caret: 3 })
})
