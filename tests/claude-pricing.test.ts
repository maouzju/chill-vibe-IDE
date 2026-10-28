import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CLAUDE_PRICING_COPIED_ON,
  claudePriceTable,
  estimateClaudeCostUsd,
  resolveClaudeModelFamily,
  resolveClaudePriceKey,
  resolveClaudePriceRow,
} from '../shared/claude-pricing.ts'

describe('claude pricing', () => {
  it('records where the numbers came from', () => {
    assert.equal(CLAUDE_PRICING_COPIED_ON, '2026-10-28')
    // 照抄 prices.json：五档 [输入, 输出, 缓存写 5 分钟, 缓存写 1 小时, 缓存读]
    assert.deepEqual(claudePriceTable['claude-opus-5-5'], [4, 20, 5, 8, 0.2])
    assert.deepEqual(claudePriceTable['claude-haiku-5-5@long'], [0.5, 2.5, 0.625, 1, 0.05])
  })

  it('maps models to a family, mythos included', () => {
    assert.equal(resolveClaudeModelFamily('claude-fable-5-1'), 'fable')
    assert.equal(resolveClaudeModelFamily('claude-mythos-5'), 'fable')
    assert.equal(resolveClaudeModelFamily('claude-opus-4-1-20250805'), 'opus')
    assert.equal(resolveClaudeModelFamily('claude-sonnet-5-5'), 'sonnet')
    assert.equal(resolveClaudeModelFamily('claude-3-5-haiku-20241022'), 'haiku')
    assert.equal(resolveClaudeModelFamily('<synthetic>'), null)
    assert.equal(resolveClaudeModelFamily(undefined), null)
  })

  it('normalizes dotted versions before matching the longest prefix', () => {
    assert.equal(resolveClaudePriceKey('claude-opus-4.1', 10), 'claude-opus-4-1')
    assert.deepEqual(resolveClaudePriceRow('claude-opus-4-1'), claudePriceTable['claude-opus-4-1'])
    // 最长前缀：opus-5-5 不能落到 opus-5 那一档
    assert.deepEqual(
      resolveClaudePriceRow('claude-opus-5-5-20261001'),
      claudePriceTable['claude-opus-5-5'],
    )
    assert.deepEqual(resolveClaudePriceRow('claude-opus-5-20260301'), claudePriceTable['claude-opus-5'])
  })

  it('sends haiku 5.5 to the long-context tier above 100k prompt tokens', () => {
    assert.equal(resolveClaudePriceKey('claude-haiku-5-5', 100_000), 'claude-haiku-5-5')
    assert.equal(resolveClaudePriceKey('claude-haiku-5-5', 100_001), 'claude-haiku-5-5@long')
    // 其它型号没有 @long 档
    assert.equal(resolveClaudePriceKey('claude-sonnet-5-5', 500_000), 'claude-sonnet-5-5')
    assert.deepEqual(
      resolveClaudePriceRow('claude-haiku-5-5@long'),
      claudePriceTable['claude-haiku-5-5@long'],
    )
    // @long 只匹配 @long，不能被更长的非 long 键截胡
    assert.deepEqual(resolveClaudePriceRow('claude-haiku-5-5'), claudePriceTable['claude-haiku-5-5'])
  })

  it('falls back to the family default for unknown models', () => {
    assert.deepEqual(resolveClaudePriceRow('claude-sonnet-9'), claudePriceTable.sonnet)
    assert.deepEqual(resolveClaudePriceRow('claude-mythos-7'), claudePriceTable.fable)
    assert.deepEqual(resolveClaudePriceRow('claude-haiku-9@long'), claudePriceTable.haiku)
    // 连系列都认不出：按 opus 计（与 token-dashboard 一致）
    assert.deepEqual(resolveClaudePriceRow('something-else'), claudePriceTable.opus)
  })

  it('prices the five buckets in USD per million tokens', () => {
    // opus-5-5：[4, 20, 5, 8, 0.2]；cw 含 1h 部分，1h 部分按 1h 价
    const cost = estimateClaudeCostUsd('claude-opus-5-5', {
      input: 1_000_000,
      output: 100_000,
      cacheWrite: 300_000,
      cacheWrite1h: 100_000,
      cacheRead: 2_000_000,
    })
    assert.ok(Math.abs(cost - (4 + 2 + 200_000 * 5 / 1e6 + 100_000 * 8 / 1e6 + 0.4)) < 1e-9)
  })
})
