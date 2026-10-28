import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildUsageChart,
  claudeUsagePresets,
  filterUsageProjects,
  formatUsageMoney,
  formatUsageTokens,
  resolveUsagePresetRange,
} from '../src/claude-usage-view-model.ts'

const now = new Date(2026, 9, 28, 15, 0, 0, 0) // 2026-10-28, local

describe('claude usage presets', () => {
  it('resolves every preset to a local day range', () => {
    assert.deepEqual(resolveUsagePresetRange('today', now), { from: '2026-10-28', to: '2026-10-28' })
    assert.deepEqual(resolveUsagePresetRange('yesterday', now), { from: '2026-10-27', to: '2026-10-27' })
    assert.deepEqual(resolveUsagePresetRange('last7', now), { from: '2026-10-22', to: '2026-10-28' })
    assert.deepEqual(resolveUsagePresetRange('last30', now), { from: '2026-09-29', to: '2026-10-28' })
    assert.deepEqual(resolveUsagePresetRange('thisMonth', now), { from: '2026-10-01', to: '2026-10-28' })
    assert.deepEqual(resolveUsagePresetRange('lastMonth', now), { from: '2026-09-01', to: '2026-09-30' })
    assert.deepEqual(resolveUsagePresetRange('all', now), { from: '2000-01-01', to: '2026-10-28' })
    assert.equal(claudeUsagePresets.length, 7)
  })

  it('handles the January edge of "last month"', () => {
    assert.deepEqual(resolveUsagePresetRange('lastMonth', new Date(2026, 0, 5)), {
      from: '2025-12-01',
      to: '2025-12-31',
    })
  })
})

describe('formatting', () => {
  it('formats money and tokens compactly', () => {
    assert.equal(formatUsageMoney(0.004), '$0.00')
    assert.equal(formatUsageMoney(3.456), '$3.46')
    assert.equal(formatUsageMoney(45_133.2), '$45,133')
    assert.equal(formatUsageTokens(950), '950')
    assert.equal(formatUsageTokens(12_300), '12K')
    assert.equal(formatUsageTokens(8_670_000), '8.7M')
    assert.equal(formatUsageTokens(30_210_000_000), '30.21B')
  })
})

describe('buildUsageChart', () => {
  const daily = {
    '2026-10-26': { kubi: 10, other1: 1, other2: 2 },
    '2026-10-27': { kubi: 30 },
  }

  it('lays out one stacked bar per day, folding non-color projects into "other"', () => {
    const chart = buildUsageChart({
      daily,
      from: '2026-10-25',
      to: '2026-10-27',
      colorOrder: ['kubi'],
      width: 400,
      height: 230,
    })
    // 与 token-dashboard 一致：范围开头没数据的日子不画（否则「全部」会从 2000 年画起）
    assert.deepEqual(
      chart.days.map((day) => day.key),
      ['2026-10-26', '2026-10-27'],
    )
    assert.deepEqual(chart.days[0]?.segments.map((segment) => [segment.project, segment.value]), [
      ['kubi', 10],
      ['__other__', 3],
    ])
    assert.equal(chart.days[0]?.segments[1]?.colorIndex, -1)
    assert.equal(chart.days[0]?.segments[0]?.colorIndex, 0)
    assert.equal(chart.days[1]?.segments.length, 1)
    assert.equal(chart.maxValue, 30)
    assert.ok(chart.ticks.length >= 2)
    assert.equal(chart.ticks[0]?.value, 0)
    // 柱子从左到右按天排布，宽度相同
    assert.ok(chart.days[0]!.x < chart.days[1]!.x)
    assert.ok(chart.days[0]!.width > 0)
    // 段叠放：下一段的 y 落在上一段顶部
    const [low, high] = chart.days[0]!.segments
    assert.ok(Math.abs(low!.y - (high!.y + high!.height)) < 1e-6)
  })

  it('starts at the first day with data when the range opens before any usage', () => {
    const chart = buildUsageChart({
      daily,
      from: '2000-01-01',
      to: '2026-10-27',
      colorOrder: ['kubi'],
      width: 400,
      height: 230,
    })
    assert.equal(chart.days[0]?.key, '2026-10-26')
    assert.equal(chart.days.length, 2)
  })
})

describe('filterUsageProjects', () => {
  const projects = [
    { id: 'kubi', path: 'D:\\Git\\kubi' },
    { id: '(temp)', path: null },
    { id: 'TaleCity', path: 'D:\\Git\\TaleCity' },
  ]
  it('matches id, display label and path case-insensitively', () => {
    const label = (id: string) => (id === '(temp)' ? '临时目录' : id)
    assert.deepEqual(filterUsageProjects(projects, 'tale', label).map((p) => p.id), ['TaleCity'])
    assert.deepEqual(filterUsageProjects(projects, '临时', label).map((p) => p.id), ['(temp)'])
    assert.deepEqual(filterUsageProjects(projects, 'd:\\git', label).map((p) => p.id), ['kubi', 'TaleCity'])
    assert.equal(filterUsageProjects(projects, '  ', label).length, 3)
  })
})
