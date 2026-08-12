import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createDefaultAutomationBoardTemplateTrigger } from '../shared/schema.ts'
import type { AutomationBoard, AutomationBoardTemplate } from '../shared/schema.ts'
import {
  resolveAutomationBoardTemplateInstanceCardId,
  resolveAutomationBoardTemplateTriggerDecisions,
  type AutomationBoardCardActivity,
} from '../src/components/automation-board-auto-trigger.ts'

type ItemSeed = {
  cardId: string
  lane: 'standby' | 'running' | 'done'
  templateId?: string
}

const board = (items: ItemSeed[]): AutomationBoard => ({
  items: items.map((item) => ({
    cardId: item.cardId,
    lane: item.lane,
    requirement: `req ${item.cardId}`,
    templateId: item.templateId ?? '',
  })),
})

const activity = (
  entries: Record<string, Partial<AutomationBoardCardActivity>>,
): Record<string, AutomationBoardCardActivity> =>
  Object.fromEntries(
    Object.entries(entries).map(([cardId, value]) => [
      cardId,
      {
        status: value.status ?? 'idle',
        backgroundWorkPending: value.backgroundWorkPending ?? false,
      },
    ]),
  )

const template = (overrides: Partial<AutomationBoardTemplate> = {}): AutomationBoardTemplate => ({
  id: 'tpl-supervisor',
  name: '看板监工',
  requirement: '检查看板',
  provider: 'claude',
  model: '',
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  adminAccess: true,
  builtIn: true,
  instanceCardId: '',
  wakeTimerActive: false,
  repeatLoopActive: false,
  ...overrides,
  trigger: {
    ...createDefaultAutomationBoardTemplateTrigger(),
    enabled: true,
    ...(overrides.trigger ?? {}),
  },
})

const nowMs = Date.parse('2026-08-11T12:00:00.000Z')

const decide = (
  overrides: Partial<Parameters<typeof resolveAutomationBoardTemplateTriggerDecisions>[0]> & {
    templates: readonly AutomationBoardTemplate[]
    board: AutomationBoard | undefined
    settledCardId: string
  },
) =>
  resolveAutomationBoardTemplateTriggerDecisions({
    cardActivity: {},
    lastFiredAtMs: {},
    nowMs,
    ...overrides,
  })

describe('automation board template triggers', () => {
  it('fires when the only running item settles', () => {
    assert.deepEqual(
      decide({
        templates: [template()],
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {} }),
      }),
      [{ templateId: 'tpl-supervisor', fire: true, reason: 'ready' }],
    )
  })

  it('does not fire when the template trigger is off', () => {
    assert.deepEqual(
      decide({
        templates: [template({ trigger: { ...createDefaultAutomationBoardTemplateTrigger() } })],
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {} }),
      }),
      [{ templateId: 'tpl-supervisor', fire: false, reason: 'disabled' }],
    )
  })

  it('does not fire for a card that is not a running-lane item', () => {
    assert.deepEqual(
      decide({
        templates: [template()],
        board: board([{ cardId: 'item-a', lane: 'standby' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {} }),
      }),
      [{ templateId: 'tpl-supervisor', fire: false, reason: 'not-board-item' }],
    )
  })

  /**
   * 这是 v2 全部防递归的核心，也是整次重构最容易写错的一处。
   *
   * v1 靠"监工不在 board.items 里"隐式免疫；v2 的监工实例**就是** running 道
   * 的一个普通项，如果不认 templateId，它每答完一轮都会把自己再叫起来。
   */
  it('does not fire when the settled item is this template own instance', () => {
    assert.deepEqual(
      decide({
        templates: [template({ instanceCardId: 'sup-run-1' })],
        board: board([{ cardId: 'sup-run-1', lane: 'running', templateId: 'tpl-supervisor' }]),
        settledCardId: 'sup-run-1',
        cardActivity: activity({ 'sup-run-1': {} }),
      }),
      [{ templateId: 'tpl-supervisor', fire: false, reason: 'self-triggered' }],
    )
  })

  // 自触发防护认的是项上的 templateId，不是 instanceCardId：一张实例卡被
  // 拖出去又拖回来后 instanceCardId 可能已经作废，但它仍然是这个模板生的。
  it('recognises its own instance from the item templateId alone', () => {
    assert.deepEqual(
      decide({
        templates: [template({ instanceCardId: '' })],
        board: board([{ cardId: 'sup-run-1', lane: 'running', templateId: 'tpl-supervisor' }]),
        settledCardId: 'sup-run-1',
        cardActivity: activity({ 'sup-run-1': {} }),
      }),
      [{ templateId: 'tpl-supervisor', fire: false, reason: 'self-triggered' }],
    )
  })

  // 另一个模板生出来的项结束，本模板照常触发 —— 自触发防护不能扩大成
  // "只要是模板生的项就都不触发"。
  it('still fires when another template instance settles', () => {
    assert.deepEqual(
      decide({
        templates: [template()],
        board: board([{ cardId: 'item-a', lane: 'running', templateId: 'tpl-other' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {} }),
      }),
      [{ templateId: 'tpl-supervisor', fire: true, reason: 'ready' }],
    )
  })

  it('waits while another running item is still streaming', () => {
    assert.deepEqual(
      decide({
        templates: [template()],
        board: board([
          { cardId: 'item-a', lane: 'running' },
          { cardId: 'item-b', lane: 'running' },
        ]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {}, 'item-b': { status: 'streaming' } }),
      }),
      [{ templateId: 'tpl-supervisor', fire: false, reason: 'still-running' }],
    )
  })

  it('waits while another running item awaits background work', () => {
    assert.deepEqual(
      decide({
        templates: [template()],
        board: board([
          { cardId: 'item-a', lane: 'running' },
          { cardId: 'item-b', lane: 'running' },
        ]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {}, 'item-b': { backgroundWorkPending: true } }),
      }),
      [{ templateId: 'tpl-supervisor', fire: false, reason: 'still-running' }],
    )
  })

  // v1 的 supervisor-busy 规则在 v2 被 still-running 吸收：监工实例是 running
  // 道的普通项，它在跑时天然拦住下一次触发。
  it('waits while this template own instance is still running', () => {
    assert.deepEqual(
      decide({
        templates: [template({ instanceCardId: 'sup-run-1' })],
        board: board([
          { cardId: 'item-a', lane: 'running' },
          { cardId: 'sup-run-1', lane: 'running', templateId: 'tpl-supervisor' },
        ]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {}, 'sup-run-1': { status: 'streaming' } }),
      }),
      [{ templateId: 'tpl-supervisor', fire: false, reason: 'still-running' }],
    )
  })

  it('throttles a second fire inside this template minimum interval', () => {
    assert.deepEqual(
      decide({
        templates: [template({ trigger: { minIntervalMinutes: 10 } as never })],
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {} }),
        lastFiredAtMs: { 'tpl-supervisor': nowMs - 60_000 },
      }),
      [{ templateId: 'tpl-supervisor', fire: false, reason: 'throttled' }],
    )
  })

  it('fires again once this template interval has elapsed', () => {
    assert.deepEqual(
      decide({
        templates: [template({ trigger: { minIntervalMinutes: 10 } as never })],
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {} }),
        lastFiredAtMs: { 'tpl-supervisor': nowMs - 11 * 60_000 },
      }),
      [{ templateId: 'tpl-supervisor', fire: true, reason: 'ready' }],
    )
  })

  // 节流是按模板记的：一个模板刚跑过不该把另一个模板也挡住。
  it('throttles each template independently', () => {
    assert.deepEqual(
      decide({
        templates: [
          template({ id: 'tpl-a', trigger: { minIntervalMinutes: 10 } as never }),
          template({ id: 'tpl-b', trigger: { minIntervalMinutes: 10 } as never }),
        ],
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {} }),
        lastFiredAtMs: { 'tpl-a': nowMs - 60_000 },
      }),
      [
        { templateId: 'tpl-a', fire: false, reason: 'throttled' },
        { templateId: 'tpl-b', fire: true, reason: 'ready' },
      ],
    )
  })

  it('reports disabled when the board is gone', () => {
    assert.deepEqual(
      decide({
        templates: [template()],
        board: undefined,
        settledCardId: 'item-a',
      }),
      [{ templateId: 'tpl-supervisor', fire: false, reason: 'disabled' }],
    )
  })

  it('returns nothing when no template has a trigger at all', () => {
    assert.deepEqual(
      decide({
        templates: [],
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {} }),
      }),
      [],
    )
  })
})

describe('automation board template instance reuse', () => {
  it('reuses the recorded instance while it is still on the board', () => {
    assert.equal(
      resolveAutomationBoardTemplateInstanceCardId({
        board: board([{ cardId: 'sup-1', lane: 'done', templateId: 'tpl-supervisor' }]),
        templateId: 'tpl-supervisor',
        instanceCardId: 'sup-1',
      }),
      'sup-1',
    )
  })

  it('asks for a fresh card once the recorded instance left the board', () => {
    assert.equal(
      resolveAutomationBoardTemplateInstanceCardId({
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        templateId: 'tpl-supervisor',
        instanceCardId: 'sup-gone',
      }),
      '',
    )
  })

  // 用户手动把同一个模板拖进泳道得到的卡不会被记进 instanceCardId；靠项自带的
  // templateId 认血缘，才不会在它旁边再造一张。
  it('falls back to the newest item that carries this template id', () => {
    assert.equal(
      resolveAutomationBoardTemplateInstanceCardId({
        board: board([
          { cardId: 'sup-old', lane: 'done', templateId: 'tpl-supervisor' },
          { cardId: 'item-a', lane: 'running' },
          { cardId: 'sup-new', lane: 'standby', templateId: 'tpl-supervisor' },
        ]),
        templateId: 'tpl-supervisor',
        instanceCardId: '',
      }),
      'sup-new',
    )
  })

  it('asks for a fresh card when nothing on the board came from this template', () => {
    assert.equal(
      resolveAutomationBoardTemplateInstanceCardId({
        board: board([{ cardId: 'item-a', lane: 'running', templateId: 'tpl-other' }]),
        templateId: 'tpl-supervisor',
        instanceCardId: '',
      }),
      '',
    )
  })
})
