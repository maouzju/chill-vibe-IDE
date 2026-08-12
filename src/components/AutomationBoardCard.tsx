import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, DragEvent, KeyboardEvent } from 'react'

import { getLocaleText } from '../../shared/i18n'
import { MODEL_OPTIONS, isModelPickerOptionVisible } from '../../shared/models'
import { defaultAutomationBoardSupervisorRequirement } from '../../shared/schema'
import type {
  AppLanguage,
  AutomationBoard,
  AutomationBoardLane,
  AutomationBoardTemplate,
  ChatCard,
  Provider,
} from '../../shared/schema'
import { clearDragPayload, readDragPayload, writeDragPayload } from '../dnd'
import {
  ChevronDownIcon,
  CloseIcon,
  IconButton,
  PlayIcon,
  RefreshIcon,
  ShieldIcon,
  StickyNoteIcon,
  StopIcon,
  ZapIcon,
} from './Icons'
import {
  buildRenderableMessages,
  type RenderableMessage,
} from './chat-card-parsing'
import { buildToolGroupSummary, renderMarkdown } from './chat-card-rendering'
import {
  automationBoardItemMessageWindow,
  defaultAutomationBoardItemMessageLimit,
} from './automation-board-transitions'
import {
  buildAutomationBoardLaneViews,
  budgetAutomationBoardItemMessages,
  resolveAutomationBoardItemStatusClass,
  type AutomationBoardItemView,
} from './automation-board-view'

export type AutomationBoardTabDropSource = {
  columnId: string
  paneId: string
  tabId: string
}

export type AutomationBoardCardProps = {
  boardCardId: string
  columnId: string
  workspacePath: string
  language: AppLanguage
  board: AutomationBoard
  cards: Record<string, ChatCard>
  templates: AutomationBoardTemplate[]
  wakeTimerEnabled: boolean
  repeatLoopEnabled: boolean
  onCreateItem: (lane: AutomationBoardLane, requirement: string, index?: number) => void
  onMoveItem: (cardId: string, lane: AutomationBoardLane, index?: number) => void
  onPopOutItem: (cardId: string) => void
  onAbsorbTab: (
    source: AutomationBoardTabDropSource,
    lane: AutomationBoardLane,
    index?: number,
  ) => void
  onInstantiateTemplate: (
    templateId: string,
    lane: AutomationBoardLane,
    index?: number,
  ) => void
  onDeleteItem: (cardId: string) => void
  onSaveTemplate: (cardId: string) => void
  onRenameTemplate: (templateId: string, name: string) => void
  onDeleteTemplate: (templateId: string) => void
  onStopItem: (cardId: string) => void
  onSendToItem: (cardId: string, message: string) => void
  onPatchItemCard: (cardId: string, patch: Partial<ChatCard>) => void
  /**
   * 改模板的任意字段。改 `trigger` 的子字段时必须给一个**完整**的 trigger 对象
   * （`{ ...template.trigger, enabled: next }`）—— reducer 那层是浅合并。
   */
  onUpdateTemplate: (templateId: string, patch: Partial<AutomationBoardTemplate>) => void
  onRunTemplateNow: (templateId: string) => void
}

/**
 * 症状：新增本组件后，所有走 `renderToStaticMarkup` 的 `.tsx` 测试一起红在
 *   `ERR_UNKNOWN_FILE_EXTENSION ... @primer/react/dist/BaseStyles-*.css`。
 * 根因：`AppButton` 封的是 `@primer/react` 的 Button，而那个包有 CSS 副作用
 *   import；本组件被 ChatCard 引用后，Primer 第一次进入 ChatCard 的依赖图，
 *   Node 的测试运行器没有 CSS loader，于是在渲染之前就崩了。
 * 被否决：给测试加 CSS loader —— 那是为了一个按钮样式给整条测试链加装配。
 *   这里本来就只需要一个带既有 `btn` 类的普通按钮。
 */
const BoardButton = ({
  tone = 'ghost',
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'ghost' }) => (
  <button
    type="button"
    className={`btn ${tone === 'primary' ? 'btn-primary' : 'btn-ghost'}${className ? ` ${className}` : ''}`}
    {...props}
  >
    {children}
  </button>
)

const messageLimit = defaultAutomationBoardItemMessageLimit

const modelPickerOptions = MODEL_OPTIONS.filter((option) => isModelPickerOptionVisible(option))

const entryKey = (entry: RenderableMessage, index: number) =>
  entry.type === 'message' ? entry.message.id : `${entry.items[0]?.message.id ?? 'group'}-${index}`

/**
 * 紧凑转录：分组前先砍原始消息（budget），分组后再取末 N 条（window）。
 * 两层都必须在 markdown 解析之前，否则 10+ 并发项会把主线程占死。
 */
const AutomationBoardItemTranscript = ({
  card,
  language,
  workspacePath,
}: {
  card: ChatCard
  language: AppLanguage
  workspacePath: string
}) => {
  const text = getLocaleText(language)
  const { visible, hiddenCount } = useMemo(() => {
    const grouped = buildRenderableMessages(budgetAutomationBoardItemMessages(card.messages))
    return automationBoardItemMessageWindow(grouped, messageLimit)
  }, [card.messages])

  if (visible.length === 0) {
    return null
  }

  return (
    <div className="automation-board-item-transcript">
      {hiddenCount > 0 ? (
        <p className="automation-board-item-truncated">
          {text.automationBoardMessagesTruncated(hiddenCount)}
        </p>
      ) : null}
      {visible.map((entry, index) => {
        if (entry.type === 'tool-group') {
          return (
            <p
              key={entryKey(entry, index)}
              className="automation-board-item-line is-tool"
            >
              {buildToolGroupSummary(entry.items, language)}
            </p>
          )
        }

        const { message } = entry
        if (!message.content.trim()) {
          return null
        }

        return (
          <div
            key={entryKey(entry, index)}
            className={`automation-board-item-line is-${message.role}`}
          >
            {renderMarkdown(message.content, workspacePath)}
          </div>
        )
      })}
    </div>
  )
}

const AutomationBoardItemCard = ({
  view,
  lane,
  boardCardId,
  columnId,
  language,
  workspacePath,
  wakeTimerEnabled,
  repeatLoopEnabled,
  onPopOutItem,
  onDeleteItem,
  onSaveTemplate,
  onStopItem,
  onMoveItem,
  onSendToItem,
  onPatchItemCard,
}: {
  view: AutomationBoardItemView
  lane: AutomationBoardLane
} & Pick<
  AutomationBoardCardProps,
  | 'boardCardId'
  | 'columnId'
  | 'language'
  | 'workspacePath'
  | 'wakeTimerEnabled'
  | 'repeatLoopEnabled'
  | 'onPopOutItem'
  | 'onDeleteItem'
  | 'onSaveTemplate'
  | 'onStopItem'
  | 'onMoveItem'
  | 'onSendToItem'
  | 'onPatchItemCard'
>) => {
  const text = getLocaleText(language)
  const { card, item, aboveCardId } = view
  const [nudge, setNudge] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement | null>(null)
  const isStreaming = card.status === 'streaming'

  /**
   * 泳道是滚动容器，窄屏下它只有 9rem 高：展开的抽屉会落在可视区之外，
   * 用户点了开关却什么都没看见。`block: 'nearest'` 只把它拉进最近的滚动
   * 容器，不会顺手把整页拽走。
   */
  useEffect(() => {
    if (!drawerOpen) {
      return
    }

    drawerRef.current?.scrollIntoView({ block: 'nearest' })
  }, [drawerOpen])

  const submitNudge = () => {
    const trimmed = nudge.trim()
    if (!trimmed) {
      return
    }

    setNudge('')
    onSendToItem(card.id, trimmed)
  }

  const handleNudgeKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitNudge()
    }
  }

  const wakeMode = card.wakeTimerMode ?? 'workspace-agents'
  const showsWakeControls = wakeTimerEnabled && lane === 'running'
  const showsRepeatToggle = repeatLoopEnabled && lane === 'running'

  /**
   * 标题几乎总是由需求原文生成，两行显示同一句话是图上最刺眼的重复。
   * 只在它们真的不同的时候才留下需求段落；完整原文始终在 title 提示里。
   */
  const requirement = item.requirement.trim()
  const showsRequirement = requirement.length > 0 && requirement !== (card.title || '').trim()

  return (
    <article
      className={`automation-board-item ${resolveAutomationBoardItemStatusClass(card)}${drawerOpen ? ' is-drawer-open' : ''}`.trim()}
      data-automation-board-item-id={card.id}
      draggable
      onDragStart={(event) => {
        // 绝不在这里对 mousedown 做 preventDefault：启动拖拽是 mousedown 的
        // 默认动作，阻止它会让 dragstart 永不触发（AGENTS.md pitfall 176）。
        writeDragPayload(event, {
          type: 'automation-board-item',
          columnId,
          boardCardId,
          cardId: card.id,
          lane,
        })
      }}
      onDragEnd={() => clearDragPayload()}
    >
      {/* 计划唤醒在看板里放在卡片"上方"而不是 composer 左侧 —— 这是需求里
          "左侧变为上方"那条，方位与语义（等上一项）在这里是一致的。 */}
      {showsWakeControls && card.wakeTimerActive ? (
        <div className="automation-board-item-wake" role="status">
          <span className="automation-board-item-wake-icon" aria-hidden="true">
            <RefreshIcon />
          </span>
          <span>
            {wakeMode === 'left-tab'
              ? aboveCardId
                ? text.automationBoardWakeAboveTargetHint(view.aboveTitle ?? '')
                : text.automationBoardWakeAboveUnavailable
              : wakeMode === 'duration'
                ? `${card.wakeTimerDurationMinutes ?? 30} ${text.wakeTimerMinutes}`
                : text.wakeTimerModeWorkspace}
          </span>
        </div>
      ) : null}

      <header className="automation-board-item-head">
        {/* 需求段落被去重掉时，标题就是唯一一处需求原文了 —— 这时候让它像
            原来的段落一样夹到两行，否则长需求只剩一行省略号。 */}
        <h4
          className={`automation-board-item-title${showsRequirement ? '' : ' is-sole-copy'}`}
          title={item.requirement}
        >
          {card.title || item.requirement || text.automationBoardTitle}
        </h4>
        <span className="automation-board-item-model">{card.model || card.provider}</span>
        <span
          className={`automation-board-item-dot${isStreaming ? ' is-active' : ''}`}
          aria-hidden="true"
        />
      </header>

      {showsRequirement ? (
        <p className="automation-board-item-requirement" title={item.requirement}>
          {item.requirement}
        </p>
      ) : null}

      <AutomationBoardItemTranscript
        card={card}
        language={language}
        workspacePath={workspacePath}
      />

      {/* 一级只留主操作：开始/中断、展开二级、删除。其余全部收进抽屉 ——
          ui-principles「控件不能比工作内容更响」。 */}
      <footer className="automation-board-item-actions">
        {isStreaming ? (
          <IconButton label={text.automationBoardStopAction} onClick={() => onStopItem(card.id)}>
            <StopIcon />
          </IconButton>
        ) : lane !== 'running' ? (
          <IconButton
            label={text.automationBoardStartAction}
            onClick={() => onMoveItem(card.id, 'running')}
          >
            <PlayIcon />
          </IconButton>
        ) : null}

        <IconButton
          label={
            drawerOpen ? text.automationBoardItemLessAction : text.automationBoardItemMoreAction
          }
          className="automation-board-item-more"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <ChevronDownIcon />
        </IconButton>

        <IconButton
          label={text.automationBoardDeleteAction}
          className="automation-board-item-delete"
          onClick={() => onDeleteItem(card.id)}
        >
          <CloseIcon />
        </IconButton>
      </footer>

      {/* 抽屉里有 textarea：不拦住 dragstart 的话，在输入框里选文字会被外层
          article 的 draggable 抢成"拖卡片"。 */}
      {drawerOpen ? (
        <div
          ref={drawerRef}
          className="automation-board-item-drawer"
          onDragStart={(event) => event.stopPropagation()}
        >
          <div className="automation-board-item-drawer-row">
            <BoardButton
              tone="ghost"
              className="automation-board-item-action"
              onClick={() => onPopOutItem(card.id)}
            >
              {text.automationBoardPopOutAction}
            </BoardButton>

            <BoardButton
              tone="ghost"
              className="automation-board-item-action"
              onClick={() => onSaveTemplate(card.id)}
            >
              {text.automationBoardSaveTemplateAction}
            </BoardButton>
          </div>

          {showsWakeControls || showsRepeatToggle ? (
            <div className="automation-board-item-drawer-row">
              {showsWakeControls ? (
                <label className="automation-board-item-toggle">
                  <input
                    type="checkbox"
                    checked={card.wakeTimerActive === true}
                    onChange={(event) =>
                      onPatchItemCard(card.id, {
                        wakeTimerActive: event.target.checked,
                        wakeTimerMode: card.wakeTimerMode ?? 'left-tab',
                      })
                    }
                  />
                  <span>{text.automationBoardWakeAboveLabel}</span>
                </label>
              ) : null}

              {showsRepeatToggle ? (
                <label className="automation-board-item-toggle">
                  <input
                    type="checkbox"
                    checked={card.repeatLoopActive === true}
                    onChange={(event) =>
                      onPatchItemCard(card.id, { repeatLoopActive: event.target.checked })
                    }
                  />
                  <span>{text.repeatLoopStatusLabel}</span>
                </label>
              ) : null}
            </div>
          ) : null}

          <div className="automation-board-item-nudge">
            <textarea
              value={nudge}
              rows={2}
              placeholder={text.automationBoardItemNudgePlaceholder}
              onChange={(event) => setNudge(event.target.value)}
              onKeyDown={handleNudgeKeyDown}
            />
          </div>
        </div>
      ) : null}
    </article>
  )
}

/**
 * 模板的可展开配置面板。v1 的"监工区"整块没了：监工只是一个 `builtIn` 模板，
 * 它的需求 / 模型 / 权限 / 触发器都在这里配，与用户自己存的模板走同一套 UI。
 *
 * 导出是为了让 SSR 单测能直接渲染展开态 —— `renderToStaticMarkup` 点不了按钮，
 * 否则"展开后有需求 textarea 和触发器开关"这条就只能靠 Playwright 覆盖。
 */
export const AutomationBoardTemplateConfig = ({
  template,
  language,
  onUpdateTemplate,
  onRunTemplateNow,
}: {
  template: AutomationBoardTemplate
  language: AppLanguage
  onUpdateTemplate: AutomationBoardCardProps['onUpdateTemplate']
  onRunTemplateNow: AutomationBoardCardProps['onRunTemplateNow']
}) => {
  const text = getLocaleText(language)
  const laneLabels: Record<AutomationBoardLane, string> = {
    standby: text.automationBoardLaneStandby,
    running: text.automationBoardLaneRunning,
    done: text.automationBoardLaneDone,
  }

  // trigger 的每次改动都要把整个对象带上：state 那层是浅合并，只发一个子字段
  // 会把 lane / minIntervalMinutes 一起抹成默认值。
  const patchTrigger = (patch: Partial<AutomationBoardTemplate['trigger']>) =>
    onUpdateTemplate(template.id, { trigger: { ...template.trigger, ...patch } })

  return (
    <div className="automation-board-template-config">
      <label className="automation-board-template-field">
        <span>{text.automationBoardTemplateNameLabel}</span>
        <input
          type="text"
          value={template.name}
          onChange={(event) => onUpdateTemplate(template.id, { name: event.target.value })}
        />
      </label>

      <label className="automation-board-template-field is-stacked">
        <span>{text.automationBoardTemplateRequirementLabel}</span>
        <textarea
          value={template.requirement}
          rows={5}
          onChange={(event) => onUpdateTemplate(template.id, { requirement: event.target.value })}
        />
      </label>

      <label className="automation-board-template-field">
        <span>{text.automationBoardTemplateModelLabel}</span>
        <select
          value={`${template.provider}::${template.model}`}
          onChange={(event) => {
            const [provider, model] = event.target.value.split('::')
            onUpdateTemplate(template.id, {
              provider: (provider as Provider) ?? 'codex',
              model: model ?? '',
            })
          }}
        >
          {modelPickerOptions.map((option) => (
            <option
              key={`${option.provider}::${option.model}`}
              value={`${option.provider}::${option.model}`}
            >
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label
        className={`automation-board-template-field${template.adminAccess ? ' is-admin' : ''}`}
      >
        <input
          type="checkbox"
          checked={template.adminAccess}
          onChange={(event) => onUpdateTemplate(template.id, { adminAccess: event.target.checked })}
        />
        <span>{text.automationBoardTemplateAdminAccessLabel}</span>
      </label>
      <p className="automation-board-template-hint">
        {text.automationBoardTemplateAdminAccessHint}
      </p>

      <div className="automation-board-template-trigger">
        <h5 className="automation-board-template-trigger-title">
          {text.automationBoardTriggerLabel}
        </h5>
        <p className="automation-board-template-hint">{text.automationBoardTriggerHint}</p>

        <label className="automation-board-template-field">
          <input
            type="checkbox"
            checked={template.trigger.enabled}
            onChange={(event) => patchTrigger({ enabled: event.target.checked })}
          />
          <span>{text.automationBoardTriggerEnableLabel}</span>
        </label>

        <p className="automation-board-template-trigger-kind">
          {text.automationBoardTriggerKindLastItemSettled}
        </p>

        <label className="automation-board-template-field">
          <span>{text.automationBoardTriggerLaneLabel}</span>
          <select
            value={template.trigger.lane}
            onChange={(event) => patchTrigger({ lane: event.target.value as AutomationBoardLane })}
          >
            {(Object.keys(laneLabels) as AutomationBoardLane[]).map((lane) => (
              <option key={lane} value={lane}>
                {laneLabels[lane]}
              </option>
            ))}
          </select>
        </label>

        <label className="automation-board-template-field">
          <span>{text.automationBoardTriggerIntervalLabel}</span>
          <input
            type="number"
            min={0}
            max={1440}
            value={template.trigger.minIntervalMinutes}
            onChange={(event) =>
              patchTrigger({ minIntervalMinutes: Number(event.target.value) || 0 })
            }
          />
        </label>
      </div>

      <div className="automation-board-template-config-actions">
        <BoardButton tone="ghost" onClick={() => onRunTemplateNow(template.id)}>
          {text.automationBoardTemplateRunNowAction}
        </BoardButton>

        {template.builtIn ? (
          <BoardButton
            tone="ghost"
            onClick={() =>
              onUpdateTemplate(template.id, {
                requirement: defaultAutomationBoardSupervisorRequirement,
              })
            }
          >
            {text.automationBoardTemplateResetRequirementAction}
          </BoardButton>
        ) : null}
      </div>
    </div>
  )
}

const AutomationBoardCardView = (props: AutomationBoardCardProps) => {
  const {
    board,
    cards,
    columnId,
    boardCardId,
    language,
    workspacePath,
    templates,
    onCreateItem,
    onMoveItem,
    onAbsorbTab,
    onInstantiateTemplate,
    onRenameTemplate,
    onDeleteTemplate,
    onUpdateTemplate,
    onRunTemplateNow,
  } = props
  const text = getLocaleText(language)
  const [draft, setDraft] = useState('')
  const [dropLane, setDropLane] = useState<AutomationBoardLane | null>(null)
  const [rejectedDrop, setRejectedDrop] = useState(false)
  // 同时只展开一个模板的配置面板：模板条是横向滚动的一行，两个面板同时展开
  // 会把看板下半截全吃掉。
  const [expandedTemplateId, setExpandedTemplateId] = useState<string | null>(null)
  const rejectionTimerRef = useRef<number | null>(null)

  const expandedTemplate = templates.find((entry) => entry.id === expandedTemplateId)

  const laneViews = useMemo(
    () => buildAutomationBoardLaneViews(board, cards, language),
    [board, cards, language],
  )

  const flashRejection = useCallback(() => {
    setRejectedDrop(true)
    if (rejectionTimerRef.current !== null) {
      window.clearTimeout(rejectionTimerRef.current)
    }
    rejectionTimerRef.current = window.setTimeout(() => {
      setRejectedDrop(false)
      rejectionTimerRef.current = null
    }, 2400)
  }, [])

  const clearHints = useCallback(() => setDropLane(null), [])

  /**
   * 落点是否可接收。跨列一律拒绝：项卡片的 cwd 由所在列的 workspacePath 决定，
   * 把别的项目的需求挂进来会让 agent 在错误的目录里干活。
   */
  const canAcceptPayload = useCallback(
    (payload: ReturnType<typeof readDragPayload>) => {
      if (!payload) {
        return false
      }

      if (payload.type === 'tab') {
        return payload.columnId === columnId && payload.tabId !== boardCardId
      }

      if (payload.type === 'automation-board-item') {
        return payload.columnId === columnId && payload.boardCardId === boardCardId
      }

      if (payload.type === 'automation-board-template') {
        return payload.workspacePath === workspacePath
      }

      return false
    },
    [boardCardId, columnId, workspacePath],
  )

  const handleLaneDragOver = (lane: AutomationBoardLane) => (event: DragEvent<HTMLDivElement>) => {
    const payload = readDragPayload(event)
    if (!payload) {
      return
    }

    // 明确是别列的 tab / 别的工作区的模板：不 preventDefault（因此不可 drop），
    // 但给用户一句解释，而不是让拖拽静默失败。
    if (!canAcceptPayload(payload)) {
      if (payload.type === 'tab' || payload.type === 'automation-board-template') {
        flashRejection()
      }
      return
    }

    event.preventDefault()
    event.stopPropagation()
    setDropLane(lane)
  }

  const handleLaneDrop = (lane: AutomationBoardLane) => (event: DragEvent<HTMLDivElement>) => {
    const payload = readDragPayload(event)
    if (!canAcceptPayload(payload) || !payload) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    if (payload.type === 'tab') {
      onAbsorbTab(
        { columnId: payload.columnId, paneId: payload.paneId, tabId: payload.tabId },
        lane,
      )
    } else if (payload.type === 'automation-board-item') {
      onMoveItem(payload.cardId, lane)
    } else if (payload.type === 'automation-board-template') {
      onInstantiateTemplate(payload.templateId, lane)
    }

    clearDragPayload()
    clearHints()
  }

  const submitDraft = () => {
    const trimmed = draft.trim()
    if (!trimmed) {
      return
    }

    setDraft('')
    onCreateItem('standby', trimmed)
  }

  return (
    <div className="automation-board">
      {rejectedDrop ? (
        <p className="automation-board-reject" role="status">
          {text.automationBoardCrossWorkspaceRejected}
        </p>
      ) : null}

      <div className="automation-board-lanes">
        {laneViews.map((laneView) => (
          <section
            key={laneView.lane}
            className={`automation-board-lane${dropLane === laneView.lane ? ' is-drop-target' : ''}`}
            data-lane={laneView.lane}
          >
            <header className="automation-board-lane-head">
              <h3>{laneView.title}</h3>
              <span className="automation-board-lane-count">
                {text.automationBoardItemCount(laneView.items.length)}
              </span>
            </header>

            <div
              className="automation-board-lane-body"
              onDragOver={handleLaneDragOver(laneView.lane)}
              onDragLeave={(event) => {
                const next = event.relatedTarget
                if (next instanceof Node && event.currentTarget.contains(next)) {
                  return
                }
                setDropLane((current) => (current === laneView.lane ? null : current))
              }}
              onDrop={handleLaneDrop(laneView.lane)}
            >
              {laneView.items.length === 0 ? (
                <p className="automation-board-lane-empty">{text.automationBoardEmptyLane}</p>
              ) : (
                laneView.items.map((view) => (
                  <AutomationBoardItemCard
                    key={view.card.id}
                    view={view}
                    lane={laneView.lane}
                    boardCardId={boardCardId}
                    columnId={columnId}
                    language={language}
                    workspacePath={workspacePath}
                    wakeTimerEnabled={props.wakeTimerEnabled}
                    repeatLoopEnabled={props.repeatLoopEnabled}
                    onPopOutItem={props.onPopOutItem}
                    onDeleteItem={props.onDeleteItem}
                    onSaveTemplate={props.onSaveTemplate}
                    onStopItem={props.onStopItem}
                    onMoveItem={props.onMoveItem}
                    onSendToItem={props.onSendToItem}
                    onPatchItemCard={props.onPatchItemCard}
                  />
                ))
              )}
            </div>

            {laneView.lane === 'standby' ? (
              <div className="automation-board-lane-compose">
                <textarea
                  value={draft}
                  rows={2}
                  placeholder={text.automationBoardNewRequirementPlaceholder}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      submitDraft()
                    }
                  }}
                />
                <BoardButton tone="primary" onClick={submitDraft} disabled={!draft.trim()}>
                  {text.automationBoardAddRequirement}
                </BoardButton>
              </div>
            ) : (
              <p className="automation-board-lane-hint">{laneView.hint}</p>
            )}
          </section>
        ))}
      </div>

      <section className="automation-board-templates">
        <header className="automation-board-templates-head">
          <span className="automation-board-templates-icon" aria-hidden="true">
            <StickyNoteIcon />
          </span>
          <h3>{text.automationBoardTemplatesLabel}</h3>
        </header>

        {/* 模板条现在永远非空（工作区默认种一个内置监工模板），但用户可以把
            模板全删光，所以空态分支保留。 */}
        {templates.length === 0 ? (
          <p className="automation-board-templates-empty">{text.automationBoardTemplatesEmpty}</p>
        ) : (
          <ul className="automation-board-templates-list">
            {templates.map((template) => (
              <li
                key={template.id}
                className={`automation-board-template${expandedTemplateId === template.id ? ' is-expanded' : ''}`}
                draggable
                onDragStart={(event) => {
                  writeDragPayload(event, {
                    type: 'automation-board-template',
                    workspacePath,
                    templateId: template.id,
                  })
                }}
                onDragEnd={() => clearDragPayload()}
                title={template.requirement}
              >
                <span className="automation-board-template-name">
                  {template.name || template.requirement}
                </span>
                {template.trigger.enabled ? (
                  <span
                    className="automation-board-template-badge is-trigger"
                    title={text.automationBoardTriggerBadgeTitle}
                    aria-label={text.automationBoardTriggerBadgeTitle}
                  >
                    <ZapIcon />
                  </span>
                ) : null}
                {template.adminAccess ? (
                  <span
                    className="automation-board-template-badge is-admin"
                    title={text.adminAccessBadgeTitle}
                    aria-label={text.adminAccessBadgeTitle}
                  >
                    <ShieldIcon />
                  </span>
                ) : null}
                <span className="automation-board-template-model">
                  {template.model || template.provider}
                </span>
                <IconButton
                  label={
                    expandedTemplateId === template.id
                      ? text.automationBoardTemplateCloseAction
                      : text.automationBoardTemplateConfigureAction
                  }
                  className="automation-board-template-configure"
                  aria-expanded={expandedTemplateId === template.id}
                  onClick={() =>
                    setExpandedTemplateId((current) =>
                      current === template.id ? null : template.id,
                    )
                  }
                >
                  <ChevronDownIcon />
                </IconButton>
                <IconButton
                  label={text.automationBoardTemplateRenameAction}
                  className="automation-board-template-rename"
                  onClick={() => {
                    const next = window.prompt(
                      text.automationBoardTemplateNamePrompt,
                      template.name,
                    )
                    if (next !== null && next.trim()) {
                      onRenameTemplate(template.id, next)
                    }
                  }}
                >
                  <RefreshIcon />
                </IconButton>
                <IconButton
                  label={text.automationBoardTemplateDeleteAction}
                  onClick={() => onDeleteTemplate(template.id)}
                >
                  <CloseIcon />
                </IconButton>
              </li>
            ))}
          </ul>
        )}

        {/* 配置面板挂在模板条**下面**而不是胶囊内部：胶囊列表是横向滚动的一行，
            把一个五行 textarea 塞进 li 会让面板随水平滚动漂出可视区，并把整条
            strip 撑到看板一半高。 */}
        {expandedTemplate ? (
          <AutomationBoardTemplateConfig
            template={expandedTemplate}
            language={language}
            onUpdateTemplate={onUpdateTemplate}
            onRunTemplateNow={onRunTemplateNow}
          />
        ) : null}
      </section>
    </div>
  )
}

export const AutomationBoardCard = memo(AutomationBoardCardView)
