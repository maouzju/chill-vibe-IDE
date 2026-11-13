import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatMessage } from '../shared/schema.ts'
import { attachContextUsageMeta } from '../src/components/context-usage.ts'
import {
  applyContextUsageEvent,
  clearContextUsage,
  resetContextUsageStoreForTests,
} from '../src/components/context-usage-store.ts'
import {
  ContextUsageIndicator,
  type ContextUsageIndicatorProps,
} from '../src/components/ContextUsageIndicator.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const recorded = (used: number, size?: number): ChatMessage =>
  attachContextUsageMeta(
    {
      id: `d-${used}`,
      role: 'system',
      content: '耗时 12 秒',
      createdAt: '2026-11-12T08:00:00.000Z',
      meta: { kind: 'run-duration' },
    },
    { used, ...(size === undefined ? {} : { size }) },
    'claude',
  )

const render = (overrides: Partial<ContextUsageIndicatorProps> = {}) =>
  renderToStaticMarkup(
    React.createElement(ContextUsageIndicator, {
      cardId: 'card-a',
      messages: [recorded(44377, 200000)],
      provider: 'claude',
      streaming: false,
      hasSession: true,
      language: 'zh-CN',
      autoCompactEnabled: true,
      autoCompactThresholdPercent: 80,
      ...overrides,
    } as ContextUsageIndicatorProps),
  )

describe('输入框旁的上下文占用指示', () => {
  beforeEach(() => {
    resetContextUsageStoreForTests()
  })

  it('知道窗口时画一个圆环并写百分比', () => {
    const markup = render()

    assert.match(markup, /class="composer-context-usage"/)
    assert.match(markup, /data-level="normal"/)
    assert.match(markup, /aria-label="上下文已用 44\.4k \/ 200k（22%）"/)
    assert.match(markup, /<svg[^>]*class="composer-context-usage-ring"/)
    assert.match(markup, />22%<\/span>/)
  })

  it('不知道窗口时只写已用的 token 数，不画圆环', () => {
    const markup = render({ messages: [recorded(44289)] })

    assert.match(markup, />44\.3k<\/span>/)
    assert.doesNotMatch(markup, /<svg/)
  })

  it('没有数字就什么都不显示', () => {
    assert.equal(render({ messages: [] }), '')
  })

  it('不支持的 CLI 不显示', () => {
    assert.equal(render({ provider: 'gemini' }), '')
  })

  it('会话已经不在了、又没有回合在跑时不显示旧数字', () => {
    assert.equal(render({ hasSession: false }), '')
  })

  it('接近和到达自动压缩阈值时换颜色档位', () => {
    assert.match(render({ messages: [recorded(150000, 200000)] }), /data-level="warning"/)
    assert.match(render({ messages: [recorded(170000, 200000)] }), /data-level="danger"/)
  })

  it('回合进行中用实时值，回合之间用记在对话里的值', () => {
    applyContextUsageEvent('card-a', { used: 120000, size: 200000 })

    assert.match(render({ streaming: true }), />60%<\/span>/)
    assert.match(render({ streaming: false }), />22%<\/span>/)
    // 别的卡的实时值不串过来。
    assert.match(render({ cardId: 'card-b', streaming: true }), />22%<\/span>/)
  })

  it('回合进行中刚开了新会话：不知道就不显示，不拿旧会话的数字顶上', () => {
    clearContextUsage('card-a')

    assert.equal(render({ streaming: true, hasSession: false }), '')
  })
})
