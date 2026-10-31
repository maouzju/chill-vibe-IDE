import assert from 'node:assert/strict'
import test from 'node:test'

import { createDefaultSettings, isQuickToolModelEnabled } from '../shared/default-state.ts'
import { STATS_TOOL_MODEL } from '../shared/models.ts'

test('stats card is always available, even when an old save has the experimental flag off', () => {
  const settings = { ...createDefaultSettings(), experimentalStatsEnabled: false }
  assert.equal(isQuickToolModelEnabled(settings, STATS_TOOL_MODEL), true)
})
