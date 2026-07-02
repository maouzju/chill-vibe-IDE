import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isBareClaudeToolCallMarkerText,
  stripTrailingClaudeTypedToolMarkerLines,
} from '../server/providers.ts'
import { stripPersistedClaudeProtocolResidueLines } from '../server/state-store.ts'
import { createClaudeAskUserDeltaStripper } from '../server/claude-structured-output.ts'

test('isBareClaudeToolCallMarkerText treats the known marker family as bare markers', () => {
  assert.equal(isBareClaudeToolCallMarkerText('call'), true)
  assert.equal(isBareClaudeToolCallMarkerText('call:'), true)
  assert.equal(isBareClaudeToolCallMarkerText('court'), true)
  assert.equal(isBareClaudeToolCallMarkerText('card'), true)
  assert.equal(isBareClaudeToolCallMarkerText('count'), true)
  assert.equal(isBareClaudeToolCallMarkerText('course'), true)
  assert.equal(isBareClaudeToolCallMarkerText('课'), true)
  assert.equal(isBareClaudeToolCallMarkerText('call:\ncourt'), true)
})

test('isBareClaudeToolCallMarkerText treats novel lone short words as residue too', () => {
  // Leaked marker words keep mutating; a text that is nothing but 1-2 bare
  // short words beside real tool activity is never meaningful prose.
  assert.equal(isBareClaudeToolCallMarkerText('cart'), true)
  assert.equal(isBareClaudeToolCallMarkerText('cold\n'), true)
  assert.equal(isBareClaudeToolCallMarkerText('卡'), true)
})

test('isBareClaudeToolCallMarkerText keeps real assistant prose', () => {
  assert.equal(isBareClaudeToolCallMarkerText('The card is ready.'), false)
  assert.equal(isBareClaudeToolCallMarkerText('整体高度一致，色调略微偏移。'), false)
  // 3+ bare word lines look like a deliberate list, not a leaked marker.
  assert.equal(isBareClaudeToolCallMarkerText('one\ntwo\nthree'), false)
  assert.equal(isBareClaudeToolCallMarkerText('done and dusted'), false)
})

test('stripTrailingClaudeTypedToolMarkerLines strips the extended marker family', () => {
  assert.equal(stripTrailingClaudeTypedToolMarkerLines('正文说明。\ncard'), '正文说明。')
  assert.equal(stripTrailingClaudeTypedToolMarkerLines('正文说明。\ncourse\ncount'), '正文说明。')
  assert.equal(stripTrailingClaudeTypedToolMarkerLines('正文说明。\ncall:\n课'), '正文说明。')
})

test('stripTrailingClaudeTypedToolMarkerLines leaves unknown trailing words alone', () => {
  // Blanket trailing removal has no sandwich context, so novel words are only
  // handled by the whole-text bare-marker check and the renderer fallback.
  assert.equal(
    stripTrailingClaudeTypedToolMarkerLines('正文说明。\nfinished'),
    '正文说明。\nfinished',
  )
})

test('stripPersistedClaudeProtocolResidueLines strips trailing card residue at save time', () => {
  assert.equal(stripPersistedClaudeProtocolResidueLines('正文说明。\n\ncard\n'), '正文说明。')
  assert.equal(stripPersistedClaudeProtocolResidueLines('正文说明。\n\ncourse\n'), '正文说明。')
  assert.equal(stripPersistedClaudeProtocolResidueLines('正文说明。\n\ncount\n'), '正文说明。')
})

test('stripPersistedClaudeProtocolResidueLines keeps normal prose endings', () => {
  assert.equal(
    stripPersistedClaudeProtocolResidueLines('修复完成，测试全绿。'),
    '修复完成，测试全绿。',
  )
})

test('delta stripper drops a stray card marker line attached to a typed tool-call block', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const released =
    stripper.push(
      '前置说明。\ncard\n<invoke name="Edit">\n<parameter name="file_path">a.ts</parameter>\n</invoke>',
    ) + stripper.flush()

  assert.equal(released.trim(), '前置说明。')
})

test('delta stripper drops a novel stray marker word attached to a typed tool-call block', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const released =
    stripper.push(
      '前置说明。\ncart\n<invoke name="Edit">\n<parameter name="file_path">a.ts</parameter>\n</invoke>',
    ) + stripper.flush()

  assert.equal(released.trim(), '前置说明。')
})
