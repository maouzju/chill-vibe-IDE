import assert from 'node:assert/strict'
import test from 'node:test'

import { getSpecToolText } from '../src/components/tool-card-text.ts'

test('SPEC tool zh-CN labels stay readable', () => {
  const text = getSpecToolText('zh-CN')

  assert.equal(text.emptyTitle, '新 SPEC')
  assert.equal(text.startButton, '生成 SPEC 骨架')
  assert.equal(text.openRequirements, '打开需求')
  assert.equal(text.docsReady, 'SPEC 文档已就位，可以先 review 再写代码。')
})
