import assert from 'node:assert/strict'
import test from 'node:test'

import { describeTextEditorLoadFailure } from '../src/components/text-editor-load-failure.ts'
import { getTextEditorCardText } from '../src/components/tool-card-text.ts'

const zh = getTextEditorCardText('zh-CN')
const en = getTextEditorCardText('en')

test('a missing file reads as a missing file, not as a raw ENOENT dump', () => {
  const raw = "ENOENT: no such file or directory, open 'D:\\Git\\demo\\src\\gone.ts'"

  assert.equal(describeTextEditorLoadFailure(new Error(raw), 'zh-CN'), zh.missingFile)
  assert.equal(describeTextEditorLoadFailure(new Error(raw), 'en'), en.missingFile)
})

test('the server-side "Path not found." wording maps to the same message', () => {
  assert.equal(describeTextEditorLoadFailure(new Error('Path not found.'), 'zh-CN'), zh.missingFile)
})

test('other failures keep their original message so real problems stay visible', () => {
  assert.equal(
    describeTextEditorLoadFailure(new Error('EACCES: permission denied'), 'en'),
    'EACCES: permission denied',
  )
  assert.equal(describeTextEditorLoadFailure('boom', 'en'), 'Failed to load file')
})
