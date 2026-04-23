import { createDefaultState, createMessage, getOrderedColumnCards } from '../shared/default-state'
import type {
  AppLanguage,
  AppState,
  BoardColumn,
  ChatMessage,
  Provider,
  StreamActivity,
  StreamAssistantMessage,
} from '../shared/schema'
import { getLocaleText } from '../shared/i18n'
import type { ChatStreamSource } from './api'

export type LoadStatus = 'loading' | 'ready' | 'error'
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export type ActiveStream = {
  cardId: string
  streamId: string
  provider: Provider
  source: ChatStreamSource
  assistantMessageId?: string
}

export type OnboardingStage = 'loading' | 'setup' | 'import' | 'complete'
export type OnboardingImportState = 'idle' | 'imported' | 'skipped'

export type ProfileDraft = {
  name: string
  baseUrl: string
  apiKey: string
}

export type StoppedRunReason = 'manual' | 'user-interrupt'

export const emptyProfileDraft = (): ProfileDraft => ({
  name: '',
  baseUrl: '',
  apiKey: '',
})

export const onboardingStorageKey = 'chill-vibe:onboarding:v1'
export const onboardingLanguages = [
  { value: 'zh-CN' as const, flag: '\u{1F1E8}\u{1F1F3}', label: '\u4E2D\u6587' },
  { value: 'en' as const, flag: '\u{1F1FA}\u{1F1F8}', label: 'English' },
] as const

export const getAgentDoneSoundUrl = (baseUrl?: string) => {
  const resolvedBaseUrl =
    baseUrl ??
    (typeof import.meta !== 'undefined' && typeof import.meta.env?.BASE_URL === 'string'
      ? import.meta.env.BASE_URL
      : '/')

  return `${resolvedBaseUrl.endsWith('/') ? resolvedBaseUrl : `${resolvedBaseUrl}/`}agent-done.wav`
}

export const readFileAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Unable to read the selected file.'))
        return
      }

      const commaIndex = reader.result.indexOf(',')
      resolve(commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result)
    }

    reader.onerror = () => {
      reject(new Error('Unable to read the selected file.'))
    }

    reader.readAsDataURL(file)
  })

export const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

export const getColumnById = <T extends Pick<BoardColumn, 'id'>>(columns: T[], columnId: string) =>
  columns.find((column) => column.id === columnId)

export const importErrorMessage = (error: unknown, fallback: string, tooLargeFallback: string) => {
  const message = errorMessage(error, fallback)
  return /cc-switch export is too large|payload is too large|entity too large/i.test(message)
    ? tooLargeFallback
    : message
}

export const getRoutingImportText = (language: AppState['settings']['language']) =>
  language === 'en'
    ? {
        importSummary: (
          source: string,
          total: number,
          claudeCount: number,
          codexCount: number,
          addedCount: number,
          updatedCount: number,
        ) =>
          `Imported ${total} profiles from ${source} (Claude ${claudeCount}, Codex ${codexCount}). Added ${addedCount}, updated ${updatedCount}.`,
        importError: 'Unable to import cc-switch routing settings.',
        importTooLarge:
          'That cc-switch export is too large to upload. Use "Import default db" or choose a smaller SQL export.',
      }
    : {
        importSummary: (
          source: string,
          total: number,
          claudeCount: number,
          codexCount: number,
          addedCount: number,
          updatedCount: number,
        ) =>
          `已从 ${source} 导入 ${total} 个配置（Claude ${claudeCount}，Codex ${codexCount}）。新增 ${addedCount} 个，更新 ${updatedCount} 个。`,
        importError: '无法导入 cc-switch 路由配置。',
        importTooLarge:
          '所选 cc-switch 导出文件太大，无法上传。请使用"导入默认数据库"或选择更小的 SQL 导出文件。',
      }

export const isFirstOpenState = (state: AppState) => {
  const providerProfiles = state.settings.providerProfiles
  const hasProfiles =
    providerProfiles.claude.profiles.length > 0 ||
    providerProfiles.codex.profiles.length > 0 ||
    Boolean(providerProfiles.claude.activeProfileId) ||
    Boolean(providerProfiles.codex.activeProfileId)
  if (hasProfiles || state.columns.length !== 2) {
    return false
  }
  const [developmentColumn, reviewColumn] = state.columns
  if (!developmentColumn || !reviewColumn) {
    return false
  }
  const expectedState = createDefaultState(developmentColumn.workspacePath, state.settings.language)
  const expectedTitles = [
    new Set([expectedState.columns[0]?.title, '\u5F00\u53D1\u9891\u9053'].filter(Boolean)),
    new Set([expectedState.columns[1]?.title, '\u8BC4\u5BA1\u9891\u9053'].filter(Boolean)),
  ]
  const matchesDefaultLayout = state.columns.every((column, columnIndex) => {
    const expectedColumn = expectedState.columns[columnIndex]
    if (!expectedColumn) {
      return false
    }
    const cards = getOrderedColumnCards(column)
    const expectedCards = getOrderedColumnCards(expectedColumn)
    if (
      column.provider !== expectedColumn.provider ||
      column.workspacePath !== expectedColumn.workspacePath ||
      column.model !== expectedColumn.model ||
      cards.length !== expectedCards.length ||
      !expectedTitles[columnIndex]?.has(column.title)
    ) {
      return false
    }
    return cards.every((card, cardIndex) => {
      const expectedCard = expectedCards[cardIndex]
      return Boolean(expectedCard) && (
        card.title === expectedCard.title &&
        card.provider === expectedCard.provider &&
        card.model === expectedCard.model &&
        card.reasoningEffort === expectedCard.reasoningEffort &&
        card.size === expectedCard.size
      )
    })
  })
  const allCardsIdle = state.columns.every((column) =>
    getOrderedColumnCards(column).every(
      (card) => card.status === 'idle' && card.messages.length === 0 && !card.draft.trim() && !card.sessionId,
    ),
  )
  return matchesDefaultLayout && allCardsIdle
}

export const createLogMessages = (provider: Provider, message: string) => {
  const normalized = message
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .trim()

  if (!normalized) {
    return []
  }

  return [
    createMessage('system', normalized, {
      kind: 'log',
      provider,
    }),
  ]
}

export const createStoppedRunMessage = (
  language: AppLanguage,
  reason: StoppedRunReason = 'manual',
): ChatMessage =>
  createMessage(
    'system',
    reason === 'user-interrupt' ? getLocaleText(language).userInterrupted : getLocaleText(language).runStopped,
    {
      kind: 'run-stopped',
      stopReason: reason,
    },
  )

export const createStructuredMessageId = (provider: Provider, streamId: string, itemId: string) =>
  `${provider}:${streamId}:item:${itemId}`

const getStructuredMessageKey = (payload: StreamActivity | StreamAssistantMessage) => {
  if ('content' in payload) {
    return payload.itemId
  }

  if (payload.kind === 'todo') {
    return 'todo:list'
  }

  if (payload.kind !== 'ask-user') {
    return payload.itemId
  }

  return payload.planFile ? 'ask-user:plan-approval' : 'ask-user:question'
}

export const createStructuredAssistantMessage = (
  provider: Provider,
  streamId: string,
  payload: StreamAssistantMessage,
): ChatMessage => ({
  id: createStructuredMessageId(provider, streamId, getStructuredMessageKey(payload)),
  role: 'assistant',
  content: payload.content,
  createdAt: new Date().toISOString(),
  meta: {
    provider,
    itemId: payload.itemId,
  },
})

export const finalizeStreamedAssistantMessage = (
  messages: ChatMessage[],
  streamingMessageId: string | undefined,
  provider: Provider,
  streamId: string,
  payload: StreamAssistantMessage,
): ChatMessage[] => {
  if (streamingMessageId) {
    const existingIndex = messages.findIndex((message) => message.id === streamingMessageId)

    if (existingIndex >= 0) {
      const existing = messages[existingIndex]!
      const nextMeta = {
        ...(existing.meta ?? {}),
        provider,
        itemId: payload.itemId,
      }

      if (
        existing.content === payload.content &&
        existing.meta?.provider === provider &&
        existing.meta?.itemId === payload.itemId
      ) {
        return messages
      }

      return [
        ...messages.slice(0, existingIndex),
        {
          ...existing,
          role: 'assistant',
          content: payload.content,
          meta: nextMeta,
        },
        ...messages.slice(existingIndex + 1),
      ]
    }
  }

  const nextMessage = createStructuredAssistantMessage(provider, streamId, payload)
  const existingIndex = messages.findIndex((message) => message.id === nextMessage.id)

  if (existingIndex < 0) {
    return [...messages, nextMessage]
  }

  if (
    messages[existingIndex]?.content === nextMessage.content &&
    messages[existingIndex]?.meta?.provider === nextMessage.meta?.provider &&
    messages[existingIndex]?.meta?.itemId === nextMessage.meta?.itemId
  ) {
    return messages
  }

  return [
    ...messages.slice(0, existingIndex),
    {
      ...nextMessage,
      createdAt: messages[existingIndex]?.createdAt ?? nextMessage.createdAt,
    },
    ...messages.slice(existingIndex + 1),
  ]
}

export const createStructuredActivityMessage = (
  provider: Provider,
  streamId: string,
  payload: StreamActivity,
): ChatMessage => ({
  id: createStructuredMessageId(provider, streamId, getStructuredMessageKey(payload)),
  role: 'assistant',
  content: '',
  createdAt: new Date().toISOString(),
  meta: {
    provider,
    kind: payload.kind,
    itemId: payload.itemId,
    structuredData: JSON.stringify(payload),
  },
})

export const finalizeStructuredActivityMessage = (
  messages: ChatMessage[],
  streamingMessageId: string | undefined,
  provider: Provider,
  streamId: string,
  payload: StreamActivity,
): ChatMessage[] => {
  const nextMessage = createStructuredActivityMessage(provider, streamId, payload)
  const streamingIndex =
    streamingMessageId
      ? messages.findIndex((message) => message.id === streamingMessageId)
      : -1
  const existingStructuredIndex = messages.findIndex((message) => message.id === nextMessage.id)
  const streamingContent =
    streamingIndex >= 0 ? messages[streamingIndex]?.content ?? '' : ''
  // Only drop the live streaming bubble when it is a synthetic <ask-user-question>
  // XML blob that the structured card is replacing. Real assistant prose (e.g. Claude
  // native AskUserQuestion tool flows) must survive so the user does not lose context.
  const streamingIsAskUserXmlBlob =
    payload.kind === 'ask-user' && /<ask-user-question>/i.test(streamingContent)
  const shouldReplaceStreaming =
    streamingIndex >= 0 &&
    messages[streamingIndex]?.id !== nextMessage.id &&
    (payload.kind !== 'ask-user' || streamingIsAskUserXmlBlob)
  const createdAt =
    messages[existingStructuredIndex]?.createdAt ??
    (shouldReplaceStreaming ? messages[streamingIndex]?.createdAt : undefined) ??
    nextMessage.createdAt

  const nextMessages = shouldReplaceStreaming
    ? messages.filter((message) => message.id !== streamingMessageId)
    : [...messages]

  const nextIndex = nextMessages.findIndex((message) => message.id === nextMessage.id)

  if (nextIndex < 0) {
    return [
      ...nextMessages,
      {
        ...nextMessage,
        createdAt,
      },
    ]
  }

  const existing = nextMessages[nextIndex]!

  if (
    existing.content === nextMessage.content &&
    existing.meta?.provider === nextMessage.meta?.provider &&
    existing.meta?.itemId === nextMessage.meta?.itemId &&
    existing.meta?.kind === nextMessage.meta?.kind &&
    existing.meta?.structuredData === nextMessage.meta?.structuredData
  ) {
    return nextMessages
  }

  return [
    ...nextMessages.slice(0, nextIndex),
    {
      ...nextMessage,
      createdAt,
    },
    ...nextMessages.slice(nextIndex + 1),
  ]
}
