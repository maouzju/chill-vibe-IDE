import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ButtonHTMLAttributes,
  ClipboardEvent,
  CSSProperties,
  DragEvent,
  KeyboardEvent,
  PointerEvent,
} from 'react'

import { getLocaleText } from '../../shared/i18n'
import {
  MODEL_OPTIONS,
  MODEL_PICKER_HIDDEN_TOOL_MODELS,
  isModelPickerOptionVisible,
} from '../../shared/models'
import {
  getReasoningOptionsForModel,
  isClaudeAlwaysThinkingModel,
  normalizeReasoningEffortForModel,
} from '../../shared/reasoning'
import { defaultAutomationBoardSupervisorRequirement } from '../../shared/schema'
import type {
  AppLanguage,
  AutomationBoard,
  AutomationBoardComposeDefaults,
  AutomationBoardLane,
  AutomationBoardLaneWidths,
  AutomationBoardTemplate,
  ChatCard,
  ImageAttachment,
  Provider,
} from '../../shared/schema'
import { resizeColumnGroups } from '../column-resize'
import {
  AUTOMATION_BOARD_LANE_MIN_WIDTH,
  getAutomationBoardLaneTracks,
  resolveAutomationBoardLaneWidths,
  toAutomationBoardLaneWidths,
} from './automation-board-lane-resize'
import {
  promoteDraftAttachment,
  type PendingComposerAttachment,
} from './composer-draft-attachments'
import { collectPastedImageFiles, uploadPendingImage } from './composer-image-paste'
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
import { WakeTimerSettingsPanel } from './WakeTimerSettingsPanel'

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
  /** 这一列的 provider/model，只在这张看板还没存过 `composeDefaults` 时兜底。 */
  defaultProvider: Provider
  defaultModel: string
  wakeTimerEnabled: boolean
  repeatLoopEnabled: boolean
  onCreateItem: (
    lane: AutomationBoardLane,
    requirement: string,
    index?: number,
    options?: Partial<AutomationBoardComposeDefaults> & { attachments?: ImageAttachment[] },
  ) => void
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
  /** 泳道宽度落定（`null` = 双击恢复均分）。拖拽过程中不调它，见下面的注释。 */
  onSetLaneWidths: (widths: AutomationBoardLaneWidths | null) => void
  /** 「加入待命」那组执行参数的落盘出口（一次一个字段，reducer 那层浅合并）。 */
  onSetComposeDefaults: (patch: Partial<AutomationBoardComposeDefaults>) => void
  /** 待命草稿落盘。只在失焦与卸载时调，理由见 automation-board-host.ts。 */
  onSetComposerDraft: (draft: string) => void
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

/**
 * 存档里的模型可能已经从选单里下架（或是用户手写的自定义型号），那种 value 交给
 * 原生 select 会静默回落到**第一个** option —— 显示的和实际用的对不上。回落到同
 * provider 的"用默认模型"那一项，至少 CLI 是对的。
 */
const resolveModelPickerValue = (provider: Provider, model: string) => {
  const value = `${provider}::${model}`
  return modelPickerOptions.some((option) => `${option.provider}::${option.model}` === value)
    ? value
    : `${provider}::`
}

/**
 * 一次执行的参数（模型 + 思考 + 思考深度 + 计划模式 + 超管权限）。
 *
 * 模板配置面板与待命 composer 需要的是**同一组语义**，而这组语义带着一串
 * provider/model 相关的规则（Fable 5 强制思考、Codex 老模型没有 max/ultra 档、
 * planMode 只对 Claude 有意义）。两处各写一遍 select 的代价不是重复代码，是规则
 * 漂移：以后加一个模型档位只改了一处，另一处静默给出非法组合。
 *
 * 导出是为了让 SSR 单测能直接渲染 —— 与 `AutomationBoardTemplateConfig` 同一个
 * 理由（`renderToStaticMarkup` 点不开折叠面板）。
 */
export const AutomationBoardModelSettings = ({
  value,
  language,
  onChange,
  showModel = true,
}: {
  value: AutomationBoardComposeDefaults
  language: AppLanguage
  onChange: (patch: Partial<AutomationBoardComposeDefaults>) => void
  /** 待命 composer 把模型留在一级操作行，面板里就不再重复渲染一遍。 */
  showModel?: boolean
}) => {
  const text = getLocaleText(language)
  const alwaysThinking = value.provider === 'claude' && isClaudeAlwaysThinkingModel(value.model)
  const thinkingOn = alwaysThinking || value.thinkingEnabled
  const reasoningOptions = getReasoningOptionsForModel(value.provider, value.model, language)
  const reasoningValue = normalizeReasoningEffortForModel(
    value.provider,
    value.model,
    value.reasoningEffort,
  )

  return (
    <>
      {showModel ? (
      <label className="automation-board-template-field">
        <span>{text.automationBoardTemplateModelLabel}</span>
        <select
          value={resolveModelPickerValue(value.provider, value.model)}
          onChange={(event) => {
            const [provider, model] = event.target.value.split('::')
            const nextProvider = (provider as Provider) ?? 'codex'
            // 换 provider/model 时把深度一起交还给"跟着默认走"：Codex 老模型上留着
            // 一个 max/ultra、或 Claude 上留着 ultra，都是启动就被 CLI 拒绝的档位。
            onChange({
              provider: nextProvider,
              model: model ?? '',
              reasoningEffort: normalizeReasoningEffortForModel(
                nextProvider,
                model ?? '',
                value.reasoningEffort,
              ),
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
      ) : null}

      <label className="automation-board-template-field">
        <input
          type="checkbox"
          checked={thinkingOn}
          disabled={alwaysThinking}
          onChange={(event) => onChange({ thinkingEnabled: event.target.checked })}
        />
        <span>{text.thinking}</span>
      </label>

      <label className="automation-board-template-field">
        <span>{text.thinkingDepthLabel}</span>
        <select
          className="reasoning-select"
          value={reasoningValue}
          disabled={!thinkingOn}
          onChange={(event) => onChange({ reasoningEffort: event.target.value })}
        >
          {reasoningOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {/* 计划模式是 Claude 专用，与聊天 composer 同一条规则。 */}
      {value.provider === 'claude' ? (
        <label className="automation-board-template-field">
          <input
            type="checkbox"
            checked={value.planMode}
            onChange={(event) => onChange({ planMode: event.target.checked })}
          />
          <span>{text.planMode}</span>
        </label>
      ) : null}

      <label
        className={`automation-board-template-field${value.adminAccess ? ' is-admin' : ''}`}
      >
        <input
          type="checkbox"
          checked={value.adminAccess}
          onChange={(event) => onChange({ adminAccess: event.target.checked })}
        />
        <span>{text.automationBoardTemplateAdminAccessLabel}</span>
      </label>
    </>
  )
}

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
  workspaceAgentCount,
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
  /** 本工作区里除这一项以外的 Agent 数量，`workspace-agents` 模式的提示用。 */
  workspaceAgentCount: number
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

  const wakeMode = card.wakeTimerMode ?? 'workspace-agents'
  const showsWakeControls = wakeTimerEnabled && lane === 'running'

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
        <div ref={drawerRef} onDragStart={(event) => event.stopPropagation()}>
          <AutomationBoardItemDrawer
            view={view}
            lane={lane}
            language={language}
            wakeTimerEnabled={wakeTimerEnabled}
            repeatLoopEnabled={repeatLoopEnabled}
            workspaceAgentCount={workspaceAgentCount}
            nudge={nudge}
            onNudgeChange={setNudge}
            onNudgeSubmit={submitNudge}
            onPopOutItem={onPopOutItem}
            onSaveTemplate={onSaveTemplate}
            onPatchItemCard={onPatchItemCard}
          />
        </div>
      ) : null}
    </article>
  )
}

/**
 * 项卡片的二级抽屉。
 *
 * 导出是为了让 SSR 单测能直接渲染展开态 —— `renderToStaticMarkup` 点不了折叠
 * 开关，和 `AutomationBoardTemplateConfig` 同一个理由。
 */
export const AutomationBoardItemDrawer = ({
  view,
  lane,
  language,
  wakeTimerEnabled,
  repeatLoopEnabled,
  workspaceAgentCount,
  nudge,
  onNudgeChange,
  onNudgeSubmit,
  onPopOutItem,
  onSaveTemplate,
  onPatchItemCard,
}: {
  view: AutomationBoardItemView
  lane: AutomationBoardLane
  workspaceAgentCount: number
  nudge: string
  onNudgeChange: (next: string) => void
  onNudgeSubmit: () => void
} & Pick<
  AutomationBoardCardProps,
  | 'language'
  | 'wakeTimerEnabled'
  | 'repeatLoopEnabled'
  | 'onPopOutItem'
  | 'onSaveTemplate'
  | 'onPatchItemCard'
>) => {
  const text = getLocaleText(language)
  const { card, aboveCardId, aboveTitle } = view
  const showsWakeControls = wakeTimerEnabled && lane === 'running'
  const showsRepeatToggle = repeatLoopEnabled && lane === 'running'

  const handleNudgeKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onNudgeSubmit()
    }
  }

  return (
    <div className="automation-board-item-drawer">
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

      {/* 计划唤醒复用 composer 那一整块面板，而不是本地再写一个"上方需求"复选框：
          唤醒模式是三选一，看板少一个入口就等于那两个模式在看板里永远够不到。
          语境差异只允许落在文案上（`context="board"`：左侧 Tab → 上方需求）。 */}
      {showsWakeControls ? (
        <WakeTimerSettingsPanel
          language={language}
          context="board"
          card={card}
          neighbourTarget={aboveCardId ? { id: aboveCardId, title: aboveTitle ?? '' } : null}
          workspaceAgentCount={workspaceAgentCount}
          locked={(card.wakeTimerQueuedSends?.length ?? 0) > 0}
          onPatch={(patch) => onPatchItemCard(card.id, patch)}
          className="automation-board-item-wake-panel"
        />
      ) : null}

      {showsRepeatToggle ? (
        <div className="automation-board-item-drawer-row">
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
        </div>
      ) : null}

      <div className="automation-board-item-nudge">
        <textarea
          value={nudge}
          rows={2}
          placeholder={text.automationBoardItemNudgePlaceholder}
          onChange={(event) => onNudgeChange(event.target.value)}
          onKeyDown={handleNudgeKeyDown}
        />
      </div>
    </div>
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

      {/* 名称与模型都是单行的"这是哪个模板"信息，紧挨着放；需求是正文，跟在
          它们后面。宽看板下配置面板走双栏，这个顺序让两个单行字段自然配成
          一行，而不是名称旁边空着半个面板。
          模板 schema 一直存着 reasoningEffort / thinkingEnabled / planMode，v2.3
          之前只有模型和超管两行有入口 —— 存了却配不了等于存了个死值。 */}
      <AutomationBoardModelSettings
        value={{
          provider: template.provider,
          model: template.model,
          reasoningEffort: template.reasoningEffort,
          thinkingEnabled: template.thinkingEnabled,
          planMode: template.planMode,
          adminAccess: template.adminAccess,
        }}
        language={language}
        onChange={(patch) => onUpdateTemplate(template.id, patch)}
      />
      <p className="automation-board-template-hint">
        {text.automationBoardTemplateAdminAccessHint}
      </p>

      <label className="automation-board-template-field is-stacked">
        <span>{text.automationBoardTemplateRequirementLabel}</span>
        <textarea
          value={template.requirement}
          rows={5}
          onChange={(event) => onUpdateTemplate(template.id, { requirement: event.target.value })}
        />
      </label>

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
    onSetComposeDefaults,
    onSetLaneWidths,
  } = props
  const text = getLocaleText(language)
  // 本地 state 承担每次按键，落盘只在失焦 / 卸载时发生（见 onSetComposerDraft）。
  // 初值取自看板，所以切走再回来、乃至关掉 tab 再开一张看板，写到一半的需求都在。
  const [draft, setDraft] = useState(board.draft ?? '')
  const draftRef = useRef(draft)
  const commitDraftRef = useRef(props.onSetComposerDraft)
  // 只能在 effect 里写 ref（react-hooks/refs 禁止 render 期赋值）。这个 effect
  // 刻意不带依赖数组：每次渲染后都把最新值推进去，卸载 cleanup 读到的才是最新的。
  useEffect(() => {
    draftRef.current = draft
    commitDraftRef.current = props.onSetComposerDraft
  })
  const commitDraft = () => {
    commitDraftRef.current(draftRef.current)
  }

  // 卸载即落盘：看板不在 `cardKeepsPaneRuntimeWhenInactive` 白名单里，切 tab 会
  // 把整棵子树卸载掉，textarea 根本没机会 blur。ref 转发是为了让这个 effect 保持
  // 空依赖 —— 挂上 draft 依赖的话每敲一个字符都要拆装一次订阅。
  useEffect(() => commitDraft, [])
  // 症状：这组选择原本只活在组件 useState 里（理由写的是"落盘会让用户被上次的
  //   一次性选择绑住"），实际是连着加十个需求项要重选十次，切走再回来还回到列默认。
  // 根因：把它当成一次性意图，而用户的真实用法是"这张看板就用这套参数"。
  // 为什么不能只加个默认值：默认值仍然每次挂载重置；必须随看板落盘（FR12）。
  const composeDefaults: AutomationBoardComposeDefaults = board.composeDefaults ?? {
    provider: props.defaultProvider,
    model: props.defaultModel,
    reasoningEffort: '',
    thinkingEnabled: true,
    planMode: false,
    adminAccess: false,
  }
  const [composeSettingsOpen, setComposeSettingsOpen] = useState(false)
  // 待命草稿的粘贴图片。需求经常本身就是一张截图，只能打字等于逼用户先建卡
  // 再去卡里粘一遍。
  const [draftImages, setDraftImages] = useState<PendingComposerAttachment[]>([])
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

  // `workspace-agents` 模式等的是"这一列里其他 Agent 卡"，和 composer 那侧同一个
  // 口径（`PaneView` 也是这么数的）：工具卡不算 Agent。看板项自己要从里面刨掉，
  // 所以这里先数总数，逐项再减自己。
  const workspaceAgentCardCount = useMemo(
    () =>
      Object.values(cards).filter((entry) => !MODEL_PICKER_HIDDEN_TOOL_MODELS.has(entry.model))
        .length,
    [cards],
  )

  const lanesRef = useRef<HTMLDivElement | null>(null)
  const laneTracks = getAutomationBoardLaneTracks(
    resolveAutomationBoardLaneWidths(board.laneWidths),
  )

  /**
   * 泳道分隔条拖拽。数学直接复用工作区列那套 `resizeColumnGroups`：两者是同一个
   * 问题（分隔条两侧的组按比例整体让位、每个成员钉一个最小宽度），手感一致还能
   * 让用户把列分隔条的肌肉记忆直接搬过来。
   *
   * 拖拽过程中只写 DOM 上的 CSS 变量、不 dispatch：每帧派发 reducer 会把整列子树
   * 的 memo 全部打穿（pitfall 187），松手才提交一次。
   *
   * 那个变量必须是**另一个** `--automation-board-lane-drag-tracks`，不能直接脏写
   * React 内联管着的 `--automation-board-lane-tracks`：React 的 style diff 比的是上
   * 一次渲染的值、不是 DOM 现值，一旦命令式写过同一个属性，"新旧计算值相同"就会
   * 让它跳过写入，脏值永久留在 DOM 上。2026-08-13 实测的表现是拖完再双击恢复均分
   * 完全无效——事件、reducer、持久化全都对，只有那一行 CSS 变量还是拖拽时的残留。
   */
  const handleLaneResizeStart =
    (dividerIndex: number) => (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return
      }

      const container = lanesRef.current
      if (!container) {
        return
      }

      const laneElements = Array.from(
        container.querySelectorAll<HTMLElement>('.automation-board-lane'),
      )

      if (dividerIndex < 0 || dividerIndex >= laneElements.length - 1) {
        return
      }

      // 这里**不能** `event.preventDefault()`（列分隔条 `WorkspaceColumn` 就是那么写
      // 的）：pointerdown 上的 preventDefault 会连带压掉后续的兼容鼠标事件，于是
      // `onDoubleClick` 永远收不到，双击恢复均分静默失效（2026-08-13 实测：拖完双击
      // 三条泳道纹丝不动）。拖拽期间的文字选中改由手柄自己的 `user-select: none` 挡。
      const startWidths = laneElements.map((element) =>
        Math.max(
          AUTOMATION_BOARD_LANE_MIN_WIDTH,
          Math.round(element.getBoundingClientRect().width),
        ),
      )
      const startX = event.clientX
      let nextWidths = startWidths

      document.body.classList.add('is-col-resizing')

      const handleMove = (moveEvent: globalThis.PointerEvent) => {
        nextWidths = resizeColumnGroups(
          startWidths,
          dividerIndex,
          moveEvent.clientX - startX,
          AUTOMATION_BOARD_LANE_MIN_WIDTH,
        )
        container.style.setProperty(
          '--automation-board-lane-drag-tracks',
          getAutomationBoardLaneTracks(nextWidths),
        )
      }

      const handleStop = () => {
        document.body.classList.remove('is-col-resizing')
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleStop)
        window.removeEventListener('pointercancel', handleStop)
        window.removeEventListener('blur', handleStop)

        // 手指没动过就什么都不提交，连带免掉"点一下也写一次盘"。
        if (nextWidths === startWidths) {
          container.style.removeProperty('--automation-board-lane-drag-tracks')
          return
        }

        // 先提交再撤掉拖拽覆盖：pointerup 是离散事件，React 在这里同步提交，撤掉时
        // 底下那份 React 管的值已经是新的了，不会闪一帧旧比例。
        onSetLaneWidths(toAutomationBoardLaneWidths(nextWidths))
        container.style.removeProperty('--automation-board-lane-drag-tracks')
      }

      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleStop)
      window.addEventListener('pointercancel', handleStop)
      window.addEventListener('blur', handleStop)
    }

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

  /**
   * 粘贴即后台上传，和聊天 composer 同一套语义：本组件随时可能被切走卸载，
   * 只留一个 `File` 在 state 里等到提交的话，切一下 tab 图片就没了。
   */
  const handleDraftPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = collectPastedImageFiles(event.clipboardData?.items ?? null)
    if (files.length === 0) {
      return
    }

    event.preventDefault()

    const entries: PendingComposerAttachment[] = files.map((file) => ({
      kind: 'local',
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
    }))

    setDraftImages((current) => [...current, ...entries])

    for (const entry of entries) {
      void uploadPendingImage(entry)
        .then((uploaded) => {
          setDraftImages(
            (current) =>
              promoteDraftAttachment(
                current,
                entry.id,
                uploaded,
                // 继续用本地 objectURL 当预览：换成 attachment:// 会让缩略图
                // 在上传完成的那一帧闪一下白。
                entry.previewUrl,
              ).next as PendingComposerAttachment[],
          )
        })
        // 上传失败不该吃掉这张图：条目留在 local 态，提交时还会再传一次。
        .catch(() => undefined)
    }
  }

  const removeDraftImage = (attachmentId: string) => {
    setDraftImages((current) => {
      const target = current.find((entry) => entry.id === attachmentId)
      if (target?.kind === 'local') {
        URL.revokeObjectURL(target.previewUrl)
      }
      return current.filter((entry) => entry.id !== attachmentId)
    })
  }

  const submitDraft = () => {
    const trimmed = draft.trim()
    if (!trimmed) {
      return
    }

    // 下架的模型在这里也要走一次回落，否则 select 显示的是"用默认模型"、发出去的
    // 却是那个已经不存在的型号。
    const [provider, model] = resolveModelPickerValue(
      composeDefaults.provider,
      composeDefaults.model,
    ).split('::')
    const options = {
      provider: (provider as Provider) ?? props.defaultProvider,
      model: model ?? '',
      reasoningEffort: normalizeReasoningEffortForModel(
        composeDefaults.provider,
        composeDefaults.model,
        composeDefaults.reasoningEffort,
      ),
      thinkingEnabled: composeDefaults.thinkingEnabled,
      planMode: composeDefaults.planMode,
      adminAccess: composeDefaults.adminAccess,
    }
    const images = draftImages

    setDraft('')
    // 提交出去的文本必须同步从存档里抹掉，否则下次打开这张看板，已经变成项的
    // 那段需求还会原样躺在输入框里。
    commitDraftRef.current('')
    setDraftImages([])

    if (images.length === 0) {
      onCreateItem('standby', trimmed, undefined, options)
      return
    }

    void (async () => {
      // 后台上传大概率已经跑完（uploadPendingImage 对 uploaded 条目是直通），
      // 这里只是把还没传完 / 传失败的补上。
      const uploaded = await Promise.all(
        images.map((entry) => uploadPendingImage(entry).catch(() => null)),
      )

      for (const entry of images) {
        if (entry.kind === 'local') {
          URL.revokeObjectURL(entry.previewUrl)
        }
      }

      onCreateItem('standby', trimmed, undefined, {
        ...options,
        attachments: uploaded.filter((entry): entry is ImageAttachment => entry !== null),
      })
    })()
  }

  return (
    <div className="automation-board">
      {rejectedDrop ? (
        <p className="automation-board-reject" role="status">
          {text.automationBoardCrossWorkspaceRejected}
        </p>
      ) : null}

      {/* 内联只设自定义属性，**绝不**设 grid-template-columns：内联样式压得过
          @container 里的窄档覆盖，两轨 / 竖排档会被永久钉死成三轨。 */}
      <div
        className="automation-board-lanes"
        ref={lanesRef}
        style={{ '--automation-board-lane-tracks': laneTracks } as CSSProperties}
      >
        {/* 分隔条与左侧那条泳道同格（负 margin 落进 8px 的 gap），不占独立轨道：
            布局回归数的就是 gridTemplateColumns 的 token 数，多两条轨会把 3/2/1
            三档断言全打红。 */}
        {laneViews.slice(0, -1).map((laneView, index) => (
          <div
            key={`resize-${laneView.lane}`}
            className="automation-board-lane-resize-handle"
            style={{ gridRow: 1, gridColumn: index + 1 }}
            role="separator"
            aria-orientation="vertical"
            title={text.automationBoardResizeLane}
            onPointerDown={handleLaneResizeStart(index)}
            onDoubleClick={() => onSetLaneWidths(null)}
          />
        ))}
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
                    workspaceAgentCount={Math.max(
                      0,
                      workspaceAgentCardCount -
                        (MODEL_PICKER_HIDDEN_TOOL_MODELS.has(view.card.model) ? 0 : 1),
                    )}
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
                  onBlur={commitDraft}
                  onPaste={handleDraftPaste}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      submitDraft()
                    }
                  }}
                />
                {draftImages.length > 0 ? (
                  <ul className="automation-board-compose-attachments">
                    {draftImages.map((entry) => (
                      <li key={entry.id}>
                        <img src={entry.previewUrl} alt="" />
                        <IconButton
                          label={text.removeAttachment}
                          onClick={() => removeDraftImage(entry.id)}
                        >
                          <CloseIcon />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="automation-board-lane-compose-actions">
                  {/* 模型留在一级：它是这里最高频的一次选择。其余参数收进折叠区，
                      否则待命道底部会被五行控件吃掉半条泳道。 */}
                  <select
                    className="automation-board-compose-model"
                    aria-label={text.automationBoardTemplateModelLabel}
                    value={resolveModelPickerValue(composeDefaults.provider, composeDefaults.model)}
                    onChange={(event) => {
                      const [provider, model] = event.target.value.split('::')
                      const nextProvider = (provider as Provider) ?? props.defaultProvider
                      onSetComposeDefaults({
                        provider: nextProvider,
                        model: model ?? '',
                        reasoningEffort: normalizeReasoningEffortForModel(
                          nextProvider,
                          model ?? '',
                          composeDefaults.reasoningEffort,
                        ),
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
                  <button
                    type="button"
                    className={`automation-board-compose-settings-toggle${composeSettingsOpen ? ' is-open' : ''}${composeDefaults.adminAccess ? ' is-admin' : ''}`}
                    aria-expanded={composeSettingsOpen}
                    title={text.automationBoardComposeSettingsHint}
                    onClick={() => setComposeSettingsOpen((current) => !current)}
                  >
                    {text.automationBoardComposeSettingsLabel}
                    <ChevronDownIcon />
                  </button>
                  <BoardButton tone="primary" onClick={submitDraft} disabled={!draft.trim()}>
                    {text.automationBoardAddRequirement}
                  </BoardButton>
                </div>
                {composeSettingsOpen ? (
                  <div className="automation-board-compose-settings">
                    <AutomationBoardModelSettings
                      value={composeDefaults}
                      language={language}
                      showModel={false}
                      onChange={onSetComposeDefaults}
                    />
                  </div>
                ) : null}
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
