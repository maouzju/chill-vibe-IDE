import assert from 'node:assert/strict'
import test from 'node:test'

import { getFileTreeCardText, getTextEditorCardText } from '../src/components/tool-card-text.ts'

test('tool card zh-CN labels stay readable', () => {
  const fileTreeText = getFileTreeCardText('zh-CN')
  assert.equal(fileTreeText.loading, '\u52a0\u8f7d\u6587\u4ef6\u4e2d...')
  assert.equal(fileTreeText.searchPlaceholder, '\u641c\u7d22\u6587\u4ef6')
  assert.equal(fileTreeText.searching, '\u641c\u7d22\u6587\u4ef6\u4e2d...')
  assert.equal(fileTreeText.emptySearch, '\u6ca1\u6709\u627e\u5230\u5339\u914d\u7684\u6587\u4ef6\u3002')

  const editorText = getTextEditorCardText('zh-CN')
  assert.equal(editorText.loading, '\u52a0\u8f7d\u4e2d...')
  assert.equal(editorText.saving, '\u4fdd\u5b58\u4e2d...')
  assert.equal(editorText.unsaved, '\u672a\u4fdd\u5b58')
})
