import type {
  AppLanguage,
  AutoUrgeProfile,
  BoardColumn,
  ModelPromptRule,
  PaneNode,
  ProviderStatus,
  RecentWorkspace,
  SessionHistoryEntry,
} from '../../shared/schema'

type WorkspaceColumnMemoProps = {
  column: BoardColumn
  providers: Record<string, ProviderStatus>
  language: AppLanguage
  systemPrompt: string
  modelPromptRules?: ModelPromptRule[]
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
  recentWorkspaces: RecentWorkspace[]
  sessionHistory: SessionHistoryEntry[]
}

type PaneViewMemoProps = {
  column: BoardColumn
  pane: PaneNode
  providers: Record<string, ProviderStatus>
  language: AppLanguage
  systemPrompt: string
  modelPromptRules?: ModelPromptRule[]
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
  flashCardIds: Set<string>
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
  previous.recentWorkspaces === next.recentWorkspaces &&
  haveSameSessionHistoryEntries(previous.sessionHistory, next.sessionHistory)

const haveSamePaneCardRefs = (previous: PaneViewMemoProps, next: PaneViewMemoProps) => {
  if (previous.pane.tabs.length !== next.pane.tabs.length) {
    return false
  }

  for (const tabId of next.pane.tabs) {
    if (previous.column.cards[tabId] !== next.column.cards[tabId]) {
      return false
    }

    if (previous.flashCardIds.has(tabId) !== next.flashCardIds.has(tabId)) {
      return false
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
  haveSamePaneCardRefs(previous, next)
