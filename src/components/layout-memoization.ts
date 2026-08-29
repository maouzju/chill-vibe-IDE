import type {
  AppLanguage,
  AutoUrgeProfile,
  BoardColumn,
  ChatCard,
  LocalModelEntry,
  ModelPromptRule,
  PaneNode,
  ProviderStatus,
  RecentWorkspace,
  SessionHistoryEntry,
} from '../../shared/schema'
import { AUTOMATIONBOARD_TOOL_MODEL, GIT_TOOL_MODEL } from '../../shared/models'
import { getAutomationBoard } from '../../shared/default-state'
import type { CardRecoveryStatus } from '../stream-recovery-feedback'
import type { CodexChatSettings } from '../../shared/codex-chat-settings'
import type { QueuedSendSummary } from './deferred-send-queue'

type WorkspaceColumnMemoProps = {
  column: BoardColumn
  providers: Record<string, ProviderStatus>
  language: AppLanguage
  systemPrompt: string
  modelPromptRules?: ModelPromptRule[]
  codexChatSettings?: CodexChatSettings
  crossProviderSkillReuseEnabled: boolean
  musicAlbumCoverEnabled: boolean
  weatherCity: string
  gitAgentModel: string
  brainstormRequestModel: string
  availableQuickToolModels: string[]
  localModelEntries?: LocalModelEntry[]
  autoUrgeEnabled: boolean
  autoUrgeProfiles?: AutoUrgeProfile[]
  autoUrgeMessage: string
  autoUrgeSuccessKeyword: string
  globalUrgeActive: boolean
  globalUrgeProfileId: string
  repeatLoopEnabled?: boolean
  wakeTimerEnabled?: boolean
  recentWorkspaces: RecentWorkspace[]
  sessionHistory: SessionHistoryEntry[]
  cardRecoveryStatuses?: ReadonlyMap<string, CardRecoveryStatus>
  queuedSendSummaries?: ReadonlyMap<string, QueuedSendSummary>
  automationBoardWorkspace?: unknown
  automationBoardActions?: unknown
}

type PaneViewMemoProps = {
  column: BoardColumn
  pane: PaneNode
  automationBoardActions?: unknown
  automationBoardWorkspace?: unknown
  providers: Record<string, ProviderStatus>
  language: AppLanguage
  systemPrompt: string
  modelPromptRules?: ModelPromptRule[]
  codexChatSettings?: CodexChatSettings
  crossProviderSkillReuseEnabled: boolean
  musicAlbumCoverEnabled: boolean
  weatherCity: string
  gitAgentModel: string
  brainstormRequestModel: string
  availableQuickToolModels: string[]
  localModelEntries?: LocalModelEntry[]
  autoUrgeEnabled: boolean
  autoUrgeProfiles?: AutoUrgeProfile[]
  autoUrgeMessage: string
  autoUrgeSuccessKeyword: string
  globalUrgeActive: boolean
  globalUrgeProfileId: string
  repeatLoopEnabled?: boolean
  wakeTimerEnabled?: boolean
  cardRecoveryStatuses?: ReadonlyMap<string, CardRecoveryStatus>
  queuedSendSummaries?: ReadonlyMap<string, QueuedSendSummary>
}

const haveSameSessionHistoryEntries = (
  previousEntries: SessionHistoryEntry[],
  nextEntries: SessionHistoryEntry[],
) => {
  if (previousEntries === nextEntries) {
    return true
  }

  if (previousEntries.length !== nextEntries.length) {
    return false
  }

  for (let index = 0; index < nextEntries.length; index += 1) {
    const previousEntry = previousEntries[index]
    const nextEntry = nextEntries[index]

    if (previousEntry === nextEntry) {
      continue
    }

    if (
      previousEntry?.id !== nextEntry?.id ||
      previousEntry?.title !== nextEntry?.title ||
      previousEntry?.sessionId !== nextEntry?.sessionId ||
      previousEntry?.provider !== nextEntry?.provider ||
      previousEntry?.model !== nextEntry?.model ||
      previousEntry?.workspacePath !== nextEntry?.workspacePath ||
      previousEntry?.archivedAt !== nextEntry?.archivedAt ||
      previousEntry?.messageCount !== nextEntry?.messageCount ||
      previousEntry?.messagesPreview !== nextEntry?.messagesPreview ||
      previousEntry?.messages !== nextEntry?.messages
    ) {
      return false
    }
  }

  return true
}

export const areWorkspaceColumnPropsEqual = (
  previous: WorkspaceColumnMemoProps,
  next: WorkspaceColumnMemoProps,
) =>
  previous.column === next.column &&
  previous.providers === next.providers &&
  previous.language === next.language &&
  previous.systemPrompt === next.systemPrompt &&
  previous.modelPromptRules === next.modelPromptRules &&
  previous.codexChatSettings === next.codexChatSettings &&
  previous.crossProviderSkillReuseEnabled === next.crossProviderSkillReuseEnabled &&
  previous.musicAlbumCoverEnabled === next.musicAlbumCoverEnabled &&
  previous.weatherCity === next.weatherCity &&
  previous.gitAgentModel === next.gitAgentModel &&
  previous.brainstormRequestModel === next.brainstormRequestModel &&
  previous.availableQuickToolModels === next.availableQuickToolModels &&
  previous.localModelEntries === next.localModelEntries &&
  previous.autoUrgeEnabled === next.autoUrgeEnabled &&
  previous.autoUrgeProfiles === next.autoUrgeProfiles &&
  previous.autoUrgeMessage === next.autoUrgeMessage &&
  previous.autoUrgeSuccessKeyword === next.autoUrgeSuccessKeyword &&
  previous.globalUrgeActive === next.globalUrgeActive &&
  previous.globalUrgeProfileId === next.globalUrgeProfileId &&
  previous.repeatLoopEnabled === next.repeatLoopEnabled &&
  previous.wakeTimerEnabled === next.wakeTimerEnabled &&
  previous.recentWorkspaces === next.recentWorkspaces &&
  previous.cardRecoveryStatuses === next.cardRecoveryStatuses &&
  previous.queuedSendSummaries === next.queuedSendSummaries &&
  // 症状（要防的）：模板配置面板里改需求、勾触发器、勾超管权限**全部无效** ——
  //   输入框的值当场被还原，看起来像受控组件写错了（2026-08-11 真实 Electron 实测）。
  // 根因：模板与触发器住在 `state.automationBoards[workspacePath]`，改它**不动**
  //   `column`；这里每一项都相等，于是整棵列子树被挡住，`arePaneViewPropsEqual`
  //   里那条同名比较根本没机会跑 —— 下游测得再对也白搭。
  // 被否决：只在 PaneView 那层比较。链路上任何一层 memo 漏掉这个 prop，下游的
  //   比较就是死代码；凡是"不住在 column 里但要渲染进列"的状态，每一层都得比。
  previous.automationBoardWorkspace === next.automationBoardWorkspace &&
  previous.automationBoardActions === next.automationBoardActions &&
  haveSameSessionHistoryEntries(previous.sessionHistory, next.sessionHistory)

export const cardKeepsPaneRuntimeWhenInactive = (card: Pick<ChatCard, 'model'>) =>
  card.model === GIT_TOOL_MODEL

const haveSameInactivePaneTabChrome = (previous: ChatCard | undefined, next: ChatCard | undefined) =>
  previous === next ||
  (
    previous !== undefined &&
    next !== undefined &&
    previous.id === next.id &&
    previous.title === next.title &&
    previous.provider === next.provider &&
    previous.model === next.model &&
    previous.status === next.status &&
    previous.unread === next.unread &&
    // An untitled tab renders a "waiting to wake" label while sends are queued,
    // so the queue depth is part of the inactive tab chrome.
    (previous.wakeTimerQueuedSends?.length ?? 0) === (next.wakeTimerQueuedSends?.length ?? 0)
  )

/**
 * 症状：看板项在流式输出时看板界面纹丝不动，不活跃的看板 tab 也不变橙。
 * 根因：项卡片刻意"存在于 column.cards 但不在任何 pane.tabs 里"
 *   （见 docs/specs/automation-board/design.md），而 pane 的记忆化只比较
 *   tabs 里的卡片引用加 column.id —— 项卡片的变化对它完全不可见。
 * 被否决：退化成整列比较（previous.column === next.column）。同列里任何一张
 *   无关卡片的 delta 都会重渲染每个 pane，那正是 pitfall 187 的放大路径。
 *   所以只跟看板**自己声明拥有**的那几张卡建立依赖，逐个比引用。
 *
 * 这条检查对活跃与不活跃的看板 tab 都要跑：橙色运行态是从项卡片派生的，
 * 不活跃的 tab 同样需要在项开跑时重渲染。
 */
const haveSameAutomationBoardCardRefs = (
  previous: BoardColumn,
  next: BoardColumn,
  boardCardId: string,
) => {
  const owned = new Set<string>()

  for (const source of [previous.cards[boardCardId], next.cards[boardCardId]]) {
    const board = getAutomationBoard(source)
    if (!board) {
      continue
    }

    for (const item of board.items) {
      owned.add(item.cardId)
    }
  }

  for (const cardId of owned) {
    if (previous.cards[cardId] !== next.cards[cardId]) {
      return false
    }
  }

  return true
}

const haveSamePaneCardRefs = (previous: PaneViewMemoProps, next: PaneViewMemoProps) => {
  if (previous.pane.tabs.length !== next.pane.tabs.length) {
    return false
  }

  for (const tabId of next.pane.tabs) {
    const previousCard = previous.column.cards[tabId]
    const nextCard = next.column.cards[tabId]
    const keepsInactiveRuntime =
      (previousCard !== undefined && cardKeepsPaneRuntimeWhenInactive(previousCard)) ||
      (nextCard !== undefined && cardKeepsPaneRuntimeWhenInactive(nextCard))
    const needsFullCard = tabId === next.pane.activeTabId || keepsInactiveRuntime

    if (
      needsFullCard
        ? previousCard !== nextCard
        : !haveSameInactivePaneTabChrome(previousCard, nextCard)
    ) {
      return false
    }

    if (
      (previousCard?.model === AUTOMATIONBOARD_TOOL_MODEL ||
        nextCard?.model === AUTOMATIONBOARD_TOOL_MODEL) &&
      !haveSameAutomationBoardCardRefs(previous.column, next.column, tabId)
    ) {
      return false
    }

    if (needsFullCard) {
      if (
        (previous.cardRecoveryStatuses?.get(tabId) ?? undefined) !==
        (next.cardRecoveryStatuses?.get(tabId) ?? undefined)
      ) {
        return false
      }

      if (
        (previous.queuedSendSummaries?.get(tabId) ?? undefined) !==
        (next.queuedSendSummaries?.get(tabId) ?? undefined)
      ) {
        return false
      }
    }
  }

  return true
}

export const arePaneViewPropsEqual = (previous: PaneViewMemoProps, next: PaneViewMemoProps) =>
  previous.automationBoardWorkspace === next.automationBoardWorkspace &&
  previous.automationBoardActions === next.automationBoardActions &&
  previous.pane === next.pane &&
  previous.column.id === next.column.id &&
  previous.column.workspacePath === next.column.workspacePath &&
  previous.providers === next.providers &&
  previous.language === next.language &&
  previous.systemPrompt === next.systemPrompt &&
  previous.modelPromptRules === next.modelPromptRules &&
  previous.codexChatSettings === next.codexChatSettings &&
  previous.crossProviderSkillReuseEnabled === next.crossProviderSkillReuseEnabled &&
  previous.musicAlbumCoverEnabled === next.musicAlbumCoverEnabled &&
  previous.weatherCity === next.weatherCity &&
  previous.gitAgentModel === next.gitAgentModel &&
  previous.brainstormRequestModel === next.brainstormRequestModel &&
  previous.availableQuickToolModels === next.availableQuickToolModels &&
  previous.localModelEntries === next.localModelEntries &&
  previous.autoUrgeEnabled === next.autoUrgeEnabled &&
  previous.autoUrgeProfiles === next.autoUrgeProfiles &&
  previous.autoUrgeMessage === next.autoUrgeMessage &&
  previous.autoUrgeSuccessKeyword === next.autoUrgeSuccessKeyword &&
  previous.globalUrgeActive === next.globalUrgeActive &&
  previous.globalUrgeProfileId === next.globalUrgeProfileId &&
  previous.repeatLoopEnabled === next.repeatLoopEnabled &&
  previous.wakeTimerEnabled === next.wakeTimerEnabled &&
  haveSamePaneCardRefs(previous, next)
