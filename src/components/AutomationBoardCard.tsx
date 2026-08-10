import { memo, useCallback, useMemo, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, DragEvent, KeyboardEvent } from 'react'

import { getLocaleText } from '../../shared/i18n'
import { MODEL_OPTIONS, isModelPickerOptionVisible } from '../../shared/models'
import { defaultAutomationBoardSupervisorRequirement } from '../../shared/schema'
import type {
  AppLanguage,
  AutomationBoard,
  AutomationBoardAutoTrigger,
  AutomationBoardLane,
  AutomationBoardTemplate,
  ChatCard,
  Provider,
} from '../../shared/schema'
import { clearDragPayload, readDragPayload, writeDragPayload } from '../dnd'
import {
  CloseIcon,
  IconButton,
  PlayIcon,
  RefreshIcon,
  SparklesIcon,
  StickyNoteIcon,
  StopIcon,
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
  autoTrigger: AutomationBoardAutoTrigger
  supervisorCard: ChatCard | undefined
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
  onUpdateAutoTrigger: (patch: Partial<AutomationBoardAutoTrigger>) => void
  onRunSupervisorNow: () => void
  onSetSupervisorExpanded: (expanded: boolean) => void
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
  const isStreaming = card.status === 'streaming'

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

  return (
    <article
      className={`automation-board-item ${resolveAutomationBoardItemStatusClass(card)}`.trim()}
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
        <h4 className="automation-board-item-title" title={item.requirement}>
          {card.title || item.requirement || text.automationBoardTitle}
        </h4>
        <span className="automation-board-item-model">{card.model || card.provider}</span>
        <span
          className={`automation-board-item-dot${isStreaming ? ' is-active' : ''}`}
          aria-hidden="true"
        />
      </header>

      <p className="automation-board-item-requirement" title={item.requirement}>
        {item.requirement}
      </p>

      <AutomationBoardItemTranscript
        card={card}
        language={language}
        workspacePath={workspacePath}
      />

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

        {repeatLoopEnabled && lane === 'running' ? (
          <label className="automation-board-item-toggle">
            <input
              type="checkbox"
              checked={card.repeatLoopActive === true}
              onChange={(event) => onPatchItemCard(card.id, { repeatLoopActive: event.target.checked })}
            />
            <span>{text.repeatLoopStatusLabel}</span>
          </label>
        ) : null}

        <IconButton
          label={text.automationBoardDeleteAction}
          className="automation-board-item-delete"
          onClick={() => onDeleteItem(card.id)}
        >
          <CloseIcon />
        </IconButton>
      </footer>

      <div className="automation-board-item-nudge">
        <textarea
          value={nudge}
          rows={1}
          placeholder={text.automationBoardNewRequirementPlaceholder}
          onChange={(event) => setNudge(event.target.value)}
          onKeyDown={handleNudgeKeyDown}
        />
      </div>
    </article>
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
    autoTrigger,
    supervisorCard,
    onCreateItem,
    onMoveItem,
    onAbsorbTab,
    onInstantiateTemplate,
    onRenameTemplate,
    onDeleteTemplate,
    onUpdateAutoTrigger,
    onRunSupervisorNow,
    onSetSupervisorExpanded,
  } = props
  const text = getLocaleText(language)
  const [draft, setDraft] = useState('')
  const [dropLane, setDropLane] = useState<AutomationBoardLane | null>(null)
  const [rejectedDrop, setRejectedDrop] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const rejectionTimerRef = useRef<number | null>(null)

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

  const supervisorBusy = supervisorCard?.status === 'streaming'

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

      <section className="automation-board-supervisor">
        <header className="automation-board-supervisor-head">
          <span className="automation-board-supervisor-icon" aria-hidden="true">
            <SparklesIcon />
          </span>
          <h3>{text.automationBoardSupervisorSectionLabel}</h3>
          <span className="automation-board-supervisor-state">
            {supervisorBusy ? text.automationBoardTitle : text.automationBoardSupervisorIdle}
          </span>
          <BoardButton
            tone="ghost"
            onClick={onRunSupervisorNow}
            disabled={supervisorBusy}
          >
            {text.automationBoardSupervisorRunNowAction}
          </BoardButton>
          <BoardButton tone="ghost" onClick={() => setConfigOpen((open) => !open)}>
            {configOpen
              ? text.automationBoardAutoTriggerCloseAction
              : text.automationBoardAutoTriggerConfigureAction}
          </BoardButton>
          {supervisorCard ? (
            <BoardButton
              tone="ghost"
              onClick={() => onSetSupervisorExpanded(!board.supervisorExpanded)}
            >
              {board.supervisorExpanded
                ? text.automationBoardSupervisorCollapse
                : text.automationBoardSupervisorExpand}
            </BoardButton>
          ) : null}
        </header>

        {configOpen ? (
          <div className="automation-board-trigger-config">
            <p className="automation-board-trigger-hint">{text.automationBoardAutoTriggerHint}</p>

            <label className="automation-board-trigger-row">
              <input
                type="checkbox"
                checked={autoTrigger.enabled}
                onChange={(event) => onUpdateAutoTrigger({ enabled: event.target.checked })}
              />
              <span>{text.automationBoardAutoTriggerEnableLabel}</span>
            </label>

            <p className="automation-board-trigger-kind">
              {text.automationBoardAutoTriggerKindLastItemSettled}
            </p>

            <label className="automation-board-trigger-row">
              <span>{text.automationBoardAutoTriggerModelLabel}</span>
              <select
                value={`${autoTrigger.provider}::${autoTrigger.model}`}
                onChange={(event) => {
                  const [provider, model] = event.target.value.split('::')
                  onUpdateAutoTrigger({
                    provider: (provider as Provider) ?? 'claude',
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

            <label className="automation-board-trigger-row is-stacked">
              <span>{text.automationBoardAutoTriggerRequirementLabel}</span>
              <textarea
                value={autoTrigger.requirement}
                rows={5}
                onChange={(event) => onUpdateAutoTrigger({ requirement: event.target.value })}
              />
            </label>

            <label className="automation-board-trigger-row">
              <span>{text.automationBoardAutoTriggerIntervalLabel}</span>
              <input
                type="number"
                min={0}
                max={1440}
                value={autoTrigger.minIntervalMinutes}
                onChange={(event) =>
                  onUpdateAutoTrigger({ minIntervalMinutes: Number(event.target.value) || 0 })
                }
              />
            </label>

            <BoardButton
              tone="ghost"
              onClick={() =>
                onUpdateAutoTrigger({ requirement: defaultAutomationBoardSupervisorRequirement })
              }
            >
              {text.automationBoardAutoTriggerResetAction}
            </BoardButton>
          </div>
        ) : null}

        {board.supervisorExpanded && supervisorCard ? (
          <div className="automation-board-supervisor-body">
            <AutomationBoardItemTranscript
              card={supervisorCard}
              language={language}
              workspacePath={workspacePath}
            />
            <BoardButton tone="ghost" onClick={() => props.onPopOutItem(supervisorCard.id)}>
              {text.automationBoardPopOutAction}
            </BoardButton>
          </div>
        ) : null}
      </section>

      <section className="automation-board-templates">
        <header className="automation-board-templates-head">
          <span className="automation-board-templates-icon" aria-hidden="true">
            <StickyNoteIcon />
          </span>
          <h3>{text.automationBoardTemplatesLabel}</h3>
        </header>

        {templates.length === 0 ? (
          <p className="automation-board-templates-empty">{text.automationBoardTemplatesEmpty}</p>
        ) : (
          <ul className="automation-board-templates-list">
            {templates.map((template) => (
              <li
                key={template.id}
                className="automation-board-template"
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
                <span className="automation-board-template-model">
                  {template.model || template.provider}
                </span>
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
      </section>
    </div>
  )
}

export const AutomationBoardCard = memo(AutomationBoardCardView)
