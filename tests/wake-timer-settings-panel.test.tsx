import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createCard, createDefaultSettings } from '../shared/default-state.ts'
import { getLocaleText } from '../shared/i18n.ts'
import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import type { ChatCard } from '../shared/schema.ts'
import {
  WakeTimerSettingsPanel,
  type WakeTimerSettingsPanelProps,
} from '../src/components/WakeTimerSettingsPanel.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const settings = createDefaultSettings()
const text = getLocaleText(settings.language)

const card = (overrides: Partial<ChatCard> = {}): ChatCard => ({
  ...createCard('Item', undefined, 'codex', DEFAULT_CODEX_MODEL),
  ...overrides,
})

const render = (overrides: Partial<WakeTimerSettingsPanelProps> = {}) =>
  renderToStaticMarkup(
    React.createElement(WakeTimerSettingsPanel, {
      language: settings.language,
      context: 'tab',
      card: card({ wakeTimerActive: true }),
      neighbourTarget: { id: 'left', title: '左边那张' },
      workspaceAgentCount: 2,
      locked: false,
      onPatch: () => undefined,
      ...overrides,
    } as WakeTimerSettingsPanelProps),
  )

describe('WakeTimerSettingsPanel', () => {
  it('collapses everything but the master switch while the timer is off', () => {
    const html = render({ card: card({ wakeTimerActive: false }) })

    assert.ok(html.includes(text.wakeTimerLabel))
    assert.ok(!html.includes(text.wakeTimerModeLabel))
    assert.ok(!html.includes(text.wakeTimerModeDuration))
  })

  it('renders the full three-mode picker once the timer is on', () => {
    const html = render()

    assert.ok(html.includes(text.wakeTimerModeLabel))
    assert.ok(html.includes(text.wakeTimerModeWorkspace))
    assert.ok(html.includes(text.wakeTimerModeLeftTab))
    assert.ok(html.includes(text.wakeTimerModeDuration))
  })

  // 看板项不在任何 pane 里，它等的是"同泳道上一项"。逻辑仍是同一个 left-tab
  // 模式，只有文案换方位，所以两处必须共用这一个面板。
  it('swaps the neighbour wording for the board context', () => {
    const html = render({ context: 'board' })

    assert.ok(html.includes(text.automationBoardWakeAboveLabel))
    assert.ok(!html.includes(text.wakeTimerModeLeftTab))
  })

  it('warns with the matching wording when there is no neighbour to wait for', () => {
    const tab = render({ card: card({ wakeTimerActive: true, wakeTimerMode: 'left-tab' }), neighbourTarget: null })
    const board = render({
      context: 'board',
      card: card({ wakeTimerActive: true, wakeTimerMode: 'left-tab' }),
      neighbourTarget: null,
    })

    assert.ok(tab.includes(text.wakeTimerLeftUnavailable))
    assert.ok(!tab.includes(text.automationBoardWakeAboveUnavailable))
    assert.ok(board.includes(text.automationBoardWakeAboveUnavailable))
    assert.ok(!board.includes(text.wakeTimerLeftUnavailable))
  })

  it('keeps the warning away while a neighbour is available', () => {
    const html = render({ card: card({ wakeTimerActive: true, wakeTimerMode: 'left-tab' }) })

    assert.ok(!html.includes(text.wakeTimerLeftUnavailable))
  })

  it('shows the duration input only in duration mode', () => {
    const workspace = render({ card: card({ wakeTimerActive: true, wakeTimerMode: 'workspace-agents' }) })
    const duration = render({
      card: card({ wakeTimerActive: true, wakeTimerMode: 'duration', wakeTimerDurationMinutes: 45 }),
    })

    assert.ok(!workspace.includes(text.wakeTimerDurationLabel))
    assert.ok(duration.includes(text.wakeTimerDurationLabel))
    assert.match(duration, /value="45"/)
  })

  it('reports the peer agent count in workspace mode', () => {
    const html = render({
      card: card({ wakeTimerActive: true, wakeTimerMode: 'workspace-agents' }),
      workspaceAgentCount: 3,
    })

    assert.ok(html.includes(text.wakeTimerWorkspaceAgentCount(3)))
  })

  it('locks the mode and duration inputs while a batch is armed', () => {
    const html = render({
      card: card({ wakeTimerActive: true, wakeTimerMode: 'duration' }),
      locked: true,
    })

    assert.ok(html.includes(text.wakeTimerBatchLocked))
    assert.equal(html.match(/disabled=""/g)?.length, 2)
  })

  it('renders in English too', () => {
    const en = getLocaleText('en')
    const html = render({ language: 'en', context: 'board' })

    assert.ok(html.includes(en.wakeTimerLabel))
    assert.ok(html.includes(en.automationBoardWakeAboveLabel))
  })
})
