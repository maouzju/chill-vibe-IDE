import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createAutomationBoardCard, createCard, createDefaultSettings } from '../shared/default-state.ts'
import { getLocaleText } from '../shared/i18n.ts'
import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import { createDefaultAutomationBoardAutoTrigger } from '../shared/schema.ts'
import type { AutomationBoardTemplate, ChatCard, ChatMessage } from '../shared/schema.ts'
import {
  AutomationBoardCard,
  type AutomationBoardCardProps,
} from '../src/components/AutomationBoardCard.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const settings = createDefaultSettings()
const text = getLocaleText(settings.language)

const message = (index: number, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${index}`,
  role: 'assistant',
  content: `agent line ${index}`,
  createdAt: new Date(Date.parse('2026-08-11T00:00:00.000Z') + index * 1000).toISOString(),
  ...overrides,
})

const itemCard = (id: string, overrides: Partial<ChatCard> = {}): ChatCard => ({
  ...createCard(`Item ${id}`, undefined, 'codex', DEFAULT_CODEX_MODEL),
  id,
  ...overrides,
})

const template: AutomationBoardTemplate = {
  id: 'tpl-1',
  name: '发布前检查',
  requirement: '检查发布前的改动',
  provider: 'codex',
  model: DEFAULT_CODEX_MODEL,
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  wakeTimerActive: false,
  repeatLoopActive: false,
}

const noop = () => undefined

const renderBoard = (overrides: Partial<AutomationBoardCardProps> = {}) => {
  const board = {
    items: [
      { cardId: 'item-a', lane: 'standby' as const, requirement: '把登录页改成暗色' },
      { cardId: 'item-b', lane: 'running' as const, requirement: '补齐结算流程的测试' },
      { cardId: 'item-c', lane: 'done' as const, requirement: '升级依赖' },
    ],
    supervisorCardId: 'sup-1',
    supervisorExpanded: false,
  }

  const cards: Record<string, ChatCard> = {
    'board-1': { ...createAutomationBoardCard('Board'), id: 'board-1', automationBoard: board },
    'item-a': itemCard('item-a'),
    'item-b': itemCard('item-b', {
      status: 'streaming',
      streamId: 's1',
      wakeTimerActive: true,
      wakeTimerMode: 'left-tab',
      messages: Array.from({ length: 20 }, (_, index) => message(index)),
    }),
    'item-c': itemCard('item-c', { messages: [message(1, { role: 'user', content: '升级依赖' })] }),
    'sup-1': itemCard('sup-1'),
  }

  const props: AutomationBoardCardProps = {
    boardCardId: 'board-1',
    columnId: 'column-1',
    workspacePath: 'D:/repo/one',
    language: settings.language,
    board,
    cards,
    templates: [template],
    autoTrigger: createDefaultAutomationBoardAutoTrigger(),
    supervisorCard: cards['sup-1'],
    wakeTimerEnabled: true,
    repeatLoopEnabled: true,
    onCreateItem: noop,
    onMoveItem: noop,
    onPopOutItem: noop,
    onAbsorbTab: noop,
    onInstantiateTemplate: noop,
    onDeleteItem: noop,
    onSaveTemplate: noop,
    onRenameTemplate: noop,
    onDeleteTemplate: noop,
    onStopItem: noop,
    onSendToItem: noop,
    onPatchItemCard: noop,
    onUpdateAutoTrigger: noop,
    onRunSupervisorNow: noop,
    onSetSupervisorExpanded: noop,
    ...overrides,
  }

  return renderToStaticMarkup(React.createElement(AutomationBoardCard, props))
}

describe('AutomationBoardCard renders', () => {
  it('renders all three lanes with their counts', () => {
    const html = renderBoard()

    assert.match(html, /data-lane="standby"/)
    assert.match(html, /data-lane="running"/)
    assert.match(html, /data-lane="done"/)
    assert.ok(html.includes(text.automationBoardLaneStandby))
    assert.ok(html.includes(text.automationBoardLaneRunning))
    assert.ok(html.includes(text.automationBoardLaneDone))
    assert.ok(html.includes(text.automationBoardItemCount(1)))
  })

  it('renders each item with its original requirement', () => {
    const html = renderBoard()

    assert.ok(html.includes('把登录页改成暗色'))
    assert.ok(html.includes('补齐结算流程的测试'))
    assert.ok(html.includes('升级依赖'))
  })

  it('gives a streaming item the same status class the chat card uses', () => {
    const html = renderBoard()

    assert.match(html, /class="automation-board-item is-streaming"/)
  })

  // 计划唤醒在看板里放在项卡片顶部，文案是"上方需求"而不是"左侧 Tab"。
  it('renders the wake hint above the item, using the board wording', () => {
    const html = renderBoard()

    assert.match(html, /automation-board-item-wake/)
    assert.ok(html.includes(text.automationBoardWakeAboveUnavailable))
    assert.ok(!html.includes(text.wakeTimerModeLeftTab))
  })

  it('windows a long transcript and says how many entries are hidden', () => {
    const html = renderBoard()

    // 20 条消息、窗口 6 条 —— 提示里必须给出被隐藏的条数。
    assert.ok(html.includes(text.automationBoardMessagesTruncated(14)))
    assert.ok(html.includes('agent line 19'))
    assert.ok(!html.includes('agent line 0'))
  })

  it('renders the template strip as draggable entries', () => {
    const html = renderBoard()

    assert.ok(html.includes('发布前检查'))
    assert.match(html, /class="automation-board-template"[^>]*draggable="true"/)
  })

  it('renders the supervisor section and its idle copy', () => {
    const html = renderBoard()

    assert.ok(html.includes(text.automationBoardSupervisorSectionLabel))
    assert.ok(html.includes(text.automationBoardSupervisorIdle))
  })

  it('renders the empty-lane hint when a lane has no items', () => {
    const html = renderBoard({
      board: { items: [], supervisorCardId: '', supervisorExpanded: false },
      supervisorCard: undefined,
    })

    assert.ok(html.includes(text.automationBoardEmptyLane))
    assert.ok(html.includes(text.automationBoardItemCount(0)))
  })

  it('renders the empty template hint when there are no templates', () => {
    const html = renderBoard({ templates: [] })

    assert.ok(html.includes(text.automationBoardTemplatesEmpty))
  })

  it('survives an item whose card is missing', () => {
    assert.doesNotThrow(() =>
      renderBoard({
        board: {
          items: [{ cardId: 'ghost', lane: 'running', requirement: 'gone' }],
          supervisorCardId: '',
          supervisorExpanded: false,
        },
        supervisorCard: undefined,
      }),
    )
  })

  it('renders in English too', () => {
    const html = renderBoard({ language: 'en' })
    const en = getLocaleText('en')

    assert.ok(html.includes(en.automationBoardLaneRunning))
    assert.ok(html.includes(en.automationBoardTemplatesLabel))
  })
})
