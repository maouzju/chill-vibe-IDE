import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { getChatMessageAttachments } from '../shared/chat-attachments.js'
import {
  archiveOpenChatsForCrashRecovery,
  createCard,
  createPane,
  createDefaultState,
  getConfiguredModel,
  getCardDefaultSize,
  getCardMinimumSize,
  getOrderedColumnCards,
  getPreferredReasoningEffort,
  normalizeLayoutNode,
  normalizeAppSettings,
  normalizeCardSize,
  normalizeColumnWidth,
  normalizeSessionHistory,
  maxRecentWorkspaces,
} from '../shared/default-state.js'
import { normalizeBrainstormAnswerCount } from '../shared/brainstorm.js'
import { getWorkspaceTitle } from '../shared/i18n.js'
import { isInterruptedSessionRecoverable } from '../shared/interrupted-session-recovery.js'
import {
  BRAINSTORM_TOOL_MODEL,
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
  getDefaultModel,
  normalizeStoredModel,
  PM_TOOL_MODEL,
} from '../shared/models.js'
import { normalizeReasoningEffort } from '../shared/reasoning.js'
import {
  appStateSchema,
  desktopRuntimeKindSchema,
  internalSessionHistoryLoadResponseSchema,
  recentCrashRecoverySchema,
  type AppState,
  type AppStateLoadResponse,
  type BoardColumn,
  type ChatCard,
  type DesktopRuntimeKind,
  type ImageAttachment,
  type InterruptedSessionRecovery,
  type LayoutNode,
  type Provider,
  type RecentCrashRecovery,
  type RendererCrashCaptureRequest,
  type SessionHistoryEntry,
  type StartupStateRecovery,
  type StateRecoveryIssue,
  type StateRecoveryOption,
} from '../shared/schema.js'
import { getAppDataDir, getDefaultWorkspacePath } from './app-paths.js'

type SessionHistoryCacheMode = 'full' | 'preview'

type StateCacheEntry = {
  dataDir: string
  state: AppState
  diskStamp: string | null
  sessionHistoryMode: SessionHistoryCacheMode
}

type SanitizedStateResult = {
  state: AppState
  didCompactStructuredData: boolean
}

let cachedStateEntry: StateCacheEntry | null = null
const retainedStateSnapshotCount = 8
const maxSnapshotRecoveryOptions = 3
const stateSnapshotPrefix = 'state.snapshot-'
const stateSnapshotSuffix = '.json'
const sessionHistoryDirName = 'session-history'
const sessionHistoryFileSuffix = '.json'
const legacyRecentCrashRecoveryFileName = 'state.crash-recovery.json'
const rendererSessionHistoryPreviewMessageLimit = 8
const maxPersistedCardMessages = 500

const getCurrentDesktopRuntimeKind = (): DesktopRuntimeKind | null => {
  const parsed = desktopRuntimeKindSchema.safeParse(process.env.CHILL_VIBE_RUNTIME_KIND)
  return parsed.success ? parsed.data : null
}

const getRecentCrashRecoveryFileName = () => {
  const runtimeKind = getCurrentDesktopRuntimeKind()
  return runtimeKind
    ? `state.crash-recovery.${runtimeKind}.json`
    : legacyRecentCrashRecoveryFileName
}

const getCachedStateEntry = (dataDir = getAppDataDir()) =>
  cachedStateEntry?.dataDir === dataDir ? cachedStateEntry : null

const getSessionHistoryCacheMode = (state: AppState): SessionHistoryCacheMode =>
  state.sessionHistory.some(
    (entry) => entry.messagesPreview || getSessionHistoryMessageCount(entry) > entry.messages.length,
  )
    ? 'preview'
    : 'full'

const setCachedState = (state: AppState, dataDir = getAppDataDir(), diskStamp: string | null = null) => {
  cachedStateEntry = {
    dataDir,
    state,
    diskStamp,
    sessionHistoryMode: getSessionHistoryCacheMode(state),
  }
  return state
}

const isUntouchedEmptyChatCard = (card: Pick<ChatCard, 'status' | 'messages' | 'draft' | 'sessionId' | 'streamId'>) =>
  card.status === 'idle' &&
  card.messages.length === 0 &&
  !card.draft.trim() &&
  !card.sessionId &&
  !card.streamId

const getStartupPreferredModel = (settings: AppState['settings'], provider: ChatCard['provider']) => {
  const rememberedModel =
    settings.lastModel?.provider === provider
      ? normalizeStoredModel(provider, settings.lastModel.model)
      : ''

  return rememberedModel || getConfiguredModel(settings, provider)
}

const shouldInvalidatePersistedChatSession = (
  status: ChatCard['status'],
  messages: ChatCard['messages'],
) => status !== 'streaming' && messages.some((message) => getChatMessageAttachments(message).length > 0)

const getSessionHistoryMessageCount = (
  entry: Pick<SessionHistoryEntry, 'messages' | 'messageCount'>,
) => Math.max(typeof entry.messageCount === 'number' ? entry.messageCount : 0, entry.messages.length)

const toRendererSessionHistoryMessage = (
  message: SessionHistoryEntry['messages'][number],
): SessionHistoryEntry['messages'][number] => ({
  id: message.id,
  role: message.role,
  content: message.content,
  createdAt: message.createdAt,
})

const createRendererSessionHistoryMessages = (
  messages: SessionHistoryEntry['messages'],
): SessionHistoryEntry['messages'] => {
  if (messages.length <= rendererSessionHistoryPreviewMessageLimit) {
    return messages.map(toRendererSessionHistoryMessage)
  }

  const headCount = Math.ceil(rendererSessionHistoryPreviewMessageLimit / 2)
  const tailCount = rendererSessionHistoryPreviewMessageLimit - headCount
  return [
    ...messages.slice(0, headCount),
    ...messages.slice(-tailCount),
  ].map(toRendererSessionHistoryMessage)
}

const renderSessionHistoryForRenderer = (entries: SessionHistoryEntry[]): SessionHistoryEntry[] =>
  entries.map((entry) => {
    const messageCount = getSessionHistoryMessageCount(entry)
    const hasCompleteMessages = !entry.messagesPreview && entry.messages.length >= messageCount

    return {
      ...entry,
      messageCount,
      messagesPreview: true,
      messages: hasCompleteMessages
        ? createRendererSessionHistoryMessages(entry.messages)
        : entry.messages.map(toRendererSessionHistoryMessage),
    }
  })

const isFullSessionHistoryEntry = (entry: SessionHistoryEntry) =>
  !entry.messagesPreview &&
  entry.messages.length > 0 &&
  getSessionHistoryMessageCount(entry) <= entry.messages.length

const writeSessionHistorySidecars = async (entries: SessionHistoryEntry[], dataDir = getAppDataDir()) => {
  if (entries.length === 0) {
    return
  }

  const sidecarDir = getSessionHistoryDirPath(dataDir)
  await mkdir(sidecarDir, { recursive: true })

  await Promise.all(
    entries.filter(isFullSessionHistoryEntry).map(async (entry) => {
      await writeFile(
        getSessionHistoryEntryFilePath(entry.id, dataDir),
        `${JSON.stringify(entry, null, 2)}\n`,
        'utf8',
      )
    }),
  )
}

const readSessionHistorySidecarEntry = async (
  entryId: string,
  dataDir = getAppDataDir(),
): Promise<SessionHistoryEntry | null> => {
  try {
    const content = await readFile(getSessionHistoryEntryFilePath(entryId, dataDir), 'utf8')
    return internalSessionHistoryLoadResponseSchema.parse({
      entry: normalizePersistedSessionHistoryEntry(JSON.parse(content) as SessionHistoryEntry),
    }).entry
  } catch {
    return null
  }
}

const loadSessionHistorySidecars = async (dataDir = getAppDataDir()) => {
  try {
    const sidecarDir = getSessionHistoryDirPath(dataDir)
    const files = await readdir(sidecarDir)
    const entries = await Promise.all(
      files
        .filter((fileName) => fileName.endsWith(sessionHistoryFileSuffix))
        .map(async (fileName) => {
          try {
            const content = await readFile(path.join(sidecarDir, fileName), 'utf8')
            return internalSessionHistoryLoadResponseSchema.parse({
              entry: normalizePersistedSessionHistoryEntry(JSON.parse(content) as SessionHistoryEntry),
            }).entry
          } catch {
            return null
          }
        }),
    )

    return normalizeSessionHistory(entries.filter((entry): entry is SessionHistoryEntry => Boolean(entry)))
  } catch {
    return []
  }
}

const hydratePreviewSessionHistory = async (
  entries: SessionHistoryEntry[],
  dataDir = getAppDataDir(),
) => {
  if (entries.length === 0 || entries.every(isFullSessionHistoryEntry)) {
    return entries
  }

  const sidecarEntries = await loadSessionHistorySidecars(dataDir)
  if (sidecarEntries.length === 0) {
    return entries
  }

  const sidecarEntriesById = new Map(sidecarEntries.map((entry) => [entry.id, entry] as const))

  return entries.map((entry) => {
    const messageCount = getSessionHistoryMessageCount(entry)
    const sidecarEntry = sidecarEntriesById.get(entry.id)

    return sidecarEntry && getSessionHistoryMessageCount(sidecarEntry) >= messageCount
      ? sidecarEntry
      : entry
  })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Keep all messages when recovering a streaming card. The last assistant
 * message may be incomplete, but if the stream can be re-attached the backlog
 * replay will overwrite it via upsertMessages. If the stream is gone (server
 * restart / expiry), preserving the partial answer is far better than deleting
 * it — the client-side "Stream not found." handler now gracefully returns the
 * card to idle, so the user keeps their conversation history.
 */
const trimStreamingMessages = (messages: ChatCard['messages']) => messages

const getStateFilePathForDir = (dataDir: string) => path.join(dataDir, 'state.json')
const getSessionHistoryDirPath = (dataDir = getAppDataDir()) => path.join(dataDir, sessionHistoryDirName)

const encodeSessionHistoryFileName = (entryId: string) =>
  `${Buffer.from(entryId, 'utf8')
    .toString('base64url')
    .replace(/[^A-Za-z0-9_-]/g, '_')}${sessionHistoryFileSuffix}`

const getSessionHistoryEntryFilePath = (entryId: string, dataDir = getAppDataDir()) =>
  path.join(getSessionHistoryDirPath(dataDir), encodeSessionHistoryFileName(entryId))

const getStateDiskStamp = async (dataDir = getAppDataDir()) => {
  const stateInfo = await stat(getStateFilePathForDir(dataDir)).catch(() => null)
  const walInfo = await stat(getWalFilePath(dataDir)).catch(() => null)

  return [
    stateInfo ? `${stateInfo.size}:${stateInfo.mtimeMs}` : 'missing',
    walInfo ? `${walInfo.size}:${walInfo.mtimeMs}` : 'missing',
  ].join('|')
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isProvider = (value: unknown): value is Provider =>
  value === 'codex' || value === 'claude'

const persistedToolCardModels = new Set([
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
])

const fallbackTimestamp = '1970-01-01T00:00:00.000Z'
const fallbackMessageCreatedAt = '1970-01-01T00:00:00.000Z'

const normalizePersistedTimestamp = (value: unknown, fallback = fallbackTimestamp) => {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback
}

const normalizePersistedMessageTimestamp = (value: unknown) =>
  normalizePersistedTimestamp(value, fallbackMessageCreatedAt)

const normalizeOptionalString = (value: unknown) =>
  typeof value === 'string' ? value : undefined

const normalizeStringRecord = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : {}

const normalizePositiveInteger = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback

const normalizePersistedRecentWorkspaces = (value: unknown): AppState['settings']['recentWorkspaces'] => {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  return value
    .flatMap((item) => {
      if (!isRecord(item) || typeof item.path !== 'string' || !item.path.trim()) {
        return []
      }

      const key = item.path.toLowerCase()
      if (seen.has(key)) {
        return []
      }
      seen.add(key)

      return [{
        path: item.path,
        openedAt: normalizePersistedTimestamp(item.openedAt),
      }]
    })
    .sort((a, b) => (b.openedAt > a.openedAt ? 1 : b.openedAt < a.openedAt ? -1 : 0))
    .slice(0, maxRecentWorkspaces)
}

const normalizePersistedImageAttachments = (value: unknown): ImageAttachment[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((attachment) => {
    if (!isRecord(attachment)) {
      return []
    }

    if (
      typeof attachment.id !== 'string' ||
      !attachment.id.trim() ||
      typeof attachment.fileName !== 'string' ||
      !attachment.fileName.trim() ||
      (
        attachment.mimeType !== 'image/png' &&
        attachment.mimeType !== 'image/jpeg' &&
        attachment.mimeType !== 'image/webp' &&
        attachment.mimeType !== 'image/gif'
      ) ||
      typeof attachment.sizeBytes !== 'number' ||
      !Number.isInteger(attachment.sizeBytes) ||
      attachment.sizeBytes <= 0
    ) {
      return []
    }

    return [{
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    }]
  })
}

const normalizePersistedMessage = (
  message: unknown,
  index: number,
): ChatCard['messages'][number] => {
  const record = isRecord(message) ? message : {}
  const id = typeof record.id === 'string' && record.id.trim()
    ? record.id
    : `recovered-message-${index + 1}`
  const role =
    record.role === 'user' || record.role === 'assistant' || record.role === 'system'
      ? record.role
      : 'assistant'
  const content = typeof record.content === 'string' ? record.content : ''
  const createdAt = normalizePersistedMessageTimestamp(record.createdAt)
  const meta = normalizeStringRecord(record.meta)

  const normalized = {
    id,
    role,
    content,
    createdAt,
    meta: Object.keys(meta).length > 0 ? meta : undefined,
  }

  return normalized as ChatCard['messages'][number]
}

const normalizePersistedMessages = (messages: unknown): ChatCard['messages'] =>
  Array.isArray(messages) ? messages.map(normalizePersistedMessage) : []

const normalizePersistedBrainstorm = (
  value: unknown,
  fallback: ChatCard['brainstorm'],
): ChatCard['brainstorm'] => {
  const record = isRecord(value) ? value : {}
  const answers = Array.isArray(record.answers)
    ? record.answers.flatMap((answer, index) => {
        if (!isRecord(answer)) {
          return []
        }

        const id = typeof answer.id === 'string' && answer.id.trim()
          ? answer.id
          : `recovered-answer-${index + 1}`
        const status: ChatCard['brainstorm']['answers'][number]['status'] =
          answer.status === 'streaming' || answer.status === 'done' || answer.status === 'error'
            ? answer.status
            : 'error'
        const streamId = typeof answer.streamId === 'string' && answer.streamId.trim()
          ? answer.streamId
          : undefined

        return [{
          id,
          content: typeof answer.content === 'string' ? answer.content : '',
          status,
          streamId,
          error: typeof answer.error === 'string' ? answer.error : '',
        }]
      })
    : []

  return {
    prompt: typeof record.prompt === 'string' ? record.prompt : fallback.prompt,
    provider: isProvider(record.provider) ? record.provider : fallback.provider,
    model: typeof record.model === 'string' ? record.model : fallback.model,
    answerCount: normalizeBrainstormAnswerCount(record.answerCount, fallback.answerCount),
    answers,
    failedAnswers: Array.isArray(record.failedAnswers)
      ? record.failedAnswers.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

const normalizePersistedPm = (value: unknown, fallback: ChatCard['pm']): ChatCard['pm'] => {
  if (!isRecord(value) && !fallback) {
    return undefined
  }

  const record = isRecord(value) ? value : {}
  const provider = isProvider(record.provider) ? record.provider : (fallback?.provider ?? 'codex')

  return {
    provider,
    model: typeof record.model === 'string' && record.model.trim()
      ? normalizeStoredModel(provider, record.model)
      : (fallback?.model ?? getDefaultModel(provider)),
  }
}

const normalizePersistedCard = (
  card: unknown,
  options: {
    cardId: string
    columnProvider: Provider
    columnModel: string
    settings: AppState['settings']
    language: AppState['settings']['language']
  },
): ChatCard | null => {
  if (!isRecord(card)) {
    return null
  }

  const candidateProvider = isProvider(card.provider) ? card.provider : options.columnProvider
  const rawModel = typeof card.model === 'string' ? card.model : options.columnModel
  const isToolCard = persistedToolCardModels.has(rawModel)
  const provider = isToolCard ? options.columnProvider : candidateProvider
  const normalizedModel = normalizeStoredModel(provider, rawModel)
  const fallback = createCard(
    undefined,
    typeof card.size === 'number' && Number.isFinite(card.size) && card.size > 0 ? card.size : undefined,
    provider,
    normalizedModel || getConfiguredModel(options.settings, provider),
    typeof card.reasoningEffort === 'string' ? card.reasoningEffort : undefined,
    options.language,
  )
  const id = typeof card.id === 'string' && card.id.trim() ? card.id : options.cardId
  const rawStatus = card.status
  const hasRecoverableStream = rawStatus === 'streaming' && typeof card.streamId === 'string' && card.streamId.trim()
  const status: ChatCard['status'] =
    rawStatus === 'streaming'
      ? (hasRecoverableStream ? 'streaming' : 'idle')
      : rawStatus === 'error'
        ? 'error'
        : 'idle'
  const rawMessages = normalizePersistedMessages(
    hasRecoverableStream ? trimStreamingMessages(card.messages as ChatCard['messages']) : card.messages,
  )
  const shouldInvalidateSession = shouldInvalidatePersistedChatSession(status, rawMessages)
  const providerSessions = shouldInvalidateSession ? {} : normalizeStringRecord(card.providerSessions)
  const sessionId = shouldInvalidateSession ? undefined : normalizeOptionalString(card.sessionId)
  const streamId = hasRecoverableStream ? normalizeOptionalString(card.streamId) : undefined

  return {
    ...fallback,
    id,
    title: typeof card.title === 'string' ? card.title : fallback.title,
    sessionId,
    providerSessions,
    streamId,
    status,
    size: normalizeCardSize(
      typeof card.size === 'number' ? card.size : fallback.size,
      getCardMinimumSize(normalizedModel),
      getCardDefaultSize(normalizedModel),
    ),
    provider,
    model: normalizedModel,
    reasoningEffort: normalizeReasoningEffort(provider, typeof card.reasoningEffort === 'string' ? card.reasoningEffort : undefined),
    thinkingEnabled: typeof card.thinkingEnabled === 'boolean' ? card.thinkingEnabled : fallback.thinkingEnabled,
    planMode: typeof card.planMode === 'boolean' ? card.planMode : fallback.planMode,
    autoUrgeActive: typeof card.autoUrgeActive === 'boolean' ? card.autoUrgeActive : fallback.autoUrgeActive,
    autoUrgeProfileId: typeof card.autoUrgeProfileId === 'string' ? card.autoUrgeProfileId : fallback.autoUrgeProfileId,
    collapsed: typeof card.collapsed === 'boolean' ? card.collapsed : fallback.collapsed,
    unread: typeof card.unread === 'boolean' ? card.unread : fallback.unread,
    draft: typeof card.draft === 'string' ? card.draft : fallback.draft,
    draftAttachments: normalizePersistedImageAttachments(card.draftAttachments),
    stickyNote: typeof card.stickyNote === 'string' ? card.stickyNote : fallback.stickyNote,
    brainstorm: normalizePersistedBrainstorm(card.brainstorm, fallback.brainstorm),
    pm: normalizePersistedPm(card.pm, fallback.pm),
    pmTaskCardId: '',
    pmOwnerCardId: '',
    messages: rawMessages,
    messageCount: normalizePositiveInteger(card.messageCount, rawMessages.length),
  }
}

const normalizePersistedLayoutNode = (layout: unknown): LayoutNode | undefined => {
  if (!isRecord(layout)) {
    return undefined
  }

  const id = typeof layout.id === 'string' && layout.id.trim() ? layout.id : 'recovered-layout'
  if (layout.type === 'pane') {
    return {
      type: 'pane',
      id,
      tabs: Array.isArray(layout.tabs) ? layout.tabs.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [],
      activeTabId: typeof layout.activeTabId === 'string' ? layout.activeTabId : '',
      tabHistory: Array.isArray(layout.tabHistory)
        ? layout.tabHistory.filter((item): item is string => typeof item === 'string' && Boolean(item))
        : [],
    }
  }

  if (layout.type === 'split') {
    const children = Array.isArray(layout.children)
      ? layout.children.flatMap((child) => {
          const normalized = normalizePersistedLayoutNode(child)
          return normalized ? [normalized] : []
        })
      : []

    if (children.length < 2) {
      return children[0]
    }

    return {
      type: 'split',
      id,
      direction: layout.direction === 'vertical' ? 'vertical' : 'horizontal',
      children,
      ratios: Array.isArray(layout.ratios)
        ? layout.ratios.filter((ratio): ratio is number => typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0)
        : [],
    }
  }

  return undefined
}

const normalizePersistedSessionHistoryEntry = (
  entry: unknown,
  index = 0,
): SessionHistoryEntry | null => {
  if (!isRecord(entry)) {
    return null
  }

  const messages = normalizePersistedMessages(entry.messages)
  const id = typeof entry.id === 'string' && entry.id.trim()
    ? entry.id
    : `recovered-history-${index + 1}`
  const workspacePath = typeof entry.workspacePath === 'string' && entry.workspacePath.trim()
    ? entry.workspacePath
    : getDefaultWorkspacePath() || 'Recovered workspace'
  const provider = isProvider(entry.provider) ? entry.provider : 'codex'
  const messageCount = Math.max(normalizePositiveInteger(entry.messageCount, messages.length), messages.length)

  return {
    id,
    title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : 'Recovered history',
    sessionId: normalizeOptionalString(entry.sessionId),
    provider,
    model: typeof entry.model === 'string' ? normalizeStoredModel(provider, entry.model) : getDefaultModel(provider),
    workspacePath,
    messages,
    messageCount,
    messagesPreview: typeof entry.messagesPreview === 'boolean' ? entry.messagesPreview : undefined,
    archivedAt: normalizePersistedTimestamp(entry.archivedAt),
  }
}

const normalizePersistedSessionHistory = (items: unknown): SessionHistoryEntry[] =>
  Array.isArray(items)
    ? normalizeSessionHistory(
        items.flatMap((entry, index) => {
          const normalized = normalizePersistedSessionHistoryEntry(entry, index)
          return normalized ? [normalized] : []
        }),
      )
    : []

const normalizePersistedStartupSettings = (settings: unknown): AppState['settings'] => {
  const normalized = normalizeAppSettings(
    isRecord(settings)
      ? (settings as Parameters<typeof normalizeAppSettings>[0])
      : undefined,
  )

  return {
    ...normalized,
    recentWorkspaces: isRecord(settings)
      ? normalizePersistedRecentWorkspaces(settings.recentWorkspaces)
      : [],
  }
}

const resetLegacyBoardState = (raw: unknown): AppState | null => {
  if (!isRecord(raw) || !Array.isArray(raw.columns)) {
    return null
  }

  const hasLegacyBoardColumn = raw.columns.some((column) => {
    if (!isRecord(column)) {
      return false
    }

    return Array.isArray(column.cards) || column.layout === undefined
  })

  if (!hasLegacyBoardColumn) {
    return null
  }

  const safeSettings = normalizePersistedStartupSettings(raw.settings)
  const defaultState = createDefaultState(getDefaultWorkspacePath(), safeSettings.language)

  return {
    ...defaultState,
    settings: safeSettings,
    updatedAt: new Date().toISOString(),
  }
}

function sanitizeRecoveredWalState(raw: unknown): AppState | null {
  const legacyReset = resetLegacyBoardState(raw)
  if (legacyReset) {
    return legacyReset
  }

  if (!isPlausibleRawState(raw)) {
    return null
  }

  return sanitizeStateResult(raw).state
}

/** Back up the current state file before overwriting it with defaults. */
const backupStateFile = async (dataDir = getAppDataDir()) => {
  try {
    const stateFile = getStateFilePathForDir(dataDir)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupFile = path.join(dataDir, `state.backup-${timestamp}.json`)
    await copyFile(stateFile, backupFile)
    console.warn(`[state-store] State parse failed — backed up to ${backupFile}`)
  } catch {
    // Backup is best-effort; the original file may not exist.
  }
}

// ── WAL (Write-Ahead Log) ────────────────────────────────────────────────────
// Before writing the main state file, we write the full content to a .wal file.
// If the app crashes mid-write, the next loadState() can recover from the WAL.

const getWalFilePath = (dataDir = getAppDataDir()) => path.join(dataDir, 'state.wal')
const getTmpFilePath = (dataDir = getAppDataDir()) => path.join(dataDir, `state.tmp.${Date.now()}`)
const getRecentCrashRecoveryFilePath = (dataDir = getAppDataDir()) =>
  path.join(dataDir, getRecentCrashRecoveryFileName())
const getStateSnapshotFilePath = (
  dataDir = getAppDataDir(),
  timestamp = new Date().toISOString().replace(/[:.]/g, '-'),
) => path.join(dataDir, `${stateSnapshotPrefix}${timestamp}${stateSnapshotSuffix}`)

const toIsoTimestamp = (mtimeMs: number) => new Date(mtimeMs).toISOString()
const buildRecoveryOptionId = (source: StateRecoveryOption['source'], fileName: string) => {
  const prefix =
    source === 'current-state'
      ? 'current'
      : source === 'temp-state'
        ? 'temp'
        : 'snapshot'

  return `${prefix}:${fileName}`
}

const readValidatedStateFile = async (filePath: string) => {
  try {
    const content = await readFile(filePath, 'utf8')
    const raw = JSON.parse(content) as Record<string, unknown>
    const parsed = appStateSchema.safeParse(raw)

    if (!parsed.success) {
      return null
    }

    return sanitizeState(raw)
  } catch {
    return null
  }
}

const listStateSnapshotFiles = async (dataDir = getAppDataDir()) => {
  const files = await readdir(dataDir).catch(() => [] as string[])
  return files
    .filter((fileName) => fileName.startsWith(stateSnapshotPrefix) && fileName.endsWith(stateSnapshotSuffix))
    .sort()
    .reverse()
}

const pruneStateSnapshots = async (dataDir = getAppDataDir()) => {
  const snapshots = await listStateSnapshotFiles(dataDir)
  const staleSnapshots = snapshots.slice(retainedStateSnapshotCount)

  await Promise.all(
    staleSnapshots.map(async (fileName) => {
      try {
        await unlink(path.join(dataDir, fileName))
      } catch {
        // Best-effort pruning.
      }
    }),
  )
}

const writeStateSnapshot = async (content: string, dataDir = getAppDataDir()) => {
  try {
    await writeFile(getStateSnapshotFilePath(dataDir), content, 'utf8')
    await pruneStateSnapshots(dataDir)
  } catch (error) {
    console.warn('[state-store] Failed to write a routine snapshot.', error)
  }
}

const readRecentCrashRecovery = async (dataDir = getAppDataDir()): Promise<RecentCrashRecovery | null> => {
  try {
    const content = await readFile(getRecentCrashRecoveryFilePath(dataDir), 'utf8')
    const recovery = recentCrashRecoverySchema.parse(JSON.parse(content))
    const runtimeKind = getCurrentDesktopRuntimeKind()

    if (runtimeKind && recovery.runtimeKind && recovery.runtimeKind !== runtimeKind) {
      return null
    }

    return recovery
  } catch {
    return null
  }
}

const dismissRecentCrashRecoveryForDataDir = async (dataDir = getAppDataDir()) => {
  try {
    await unlink(getRecentCrashRecoveryFilePath(dataDir))
  } catch {
    // Already cleared or never existed.
  }
}

const getInterruptedSessionResumePayload = (card: ChatCard) => {
  if (typeof card.sessionId === 'string' && card.sessionId.trim().length > 0) {
    return {
      resumeMode: 'resume' as const,
      resumePrompt: '',
      resumeAttachments: [],
    }
  }

  const lastMessage = card.messages.at(-1)

  if (!lastMessage || lastMessage.role !== 'user') {
    return {
      resumeMode: 'resume' as const,
      resumePrompt: '',
      resumeAttachments: [],
    }
  }

  const resumeAttachments = getChatMessageAttachments(lastMessage)
  if (!lastMessage.content.trim() && resumeAttachments.length === 0) {
    return {
      resumeMode: 'resume' as const,
      resumePrompt: '',
      resumeAttachments: [],
    }
  }

  return {
    resumeMode: 'retry-last-user-message' as const,
    resumePrompt: lastMessage.content,
    resumeAttachments,
  }
}

const inspectInterruptedSessionRecovery = (state: AppState): InterruptedSessionRecovery | null => {
  const entries = state.columns.flatMap((column) =>
    getOrderedColumnCards(column)
      .filter((card) => card.status === 'streaming')
      .map((card) => {
        const resumePayload = getInterruptedSessionResumePayload(card)

        return {
          columnId: column.id,
          cardId: card.id,
          title: card.title,
          provider: card.provider,
          sessionId: card.sessionId,
          recoverable: isInterruptedSessionRecoverable({
            sessionId: card.sessionId,
            ...resumePayload,
          }),
          ...resumePayload,
        }
      }),
  )

  if (entries.length === 0) {
    return null
  }

  return { entries }
}

const renderInterruptedSessionsAsIdle = (
  state: AppState,
  recovery: InterruptedSessionRecovery | null,
): AppState => {
  if (!recovery) {
    return state
  }

  const interruptedCardIdsByColumn = new Map<string, Set<string>>()
  for (const entry of recovery.entries) {
    const existing = interruptedCardIdsByColumn.get(entry.columnId)
    if (existing) {
      existing.add(entry.cardId)
      continue
    }

    interruptedCardIdsByColumn.set(entry.columnId, new Set([entry.cardId]))
  }

  let didChange = false
  const normalizeInterruptedMessages = (messages: ChatCard['messages']) => {
    let didNormalize = false

    const nextMessages = messages.map((message) => {
      const structuredData = message.meta?.structuredData
      if (!structuredData || !message.meta?.kind) {
        return message
      }

      try {
        const payload = JSON.parse(structuredData) as Record<string, unknown>

        if (message.meta.kind === 'command' && payload.status === 'in_progress') {
          didNormalize = true
          return {
            ...message,
            meta: {
              ...message.meta,
              structuredData: JSON.stringify({
                ...payload,
                status: 'declined',
              }),
            },
          }
        }

        if (message.meta.kind === 'todo' && Array.isArray(payload.items)) {
          let changedTodo = false
          const items = payload.items.map((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              return item
            }

            if ((item as { status?: unknown }).status !== 'in_progress') {
              return item
            }

            changedTodo = true
            return {
              ...(item as Record<string, unknown>),
              status: 'pending',
            }
          })

          if (changedTodo) {
            didNormalize = true
            return {
              ...message,
              meta: {
                ...message.meta,
                structuredData: JSON.stringify({
                  ...payload,
                  items,
                }),
              },
            }
          }
        }
      } catch {
        return message
      }

      return message
    })

    return {
      messages: didNormalize ? nextMessages : messages,
      didNormalize,
    }
  }

  const columns = state.columns.map((column) => {
    const interruptedCardIds = interruptedCardIdsByColumn.get(column.id)
    if (!interruptedCardIds || interruptedCardIds.size === 0) {
      return column
    }

    let columnChanged = false
    const cards = Object.fromEntries(
      Object.entries(column.cards).map(([cardId, card]) => {
        if (!interruptedCardIds.has(cardId)) {
          return [cardId, card]
        }

        const normalizedMessages = normalizeInterruptedMessages(card.messages)
        if (card.status === 'idle' && !card.streamId && !normalizedMessages.didNormalize) {
          return [cardId, card]
        }

        didChange = true
        columnChanged = true
        return [
          cardId,
          {
            ...card,
            status: 'idle' as const,
            streamId: undefined,
            messages: normalizedMessages.messages,
          },
        ]
      }),
    )

    return columnChanged ? { ...column, cards } : column
  })

  return didChange ? { ...state, columns } : state
}

const inspectCorruptedWal = async (dataDir = getAppDataDir()): Promise<StateRecoveryIssue | null> => {
  const walPath = getWalFilePath(dataDir)
  const walInfo = await stat(walPath).catch(() => null)
  if (!walInfo) {
    return null
  }

  try {
    const walContent = await readFile(walPath, 'utf8')
    const raw = JSON.parse(walContent) as Record<string, unknown>
    if (appStateSchema.safeParse(raw).success) {
      return null
    }
  } catch {
    // Fall through to a recovery issue.
  }

  return {
    kind: 'corrupted-wal',
    fileName: path.basename(walPath),
    updatedAt: toIsoTimestamp(walInfo.mtimeMs),
    details: 'The pending write-ahead log could not be parsed.',
  }
}

const inspectNewerTempStates = async (dataDir = getAppDataDir()): Promise<{
  issues: StateRecoveryIssue[]
  options: StateRecoveryOption[]
}> => {
  const stateInfo = await stat(getStateFilePathForDir(dataDir)).catch(() => null)
  const files = await readdir(dataDir).catch(() => [] as string[])
  const discoveredTempFiles = await Promise.all(
    files
      .filter((fileName) => fileName.startsWith('state.tmp.'))
      .map(async (fileName) => {
        const filePath = path.join(dataDir, fileName)
        const fileInfo = await stat(filePath).catch(() => null)
        if (!fileInfo) {
          return null
        }

        if (stateInfo && fileInfo.mtimeMs <= stateInfo.mtimeMs + 1) {
          return null
        }

        return { fileName, filePath, fileInfo }
      }),
  )

  const tempFiles = discoveredTempFiles
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) => right.fileInfo.mtimeMs - left.fileInfo.mtimeMs)

  const issues = tempFiles.map<StateRecoveryIssue>(({ fileName, fileInfo }) => ({
    kind: 'newer-temp-state',
    fileName,
    updatedAt: toIsoTimestamp(fileInfo.mtimeMs),
    details: 'A newer temporary state file was left behind by an interrupted save.',
  }))

  const options: StateRecoveryOption[] = []

  for (const [index, entry] of tempFiles.entries()) {
    const validState = await readValidatedStateFile(entry.filePath)
    if (!validState) {
      continue
    }

    options.push({
      id: buildRecoveryOptionId('temp-state', entry.fileName),
      source: 'temp-state',
      fileName: entry.fileName,
      updatedAt: toIsoTimestamp(entry.fileInfo.mtimeMs),
      recommended: index === 0,
    })
  }

  return {
    issues,
    options,
  }
}

const getSnapshotRecoveryOptions = async (dataDir = getAppDataDir()) => {
  const snapshotFiles = await listStateSnapshotFiles(dataDir)
  const options: StateRecoveryOption[] = []

  for (const fileName of snapshotFiles) {
    if (options.length >= maxSnapshotRecoveryOptions) {
      break
    }

    const filePath = path.join(dataDir, fileName)
    const fileInfo = await stat(filePath).catch(() => null)
    if (!fileInfo) {
      continue
    }

    const validState = await readValidatedStateFile(filePath)
    if (!validState) {
      continue
    }

    options.push({
      id: buildRecoveryOptionId('snapshot', fileName),
      source: 'snapshot',
      fileName,
      updatedAt: toIsoTimestamp(fileInfo.mtimeMs),
      recommended: false,
    })
  }

  return options
}

const inspectStartupRecovery = async (dataDir = getAppDataDir()): Promise<StartupStateRecovery | null> => {
  const issues: StateRecoveryIssue[] = []
  const stateInfo = await stat(getStateFilePathForDir(dataDir)).catch(() => null)
  const currentOption: StateRecoveryOption = {
    id: buildRecoveryOptionId('current-state', 'state.json'),
    source: 'current-state',
    fileName: 'state.json',
    updatedAt: stateInfo ? toIsoTimestamp(stateInfo.mtimeMs) : undefined,
    recommended: false,
  }

  const walIssue = await inspectCorruptedWal(dataDir)
  if (walIssue) {
    issues.push(walIssue)
  }

  const tempStates = await inspectNewerTempStates(dataDir)
  issues.push(...tempStates.issues)

  if (issues.length === 0) {
    return null
  }

  return {
    issues,
    options: [
      currentOption,
      ...tempStates.options,
      ...(await getSnapshotRecoveryOptions(dataDir)),
    ],
    currentOptionId: currentOption.id,
  }
}

const resolveRecoveryOptionFilePath = (dataDir: string, option: StateRecoveryOption) =>
  option.source === 'current-state'
    ? getStateFilePathForDir(dataDir)
    : path.join(dataDir, option.fileName)

const archiveRecoveryArtifact = async (filePath: string, nextFileName: string) => {
  const fileInfo = await stat(filePath).catch(() => null)
  if (!fileInfo) {
    return
  }

  try {
    await rename(filePath, path.join(path.dirname(filePath), nextFileName))
  } catch {
    try {
      await unlink(filePath)
    } catch {
      // Best-effort cleanup.
    }
  }
}

const cleanupStartupRecoveryArtifacts = async (
  prompt: StartupStateRecovery,
  dataDir = getAppDataDir(),
) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  await Promise.all(
    prompt.issues.map(async (issue, index) => {
      const filePath = path.join(dataDir, issue.fileName)
      const nextFileName =
        issue.kind === 'corrupted-wal'
          ? `state.wal.corrupt-${stamp}-${index}`
          : `state.tmp.archived-${stamp}-${index}-${issue.fileName.replace(/[^\w.-]/g, '_')}`

      await archiveRecoveryArtifact(filePath, nextFileName)
    }),
  )
}

const recoverFromWal = async (dataDir = getAppDataDir()): Promise<AppState | null> => {
  try {
    const walContent = await readFile(getWalFilePath(dataDir), 'utf8')
    const raw = JSON.parse(walContent) as Record<string, unknown>
    const recoveredState = sanitizeRecoveredWalState(raw)

    if (recoveredState) {
      // WAL is valid — promote it to the main file atomically
      const tmpFile = getTmpFilePath(dataDir)
      await writeFile(tmpFile, walContent, 'utf8')
      await rename(tmpFile, getStateFilePathForDir(dataDir))
      await removeWal(dataDir)
      console.warn('[state-store] Recovered state from WAL after crash.')
      return setCachedState(recoveredState, dataDir, await getStateDiskStamp(dataDir))
    }

  } catch {
    // No WAL or unreadable — normal case
  }

  return null
}

const removeWal = async (dataDir = getAppDataDir()) => {
  try {
    await unlink(getWalFilePath(dataDir))
  } catch {
    // Already removed or never existed
  }
}

// ── Atomic write with retry ──────────────────────────────────────────────────

const maxRetries = 3
const retryDelayMs = 100

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Write content to file atomically: write to .tmp, then rename over target. */
const atomicWriteFile = async (filePath: string, content: string, dataDir = getAppDataDir()) => {
  const tmpFile = getTmpFilePath(dataDir)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Step 1: Write WAL (intent log)
      await writeFile(getWalFilePath(dataDir), content, 'utf8')

      // Step 2: Write to temp file
      await writeFile(tmpFile, content, 'utf8')

      // Step 3: Atomic rename (replaces target)
      await rename(tmpFile, filePath)

      // Step 4: Remove WAL (save succeeded)
      await removeWal(dataDir)
      return
    } catch (error) {
      // Clean up temp file on failure
      try {
        await unlink(tmpFile)
      } catch {
        // Ignore cleanup errors
      }

      if (attempt < maxRetries) {
        const delay = retryDelayMs * 2 ** attempt
        console.warn(`[state-store] Write attempt ${attempt + 1} failed, retrying in ${delay}ms...`)
        await sleep(delay)
      } else {
        throw error
      }
    }
  }
}

// ── Async mutex ──────────────────────────────────────────────────────────────
// Prevents concurrent writes from interleaving.

let mutexPromise: Promise<void> = Promise.resolve()

const withWriteLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void
  const nextLock = new Promise<void>((resolve) => {
    release = resolve
  })

  const previousLock = mutexPromise
  mutexPromise = nextLock

  await previousLock

  try {
    return await fn()
  } finally {
    release!()
  }
}

// ── Sanitize ─────────────────────────────────────────────────────────────────

const maxPersistedCommandOutputChars = 512
const persistedCommandOutputHeadChars = 256
const persistedCommandOutputTailChars = 256

const compactPersistedCommandOutput = (output: string) => {
  if (output.length <= maxPersistedCommandOutputChars) {
    return {
      output,
      didCompact: false,
    }
  }

  const omittedChars = output.length - persistedCommandOutputHeadChars - persistedCommandOutputTailChars

  return {
    output: [
      output.slice(0, persistedCommandOutputHeadChars),
      '',
      `[Output truncated in saved state. ${omittedChars} characters omitted.]`,
      '',
      output.slice(-persistedCommandOutputTailChars),
    ].join('\n'),
    didCompact: true,
  }
}

const compactPersistedMessageMeta = (meta: ChatCard['messages'][number]['meta']) => {
  if (!meta?.structuredData || meta.kind !== 'command') {
    return {
      meta,
      didCompact: false,
    }
  }

  try {
    const payload = JSON.parse(meta.structuredData) as Record<string, unknown>

    if (payload.kind !== 'command' || typeof payload.output !== 'string') {
      return {
        meta,
        didCompact: false,
      }
    }

    const compactedOutput = compactPersistedCommandOutput(payload.output)
    if (!compactedOutput.didCompact) {
      return {
        meta,
        didCompact: false,
      }
    }

    return {
      meta: {
        ...meta,
        structuredData: JSON.stringify({
          ...payload,
          output: compactedOutput.output,
        }),
      },
      didCompact: true,
    }
  } catch {
    return {
      meta,
      didCompact: false,
    }
  }
}

const compactPersistedMessages = (messages: ChatCard['messages']) => {
  let didCompact = false

  return {
    messages: messages.map((message) => {
      const compactedMeta = compactPersistedMessageMeta(message.meta)
      if (!compactedMeta.didCompact) {
        return message
      }

      didCompact = true
      return {
        ...message,
        meta: compactedMeta.meta,
      }
    }),
    didCompact,
  }
}

const isPlausibleRawState = (raw: unknown): raw is AppState =>
  typeof raw === 'object' &&
  raw !== null &&
  'columns' in raw &&
  Array.isArray((raw as Record<string, unknown>).columns) &&
  'settings' in raw &&
  typeof (raw as Record<string, unknown>).settings === 'object'

const normalizePersistedColumn = (
  column: unknown,
  columnIndex: number,
  options: {
    settings: AppState['settings']
    language: AppState['settings']['language']
    fallbackColumn: BoardColumn
  },
): BoardColumn | null => {
  if (!isRecord(column)) {
    return null
  }

  const provider = isProvider(column.provider)
    ? column.provider
    : isProvider(options.fallbackColumn.provider)
      ? options.fallbackColumn.provider
      : 'codex'
  const configuredModel = getConfiguredModel(options.settings, provider)
  const rawColumnModel = typeof column.model === 'string' ? column.model : configuredModel
  const normalizedColumnModel = normalizeStoredModel(provider, rawColumnModel) || configuredModel
  const rawCards = isRecord(column.cards) ? column.cards : {}
  const cards = Object.fromEntries(
    Object.entries(rawCards).flatMap(([cardId, card]) => {
      const normalizedCard = normalizePersistedCard(card, {
        cardId,
        columnProvider: provider,
        columnModel: normalizedColumnModel,
        settings: options.settings,
        language: options.language,
      })

      if (!normalizedCard) {
        return []
      }

      return [[normalizedCard.id, normalizedCard] satisfies [string, ChatCard]]
    }),
  )
  const normalizedLayoutInput = normalizePersistedLayoutNode(column.layout)
  const layout = normalizeLayoutNode(normalizedLayoutInput, cards)

  return {
    id: typeof column.id === 'string' && column.id.trim()
      ? column.id
      : options.fallbackColumn.id,
    title: typeof column.title === 'string' && column.title.trim()
      ? column.title
      : getWorkspaceTitle(options.language, columnIndex + 1),
    provider,
    workspacePath: typeof column.workspacePath === 'string' ? column.workspacePath : options.fallbackColumn.workspacePath,
    model: normalizedColumnModel,
    width: normalizeColumnWidth(column.width as number | undefined),
    layout:
      layout.type === 'pane' && layout.tabs.length === 0 && Object.keys(cards).length > 0
        ? createPane(Object.keys(cards))
        : layout,
    cards,
  }
}

const sanitizeStateResult = (raw: unknown): SanitizedStateResult => {
  const defaultState = createDefaultState(getDefaultWorkspacePath())

  if (!isPlausibleRawState(raw)) {
    return {
      state: defaultState,
      didCompactStructuredData: false,
    }
  }

  // Cast directly — Zod safeParse is too slow on large states (>30s for 2MB,
  // OOM for >5MB due to deep-clone amplification).  The data was written by
  // this app, so a structural plausibility check is sufficient.
  const data = raw as AppState

  const safeSettings = normalizePersistedStartupSettings(data.settings)
  const safeColumns = (data.columns.length > 0 ? data.columns : defaultState.columns)
    .flatMap((column: unknown, columnIndex: number) => {
      const normalizedColumn = normalizePersistedColumn(column, columnIndex, {
        settings: safeSettings,
        language: safeSettings.language,
        fallbackColumn: defaultState.columns[columnIndex] ?? defaultState.columns[0]!,
      })

      return normalizedColumn ? [normalizedColumn] : []
    })
  const safeSessionHistory = normalizePersistedSessionHistory(data.sessionHistory ?? [])
  const language = safeSettings.language
  let didCompactStructuredData = false

  const state: AppState = {
    ...data,
    version: 1,
    settings: safeSettings,
    updatedAt: new Date().toISOString(),
    columns: safeColumns.map((column: BoardColumn, columnIndex: number) => ({
      ...(() => {
        const cardEntries: [string, ChatCard][] = []

        for (const [cardId, card] of Object.entries(column.cards) as [string, ChatCard][]) {
          if (card.model === BRAINSTORM_TOOL_MODEL) {
            continue
          }

          const hasRecoverableStream = card.status === 'streaming' && Boolean(card.streamId)
          const status: ChatCard['status'] =
            card.status === 'streaming' ? (hasRecoverableStream ? 'streaming' : 'idle') : card.status
          const rawMessages = normalizePersistedMessages(
            hasRecoverableStream ? trimStreamingMessages(card.messages) : card.messages,
          )
          const compactedMessages = compactPersistedMessages(rawMessages)
          if (compactedMessages.didCompact) {
            didCompactStructuredData = true
          }

          const messages = compactedMessages.messages.length > maxPersistedCardMessages
            ? compactedMessages.messages.slice(-maxPersistedCardMessages)
            : compactedMessages.messages
          const shouldInvalidateSession = shouldInvalidatePersistedChatSession(status, messages)
          const normalizedModel = normalizeStoredModel(card.provider, card.model)
          const configuredModel = getConfiguredModel(safeSettings, card.provider)
          const startupPreferredModel = getStartupPreferredModel(safeSettings, card.provider)
          const isLegacyPmCard = normalizedModel === PM_TOOL_MODEL
          const cardWithoutLegacyDream = {
            ...(card as ChatCard & { dream?: unknown }),
          }
          delete cardWithoutLegacyDream.dream
          const migratedModel =
            isLegacyPmCard
              ? configuredModel
              : isUntouchedEmptyChatCard({
                    status,
                    messages,
                    draft: card.draft,
                    sessionId: card.sessionId,
                    streamId: hasRecoverableStream ? card.streamId : undefined,
                  }) &&
                  startupPreferredModel !== normalizedModel &&
                  (normalizedModel === getDefaultModel(card.provider) ||
                    normalizedModel === configuredModel) &&
                  !card.title.trim()
                ? startupPreferredModel
                : normalizedModel

          cardEntries.push([
            cardId,
            {
              ...cardWithoutLegacyDream,
              model: migratedModel,
              reasoningEffort:
                !isLegacyPmCard && migratedModel === normalizedModel
                  ? normalizeReasoningEffort(card.provider, card.reasoningEffort)
                  : getPreferredReasoningEffort(safeSettings, card.provider, migratedModel),
              title: card.title || '',
              draft: card.draft,
              sessionId: shouldInvalidateSession ? undefined : card.sessionId,
              providerSessions: shouldInvalidateSession ? {} : card.providerSessions,
              streamId: hasRecoverableStream ? card.streamId : undefined,
              status,
              pmTaskCardId: '',
              pmOwnerCardId: '',
              messages,
            },
          ])
        }

        const cards: Record<string, ChatCard> = Object.fromEntries(cardEntries)

        const layout = normalizeLayoutNode(column.layout, cards)

        return {
          ...column,
          title: column.title || getWorkspaceTitle(language, columnIndex + 1),
          model: (() => {
            const normalizedColumnModel = normalizeStoredModel(column.provider, column.model)
            const configuredColumnModel = getConfiguredModel(safeSettings, column.provider)
            const startupPreferredColumnModel = getStartupPreferredModel(safeSettings, column.provider)

            return (normalizedColumnModel === getDefaultModel(column.provider) ||
              normalizedColumnModel === configuredColumnModel) &&
              startupPreferredColumnModel !== normalizedColumnModel
              ? startupPreferredColumnModel
              : normalizedColumnModel
          })(),
          width: normalizeColumnWidth(column.width),
          layout:
            layout.type === 'pane' && layout.tabs.length === 0 && Object.keys(cards).length > 0
              ? createPane(Object.keys(cards))
              : layout,
          cards,
        }
      })(),
    })),
    sessionHistory: safeSessionHistory.map((entry) => {
      const compactedMessages = compactPersistedMessages(normalizePersistedMessages(entry.messages))
      if (compactedMessages.didCompact) {
        didCompactStructuredData = true
      }

      const trimmedMessages = compactedMessages.messages.length > maxPersistedCardMessages
        ? compactedMessages.messages.slice(-maxPersistedCardMessages)
        : compactedMessages.messages

      return {
        ...entry,
        messages: trimmedMessages,
      }
    }),
  }

  return {
    state,
    didCompactStructuredData,
  }
}

const sanitizeState = (raw: unknown): AppState => sanitizeStateResult(raw).state

/** Try to recover from the most recent valid backup file. */
const recoverFromBackups = async (dataDir = getAppDataDir()): Promise<AppState | null> => {
  try {
    const files = await readdir(dataDir)
    const backups = files
      .filter((f) => f.startsWith('state.backup-') && f.endsWith('.json'))
      .sort()
      .reverse() // newest first

    for (const backup of backups) {
      try {
        const content = await readFile(path.join(dataDir, backup), 'utf8')
        const raw = JSON.parse(content) as Record<string, unknown>
        const parsed = appStateSchema.safeParse(raw)
        if (parsed.success) {
          console.warn(`[state-store] Recovered state from backup: ${backup}`)
          return setCachedState(sanitizeState(raw), dataDir, await getStateDiskStamp(dataDir))
        }
      } catch {
        // This backup is unreadable — try the next one
      }
    }
  } catch {
    // Cannot read data directory — nothing to recover
  }

  return null
}

// Pre-trim oversized message arrays in-place before Zod validation.
// Zod safeParse deep-clones the entire input; for a 17MB state with thousands
// of messages, this amplifies heap usage ~200x and triggers V8 OOM.  Trimming
// first keeps the Zod input small enough to validate safely.
// The full messages are preserved on disk and restored via mergePersistedSessionHistory.
const preTrimMaxCardMessages = 300
const preTrimMaxHistoryMessages = 20

const preTrimOversizedMessages = (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return
  const state = raw as Record<string, unknown>

  if (Array.isArray(state.columns)) {
    for (const col of state.columns) {
      if (!col || typeof col !== 'object') continue
      const cards = (col as Record<string, unknown>).cards
      if (!cards || typeof cards !== 'object') continue
      for (const card of Object.values(cards as Record<string, unknown>)) {
        if (!card || typeof card !== 'object') continue
        const c = card as Record<string, unknown>
        if (Array.isArray(c.messages) && c.messages.length > preTrimMaxCardMessages) {
          c.messages = c.messages.slice(-preTrimMaxCardMessages)
        }
      }
    }
  }

  if (Array.isArray(state.sessionHistory)) {
    for (const entry of state.sessionHistory) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      if (Array.isArray(e.messages) && e.messages.length > preTrimMaxHistoryMessages) {
        e.messages = [
          ...e.messages.slice(0, Math.ceil(preTrimMaxHistoryMessages / 2)),
          ...e.messages.slice(-Math.floor(preTrimMaxHistoryMessages / 2)),
        ]
      }
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export const loadState = async () => {
  const dataDir = getAppDataDir()
  const cachedStateEntry = getCachedStateEntry(dataDir)
  if (cachedStateEntry) {
    if (cachedStateEntry.diskStamp === null) {
      return cachedStateEntry.state
    }

    const currentDiskStamp = await getStateDiskStamp(dataDir)
    if (
      currentDiskStamp === cachedStateEntry.diskStamp &&
      cachedStateEntry.sessionHistoryMode === 'full'
    ) {
      return cachedStateEntry.state
    }
  }

  try {
    // Try WAL recovery first (crash happened mid-write)
    const walRecovered = await recoverFromWal(dataDir)
    if (walRecovered) {
      return walRecovered
    }

    const file = await readFile(getStateFilePathForDir(dataDir), 'utf8')
    const raw = JSON.parse(file) as Record<string, unknown>

    // Pre-trim oversized message arrays BEFORE Zod validation to prevent OOM.
    // Zod's deep-clone behavior amplifies memory usage ~200x on large arrays.
    preTrimOversizedMessages(raw)

    const legacyReset = resetLegacyBoardState(raw)
    if (legacyReset) {
      await backupStateFile(dataDir)
      return setCachedState(legacyReset, dataDir, await getStateDiskStamp(dataDir))
    }

    // sanitizeStateResult does its own safeParse internally — skip the
    // redundant first parse that doubled Zod's memory footprint on large states.
    const sanitized = sanitizeStateResult(raw)

    if (sanitized.state.columns.length > 0 || !Array.isArray((raw as Record<string, unknown>).columns)) {
      if (sanitized.didCompactStructuredData) {
        return saveStateToDataDir(sanitized.state, dataDir)
      }

      return setCachedState(
        {
          ...sanitized.state,
          sessionHistory: await hydratePreviewSessionHistory(sanitized.state.sessionHistory, dataDir),
        },
        dataDir,
        await getStateDiskStamp(dataDir),
      )
    }

    // Schema changed or file has unexpected shape — backup before fallback
    await backupStateFile(dataDir)

    // Lenient recovery: force-cast known top-level keys so columns/messages survive
    // even when a new field was added without a default.
    if (raw && typeof raw === 'object' && Array.isArray(raw.columns)) {
      const patched = { ...raw }
      const retrySanitized = sanitizeStateResult(patched)

      if (retrySanitized.state.columns.length > 0) {
        if (retrySanitized.didCompactStructuredData) {
          return saveStateToDataDir(retrySanitized.state, dataDir)
        }

        return setCachedState(
          {
            ...retrySanitized.state,
            sessionHistory: await hydratePreviewSessionHistory(retrySanitized.state.sessionHistory, dataDir),
          },
          dataDir,
          await getStateDiskStamp(dataDir),
        )
      }
    }

    console.warn('[state-store] Could not recover state from main file. Trying backups...')
    const backupRecovered = await recoverFromBackups(dataDir)
    if (backupRecovered) {
      return backupRecovered
    }

    if (cachedStateEntry) {
      return cachedStateEntry.state
    }

    console.warn('[state-store] No valid backups found, using defaults.')
    return setCachedState(sanitizeState(raw), dataDir, await getStateDiskStamp(dataDir))
  } catch {
    // Main file unreadable — try backups before falling back to defaults
    const backupRecovered = await recoverFromBackups(dataDir)
    if (backupRecovered) {
      return backupRecovered
    }

    if (cachedStateEntry) {
      return cachedStateEntry.state
    }

    return setCachedState(createDefaultState(getDefaultWorkspacePath()), dataDir, await getStateDiskStamp(dataDir))
  }
}

const loadRendererStartupState = async (dataDir = getAppDataDir()): Promise<AppState> => {
  const cachedStateEntry = getCachedStateEntry(dataDir)
  if (cachedStateEntry) {
    if (cachedStateEntry.diskStamp === null) {
      return cachedStateEntry.state
    }

    const currentDiskStamp = await getStateDiskStamp(dataDir)
    if (currentDiskStamp === cachedStateEntry.diskStamp) {
      return cachedStateEntry.state
    }
  }

  try {
    const walRecovered = await recoverFromWal(dataDir)
    if (walRecovered) {
      return walRecovered
    }

    const file = await readFile(getStateFilePathForDir(dataDir), 'utf8')
    const raw = JSON.parse(file) as Record<string, unknown>

    preTrimOversizedMessages(raw)

    if (Array.isArray(raw.sessionHistory)) {
      raw.sessionHistory = renderSessionHistoryForRenderer(
        normalizePersistedSessionHistory(raw.sessionHistory),
      )
    }

    const legacyReset = resetLegacyBoardState(raw)
    if (legacyReset) {
      return legacyReset
    }

    const sanitized = sanitizeStateResult(raw)

    if (sanitized.state.columns.length > 0 || !Array.isArray((raw as Record<string, unknown>).columns)) {
      return sanitized.state
    }

    if (raw && typeof raw === 'object' && Array.isArray(raw.columns)) {
      const patched = { ...raw }
      const retrySanitized = sanitizeStateResult(patched)

      if (retrySanitized.state.columns.length > 0) {
        return retrySanitized.state
      }
    }

    const backupRecovered = await recoverFromBackups(dataDir)
    if (backupRecovered) {
      return {
        ...backupRecovered,
        sessionHistory: renderSessionHistoryForRenderer(backupRecovered.sessionHistory),
      }
    }

    return sanitizeState(raw)
  } catch {
    const backupRecovered = await recoverFromBackups(dataDir)
    if (backupRecovered) {
      return {
        ...backupRecovered,
        sessionHistory: renderSessionHistoryForRenderer(backupRecovered.sessionHistory),
      }
    }

    return createDefaultState(getDefaultWorkspacePath())
  }
}

const loadPersistedSessionHistory = async (dataDir = getAppDataDir()) => {
  const cachedStateEntry = getCachedStateEntry(dataDir)
  const cachedState = cachedStateEntry?.state
  const cachedSessionHistory = cachedState?.sessionHistory

  if (
    Array.isArray(cachedSessionHistory) &&
    (
      cachedStateEntry?.diskStamp === null ||
      cachedStateEntry?.diskStamp === await getStateDiskStamp(dataDir)
    )
  ) {
    if (
      cachedStateEntry?.sessionHistoryMode === 'full' &&
      cachedSessionHistory.every(isFullSessionHistoryEntry)
    ) {
      return cachedSessionHistory
    }

    const sidecarSessionHistory = await loadSessionHistorySidecars(dataDir)
    if (sidecarSessionHistory.length > 0) {
      return sidecarSessionHistory
    }
  }

  try {
    const walRecovered = await recoverFromWal(dataDir)
    if (walRecovered) {
      return walRecovered.sessionHistory
    }

    const sidecarSessionHistory = await loadSessionHistorySidecars(dataDir)
    if (sidecarSessionHistory.length > 0) {
      return sidecarSessionHistory
    }

    const file = await readFile(getStateFilePathForDir(dataDir), 'utf8')
    const raw = JSON.parse(file) as Record<string, unknown>

    return normalizePersistedSessionHistory(raw.sessionHistory)
  } catch {
    return []
  }
}

const mergePersistedSessionHistory = async (state: AppState, dataDir: string): Promise<AppState> => {
  if (state.sessionHistory.length === 0) {
    return state
  }

  const persistedSessionHistory = await loadPersistedSessionHistory(dataDir)
  if (
    persistedSessionHistory.length === 0 &&
    state.sessionHistory.every(isFullSessionHistoryEntry)
  ) {
    return state
  }
  const persistedEntriesById = new Map(
    persistedSessionHistory.map((entry) => [entry.id, entry] as const),
  )

  return {
    ...state,
    sessionHistory: state.sessionHistory.map((entry) => {
      const messageCount = getSessionHistoryMessageCount(entry)
      const persistedEntry = persistedEntriesById.get(entry.id)

      if (!persistedEntry) {
        return messageCount === entry.messages.length && !entry.messagesPreview
          ? entry
          : { ...entry, messageCount, messagesPreview: undefined }
      }

      if (
        !entry.messagesPreview &&
        messageCount <= entry.messages.length
      ) {
        return messageCount === entry.messages.length
          ? { ...entry, messagesPreview: undefined }
          : { ...entry, messageCount, messagesPreview: undefined }
      }

      if (getSessionHistoryMessageCount(persistedEntry) < messageCount || persistedEntry.messages.length === 0) {
        return { ...entry, messageCount, messagesPreview: undefined }
      }

      return {
        ...entry,
        messageCount,
        messagesPreview: undefined,
        messages: persistedEntry.messages,
      }
    }),
  }
}

const saveStateToDataDir = async (state: AppState, dataDir: string) => {
  await mkdir(dataDir, { recursive: true })
  const sanitizedState = sanitizeStateResult(state).state
  const safeState = await mergePersistedSessionHistory(sanitizedState, dataDir)
  await writeSessionHistorySidecars(safeState.sessionHistory, dataDir)
  const lightweightState: AppState = {
    ...safeState,
    sessionHistory: renderSessionHistoryForRenderer(safeState.sessionHistory),
  }
  const content = `${JSON.stringify(lightweightState, null, 2)}\n`

  // Safety: if the new state has no real content but the existing file does,
  // backup and skip the write to avoid silent data loss.
  const hasRealContent =
    safeState.columns.some((col) =>
      Object.values(col.cards).some((card) => card.messages.length > 0),
    ) || safeState.sessionHistory.some((entry) => getSessionHistoryMessageCount(entry) > 0)
  if (!hasRealContent) {
    try {
      const existing = await readFile(getStateFilePathForDir(dataDir), 'utf8')
      if (existing.length > content.length * 2) {
        await backupStateFile(dataDir)
        console.warn('[state-store] Refusing to overwrite content-rich state with empty state.')
        return safeState
      }
    } catch {
      // File doesn't exist yet — safe to write.
    }
  }

  await atomicWriteFile(getStateFilePathForDir(dataDir), content, dataDir)
  await writeStateSnapshot(content, dataDir)
  return setCachedState(lightweightState, dataDir, await getStateDiskStamp(dataDir))
}

export const saveState = async (state: AppState) => saveStateToDataDir(state, getAppDataDir())
export const dismissRecentCrashRecovery = async () => dismissRecentCrashRecoveryForDataDir(getAppDataDir())

export const captureRendererCrash = async (
  request: RendererCrashCaptureRequest,
): Promise<RecentCrashRecovery | null> => {
  const dataDir = getAppDataDir()
  const { state, recovery } = archiveOpenChatsForCrashRecovery(
    sanitizeState(request.state),
    request.message,
  )

  if (!recovery) {
    return null
  }

  const taggedRecovery = (() => {
    const runtimeKind = getCurrentDesktopRuntimeKind()
    return runtimeKind
      ? {
          ...recovery,
          runtimeKind,
        }
      : recovery
  })()

  await saveStateToDataDir(state, dataDir)
  await writeFile(
    getRecentCrashRecoveryFilePath(dataDir),
    `${JSON.stringify(taggedRecovery, null, 2)}\n`,
    'utf8',
  )

  return taggedRecovery
}

export const loadStateForRenderer = async (): Promise<AppStateLoadResponse> => {
  const dataDir = getAppDataDir()
  const state = await loadRendererStartupState(dataDir)
  const recentCrash = await readRecentCrashRecovery(dataDir)
  const interruptedSessions = recentCrash ? null : inspectInterruptedSessionRecovery(state)
  const rendererState = renderInterruptedSessionsAsIdle(state, interruptedSessions)

  // Reuse the sanitized startup state, then trim archived session history before
  // sending it to the renderer so packaged startup does not clone extra data.
  const trimmedRendererState = {
    ...rendererState,
    sessionHistory: renderSessionHistoryForRenderer(rendererState.sessionHistory),
  }

  return {
    state: trimmedRendererState,
    recovery: {
      startup: await inspectStartupRecovery(dataDir),
      recentCrash,
      interruptedSessions,
    },
  }
}

export const loadSessionHistoryEntry = async (request: { entryId: string }) => {
  const dataDir = getAppDataDir()
  const sidecarEntry = await readSessionHistorySidecarEntry(request.entryId, dataDir)
  const entry = sidecarEntry ?? (await loadPersistedSessionHistory(dataDir)).find((item) => item.id === request.entryId)

  if (!entry) {
    throw new Error(`Session history entry not found: ${request.entryId}`)
  }

  return internalSessionHistoryLoadResponseSchema.parse({ entry })
}

export const resolveStateRecoveryOption = async (optionId: string): Promise<AppStateLoadResponse> => {
  const dataDir = getAppDataDir()
  const prompt = await inspectStartupRecovery(dataDir)

  if (!prompt) {
    return loadStateForRenderer()
  }

  const selectedOption = prompt.options.find((option) => option.id === optionId)
  if (!selectedOption) {
    throw new Error(`Unknown state recovery option: ${optionId}`)
  }

  if (selectedOption.source !== 'current-state') {
    const selectedState = await readValidatedStateFile(resolveRecoveryOptionFilePath(dataDir, selectedOption))
    if (!selectedState) {
      throw new Error(`The selected recovery file is no longer valid: ${selectedOption.fileName}`)
    }

    await saveStateToDataDir(selectedState, dataDir)
  }

  await cleanupStartupRecoveryArtifacts(prompt, dataDir)
  return loadStateForRenderer()
}

// ── Queue with async mutex ───────────────────────────────────────────────────

let pendingState: { state: AppState; dataDir: string } | null = null
let latestQueuedStateWrite: Promise<void> = Promise.resolve()

const drainPendingStateWrites = () => withWriteLock(async () => {
  while (pendingState) {
    const toWrite = pendingState
    pendingState = null
    await saveStateToDataDir(toWrite.state, toWrite.dataDir)
  }
})

export const queueSaveState = (state: AppState) => {
  const dataDir = getAppDataDir()
  pendingState = {
    state,
    dataDir,
  }

  const queuedWrite = drainPendingStateWrites()

  latestQueuedStateWrite = queuedWrite.catch(() => undefined)
  return queuedWrite
}

export const waitForPendingStateWrites = async () => {
  while (pendingState) {
    const queuedWrite = drainPendingStateWrites()
    latestQueuedStateWrite = queuedWrite.catch(() => undefined)
    await queuedWrite
  }

  while (true) {
    const activeWrite = latestQueuedStateWrite
    await activeWrite

    if (activeWrite === latestQueuedStateWrite && !pendingState) {
      return
    }
  }
}

export const resetState = async () => {
  await dismissRecentCrashRecoveryForDataDir(getAppDataDir())
  return saveState(createDefaultState(getDefaultWorkspacePath()))
}
