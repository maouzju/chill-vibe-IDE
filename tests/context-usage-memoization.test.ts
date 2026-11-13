import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCard, createDefaultSettings } from '../shared/default-state.ts'
import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import type { BoardColumn, PaneNode } from '../shared/schema.ts'
import {
  arePaneViewPropsEqual,
  areWorkspaceColumnPropsEqual,
} from '../src/components/layout-memoization.ts'

/**
 * 症状（要防的）：在设置里把自动压缩的阈值从 80% 调到 60%（或者关掉开关）再回到看板，
 *   已经打开的卡片上，圆环的颜色档位和悬停说明仍按旧值显示，直到那一列有别的变化才更新。
 *   而发送前的判定读的是最新设置——圆环在 65% 还是普通色，下一条消息却先压缩了。
 * 根因（2026-11-12 独立审查）：这两个设置不住在 `column` 里；WorkspaceColumn 和 PaneView
 *   的比较函数没有比它们，整棵列子树被挡住，ChatCard 里新加的那条比较根本没机会跑
 *   （AGENTS.md pitfall #265：不住在 column 里但要渲染进列的状态，链路上每一层 memo 都得比）。
 *
 * 除被测字段外每个 prop 都是同一个对象身份，否则比较函数读到被测字段之前就已经返回 false，
 * 一个看不见新数据的比较函数照样全绿（pitfall #257）。
 */
const settings = createDefaultSettings()

const pane: PaneNode = {
  type: 'pane',
  id: 'pane-1',
  tabs: ['chat-1'],
  activeTabId: 'chat-1',
  tabHistory: ['chat-1'],
}

const column: BoardColumn = {
  id: 'column-1',
  title: 'Workspace',
  provider: 'codex',
  workspacePath: 'D:/repo/one',
  model: DEFAULT_CODEX_MODEL,
  width: undefined,
  layout: pane,
  cards: {
    'chat-1': { ...createCard('Chat', undefined, 'codex', DEFAULT_CODEX_MODEL), id: 'chat-1' },
  },
}

const sharedProps = {
  column,
  providers: {},
  language: settings.language,
  systemPrompt: settings.systemPrompt,
  crossProviderSkillReuseEnabled: true,
  musicAlbumCoverEnabled: false,
  weatherCity: '',
  gitAgentModel: '',
  brainstormRequestModel: '',
  availableQuickToolModels: [] as string[],
  autoUrgeEnabled: false,
  autoUrgeMessage: '',
  autoUrgeSuccessKeyword: '',
  globalUrgeActive: false,
  globalUrgeProfileId: '',
  autoCompactEnabled: true,
  autoCompactThresholdPercent: 80,
}

const columnProps = { ...sharedProps, recentWorkspaces: [], sessionHistory: [] }
const paneProps = { ...sharedProps, pane }

describe('WorkspaceColumn memoization sees the auto-compact settings', () => {
  it('re-renders the column when the auto-compact threshold changes', () => {
    assert.equal(
      areWorkspaceColumnPropsEqual(columnProps, { ...columnProps, autoCompactThresholdPercent: 60 }),
      false,
    )
  })

  it('re-renders the column when auto-compact is switched off', () => {
    assert.equal(
      areWorkspaceColumnPropsEqual(columnProps, { ...columnProps, autoCompactEnabled: false }),
      false,
    )
  })

  it('stays memoized while both settings are unchanged', () => {
    assert.equal(areWorkspaceColumnPropsEqual(columnProps, { ...columnProps }), true)
  })
})

describe('PaneView memoization sees the auto-compact settings', () => {
  it('re-renders the pane when the auto-compact threshold changes', () => {
    assert.equal(
      arePaneViewPropsEqual(paneProps, { ...paneProps, autoCompactThresholdPercent: 60 }),
      false,
    )
  })

  it('re-renders the pane when auto-compact is switched off', () => {
    assert.equal(arePaneViewPropsEqual(paneProps, { ...paneProps, autoCompactEnabled: false }), false)
  })

  it('stays memoized while both settings are unchanged', () => {
    assert.equal(arePaneViewPropsEqual(paneProps, { ...paneProps }), true)
  })
})
