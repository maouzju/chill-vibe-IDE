import assert from 'node:assert/strict'
import test from 'node:test'

import { getFileTreeCardText, getTextEditorCardText } from '../src/components/tool-card-text.ts'

test('tool card zh-CN labels stay readable', () => {
  const fileTreeText = getFileTreeCardText('zh-CN')
  assert.equal(fileTreeText.loading, '加载文件中...')
  assert.equal(fileTreeText.searchPlaceholder, '搜索文件')
  assert.equal(fileTreeText.searching, '搜索文件中...')
  assert.equal(fileTreeText.emptySearch, '没有找到匹配的文件。')

  const editorText = getTextEditorCardText('zh-CN')
  assert.equal(editorText.loading, '加载中...')
  assert.equal(editorText.saving, '保存中...')
  assert.equal(editorText.unsaved, '未保存')
})
