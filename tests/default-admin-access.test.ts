import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createDefaultSettings, createDefaultState, normalizeAppSettings, createAutomationBoardCard } from '../shared/default-state.ts'
import { appSettingsSchema } from '../shared/schema.ts'
import { STICKYNOTE_TOOL_MODEL } from '../shared/models.ts'
import { ideReducer } from '../src/state.ts'

it('默认超管设置安全迁移并保留显式选择', () => {
  assert.equal(createDefaultSettings().defaultAdminAccess, false)
  assert.equal(appSettingsSchema.parse({}).defaultAdminAccess, false)
  assert.equal(normalizeAppSettings({}).defaultAdminAccess, false)
  assert.equal(normalizeAppSettings({ defaultAdminAccess: true }).defaultAdminAccess, true)
  assert.equal(appSettingsSchema.parse({ defaultAdminAccess: true }).defaultAdminAccess, true)
})

it('默认权限仅播种新会话，显式关闭和工具卡不提权', () => {
  const original = createDefaultState()
  const state = ideReducer(original, { type: 'updateSettings', patch: { defaultAdminAccess: true } })
  assert.deepEqual(state.columns, original.columns)
  const column = state.columns[0]!
  const paneId = column.layout.id
  for (const provider of ['codex', 'claude'] as const) {
    const next = ideReducer(state, { type: 'addTab', columnId: column.id, paneId, cardId: 'new', provider })
    assert.equal(next.columns[0]!.cards.new!.adminAccess, true)
  }
  const explicit = ideReducer(state, { type: 'addTab', columnId: column.id, paneId, cardId: 'explicit', adminAccess: false })
  assert.equal(explicit.columns[0]!.cards.explicit!.adminAccess, false)
  const tool = ideReducer(state, { type: 'addTab', columnId: column.id, paneId, cardId: 'tool', model: STICKYNOTE_TOOL_MODEL })
  assert.notEqual(tool.columns[0]!.cards.tool!.adminAccess, true)
  const added = ideReducer(state, { type: 'addColumn' })
  assert.equal(Object.values(added.columns.at(-1)!.cards)[0]!.adminAccess, true)
  const disabled = ideReducer(state, { type: 'updateSettings', patch: { defaultAdminAccess: false } })
  const next = ideReducer(disabled, { type: 'addTab', columnId: column.id, paneId, cardId: 'new' })
  assert.notEqual(next.columns[0]!.cards.new!.adminAccess, true)
})

it('看板显式权限优先于默认权限（MCP 可以强制关闭）', () => {
  const state = createDefaultState()
  state.settings.defaultAdminAccess = true
  const column = state.columns[0]!
  const board = createAutomationBoardCard()
  column.cards[board.id] = board
  for (const adminAccess of [undefined, false, true]) {
    const next = ideReducer(state, { type: 'createAutomationBoardItem', columnId: column.id, boardCardId: board.id, cardId: 'item', lane: 'standby', requirement: '测试', adminAccess })
    assert.equal(next.columns[0]!.cards.item!.adminAccess === true, adminAccess ?? true)
  }
  // 2026-09-08 发布审计：看板建项卡曾没有 addTab 那道「工具卡永不提权」守卫。
  const tool = ideReducer(state, { type: 'createAutomationBoardItem', columnId: column.id, boardCardId: board.id, cardId: 'tool', lane: 'standby', requirement: '测试', model: STICKYNOTE_TOOL_MODEL })
  assert.notEqual(tool.columns[0]!.cards.tool!.adminAccess, true, 'tool cards never receive admin access, even from a board')
})
