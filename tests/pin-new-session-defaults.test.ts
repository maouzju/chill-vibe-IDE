import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createCard,
  createColumn,
  createDefaultSettings,
  createDefaultState,
  normalizeAppSettings,
} from '../shared/default-state.ts'
import { DEFAULT_CODEX_MODEL, listReasoningDefaultModels } from '../shared/models.ts'
import type { AppState, PaneNode } from '../shared/schema.ts'
import { ideReducer } from '../src/state.ts'

// 2026-11-06 群友反馈：「改一个窗口的思考等级和模型，需要不影响新开窗口的默认设置。
// 比如我特定任务需要开个高思考度，结果后面都被改了。」
// SPEC docs/specs/pin-new-session-defaults。

const buildState = (pin: boolean): AppState => {
  // 这张卡被特调过：Fable + 最高档，而且继承链（lastModel / 列种子）也已经被它带偏。
  const special = { ...createCard('Special task', undefined, 'claude', 'claude-fable-5-1', 'max'), id: 'card-special' }
  const column = createColumn({
    id: 'col-1',
    provider: 'claude',
    model: 'claude-fable-5-1',
    workspacePath: 'D:/repo',
    layout: { type: 'pane', id: 'pane-1', tabs: ['card-special'], activeTabId: 'card-special' },
    cards: { 'card-special': special },
  })
  const settings = {
    ...createDefaultSettings(),
    pinNewSessionDefaults: pin,
    requestModels: { codex: DEFAULT_CODEX_MODEL, claude: 'claude-opus-5-5', gemini: 'gemini-3.8-flash' },
    lastModel: { provider: 'claude' as const, model: 'claude-fable-5-1' },
    modelReasoningEfforts: { codex: {}, claude: { 'claude-opus-5-5': 'low' }, gemini: {} },
  }

  return { ...createDefaultState('D:/repo'), settings, columns: [column] }
}

const findNewCard = (state: AppState) => {
  const column = state.columns[0]!
  const pane = column.layout as PaneNode
  const newId = pane.tabs.find((id) => id !== 'card-special')
  return newId ? column.cards[newId] : undefined
}

describe('pinNewSessionDefaults setting', () => {
  it('defaults to off for fresh and legacy settings', () => {
    assert.equal(createDefaultSettings().pinNewSessionDefaults, false)
    assert.equal(normalizeAppSettings({}).pinNewSessionDefaults, false)
    assert.equal(normalizeAppSettings({ pinNewSessionDefaults: true }).pinNewSessionDefaults, true)
  })

  it('pinned: turning a card knob leaves the default effort table alone', () => {
    const state = buildState(true)
    const next = ideReducer(state, {
      type: 'rememberModelReasoningEffort',
      provider: 'claude',
      model: 'claude-opus-5-5',
      reasoningEffort: 'xhigh',
    })

    assert.deepEqual(next.settings.modelReasoningEfforts.claude, { 'claude-opus-5-5': 'low' })
  })

  it('unpinned: turning a card knob still becomes the new default (unchanged behavior)', () => {
    const next = ideReducer(buildState(false), {
      type: 'rememberModelReasoningEffort',
      provider: 'claude',
      model: 'claude-opus-5-5',
      reasoningEffort: 'xhigh',
    })

    assert.equal(next.settings.modelReasoningEfforts.claude['claude-opus-5-5'], 'xhigh')
  })

  it('the settings table writes the default effort whether pinned or not', () => {
    for (const pin of [true, false]) {
      const next = ideReducer(buildState(pin), {
        type: 'setModelReasoningEffortDefault',
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        reasoningEffort: 'high',
      })

      assert.equal(next.settings.modelReasoningEfforts.claude['claude-sonnet-5-5'], 'high')
    }
  })

  it('pinned: switching a card model does not touch lastModel or the column seed', () => {
    const state = buildState(true)
    state.settings.lastModel = { provider: 'claude', model: 'claude-opus-5-5' }
    state.columns[0]!.model = 'claude-opus-5-5'

    const next = ideReducer(state, {
      type: 'selectCardModel',
      columnId: 'col-1',
      cardId: 'card-special',
      provider: 'claude',
      model: 'claude-sonnet-5-5',
    })

    assert.equal(next.columns[0]?.cards['card-special']?.model, 'claude-sonnet-5-5')
    assert.deepEqual(next.settings.lastModel, { provider: 'claude', model: 'claude-opus-5-5' })
    assert.equal(next.columns[0]?.model, 'claude-opus-5-5')
  })

  it('pinned: a new tab next to the tuned card starts from the settings default model and effort', () => {
    const next = ideReducer(buildState(true), { type: 'addTab', columnId: 'col-1', paneId: 'pane-1' })
    const card = findNewCard(next)

    assert.equal(card?.provider, 'claude')
    assert.equal(card?.model, 'claude-opus-5-5')
    assert.equal(card?.reasoningEffort, 'low')
  })

  it('unpinned: a new tab still inherits the neighbouring card model (unchanged behavior)', () => {
    const next = ideReducer(buildState(false), { type: 'addTab', columnId: 'col-1', paneId: 'pane-1' })

    assert.equal(findNewCard(next)?.model, 'claude-fable-5-1')
  })

  it('pinned: an explicit model on addTab is still honoured', () => {
    const next = ideReducer(buildState(true), {
      type: 'addTab',
      columnId: 'col-1',
      paneId: 'pane-1',
      provider: 'claude',
      model: 'claude-sonnet-5-5',
    })

    assert.equal(findNewCard(next)?.model, 'claude-sonnet-5-5')
  })

  it('pinned: a new column ignores the remembered lastModel', () => {
    const next = ideReducer(buildState(true), { type: 'addColumn' })
    const column = next.columns.at(-1)!
    const card = Object.values(column.cards)[0]

    assert.equal(column.provider, 'claude')
    assert.equal(column.model, 'claude-opus-5-5')
    assert.equal(card?.model, 'claude-opus-5-5')
    assert.equal(card?.reasoningEffort, 'low')
  })
})

describe('listReasoningDefaultModels', () => {
  it('lists the configured default first, then visible picker models and custom ones, without Gemini', () => {
    const settings = {
      ...createDefaultSettings(),
      requestModels: { codex: DEFAULT_CODEX_MODEL, claude: 'claude-opus-5-5', gemini: 'gemini-3.8-flash' },
      modelPickerVisibility: { 'claude:claude-sonnet-5-5': false },
      modelPickerCustomModels: [{ id: 'c1', provider: 'claude' as const, model: 'claude-experimental-x', label: 'Exp X' }],
    }
    const entries = listReasoningDefaultModels(settings)
    const claude = entries.filter((entry) => entry.provider === 'claude')
    const codex = entries.filter((entry) => entry.provider === 'codex')

    assert.equal(claude[0]?.model, 'claude-opus-5-5')
    assert.equal(claude[0]?.isConfiguredDefault, true)
    assert.equal(claude.filter((entry) => entry.model === 'claude-opus-5-5').length, 1)
    assert.ok(!claude.some((entry) => entry.model === 'claude-sonnet-5-5'))
    assert.ok(claude.some((entry) => entry.model === 'claude-experimental-x' && entry.label === 'Exp X'))
    assert.equal(codex[0]?.model, DEFAULT_CODEX_MODEL)
    assert.ok(!entries.some((entry) => entry.provider === 'gemini'))
    assert.ok(!entries.some((entry) => entry.model === ''))
  })
})
