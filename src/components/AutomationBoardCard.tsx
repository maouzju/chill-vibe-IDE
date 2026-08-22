import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ButtonHTMLAttributes,
  ClipboardEvent,
  CSSProperties,
  DragEvent,
  KeyboardEvent,
  PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'

import { getLocaleText, getSlashCommandSourceLabel } from '../../shared/i18n'
import { getLocalSlashCommands, getSlashCompletionQuery } from '../../shared/slash-commands'
import {
  MODEL_OPTIONS,
  MODEL_PICKER_HIDDEN_TOOL_MODELS,
  isModelPickerOptionVisible,
} from '../../shared/models'
import {
  getReasoningOptionsForModel,
  isClaudeAlwaysThinkingModel,
  normalizeReasoningEffortForModel,
  shouldEnableThinkingForDepthChange,
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
  SlashCommand,
} from '../../shared/schema'
import { fetchSlashCommands } from '../api'
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
  PencilIcon,
  PlayIcon,
  RefreshIcon,
  ShieldIcon,
  StickyNoteIcon,
  StopIcon,
  TrashIcon,
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
  canSubmitAutomationBoardDraft,
  collectAutomationBoardRunningCardIds,
  insertNewlineIntoDraft,
  resolveAutomationBoardItemStatusClass,
  resolveNextAutomationBoardRunningCardId,
  type AutomationBoardItemView,
} from './automation-board-view'
import { WakeTimerSettingsPanel } from './WakeTimerSettingsPanel'
import {
  applyAutomationBoardSlashCompletion,
  filterAutomationBoardSlashCommands,
} from './automation-board-slash-commands'

/**
 * Ctrl+回车在需求框里插一个换行。
 *
 * 症状（要防的）：先同步 setState 再用 rAF 把光标挪回去，Playwright 里下一个
 *   字符（真人快速连打同理）会落在被弹到末尾的旧光标处，打出「第一行\n二行第」。
 * 根因：受控 textarea 被 React 重设 value 后光标归零/到末尾，rAF 的修正晚了一帧。
 * 被否决：只留 rAF —— 换行本身是对的，错的是那一帧的空窗，掩盖不掉。
 * 现在先同步写回 DOM 再提交 state：React commit 时发现 value 与 DOM 相同就不重设，
 * 光标全程没被动过。
 */
const applyCtrlEnterNewline = (
  textarea: HTMLTextAreaElement,
  commit: (value: string) => void,
) => {
  const next = insertNewlineIntoDraft(
    textarea.value,
    textarea.selectionStart,
    textarea.selectionEnd,
  )
  textarea.value = next.value
  textarea.selectionStart = next.caret
  textarea.selectionEnd = next.caret
  commit(next.value)
}

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
  crossProviderSkillReuseEnabled?: boolean
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
  /** 清空整条泳道（项与会话卡一起删）。确认弹窗在本组件里，不在 App 层。 */
  onClearLane: (lane: AutomationBoardLane) => void
  /** 将点击瞬间的全部待命项逐个交给既有单项开跑路径。 */
  onRunAllStandby: (cardIds: string[]) => void
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

      {/* 深度不再被思考开关 disable —— 理由与"碰深度即开思考"的判据都在
          `shouldEnableThinkingForDepthChange` 上方。关着思考时仍要标出来，
          因为那一档确实还没生效。
          pointerdown/keydown 也挂一份，是因为 `onChange` 只在值真的变了时才发：
          用户想选的恰好是屏幕上灰着的那一档时，一个事件都不会有（与 ChatCard
          同一处修复）。这边 onChange 走的是幂等 patch，两条路都留着不会互相抵消。 */}
      <label className="automation-board-template-field">
        <span>{text.thinkingDepthLabel}</span>
        <select
          className={`reasoning-select${thinkingOn ? '' : ' is-thinking-off'}`}
          value={reasoningValue}
          title={thinkingOn ? undefined : text.thinkingDepthInactiveHint}
          onPointerDown={() => {
            if (shouldEnableThinkingForDepthChange(value.thinkingEnabled, alwaysThinking)) {
              onChange({ thinkingEnabled: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Tab' || event.key === 'Escape') {
              return
            }
            if (shouldEnableThinkingForDepthChange(value.thinkingEnabled, alwaysThinking)) {
              onChange({ thinkingEnabled: true })
            }
          }}
          onChange={(event) =>
            onChange({
              reasoningEffort: event.target.value,
              ...(shouldEnableThinkingForDepthChange(value.thinkingEnabled, alwaysThinking)
                ? { thinkingEnabled: true }
                : {}),
            })
          }
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
    if (event.key !== 'Enter') {
      return
    }
    // Ctrl+回车换行：这里也是"写需求"的地方，与新建需求框和聊天 composer 同一套手感。
    if (event.ctrlKey) {
      event.preventDefault()
      applyCtrlEnterNewline(event.currentTarget, onNudgeChange)
      return
    }
    if (event.shiftKey) {
      return
    }
    event.preventDefault()
    onNudgeSubmit()
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
      <label className="automation-board-template-field is-name">
        <span>{text.automationBoardTemplateNameLabel}</span>
        <input
          type="text"
          value={template.name}
          onChange={(event) => onUpdateTemplate(template.id, { name: event.target.value })}
        />
      </label>

      {/* 症状：面板里 8 个控件全是平铺的同号 11px 行，双栏下还被 grid 按文档序
          随手劈开（「思考」落左栏、「思考深度」落右栏，中间隔着 600px 空白）。
          根因：容器只有一层 flex/grid，没有任何"哪几行属于同一件事"的结构，
          所以布局引擎无从知道该把谁和谁绑在一起。
          现在按语义分成三组，双栏时用 grid-template-areas 让整组落位 —— 被否决的
          方案是继续单栏（宽看板下需求 textarea 会被拉到 1300px，右边全空）。 */}
      <div className="automation-board-template-group is-requirement">
        {/* 分组前这里是 `<label><span>需求</span><textarea/></label>`，包裹关系自带
            无障碍名。拆成 h5 + textarea 之后那层关系没了，屏幕阅读器读到的是一个
            匿名多行框 —— 显式接回来，别指望后来人只用 `locator('textarea')` 兜着。 */}
        <h5
          className="automation-board-template-group-title"
          id={`automation-board-template-requirement-${template.id}`}
        >
          {text.automationBoardTemplateRequirementLabel}
        </h5>
        <textarea
          aria-labelledby={`automation-board-template-requirement-${template.id}`}
          value={template.requirement}
          rows={4}
          onChange={(event) => onUpdateTemplate(template.id, { requirement: event.target.value })}
          onKeyDown={(event) => {
            // 这个框普通回车本来就换行，但从聊天 composer 养成的手是 Ctrl+回车 ——
            // 按下去一点反应都没有，用户只会以为输入框坏了。
            if (event.key !== 'Enter' || !event.ctrlKey) {
              return
            }
            event.preventDefault()
            applyCtrlEnterNewline(event.currentTarget, (requirement) =>
              onUpdateTemplate(template.id, { requirement }),
            )
          }}
        />
      </div>

      {/* 模板 schema 一直存着 reasoningEffort / thinkingEnabled / planMode，v2.3
          之前只有模型和超管两行有入口 —— 存了却配不了等于存了个死值。 */}
      {/* 分组是给人看的语义边界，也得让辅助技术知道 —— 这两组里的控件自己都带
          label，缺的只是"我属于哪一组"。 */}
      <div
        className="automation-board-template-group is-execution"
        role="group"
        aria-labelledby={`automation-board-template-execution-${template.id}`}
      >
        <h5
          className="automation-board-template-group-title"
          id={`automation-board-template-execution-${template.id}`}
        >
          {text.automationBoardTemplateExecutionLabel}
        </h5>
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
        {/* 超管说明只在开着时留在版面上。关着时它是"这个开关是干嘛的"的解释，
            按 ui-principles「Explanatory copy is idle chrome」应该退到 hover；
            开着时它描述的是一个已生效的越权范围，属于 live state，必须常驻。 */}
        {template.adminAccess ? (
          <p className="automation-board-template-hint is-admin-warning">
            {text.automationBoardTemplateAdminAccessHint}
          </p>
        ) : null}
      </div>

      <div
        className="automation-board-template-group is-trigger automation-board-template-trigger"
        role="group"
        aria-labelledby={`automation-board-template-trigger-${template.id}`}
      >
        <h5
          className="automation-board-template-group-title"
          id={`automation-board-template-trigger-${template.id}`}
          title={text.automationBoardTriggerHint}
        >
          {text.automationBoardTriggerLabel}
        </h5>

        <label className="automation-board-template-field">
          <input
            type="checkbox"
            className="composer-settings-checkbox"
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
            className="reasoning-select"
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const localSlashCommands = useMemo(() => getLocalSlashCommands(language), [language])
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(localSlashCommands)
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(true)
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0)
  // 症状：上次打了一半的 `/re` 随 board.draft 落了盘，重启应用、或切走再切回这张
  //   看板卡，用户什么都没做，一个补全面板就凭空浮在界面上（2026-08-22 实测）。
  // 根因：slashMenuOpen 只看 draft 的文本形状，而 draft 初值就取自持久化草稿 ——
  //   组件一挂载 slashQuery 就非 null，dismissed 还是 false，于是直接开着。
  // 为什么不能改成挂载时清掉 draft：草稿持久化是刻意设计（见上面 965 行那段），
  //   要压的是"自动弹菜单"这件事，不是那段没写完的需求。补全菜单只应该由用户
  //   这一次的输入触发，恢复草稿不算输入（onChange 里 query 一变就会解除）。
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(
    () => getSlashCompletionQuery(board.draft ?? '') !== null,
  )
  const [slashMenuStyle, setSlashMenuStyle] = useState<CSSProperties>({ display: 'none' })
  const composeRef = useRef<HTMLDivElement | null>(null)
  const slashMenuElRef = useRef<HTMLDivElement | null>(null)
  // 待命草稿的粘贴图片。需求经常本身就是一张截图，只能打字等于逼用户先建卡
  // 再去卡里粘一遍。
  const [draftImages, setDraftImages] = useState<PendingComposerAttachment[]>([])
  const [dropLane, setDropLane] = useState<AutomationBoardLane | null>(null)
  const [rejectedDrop, setRejectedDrop] = useState(false)
  // 同时只展开一个模板的配置面板：模板条是横向滚动的一行，两个面板同时展开
  // 会把看板下半截全吃掉。
  const [expandedTemplateId, setExpandedTemplateId] = useState<string | null>(null)
  // 改名原本走 `window.prompt`。在 Electron 里那是一个系统模态弹窗：它会抢走整个
  // 窗口的焦点、阻塞渲染进程，外观也完全不受主题控制（暗色下依然是白底灰边）。
  // 就地把胶囊上的名字换成输入框，与 ChatCard 的标题改名同一套交互。
  const [renamingTemplateId, setRenamingTemplateId] = useState<string | null>(null)
  const [renamingValue, setRenamingValue] = useState('')
  const rejectionTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!workspacePath.trim()) return
    let cancelled = false
    void fetchSlashCommands({
      provider: composeDefaults.provider,
      workspacePath,
      language,
      crossProviderSkillReuseEnabled: props.crossProviderSkillReuseEnabled === true,
    }).then((commands) => {
      if (!cancelled) setSlashCommands(commands.length > 0 ? commands : localSlashCommands)
    }).catch(() => {
      if (!cancelled) setSlashCommands(localSlashCommands)
    }).finally(() => {
      if (!cancelled) setSlashCommandsLoading(false)
    })
    return () => { cancelled = true }
  }, [composeDefaults.provider, language, localSlashCommands, props.crossProviderSkillReuseEnabled, workspacePath])

  const slashQuery = getSlashCompletionQuery(draft)
  const filteredSlashCommands = useMemo(
    () => filterAutomationBoardSlashCommands(draft, slashCommands),
    [draft, slashCommands],
  )
  const activeSlashIndex = filteredSlashCommands.length === 0
    ? 0
    : Math.min(selectedSlashIndex, filteredSlashCommands.length - 1)
  const slashMenuOpen = draftImages.length === 0 && slashQuery !== null && !slashMenuDismissed
  const highlightedSlashCommand = filteredSlashCommands[activeSlashIndex] ?? null

  useEffect(() => {
    if (!slashMenuOpen) return
    const updatePosition = () => {
      const rect = textareaRef.current?.getBoundingClientRect()
      if (!rect) return
      setSlashMenuStyle({
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${Math.max(8, rect.top - 320)}px`,
        width: `${rect.width}px`,
        maxHeight: `${Math.max(120, Math.min(300, rect.top - 16))}px`,
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [slashMenuOpen])

  // 症状：打出 `/re` 弹出菜单后点旁边任意一张卡，菜单不关，继续以 position:fixed
  //   浮在窗口上挡内容、还自己吃掉 onMouseDown；只有把焦点弄回 textarea 再按
  //   Escape 才关得掉（2026-08-22 实测）。
  // 根因：唯一能置 slashMenuDismissed 的入口是 textarea 自己 keydown 里的 Escape，
  //   而菜单 createPortal 到 document.body —— 焦点一离开 textarea 就再也按不到它。
  //   这一整套是从 ChatCard 抄过来的，恰好漏掉了它那段全局 mousedown/Escape。
  // 为什么不能改用 textarea 的 onBlur 关：菜单项本身就是按钮，点它必然先 blur，
  //   blur 关菜单等于任何一条补全都点不中。
  useEffect(() => {
    if (!slashMenuOpen) return
    const handleClickOutside = (event: Event) => {
      const target = event.target as Node
      if (
        slashMenuElRef.current
        && !slashMenuElRef.current.contains(target)
        && !composeRef.current?.contains(target)
      ) {
        setSlashMenuDismissed(true)
      }
    }
    const handleEscape = (event: Event) => {
      if ((event as globalThis.KeyboardEvent).key === 'Escape') {
        setSlashMenuDismissed(true)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [slashMenuOpen])

  const applySlashCommand = (command: SlashCommand) => {
    const nextDraft = applyAutomationBoardSlashCompletion(command)
    setDraft(nextDraft)
    setSelectedSlashIndex(0)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const expandedTemplate = templates.find((entry) => entry.id === expandedTemplateId)

  const startRename = (template: AutomationBoardTemplate) => {
    setRenamingValue(template.name)
    setRenamingTemplateId(template.id)
  }

  // 空名字不提交：模板条在名字为空时回退到显示需求原文，一个"看起来还在、
  // 但改名钮再也定位不到它"的胶囊比拒绝提交更难解释。
  const commitRename = (templateId: string) => {
    const next = renamingValue.trim()
    if (next) onRenameTemplate(templateId, next)
    setRenamingTemplateId(null)
  }

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

  // 每条泳道此刻真的在跑的项。口径见 collectAutomationBoardRunningCardIds。
  const runningCardIdsByLane = useMemo(() => {
    const entries: Record<AutomationBoardLane, string[]> = { standby: [], running: [], done: [] }
    for (const laneView of laneViews) {
      entries[laneView.lane] = collectAutomationBoardRunningCardIds(laneView.items)
    }
    return entries
  }, [laneViews])

  const lanesRef = useRef<HTMLDivElement | null>(null)
  /** 逐个定位的游标：记 cardId 而不是下标，理由见 resolveNextAutomationBoardRunningCardId。 */
  const runningLocatorCursorRef = useRef<string | null>(null)
  const runningLocatorTimerRef = useRef<number | null>(null)

  /**
   * 点一下泳道头的"N 在跑"，跳到下一个正在跑的项并短暂高亮。
   *
   * 高亮走命令式 classList 而不是 React state：state 会让整条泳道重渲染，
   * 而这里最多的时候有二十几张项卡片，每张都要重跑 markdown 解析
   * （AGENTS.md pitfall 187 就是这么被拖死的）。React 只有在 className
   * 字符串本身变了才会写 DOM，所以它不会来抢这个 class；真被抢走也只发生在
   * 那张卡状态刚好变了的时候——那时高亮消失本来就是对的。
   */
  const locateNextRunningItem = (runningCardIds: readonly string[]) => {
    const nextCardId = resolveNextAutomationBoardRunningCardId(
      runningCardIds,
      runningLocatorCursorRef.current,
    )
    if (!nextCardId) {
      return
    }

    runningLocatorCursorRef.current = nextCardId
    const target = lanesRef.current?.querySelector<HTMLElement>(
      `[data-automation-board-item-id="${nextCardId}"]`,
    )
    if (!target) {
      return
    }

    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    if (runningLocatorTimerRef.current !== null) {
      window.clearTimeout(runningLocatorTimerRef.current)
    }
    lanesRef.current
      ?.querySelectorAll('.automation-board-item.is-locating')
      .forEach((element) => element.classList.remove('is-locating'))
    target.classList.add('is-locating')
    runningLocatorTimerRef.current = window.setTimeout(() => {
      target.classList.remove('is-locating')
      runningLocatorTimerRef.current = null
    }, 1400)
  }

  useEffect(
    () => () => {
      if (runningLocatorTimerRef.current !== null) {
        window.clearTimeout(runningLocatorTimerRef.current)
      }
    },
    [],
  )

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
    if (!canSubmitAutomationBoardDraft(draft, draftImages.length)) {
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
              {/* "23 项"里有几个还真的在跑，是走开前唯一想知道的数字；总数天天在那儿
                  堆着，看不出来。计数本身就是定位器，点一下往下一个跑着的项跳。 */}
              {runningCardIdsByLane[laneView.lane].length > 0 ? (
                <button
                  type="button"
                  className="automation-board-lane-running"
                  data-automation-board-running-locator={laneView.lane}
                  title={text.automationBoardLocateRunningHint}
                  onClick={() => locateNextRunningItem(runningCardIdsByLane[laneView.lane])}
                >
                  <span className="automation-board-lane-running-dot" aria-hidden="true" />
                  {text.automationBoardRunningCount(runningCardIdsByLane[laneView.lane].length)}
                </button>
              ) : null}
              {laneView.lane === 'standby' && laneView.items.length > 0 ? (
                <button
                  type="button"
                  className="automation-board-lane-run-all"
                  onClick={() => props.onRunAllStandby(laneView.items.map((view) => view.card.id))}
                >
                  {text.automationBoardRunAllStandbyAction}
                </button>
              ) : null}
              {/* 只有已完成道能清空：待命/执行中的项还在编排里，批量删它们
                  没有对应的用户意图，而已完成道是纯粹的堆积区。 */}
              {laneView.lane === 'done' && laneView.items.length > 0 ? (
                <IconButton
                  label={text.automationBoardClearLaneAction}
                  className="automation-board-lane-clear"
                  onClick={() => {
                    // 单项删除没有确认，但这一下会一次带走几十张卡（会话归档进历史，
                    // 不是真删），与 FileTreeCard 删文件同一条规矩：先问一次。
                    if (
                      window.confirm(text.automationBoardClearLaneConfirm(laneView.items.length))
                    ) {
                      props.onClearLane(laneView.lane)
                    }
                  }}
                >
                  <TrashIcon />
                </IconButton>
              ) : null}
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
              <div className="automation-board-lane-compose" ref={composeRef}>
                <textarea
                  ref={textareaRef}
                  value={draft}
                  rows={2}
                  placeholder={text.automationBoardNewRequirementPlaceholder}
                  onChange={(event) => {
                    const nextDraft = event.target.value
                    if (getSlashCompletionQuery(nextDraft) !== slashQuery) {
                      setSlashMenuDismissed(false)
                      setSelectedSlashIndex(0)
                    }
                    setDraft(nextDraft)
                  }}
                  onBlur={commitDraft}
                  onPaste={handleDraftPaste}
                  onKeyDown={(event) => {
                    // 排在 slash 菜单之前：用户按住 Ctrl 打回车是明确要换行，
                    // 这时候把菜单高亮项补全进去是抢答。
                    if (event.key === 'Enter' && event.ctrlKey) {
                      event.preventDefault()
                      applyCtrlEnterNewline(event.currentTarget, setDraft)
                      return
                    }
                    if (slashMenuOpen) {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setSlashMenuDismissed(true)
                        return
                      }
                      if (event.key === 'ArrowDown' && filteredSlashCommands.length > 0) {
                        event.preventDefault()
                        setSelectedSlashIndex((current) => (current + 1) % filteredSlashCommands.length)
                        return
                      }
                      if (event.key === 'ArrowUp' && filteredSlashCommands.length > 0) {
                        event.preventDefault()
                        setSelectedSlashIndex((current) => current === 0 ? filteredSlashCommands.length - 1 : current - 1)
                        return
                      }
                      if ((event.key === 'Tab' || event.key === 'Enter') && highlightedSlashCommand) {
                        event.preventDefault()
                        applySlashCommand(highlightedSlashCommand)
                        return
                      }
                    }
                    // 普通回车提交；Shift+回车走 textarea 自带的换行，Ctrl+回车在上面。
                    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) {
                      event.preventDefault()
                      submitDraft()
                    }
                  }}
                />
                {slashMenuOpen && typeof document !== 'undefined' ? createPortal(
                  <div
                    ref={slashMenuElRef}
                    className="slash-command-menu automation-board-slash-command-menu"
                    role="listbox"
                    aria-label={text.slashCommands}
                    style={slashMenuStyle}
                  >
                    {filteredSlashCommands.length > 0 ? filteredSlashCommands.map((command, index) => (
                      <button
                        key={`${command.source}:${command.name}`}
                        type="button"
                        className={`slash-command-item${index === activeSlashIndex ? ' is-selected' : ''}`}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          applySlashCommand(command)
                        }}
                      >
                        <span className="slash-command-header">
                          <span className="slash-command-name">/{command.name}</span>
                          <span className="slash-command-badges">
                            <span className={`slash-command-badge is-${command.source}`}>
                              {getSlashCommandSourceLabel(language, command.source)}
                            </span>
                            {command.source === 'skill' && command.skillProvider ? (
                              <span className={`slash-command-badge is-provider-${command.skillProvider}`}>
                                {command.skillProvider === 'codex' ? 'Codex' : 'Claude'}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <span className="slash-command-description">{command.description ?? `/${command.name}`}</span>
                      </button>
                    )) : (
                      <div className="slash-command-empty">
                        {slashCommandsLoading ? text.loadingSlashCommands : text.noMatchingSlashCommands}
                      </div>
                    )}
                  </div>,
                  document.body,
                ) : null}
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
                  <BoardButton
                    tone="primary"
                    onClick={submitDraft}
                    disabled={!canSubmitAutomationBoardDraft(draft, draftImages.length)}
                  >
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
                className={`automation-board-template${expandedTemplateId === template.id ? ' is-expanded' : ''}${renamingTemplateId === template.id ? ' is-renaming' : ''}`}
                // 改名时必须停掉拖拽：胶囊本身是拖到泳道用的拖源，`draggable` 的
                // 祖先会吃掉输入框里的选词与光标拖动，用户看到的是"框里选不中字"。
                draggable={renamingTemplateId !== template.id}
                onDragStart={(event) => {
                  writeDragPayload(event, {
                    type: 'automation-board-template',
                    workspacePath,
                    templateId: template.id,
                  })
                }}
                onDragEnd={() => clearDragPayload()}
                title={renamingTemplateId === template.id ? undefined : template.requirement}
              >
                {renamingTemplateId === template.id ? (
                  <input
                    className="automation-board-template-name-input"
                    value={renamingValue}
                    autoFocus
                    aria-label={text.automationBoardTemplateNamePrompt}
                    onChange={(event) => setRenamingValue(event.target.value)}
                    onBlur={() => commitRename(template.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commitRename(template.id)
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        setRenamingTemplateId(null)
                      }
                    }}
                  />
                ) : (
                  <span
                    className="automation-board-template-name"
                    onDoubleClick={() => startRename(template)}
                  >
                    {template.name || template.requirement}
                  </span>
                )}
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
                {/* 改名与删除是低频操作，静息时收起来（CSS 控制），只留展开钮。
                    RefreshIcon 曾经当改名图标用 —— 一个循环箭头读起来是"重来 /
                    重置"，与"改个名字"完全不搭；删除同理，✕ 在这个应用里到处
                    都是"关闭"。 */}
                <IconButton
                  label={text.automationBoardTemplateRenameAction}
                  className="automation-board-template-rename"
                  onClick={() => startRename(template)}
                >
                  <PencilIcon />
                </IconButton>
                <IconButton
                  label={text.automationBoardTemplateDeleteAction}
                  className="automation-board-template-delete"
                  tone="danger"
                  onClick={() => onDeleteTemplate(template.id)}
                >
                  <TrashIcon />
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
