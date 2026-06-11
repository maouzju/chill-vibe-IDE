import assert from 'node:assert/strict'
import test from 'node:test'

import { formatLocalizedTime, formatMessageHoverTimestamp } from '../shared/i18n.ts'

const localIso = (
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
) => new Date(year, month - 1, day, hour, minute).toISOString()

const NOW = new Date(2026, 5, 11, 15, 0)

test('formatMessageHoverTimestamp shows bare time for same-day messages', () => {
  const value = localIso(2026, 6, 11, 8, 30)
  const expectedTime = formatLocalizedTime('zh-CN', value)

  assert.equal(formatMessageHoverTimestamp('zh-CN', value, NOW), expectedTime)
  assert.equal(
    formatMessageHoverTimestamp('en', value, NOW),
    formatLocalizedTime('en', value),
  )
})

test('formatMessageHoverTimestamp prefixes yesterday by calendar day, not 24h delta', () => {
  const value = localIso(2026, 6, 10, 23, 50)
  const justPastMidnight = new Date(2026, 5, 11, 0, 10)

  assert.equal(
    formatMessageHoverTimestamp('zh-CN', value, justPastMidnight),
    `昨天 ${formatLocalizedTime('zh-CN', value)}`,
  )
  assert.equal(
    formatMessageHoverTimestamp('en', value, NOW),
    `Yesterday ${formatLocalizedTime('en', value)}`,
  )
})

test('formatMessageHoverTimestamp prefixes N days ago for older messages', () => {
  const value = localIso(2026, 6, 8, 9, 0)

  assert.equal(
    formatMessageHoverTimestamp('zh-CN', value, NOW),
    `3天前 ${formatLocalizedTime('zh-CN', value)}`,
  )
  assert.equal(
    formatMessageHoverTimestamp('en', value, NOW),
    `3 days ago ${formatLocalizedTime('en', value)}`,
  )
})

test('formatMessageHoverTimestamp keeps future or invalid-day diffs prefix-free', () => {
  const futureValue = localIso(2026, 6, 12, 10, 0)

  assert.equal(
    formatMessageHoverTimestamp('zh-CN', futureValue, NOW),
    formatLocalizedTime('zh-CN', futureValue),
  )
})
