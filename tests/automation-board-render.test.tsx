import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createAutomationBoardCard, createCard, createDefaultSettings } from '../shared/default-state.ts'
import { getLocaleText } from '../shared/i18n.ts'
import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import { createDefaultAutomationBoardTemplateTrigger } from '../shared/schema.ts'
import type { AutomationBoardTemplate, ChatCard, ChatMessage } from '../shared/schema.ts'
import {
  AutomationBoardCard,
  AutomationBoardItemDrawer,
  AutomationBoardTemplateConfig,
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

const makeTemplate = (
  overrides: Partial<AutomationBoardTemplate> = {},
): AutomationBoardTemplate => ({
  id: 'tpl-1',
  name: '发布前检查',
  requirement: '检查发布前的改动',
  provider: 'codex',
  model: DEFAULT_CODEX_MODEL,
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  adminAccess: false,
  builtIn: false,
  trigger: createDefaultAutomationBoardTemplateTrigger(),
  instanceCardId: '',
  wakeTimerActive: false,
  repeatLoopActive: false,
  ...overrides,
})

// v2：监工不再是特殊实体，只是一个默认种进工作区的内置模板。
const supervisorTemplate = makeTemplate({
  id: 'tpl-supervisor',
  name: text.automationBoardSupervisorTemplateName,
  requirement: '盯着看板',
  provider: 'claude',
  model: '',
  adminAccess: true,
  builtIn: true,
})

const template = makeTemplate()

const noop = () => undefined

const renderBoard = (overrides: Partial<AutomationBoardCardProps> = {}) => {
  const board = {
    items: [
      { cardId: 'item-a', lane: 'standby' as const, requirement: '把登录页改成暗色', templateId: '' },
      { cardId: 'item-b', lane: 'running' as const, requirement: '补齐结算流程的测试', templateId: '' },
      { cardId: 'item-c', lane: 'done' as const, requirement: '升级依赖', templateId: '' },
    ],
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
  }

  const props: AutomationBoardCardProps = {
    boardCardId: 'board-1',
    columnId: 'column-1',
    workspacePath: 'D:/repo/one',
    language: settings.language,
    board,
    cards,
    templates: [supervisorTemplate, template],
    defaultProvider: 'codex',
    defaultModel: DEFAULT_CODEX_MODEL,
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
    onUpdateTemplate: noop,
    onRunTemplateNow: noop,
    onSetLaneWidths: noop,
    onSetComposeDefaults: noop,
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

  // v2：监工 = 一个 builtIn 模板，所以它必须出现在模板条里，而不是一个专属区块。
  it('renders the built-in supervisor template in the strip, not a supervisor section', () => {
    const html = renderBoard()

    assert.ok(html.includes(text.automationBoardSupervisorTemplateName))
    // 内置模板的 id 就叫 automation-board-supervisor，所以只能钉 class 形状，
    // 不能对裸字符串做 includes。
    assert.ok(!html.includes('class="automation-board-supervisor"'))
    assert.ok(!html.includes('automation-board-supervisor-head'))
    assert.ok(!html.includes('automation-board-trigger-config'))
  })

  // 超管权限的模板必须一眼可见：盾牌角标带 adminAccessBadgeTitle。
  it('flags an admin-access template with the shield badge', () => {
    const html = renderBoard()

    assert.match(html, /automation-board-template-badge is-admin/)
    assert.ok(html.includes(text.adminAccessBadgeTitle))
  })

  // 触发器开着 = 这个模板会自己跑，闪电角标是唯一的可见提示。
  it('shows the lightning badge only while the template trigger is enabled', () => {
    const off = renderBoard()
    assert.ok(!off.includes('automation-board-template-badge is-trigger'))
    assert.ok(!off.includes(text.automationBoardTriggerBadgeTitle))

    const on = renderBoard({
      templates: [
        makeTemplate({
          trigger: { ...createDefaultAutomationBoardTemplateTrigger(), enabled: true },
        }),
      ],
    })
    assert.match(on, /automation-board-template-badge is-trigger/)
    assert.ok(on.includes(text.automationBoardTriggerBadgeTitle))
  })

  // 配置面板默认折叠：需求 textarea 与触发器开关都不该在首屏。
  it('keeps the template config panel collapsed until it is expanded', () => {
    const html = renderBoard()

    assert.ok(!html.includes('class="automation-board-template-config"'))
    // "需求"这两个字在待命道的输入框文案里也有，所以折叠态只能钉触发器与
    // 立即执行这些配置面板独有的文案。
    assert.ok(!html.includes(text.automationBoardTriggerEnableLabel))
    assert.ok(!html.includes(text.automationBoardTriggerLabel))
    assert.ok(!html.includes(text.automationBoardTemplateRunNowAction))
    assert.ok(html.includes('automation-board-template-configure'))
    assert.ok(html.includes(text.automationBoardTemplateConfigureAction))
  })

  // 展开后的面板：需求 textarea、超管开关、触发器分组、立即执行。
  it('renders the requirement textarea and the trigger controls once expanded', () => {
    const html = renderToStaticMarkup(
      React.createElement(AutomationBoardTemplateConfig, {
        template: supervisorTemplate,
        language: settings.language,
        onUpdateTemplate: noop,
        onRunTemplateNow: noop,
      }),
    )

    assert.ok(html.includes('class="automation-board-template-config"'))
    assert.match(html, /<textarea[^>]*rows="5"/)
    assert.ok(html.includes('盯着看板'))
    assert.ok(html.includes(text.automationBoardTemplateRequirementLabel))
    assert.ok(html.includes(text.automationBoardTemplateAdminAccessLabel))
    assert.ok(html.includes(text.automationBoardTemplateAdminAccessHint))
    assert.ok(html.includes(text.automationBoardTriggerLabel))
    assert.ok(html.includes(text.automationBoardTriggerEnableLabel))
    assert.ok(html.includes(text.automationBoardTriggerKindLastItemSettled))
    assert.ok(html.includes(text.automationBoardTriggerLaneLabel))
    assert.ok(html.includes(text.automationBoardTriggerIntervalLabel))
    assert.ok(html.includes(text.automationBoardTemplateRunNowAction))
    // builtIn 才有"恢复默认需求"。
    assert.ok(html.includes(text.automationBoardTemplateResetRequirementAction))
  })

  it('hides the restore-default action for a user-saved template', () => {
    const html = renderToStaticMarkup(
      React.createElement(AutomationBoardTemplateConfig, {
        template,
        language: settings.language,
        onUpdateTemplate: noop,
        onRunTemplateNow: noop,
      }),
    )

    assert.ok(!html.includes(text.automationBoardTemplateResetRequirementAction))
    assert.ok(html.includes(text.automationBoardTemplateRunNowAction))
  })

  it('renders the empty-lane hint when a lane has no items', () => {
    const html = renderBoard({ board: { items: [] } })

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
          items: [{ cardId: 'ghost', lane: 'running', requirement: 'gone', templateId: '' }],
        },
      }),
    )
  })

  // 需求："拖出/保存模板/上方需求/循环重复/追加消息输入框都收进二级界面，默认折叠"。
  // 一级只留主操作（开始/中断）、折叠开关和删除。
  it('keeps the item secondary controls collapsed until the disclosure is opened', () => {
    const html = renderBoard()

    assert.ok(!html.includes('automation-board-item-drawer'))
    assert.ok(!html.includes(text.automationBoardItemNudgePlaceholder))
    assert.ok(!html.includes(text.automationBoardPopOutAction))
    assert.ok(!html.includes(text.automationBoardWakeAboveLabel))
    assert.ok(!html.includes(text.repeatLoopStatusLabel))

    assert.ok(html.includes('automation-board-item-more'))
    assert.ok(html.includes('aria-expanded="false"'))
  })

  // 追加消息发给的是这一项自己，不是"加入待命"，两个输入框的文案必须分开。
  it('gives the per-item message box its own placeholder', () => {
    assert.notEqual(
      text.automationBoardItemNudgePlaceholder,
      text.automationBoardNewRequirementPlaceholder,
    )
  })

  // 加入待命时就得能定这一项用哪个 CLI/模型 —— 否则只能等它建出来再逐张改，
  // 而看板的整个意义就是不用逐张管。
  it('lets the standby composer pick the model up front', () => {
    const html = renderBoard({ defaultProvider: 'claude', defaultModel: '' })

    assert.match(html, /automation-board-compose-model/)
    assert.match(html, /<option[^>]*value="claude::"[^>]*selected/)
  })

  it('defaults the standby composer to the column model', () => {
    const html = renderBoard()

    assert.match(
      html,
      new RegExp(`<option[^>]*value="codex::${DEFAULT_CODEX_MODEL}"[^>]*selected`),
    )
  })

  // FR12：模板 schema 一直存着 reasoningEffort / thinkingEnabled / planMode，
  // 配置面板却没有入口 —— 存了却配不了，等于存了个死值。
  it('lets the template config panel set thinking, depth and plan mode', () => {
    const html = renderToStaticMarkup(
      React.createElement(AutomationBoardTemplateConfig, {
        template: makeTemplate({ provider: 'claude', model: 'claude-opus-4-8' }),
        language: settings.language,
        onUpdateTemplate: noop,
        onRunTemplateNow: noop,
      }),
    )

    assert.ok(html.includes(text.thinking))
    assert.ok(html.includes(text.thinkingDepthLabel))
    assert.ok(html.includes(text.planMode))
    assert.match(html, /class="reasoning-select"/)
  })

  // 计划模式是 Claude 专用开关，Codex 下不该出现（与聊天 composer 同一条规则）。
  it('hides plan mode for a codex template', () => {
    const html = renderToStaticMarkup(
      React.createElement(AutomationBoardTemplateConfig, {
        template: makeTemplate({ provider: 'codex' }),
        language: settings.language,
        onUpdateTemplate: noop,
        onRunTemplateNow: noop,
      }),
    )

    assert.ok(!html.includes(text.planMode))
    assert.ok(html.includes(text.thinkingDepthLabel))
  })

  // 强制思考的模型（Fable 5）关不掉思考：开关必须置灰，而不是给一个无效选择。
  it('locks the thinking toggle on an always-thinking model', () => {
    const html = renderToStaticMarkup(
      React.createElement(AutomationBoardTemplateConfig, {
        template: makeTemplate({ provider: 'claude', model: 'claude-fable-5' }),
        language: settings.language,
        onUpdateTemplate: noop,
        onRunTemplateNow: noop,
      }),
    )

    // 属性顺序不是契约，所以先切出"思考"那一行再看它自己带了什么。
    const thinkingRow = html.split(`<span>${text.thinking}</span>`)[0]?.split('<label').pop() ?? ''
    assert.ok(thinkingRow.includes('disabled=""'))
    assert.ok(thinkingRow.includes('checked=""'))
  })

  // 加入待命的输入区必须能定同一组参数，否则只能等项建出来再逐张改。
  it('offers the execution settings in the standby composer', () => {
    const html = renderBoard()

    assert.ok(html.includes('automation-board-compose-settings-toggle'))
    assert.ok(html.includes(text.automationBoardComposeSettingsLabel))
  })

  // 上次选的模型/参数随看板存盘：连着加十个需求项时不该重选十次。
  it('restores the composer choice from the board instead of the column default', () => {
    const html = renderBoard({
      board: {
        items: [],
        composeDefaults: {
          provider: 'claude',
          model: '',
          reasoningEffort: 'high',
          thinkingEnabled: true,
          planMode: false,
          adminAccess: false,
        },
      },
    })

    assert.match(html, /<option[^>]*value="claude::"[^>]*selected/)
    assert.ok(
      !new RegExp(`<option[^>]*value="codex::${DEFAULT_CODEX_MODEL}"[^>]*selected`).test(html),
    )
  })

  it('renders in English too', () => {
    const html = renderBoard({ language: 'en' })
    const en = getLocaleText('en')

    assert.ok(html.includes(en.automationBoardLaneRunning))
    assert.ok(html.includes(en.automationBoardTemplatesLabel))
  })
})

// 抽屉单独导出是为了让 SSR 单测能看到展开态 —— `renderToStaticMarkup` 点不了
// 折叠开关，和 `AutomationBoardTemplateConfig` 同一个理由。
describe('AutomationBoardItemDrawer', () => {
  const renderDrawer = (
    cardOverrides: Partial<ChatCard> = {},
    props: Partial<React.ComponentProps<typeof AutomationBoardItemDrawer>> = {},
  ) => {
    const card = itemCard('item-b', { status: 'streaming', ...cardOverrides })
    return renderToStaticMarkup(
      React.createElement(AutomationBoardItemDrawer, {
        view: {
          item: { cardId: card.id, lane: 'running', requirement: '补齐结算流程的测试', templateId: '' },
          card,
          laneIndex: 1,
          aboveCardId: 'item-a',
          aboveTitle: '把登录页改成暗色',
        },
        lane: 'running',
        language: settings.language,
        wakeTimerEnabled: true,
        repeatLoopEnabled: true,
        workspaceAgentCount: 2,
        nudge: '',
        onNudgeChange: noop,
        onNudgeSubmit: noop,
        onPopOutItem: noop,
        onSaveTemplate: noop,
        onPatchItemCard: noop,
        ...props,
      }),
    )
  }

  // 需求：看板项的计划唤醒必须是外面那一整块面板，不是一个"上方需求"复选框 ——
  // 否则看板里永远选不到"其他 Agent 完成"和"指定时长"这两个模式。
  it('reuses the full wake timer panel instead of a lone checkbox', () => {
    const html = renderDrawer({ wakeTimerActive: true, wakeTimerMode: 'left-tab' })

    assert.ok(html.includes('composer-wake-timer-module'))
    assert.ok(html.includes(text.wakeTimerModeLabel))
    assert.ok(html.includes(text.wakeTimerModeWorkspace))
    assert.ok(html.includes(text.automationBoardWakeAboveLabel))
    assert.ok(html.includes(text.wakeTimerModeDuration))
  })

  it('keeps the board wording for the neighbour it waits on', () => {
    const html = renderDrawer(
      { wakeTimerActive: true, wakeTimerMode: 'left-tab' },
      {
        view: {
          item: { cardId: 'item-b', lane: 'running', requirement: '补齐结算流程的测试', templateId: '' },
          card: itemCard('item-b', {
            status: 'streaming',
            wakeTimerActive: true,
            wakeTimerMode: 'left-tab',
          }),
          laneIndex: 0,
          aboveCardId: '',
          aboveTitle: '',
        },
      },
    )

    assert.ok(html.includes(text.automationBoardWakeAboveUnavailable))
    assert.ok(!html.includes(text.wakeTimerLeftUnavailable))
  })

  it('offers the duration input inside the drawer too', () => {
    const html = renderDrawer({
      wakeTimerActive: true,
      wakeTimerMode: 'duration',
      wakeTimerDurationMinutes: 90,
    })

    assert.ok(html.includes(text.wakeTimerDurationLabel))
    assert.match(html, /value="90"/)
  })

  // 唤醒只对"执行中"的项有意义；待命项还没跑，done 项已经结束。
  it('hides the wake panel outside the running lane', () => {
    const html = renderDrawer({ wakeTimerActive: true }, { lane: 'standby' })

    assert.ok(!html.includes('composer-wake-timer-module'))
    assert.ok(html.includes(text.automationBoardPopOutAction))
  })

  it('still carries the repeat toggle and the nudge box', () => {
    const html = renderDrawer()

    assert.ok(html.includes(text.repeatLoopStatusLabel))
    assert.ok(html.includes(text.automationBoardItemNudgePlaceholder))
  })
})
