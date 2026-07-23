import type {
  AppLanguage,
  AutoUrgeProfile,
  BoardColumn,
  ChatCard,
  ModelPromptRule,
  PaneNode,
  ProviderStatus,
  RecentWorkspace,
  SessionHistoryEntry,
} from '../../shared/schema'
import { GIT_TOOL_MODEL } from '../../shared/models'
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
  autoUrgeEnabled: boolean
  autoUrgeProfiles?: AutoUrgeProfile[]
  autoUrgeMessage: string
  autoUrgeSuccessKeyword: string
  globalUrgeActive: boolean
  globalUrgeProfileId: string
  recentWorkspaces: RecentWorkspace[]
  sessionHistory: SessionHistoryEntry[]
  cardRecoveryStatuses?: ReadonlyMap<string, CardRecoveryStatus>
  queuedSendSummaries?: ReadonlyMap<string, QueuedSendSummary>
}

type PaneViewMemoProps = {
  column: BoardColumn
  pane: PaneNode
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
  autoUrgeEnabled: boolean
  autoUrgeProfiles?: AutoUrgeProfile[]
  autoUrgeMessage: string
  autoUrgeSuccessKeyword: string
  globalUrgeActive: boolean
  globalUrgeProfileId: string
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
  previous.autoUrgeEnabled === next.autoUrgeEnabled &&
  previous.autoUrgeProfiles === next.autoUrgeProfiles &&
  previous.autoUrgeMessage === next.autoUrgeMessage &&
  previous.autoUrgeSuccessKeyword === next.autoUrgeSuccessKeyword &&
  previous.globalUrgeActive === next.globalUrgeActive &&
  previous.globalUrgeProfileId === next.globalUrgeProfileId &&
  previous.recentWorkspaces === next.recentWorkspaces &&
  previous.cardRecoveryStatuses === next.cardRecoveryStatuses &&
  previous.queuedSendSummaries === next.queuedSendSummaries &&
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
    previous.unread === next.unread
  )

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
  previous.autoUrgeEnabled === next.autoUrgeEnabled &&
  previous.autoUrgeProfiles === next.autoUrgeProfiles &&
  previous.autoUrgeMessage === next.autoUrgeMessage &&
  previous.autoUrgeSuccessKeyword === next.autoUrgeSuccessKeyword &&
  previous.globalUrgeActive === next.globalUrgeActive &&
  previous.globalUrgeProfileId === next.globalUrgeProfileId &&
  haveSamePaneCardRefs(previous, next)
