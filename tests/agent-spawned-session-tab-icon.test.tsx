import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createDefaultState, createAutomationBoardCard } from '../shared/default-state.ts'
import { ideReducer } from '../src/state.ts'
import { getPaneTabIcon } from '../src/components/pane-tab-icon.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

// 2026-09-20：超管 agent 通过 create_session 派发的会话，tab 上仍显示 Claude/GPT 图标，
// 和用户自己新建的 tab 看不出区别。派发来源必须落在卡片上（spawnedByAgent），
// tab 图标据此显示机器人。
test('agent-spawned sessions carry spawnedByAgent on both the tab path and the board path', () => {
  const state = createDefaultState()
  const column = state.columns[0]!
  const paneId = column.layout.id

  const viaTab = ideReducer(state, { type: 'addTab', columnId: column.id, paneId, cardId: 'spawned', spawnedByAgent: true })
  assert.equal(viaTab.columns[0]!.cards.spawned!.spawnedByAgent, true)
  const userTab = ideReducer(state, { type: 'addTab', columnId: column.id, paneId, cardId: 'user' })
  assert.notEqual(userTab.columns[0]!.cards.user!.spawnedByAgent, true)

  const board = createAutomationBoardCard()
  column.cards[board.id] = board
  const viaBoard = ideReducer(state, {
    type: 'createAutomationBoardItem',
    columnId: column.id,
    boardCardId: board.id,
    cardId: 'item',
    lane: 'standby',
    requirement: '测试',
    spawnedByAgent: true,
  })
  assert.equal(viaBoard.columns[0]!.cards.item!.spawnedByAgent, true)
})

test('pane tab shows the bot icon for agent-spawned sessions and the provider icon otherwise', () => {
  const state = createDefaultState()
  const column = state.columns[0]!
  const paneId = column.layout.id
  const next = ideReducer(state, { type: 'addTab', columnId: column.id, paneId, cardId: 'spawned', provider: 'claude', spawnedByAgent: true })
  const spawned = next.columns[0]!.cards.spawned!
  const plain = ideReducer(state, { type: 'addTab', columnId: column.id, paneId, cardId: 'plain', provider: 'claude' }).columns[0]!.cards.plain!

  assert.match(renderToStaticMarkup(getPaneTabIcon(spawned)), /pane-tab-icon--bot/)
  assert.doesNotMatch(renderToStaticMarkup(getPaneTabIcon(plain)), /pane-tab-icon--bot/)
})

// 2026-09-20：用户正在某张卡上操作时，超管 agent 通过 create_session 建的普通 tab
// 会话直接成为活动 tab，把用户的视图顶走。agent 派发的 tab 必须静默追加在后台，
// 活动 tab 保持不变；用户自己点「＋」新建的 tab 仍照旧切过去。
test('agent-spawned tab is appended silently without stealing the active tab', () => {
  const state = createDefaultState()
  const column = state.columns[0]!
  const paneId = column.layout.id
  assert.equal(column.layout.type, 'pane')
  const layoutBefore = column.layout as Extract<typeof column.layout, { type: 'pane' }>
  const activeBefore = layoutBefore.activeTabId
  assert.ok(activeBefore)

  const next = ideReducer(state, { type: 'addTab', columnId: column.id, paneId, cardId: 'spawned', spawnedByAgent: true })
  const pane = next.columns[0]!.layout
  assert.equal(pane.type, 'pane')
  const spawnedPane = pane as Extract<typeof pane, { type: 'pane' }>
  assert.ok(spawnedPane.tabs.includes('spawned'))
  assert.equal(spawnedPane.activeTabId, activeBefore)

  const userNext = ideReducer(state, { type: 'addTab', columnId: column.id, paneId, cardId: 'user' })
  const userPane = userNext.columns[0]!.layout
  assert.equal(userPane.type, 'pane')
  assert.equal((userPane as Extract<typeof userPane, { type: 'pane' }>).activeTabId, 'user')
})
