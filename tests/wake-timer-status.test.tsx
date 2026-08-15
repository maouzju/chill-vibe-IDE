import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { getLocaleText } from '../shared/i18n.ts'
import { summarizeWakeTimerBatch } from '../src/components/wake-timer.ts'
import {
  WakeTimerStatus,
  type WakeTimerStatusProps,
} from '../src/components/WakeTimerStatus.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const text = getLocaleText('zh-CN')

const render = (overrides: Partial<WakeTimerStatusProps> = {}) =>
  renderToStaticMarkup(
    React.createElement(WakeTimerStatus, {
      language: 'zh-CN',
      queueLength: 1,
      conditionText: '等待左侧 Tab 完成',
      pendingStatusLabel: text.wakeTimerPendingStatus,
      wakeNowLabel: text.wakeTimerWakeNow,
      cancelLabel: text.wakeTimerCancel,
      wakeTimerMode: 'left-tab',
      wakeTimerDurationMinutes: 30,
      neighbourAvailable: true,
      onChangeMode: () => undefined,
      onChangeDurationMinutes: () => undefined,
      ...overrides,
    } as WakeTimerStatusProps),
  )

describe('待唤醒卡上直接换唤醒方式', () => {
  it('把三种唤醒方式做成状态行里的下拉，当前方式已选中', () => {
    const markup = render({ wakeTimerMode: 'workspace-agents' })

    assert.match(markup, /class="[^"]*composer-wake-timer-mode-select"/)
    assert.match(markup, /<option value="workspace-agents" selected=""/)
    assert.match(markup, new RegExp(text.wakeTimerModeLeftTab))
    assert.match(markup, new RegExp(text.wakeTimerModeDuration))
  })

  it('没有左邻可等时禁掉那个选项，不让用户切进死条件', () => {
    const markup = render({ wakeTimerMode: 'duration', neighbourAvailable: false })

    assert.match(markup, /<option value="left-tab" disabled=""/)
  })

  it('选到定时才露出分钟输入', () => {
    assert.equal(
      render({ wakeTimerMode: 'workspace-agents' }).includes('composer-wake-timer-duration-input'),
      false,
    )
    assert.match(
      render({ wakeTimerMode: 'duration', wakeTimerDurationMinutes: 45 }),
      /composer-wake-timer-duration-input[^>]*value="45"/,
    )
  })
})

describe('待唤醒卡的批次摘要', () => {
  it('在条数和条件之外显示攒着的正文，并把全文放进 title', () => {
    const summary = summarizeWakeTimerBatch([
      { id: 'one', prompt: '把发版脚本里的 zip 校验补上', attachments: [] },
    ])
    const markup = render({
      queuePreviewText: text.wakeTimerQueuePreview(summary.preview, summary.attachmentCount),
    })

    assert.match(markup, /1 条消息 · 等待左侧 Tab 完成/)
    assert.match(markup, /composer-wake-timer-preview/)
    assert.match(markup, /把发版脚本里的 zip 校验补上/)
    assert.match(markup, /title="把发版脚本里的 zip 校验补上"/)
  })

  it('没有摘要时不渲染空的摘要行', () => {
    const markup = render()

    assert.equal(markup.includes('composer-wake-timer-preview'), false)
    assert.match(markup, /待唤醒/)
  })
})
