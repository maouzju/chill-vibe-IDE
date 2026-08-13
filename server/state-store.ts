import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { getChatMessageAttachments } from '../shared/chat-attachments.js'
import {
  archiveOpenChatsForCrashRecovery,
  automationBoardSupervisorTemplateId,
  collectAutomationBoardOwnedCardIds,
  createCard,
  createDefaultAutomationBoardSupervisorTemplate,
  createPane,
  createDefaultState,
  resolveRecoveredColumnLayout,
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
  maxSessionHistoryPerWorkspace,
} from '../shared/default-state.js'
import { normalizeBrainstormAnswerCount } from '../shared/brainstorm.js'
import { getWorkspaceTitle } from '../shared/i18n.js'
import { isInterruptedSessionRecoverable } from '../shared/interrupted-session-recovery.js'
import { revealInternalSessionHistorySession } from './session-history-catalog.js'
import {
  AUTOMATIONBOARD_TOOL_MODEL,
  BRAINSTORM_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  TOOL_CARD_MODELS,
  getDefaultModel,
  normalizeStoredModel,
  PM_TOOL_MODEL,
} from '../shared/models.js'
import { normalizeReasoningEffort } from '../shared/reasoning.js'
import {
  appStateSchema,
  automationBoardLanes,
  automationBoardRequirementMaxChars,
  automationBoardWorkspaceStateSchema,
  closedWorkspaceLoadRequestSchema,
  closedWorkspaceSnapshotSchema,
  desktopRuntimeKindSchema,
  internalSessionHistoryLoadResponseSchema,
  legacyAutomationBoardAutoTriggerSchema,
  recentCrashRecoverySchema,
  type AppState,
  type AppStateLoadResponse,
  type AutomationBoardItem,
  type AutomationBoardLane,
  type AutomationBoardComposeDefaults,
  type AutomationBoardLaneWidths,
  type BoardColumn,
  type ChatCard,
  type ClosedWorkspaceLoadRequest,
  type ClosedWorkspaceLoadResponse,
  type ClosedWorkspaceSnapshot,
  type ContextTransfer,
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
import {
  compactPersistedMessages,
  compactSessionHistoryEntryForTransfer,
  maxPersistedCardMessages,
} from './session-history-compaction.js'
import {
  persistCompactedCardHistories,
  pruneResetCompactedCardHistories,
} from './compacted-card-history.js'

type PersistedChatMessage = ChatCard['messages'][number]

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
const closedWorkspaceDirName = 'closed-workspaces'
const closedWorkspaceFileSuffix = '.json'
const legacyWorkspaceCloseBatchWindowMs = 2_000
const legacyRecentCrashRecoveryFileName = 'state.crash-recovery.json'
const rendererSessionHistoryPreviewMessageLimit = 8

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

  const newlyCreated = await Promise.all(
    entries.filter(isFullSessionHistoryEntry).map(async (entry) => {
      const filePath = getSessionHistoryEntryFilePath(entry.id, dataDir)
      const tmpFilePath = `${filePath}.tmp`
      const existed = await stat(filePath).then(() => true).catch(() => false)
      try {
        await writeFile(tmpFilePath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
        await rename(tmpFilePath, filePath)
        return existed ? null : entry
      } catch (error) {
        await unlink(tmpFilePath).catch(() => undefined)
        throw error
      }
    }),
  )

  for (const entry of newlyCreated) {
    if (!entry) continue
    await revealInternalSessionHistorySession({
      provider: entry.provider,
      sessionId: entry.sessionId,
      dataDir,
    }).catch(() => undefined)
  }
}

const readSessionHistorySidecarEntry = async (
  entryId: string,
  dataDir = getAppDataDir(),
): Promise<SessionHistoryEntry | null> => {
  // Builds before the base64url sidecar naming scheme used `<entryId>.json`.
  // Try that exact legacy path directly (only for a single safe basename) so
  // compatibility does not fall back to reading the whole archive directory.
  const candidates = [getSessionHistoryEntryFilePath(entryId, dataDir)]
  if (path.basename(entryId) === entryId) {
    candidates.push(path.join(getSessionHistoryDirPath(dataDir), `${entryId}.json`))
  }

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, 'utf8')
      // No Zod parse on the raw sidecar here: legacy archives can be tens of
      // megabytes and Zod's deep-clone amplification OOMs on large inputs (see
      // sanitizeStateResult). The normalizer plus the schema check that
      // loadSessionHistoryEntry runs on the compacted payload cover validation.
      return normalizePersistedSessionHistoryEntry(JSON.parse(content))
    } catch {
      // Try the next naming convention, if any.
    }
  }

  return null
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
      ? {
          ...entry,
          messageCount,
          messagesPreview: undefined,
          messages: sidecarEntry.messages,
        }
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
const getClosedWorkspaceDirPath = (dataDir = getAppDataDir()) => path.join(dataDir, closedWorkspaceDirName)

const normalizeWorkspacePathKey = (workspacePath: string) =>
  workspacePath.trim().replace(/\\/g, '/').toLowerCase()

const encodeClosedWorkspaceFileName = (workspacePath: string) =>
  `${createHash('sha256').update(normalizeWorkspacePathKey(workspacePath)).digest('hex')}${closedWorkspaceFileSuffix}`

const getClosedWorkspaceFilePath = (workspacePath: string, dataDir = getAppDataDir()) =>
  path.join(getClosedWorkspaceDirPath(dataDir), encodeClosedWorkspaceFileName(workspacePath))

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

// 曾经手抄一份，漏了自动化看板，读档时看板卡就不被当成工具卡。
// 名单只在 shared/models.ts 维护一份。
const persistedToolCardModels = TOOL_CARD_MODELS

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

const normalizeContextTransfer = (value: unknown): ContextTransfer | undefined => {
  if (!isRecord(value) || !isProvider(value.sourceProvider)) {
    return undefined
  }

  const sourceModel = typeof value.sourceModel === 'string' ? value.sourceModel.trim() : ''
  if (!sourceModel) {
    return undefined
  }

  const sourceSessionId =
    typeof value.sourceSessionId === 'string' && value.sourceSessionId.trim()
      ? value.sourceSessionId.trim()
      : undefined

  return {
    sourceProvider: value.sourceProvider,
    sourceModel: normalizeStoredModel(value.sourceProvider, sourceModel),
    ...(sourceSessionId ? { sourceSessionId } : {}),
  }
}

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

const normalizePersistedQueuedSends = (value: unknown): ChatCard['queuedSends'] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((request) => {
    if (
      !isRecord(request) ||
      typeof request.id !== 'string' ||
      !request.id.trim()
    ) {
      return []
    }

    const prompt = typeof request.prompt === 'string' ? request.prompt : ''
    const attachments = normalizePersistedImageAttachments(request.attachments)
    if (!prompt.trim() && attachments.length === 0) {
      return []
    }

    return [{
      id: request.id,
      prompt,
      attachments,
    }]
  })
}

const normalizeWakeTimerMode = (value: unknown): NonNullable<ChatCard['wakeTimerMode']> =>
  value === 'left-tab' || value === 'duration' ? value : 'workspace-agents'

const normalizeWakeTimerDurationMinutes = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, 1), 7 * 24 * 60)
    : 30

const normalizeWakeTimerDate = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined
  }

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

const normalizeWakeTimerTargetIds = (value: unknown) =>
  Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())))]
    : []

const canContainClaudeProtocolResidue = (message: PersistedChatMessage) => {
  if (message.role !== 'assistant') return false
  if (message.meta?.kind) return false
  if (message.meta?.imageAttachments) return false

  return true
}

// Exported for tests.
export const stripPersistedClaudeProtocolResidueLines = (content: string) =>
  content
    .replace(/(?:[ \t]*(?:\r?\n|^)[ \t]*(?:call:?|court|course|card|课){1,3}[ \t]*(?:\r?\n)?)+$/iu, '')
    .replace(/(?:[ \t]*(?:\r?\n|^)[ \t]*count[ \t]*(?:\r?\n)?)+$/iu, '')
    .trim()

const sanitizePersistedClaudeProtocolResidue = (
  message: PersistedChatMessage,
): PersistedChatMessage | null => {
  if (!canContainClaudeProtocolResidue(message)) {
    return message
  }

  const content = message.meta?.provider === 'claude'
    ? stripPersistedClaudeProtocolResidueLines(message.content)
    : message.content

  if (!content) {
    return null
  }

  return content === message.content ? message : { ...message, content }
}

const normalizePersistedMessage = (
  message: unknown,
  index: number,
): PersistedChatMessage => {
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

  return normalized as PersistedChatMessage
}

const normalizePersistedMessages = (messages: unknown): ChatCard['messages'] =>
  Array.isArray(messages)
    ? messages.flatMap((message, index) => {
        const normalized = sanitizePersistedClaudeProtocolResidue(
          normalizePersistedMessage(message, index),
        )
        return normalized ? [normalized] : []
      })
    : []

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

const normalizePersistedAutomationBoardLane = (value: unknown): AutomationBoardLane =>
  value === 'running' || value === 'done' ? value : 'standby'

/**
 * 泳道宽度是三个权重，只有相对大小有意义。任何一条不可用（0 / 负 / NaN / 手改坏
 * 的存档）就整组丢弃回默认均分：一条 0 宽的泳道彻底不可见，而且没有任何 UI 能把
 * 它拖回来。判定与渲染侧 `resolveAutomationBoardLaneWidths` 必须一致。
 */
const normalizePersistedAutomationBoardLaneWidths = (
  value: unknown,
): AutomationBoardLaneWidths | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  const widths = automationBoardLanes.map((lane) => value[lane])

  if (widths.some((width) => typeof width !== 'number' || !Number.isFinite(width) || width <= 0)) {
    return undefined
  }

  return {
    standby: widths[0] as number,
    running: widths[1] as number,
    done: widths[2] as number,
  }
}

/**
 * 「加入待命」输入区记住的执行参数。这里刻意**不**校验 model / reasoningEffort
 * 的具体取值：档位随 provider 与 model 变（见 shared/reasoning.ts），渲染侧本来
 * 就要做一次 model 感知归一化，在存储层再判一次只会两处规则漂移。存不下来的只有
 * 类型不对的值。
 */
const normalizePersistedAutomationBoardComposeDefaults = (
  value: unknown,
): AutomationBoardComposeDefaults | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  return {
    provider: value.provider === 'claude' ? 'claude' : 'codex',
    model: typeof value.model === 'string' ? value.model : '',
    reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : '',
    thinkingEnabled: value.thinkingEnabled !== false,
    planMode: value.planMode === true,
    adminAccess: value.adminAccess === true,
  }
}

const normalizePersistedAutomationBoard = (value: unknown): ChatCard['automationBoard'] => {
  const record = isRecord(value) ? value : {}
  const rawItems = Array.isArray(record.items) ? record.items : []
  const seen = new Set<string>()
  const items: AutomationBoardItem[] = []

  for (const entry of rawItems) {
    if (!isRecord(entry)) {
      continue
    }

    const cardId = typeof entry.cardId === 'string' ? entry.cardId.trim() : ''
    if (!cardId || seen.has(cardId)) {
      continue
    }

    seen.add(cardId)
    items.push({
      cardId,
      lane: normalizePersistedAutomationBoardLane(entry.lane),
      requirement:
        typeof entry.requirement === 'string'
          ? entry.requirement.slice(0, automationBoardRequirementMaxChars)
          : '',
      templateId: typeof entry.templateId === 'string' ? entry.templateId : '',
      createdAt: normalizeWakeTimerDate(entry.createdAt),
      startedAt: normalizeWakeTimerDate(entry.startedAt),
      completedAt: normalizeWakeTimerDate(entry.completedAt),
    })
  }

  // v2 起看板 blob 只剩 items 与 laneWidths：v1 的 supervisorCardId /
  // supervisorExpanded 在这里被静默丢弃（"监工"已经是一个普通模板 + 普通看板项，
  // 没有专属指针）。
  //
  // 这个函数是**手抄字段**的，所以每加一个看板 blob 字段都必须在这里显式带上，
  // 否则存一次盘就被剥掉 —— 症状是"拖完宽度，重启又变回均分"（pitfall 5）。
  const laneWidths = normalizePersistedAutomationBoardLaneWidths(record.laneWidths)
  const composeDefaults = normalizePersistedAutomationBoardComposeDefaults(record.composeDefaults)
  // 与需求项同一个上限：这里存的就是还没变成项的那段文本。
  const draft =
    typeof record.draft === 'string' ? record.draft.slice(0, automationBoardRequirementMaxChars) : ''

  return {
    items,
    ...(laneWidths ? { laneWidths } : {}),
    ...(composeDefaults ? { composeDefaults } : {}),
    ...(draft ? { draft } : {}),
  }
}

/**
 * 同 id 的模板只留一条。
 *
 * 上面的补种判据修好之后新存档不会再产生重复，但已经被写进磁盘的那些重复
 * 不会自己消失 —— 而模板的每一个写操作（删除/改名/改配置）都按 id 匹配，
 * 重复 id 意味着用户点一次删除会一次删掉两条。所以加载时就地收敛。
 *
 * 保留**后出现**的那条：重复只可能由"补种 unshift 到开头"造成，排在后面的
 * 才是用户自己调过的原件；位置则保持第一次出现处，免得模板栏顺序无故跳动。
 */
const dedupeTemplatesById = (templates: unknown[]): unknown[] => {
  const slotById = new Map<string, number>()
  const result: unknown[] = []

  for (const template of templates) {
    const id = isRecord(template) && typeof template.id === 'string' ? template.id : ''
    const slot = id ? slotById.get(id) : undefined

    if (slot === undefined) {
      if (id) {
        slotById.set(id, result.length)
      }
      result.push(template)
      continue
    }

    result[slot] = template
  }

  return result
}

/**
 * v1 的工作区级 `autoTrigger` 一次性折进内置监工模板。
 *
 * 症状：v1 存档里"自动触发监工"的配置挂在工作区上，v2 读不到就等于用户悄悄
 * 丢了一份已经开着的自动化。
 * 根因：v2 把触发器搬成了模板的字段（每个模板各自一套），两边形状不兼容。
 * 被否决的替代：给 state 加一个 `automationBoardsMigratedV2` 持久标记来精确
 * 判断"用户是不是自己删了内置模板"。一个只用一次的全局标记要污染 schema、
 * 要在每条写路径上维护，不划算；这里改用"结构性证据"做同等判断 ——
 * **只有**该工作区 entry 没有 `templates` 字段（= 首次出现的旧存档）或还带着
 * 待迁移的 `autoTrigger` 时才补种内置模板。已经有 `templates` 数组（哪怕是空
 * 数组，意味着用户把内置模板删干净了）且没有 autoTrigger 的，一律不种。
 */
const migratePersistedAutomationBoardWorkspace = (
  record: Record<string, unknown>,
  language: AppState['settings']['language'],
): unknown => {
  // `autoTrigger` 绝不再写回：从这里起它就不在返回值里了。
  const rest = { ...record }
  delete rest.autoTrigger

  if ('templates' in record && !Array.isArray(record.templates)) {
    // 写坏了的条目照旧交给 safeParse 拒掉（调用方跳过它），补种默认模板等于
    // 把一条损坏记录洗成一条看着正常的记录，反而掩盖问题。
    return rest
  }

  const legacyAutoTrigger = legacyAutomationBoardAutoTriggerSchema.safeParse(record.autoTrigger)
  const hasLegacyAutoTrigger = isRecord(record.autoTrigger) && legacyAutoTrigger.success
  const hasTemplatesField = Array.isArray(record.templates)
  const templates = hasTemplatesField ? [...(record.templates as unknown[])] : []

  // 症状：模板栏里出现两条同名「看板监工」，删掉一条另一条也跟着消失（08-12）。
  // 根因：判据只认 `builtIn === true`，而旧存档写下的那条监工**没有** builtIn
  // 字段（schema 的 `.default(false)` 在 parse 时才补，这次迁移跑在 parse
  // **之前**），于是又 unshift 了一条 **id 完全相同**的默认监工；删除按 id
  // filter，一次自然删两条。
  // 为什么不能换写法：内置监工的身份是那个硬编码 id，不是 `builtIn` 标志位 ——
  // 只要 id 已经在，就绝不能再种一条。builtIn 仍参与判断，是为了兜住"用户把
  // 内置模板改名换 id"这种理论上的旧数据。
  const hasBuiltIn = templates.some(
    (template) =>
      isRecord(template) &&
      (template.builtIn === true || template.id === automationBoardSupervisorTemplateId),
  )
  const shouldSeed = !hasBuiltIn && (!hasTemplatesField || hasLegacyAutoTrigger)

  if (shouldSeed) {
    // 补种放数组开头：内置监工是这一列的"总管"，用户自己的模板保序跟在后面。
    templates.unshift(createDefaultAutomationBoardSupervisorTemplate(language))
  }

  if (hasLegacyAutoTrigger) {
    const legacy = legacyAutoTrigger.data
    const index = templates.findIndex(
      (template) => isRecord(template) && template.id === automationBoardSupervisorTemplateId,
    )

    if (index >= 0) {
      const target = templates[index] as Record<string, unknown>
      const trigger = isRecord(target.trigger) ? target.trigger : {}

      templates[index] = {
        ...target,
        ...(legacy.requirement !== undefined ? { requirement: legacy.requirement } : {}),
        ...(legacy.provider !== undefined ? { provider: legacy.provider } : {}),
        ...(legacy.model !== undefined ? { model: legacy.model } : {}),
        ...(legacy.reasoningEffort !== undefined ? { reasoningEffort: legacy.reasoningEffort } : {}),
        trigger: {
          ...trigger,
          ...(legacy.enabled !== undefined ? { enabled: legacy.enabled } : {}),
          ...(legacy.minIntervalMinutes !== undefined
            ? { minIntervalMinutes: legacy.minIntervalMinutes }
            : {}),
        },
      }
    }
  }

  return { ...rest, templates: dedupeTemplatesById(templates) }
}

const normalizePersistedAutomationBoardWorkspaces = (
  raw: unknown,
  language: AppState['settings']['language'],
): AppState['automationBoards'] => {
  if (!isRecord(raw)) {
    return {}
  }

  const result: AppState['automationBoards'] = {}

  for (const [workspacePath, value] of Object.entries(raw)) {
    if (!workspacePath.trim()) {
      continue
    }

    // 坏条目跳过而不是让整次加载失败（pitfall 5）：一个工作区的模板写坏了
    // 不该拖垮其它工作区。
    const parsed = automationBoardWorkspaceStateSchema.safeParse(
      isRecord(value) ? migratePersistedAutomationBoardWorkspace(value, language) : value,
    )
    if (parsed.success) {
      result[workspacePath] = parsed.data
    }
  }

  return result
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
  // Image-bearing chats keep their session so restart resumes natively rather
  // than forcing a fresh-session replay that re-stat-s every historical
  // attachment (collectSeededChatAttachments → resolveImageAttachmentPath, which
  // can throw "Attachment not found."). Native resume (`claude -r` / codex exec
  // resume) replays from the provider's own transcript and only carries the
  // current turn's attachmentPaths. getResumeSessionIdForModel still gates resume
  // on a matching sessionModel, and provider-stream-recovery's stale → fresh
  // fallback still covers a genuinely broken resume (AGENTS.md pitfalls 47/105/118).
  const providerSessions = normalizeStringRecord(card.providerSessions)
  const sessionId = normalizeOptionalString(card.sessionId)
  const sessionModel = normalizeOptionalString(card.sessionModel)
  const contextTransfer = normalizeContextTransfer(card.contextTransfer)
  const streamId = hasRecoverableStream ? normalizeOptionalString(card.streamId) : undefined

  return {
    ...fallback,
    id,
    title: typeof card.title === 'string' ? card.title : fallback.title,
    sessionId,
    sessionModel,
    providerSessions,
    contextTransfer,
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
    repeatLoopActive: typeof card.repeatLoopActive === 'boolean' ? card.repeatLoopActive : false,
    repeatLoopRemaining:
      typeof card.repeatLoopRemaining === 'number' && Number.isInteger(card.repeatLoopRemaining) && card.repeatLoopRemaining >= 0
        ? card.repeatLoopRemaining
        : undefined,
    collapsed: typeof card.collapsed === 'boolean' ? card.collapsed : fallback.collapsed,
    unread: typeof card.unread === 'boolean' ? card.unread : fallback.unread,
    draft: typeof card.draft === 'string' ? card.draft : fallback.draft,
    draftAttachments: normalizePersistedImageAttachments(card.draftAttachments),
    queuedSends: normalizePersistedQueuedSends(card.queuedSends),
    wakeTimerActive: typeof card.wakeTimerActive === 'boolean' ? card.wakeTimerActive : false,
    wakeTimerMode: normalizeWakeTimerMode(card.wakeTimerMode),
    wakeTimerDurationMinutes: normalizeWakeTimerDurationMinutes(card.wakeTimerDurationMinutes),
    wakeTimerQueuedSends: normalizePersistedQueuedSends(card.wakeTimerQueuedSends),
    wakeTimerArmedAt: normalizeWakeTimerDate(card.wakeTimerArmedAt),
    wakeTimerWakeAt: normalizeWakeTimerDate(card.wakeTimerWakeAt),
    wakeTimerPendingTargetIds: normalizeWakeTimerTargetIds(card.wakeTimerPendingTargetIds),
    stickyNote: typeof card.stickyNote === 'string' ? card.stickyNote : fallback.stickyNote,
    stickyNoteId:
      normalizedModel === STICKYNOTE_TOOL_MODEL
        ? normalizeOptionalString(card.stickyNoteId) ?? id
        : normalizeOptionalString(card.stickyNoteId),
    stickyNoteViewState: isRecord(card.stickyNoteViewState)
      ? {
          scrollTop: Math.max(
            0,
            typeof card.stickyNoteViewState.scrollTop === 'number' && Number.isFinite(card.stickyNoteViewState.scrollTop)
              ? card.stickyNoteViewState.scrollTop
              : 0,
          ),
          selectionStart: Math.max(
            0,
            Math.trunc(
              typeof card.stickyNoteViewState.selectionStart === 'number' && Number.isFinite(card.stickyNoteViewState.selectionStart)
                ? card.stickyNoteViewState.selectionStart
                : 0,
            ),
          ),
          selectionEnd: Math.max(
            0,
            Math.trunc(
              typeof card.stickyNoteViewState.selectionEnd === 'number' && Number.isFinite(card.stickyNoteViewState.selectionEnd)
                ? card.stickyNoteViewState.selectionEnd
                : 0,
            ),
          ),
        }
      : undefined,
    brainstorm: normalizePersistedBrainstorm(card.brainstorm, fallback.brainstorm),
    pm: normalizePersistedPm(card.pm, fallback.pm),
    pmTaskCardId: '',
    pmOwnerCardId: '',
    // A board blob only means anything on a board card. Repairing it here (as
    // opposed to letting Zod reject the card) keeps a partially-written board
    // from taking the whole workspace column down on load.
    automationBoard:
      normalizedModel === AUTOMATIONBOARD_TOOL_MODEL
        ? normalizePersistedAutomationBoard(card.automationBoard)
        : undefined,
    // 卡片级超管权限（v2 取代了看板上的 supervisorCardId 指针）。optional 而非
    // default：绝大多数卡片没有它，不给每张卡在 state.json 里加一个 false。
    adminAccess: card.adminAccess === true ? true : undefined,
    // 模板血缘：项被拖出看板时盖在卡片上，拖回来时读回去还原 item.templateId。
    // 这个 return 是**手抄白名单**，漏掉它就等于每存一次盘剥一次血缘 —— 症状是
    // 重启后拖回看板的监工实例 templateId 变空串，触发器的防自触发守卫
    // （automation-board-auto-trigger.ts 里 `settledItem.templateId === template.id`）
    // 随之短路，监工每次结算都自己触发自己（2026-08-13 审计发现）。
    automationBoardTemplateId: normalizeOptionalString(card.automationBoardTemplateId),
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
    sessionModel: normalizeOptionalString(entry.sessionModel),
    contextTransfer: normalizeContextTransfer(entry.contextTransfer),
    provider,
    model: typeof entry.model === 'string' ? normalizeStoredModel(provider, entry.model) : getDefaultModel(provider),
    workspacePath,
    messages,
    messageCount,
    messagesPreview: typeof entry.messagesPreview === 'boolean' ? entry.messagesPreview : undefined,
    workspaceCloseId: normalizeOptionalString(entry.workspaceCloseId),
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

// 症状：数据目录 2026-08-11 实测积压 100 个临时文件共 556.8 MB，最早可追到 2026-04-13，
// 体积全部卡在 512KB 的整数倍上——写到一半被强杀留下的孤儿。
// 根因：atomicWriteFile 只在 catch 分支 unlink，进程被外部强杀时根本执行不到，
// 而全仓库此前没有任何一处回收它们。
// 24 小时的下限不能调小：一次正常保存以毫秒计，任何还"年轻"的 .tmp 都可能是
// 另一个进程正在写的中间态，删掉它等于打断一次真实保存。
const orphanedTempFileMaxAgeMs = 24 * 60 * 60 * 1000

const isOrphanedTempFileName = (fileName: string) =>
  fileName.startsWith('state.tmp.') || fileName.endsWith('.tmp')

export const pruneOrphanedTempFiles = async (
  dataDir = getAppDataDir(),
  maxAgeMs = orphanedTempFileMaxAgeMs,
) => {
  const cutoffMs = Date.now() - maxAgeMs
  let removed = 0

  for (const dir of [dataDir, getSessionHistoryDirPath(dataDir), getClosedWorkspaceDirPath(dataDir)]) {
    const fileNames = await readdir(dir).catch(() => [] as string[])

    for (const fileName of fileNames) {
      if (!isOrphanedTempFileName(fileName)) {
        continue
      }

      const filePath = path.join(dir, fileName)
      const info = await stat(filePath).catch(() => null)
      if (!info?.isFile() || info.mtimeMs > cutoffMs) {
        continue
      }

      try {
        await unlink(filePath)
        removed += 1
      } catch {
        // Best-effort reclamation: a locked orphan is retried next launch.
      }
    }
  }

  return removed
}

// 按 dataDir 记而不是用一个全局开关：测试各自建临时目录，全局开关会让第二个用例
// 静默跳过回收，从而把一个真实回归伪装成通过。
const startedOrphanedTempCleanupDirs = new Set<string>()

const startOrphanedTempCleanupOnce = (dataDir: string) => {
  if (startedOrphanedTempCleanupDirs.has(dataDir)) {
    return
  }

  startedOrphanedTempCleanupDirs.add(dataDir)
  // 不 await：回收要扫 session-history（真实档案 9,203 个文件），
  // 挂在启动路径上会白白拖慢冷启动，而这些孤儿多留一会儿没有任何害处。
  void pruneOrphanedTempFiles(dataDir)
    .then((removed) => {
      if (removed > 0) {
        console.info(`[state-store] Reclaimed ${removed} orphaned temp file(s).`)
      }
    })
    .catch(() => {
      // Best-effort reclamation: retried on the next launch.
    })
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
          ...(card.sessionModel?.trim() ? { sessionModel: card.sessionModel.trim() } : {}),
          recoverable: isInterruptedSessionRecoverable({
            sessionId: card.sessionId,
            sessionModel: card.sessionModel,
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
  // `column.model` 是"这一列下一张新卡用哪个模型"的种子，工具卡模型放进去非法。
  // 已有存档被写脏过（看板漏出白名单，见 shared/models.ts TOOL_CARD_MODELS），
  // 而 normalizeStoredModel 会原样保留它 —— 不在这里拦，读档就把脏值带回来，
  // 还会经 columnModel 兜底传给缺 model 字段的卡，把它们也变成看板空壳。
  const normalizedColumnModel = TOOL_CARD_MODELS.has(rawColumnModel.trim())
    ? configuredModel
    : normalizeStoredModel(provider, rawColumnModel) || configuredModel
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
  // 症状：自动化看板的需求卡会突然全部变成 tab。
  // 根因：一张看板项卡片是刻意"存在于 column.cards 但不在任何 pane.tabs 里"的
  //   （见 docs/specs/automation-board/design.md）。下面那条空 layout 兜底会把
  //   Object.keys(cards) 整个塞进一个 pane，把它们全部曝光成 tab。
  // 被否决：让看板项存在 cards 之外的容器里——那会让它们错过消息裁剪、
  //   structuredData 压缩、sidecar 归档和 attachStreamsForState 重连这一整套。
  const boardOwnedCardIds = collectAutomationBoardOwnedCardIds(cards)

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
    layout: resolveRecoveredColumnLayout(layout, cards, boardOwnedCardIds),
    cards,
  }
}

const normalizePersistedStickyNoteArchive = (raw: unknown): AppState['stickyNoteArchive'] => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }

  const result: AppState['stickyNoteArchive'] = {}
  for (const [workspacePath, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!workspacePath || !entry || typeof entry !== 'object') {
      continue
    }
    const content = (entry as { content?: unknown }).content
    if (typeof content !== 'string' || !content) {
      continue
    }
    const updatedAt = (entry as { updatedAt?: unknown }).updatedAt
    const rawViewState = (entry as { viewState?: unknown }).viewState
    const viewState =
      rawViewState && typeof rawViewState === 'object' && !Array.isArray(rawViewState)
        ? {
            scrollTop: Math.max(0, Number((rawViewState as { scrollTop?: unknown }).scrollTop) || 0),
            selectionStart: Math.max(
              0,
              Math.round(Number((rawViewState as { selectionStart?: unknown }).selectionStart) || 0),
            ),
            selectionEnd: Math.max(
              0,
              Math.round(Number((rawViewState as { selectionEnd?: unknown }).selectionEnd) || 0),
            ),
          }
        : undefined
    result[workspacePath] = {
      content,
      updatedAt: typeof updatedAt === 'string' ? updatedAt : new Date().toISOString(),
      viewState,
    }
  }

  return result
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
    stickyNoteArchive: normalizePersistedStickyNoteArchive(data.stickyNoteArchive),
    automationBoards: normalizePersistedAutomationBoardWorkspaces(
      data.automationBoards,
      safeSettings.language,
    ),
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
              // Image-bearing chats keep their session so restart resumes natively
              // (see normalizePersistedCard above) — no longer dropped here.
              sessionId: card.sessionId,
              sessionModel: card.sessionModel,
              providerSessions: card.providerSessions,
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

      return {
        ...entry,
        // Archived session bodies are the durable source of truth. Unlike live
        // cards, they must never be tail-trimmed before their first sidecar is
        // written, or the discarded prefix cannot be recovered later.
        messages: compactedMessages.messages,
      }
    }),
  }

  return {
    state,
    didCompactStructuredData,
  }
}

const sanitizeState = (raw: unknown): AppState => sanitizeStateResult(raw).state

const normalizeClosedWorkspaceColumn = (column: BoardColumn) => {
  const fallbackState = createDefaultState(column.workspacePath)
  const normalized = sanitizeStateResult({
    ...fallbackState,
    columns: [column],
    sessionHistory: [],
  }).state.columns[0]

  if (!normalized) {
    throw new Error('Closed workspace snapshot does not contain a valid column.')
  }

  return {
    ...normalized,
    cards: Object.fromEntries(
      Object.entries(normalized.cards).map(([cardId, card]) => [
        cardId,
        {
          ...card,
          status: card.status === 'streaming' ? 'idle' : card.status,
          streamId: undefined,
        },
      ]),
    ),
  }
}

const getLegacyClosedWorkspaceEntryIds = (
  entries: SessionHistoryEntry[],
  workspacePath: string,
) => {
  const workspaceKey = normalizeWorkspacePathKey(workspacePath)
  const candidates = entries
    .filter((entry) => normalizeWorkspacePathKey(entry.workspacePath) === workspaceKey)
    .slice()
    .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt))

  const newest = candidates[0]
  if (!newest) {
    return []
  }

  if (newest.workspaceCloseId) {
    return candidates
      .filter((entry) => entry.workspaceCloseId === newest.workspaceCloseId)
      .map((entry) => entry.id)
  }

  const newestTimestamp = Date.parse(newest.archivedAt)
  if (!Number.isFinite(newestTimestamp)) {
    return [newest.id]
  }

  return candidates
    .filter((entry) => {
      const timestamp = Date.parse(entry.archivedAt)
      return Number.isFinite(timestamp) && newestTimestamp - timestamp <= legacyWorkspaceCloseBatchWindowMs
    })
    .map((entry) => entry.id)
}

export const saveClosedWorkspaceSnapshot = async (
  snapshot: ClosedWorkspaceSnapshot,
): Promise<ClosedWorkspaceSnapshot> => {
  const parsed = closedWorkspaceSnapshotSchema.parse(snapshot)
  const normalizedSnapshot = closedWorkspaceSnapshotSchema.parse({
    ...parsed,
    column: normalizeClosedWorkspaceColumn(parsed.column),
  })
  const dataDir = getAppDataDir()
  const sidecarDir = getClosedWorkspaceDirPath(dataDir)
  const filePath = getClosedWorkspaceFilePath(normalizedSnapshot.column.workspacePath, dataDir)
  const tmpFilePath = `${filePath}.tmp`

  await mkdir(sidecarDir, { recursive: true })
  try {
    await writeFile(tmpFilePath, `${JSON.stringify(normalizedSnapshot, null, 2)}\n`, 'utf8')
    await rename(tmpFilePath, filePath)
  } catch (error) {
    await unlink(tmpFilePath).catch(() => undefined)
    throw error
  }

  return normalizedSnapshot
}

export const loadClosedWorkspaceSnapshot = async (
  request: ClosedWorkspaceLoadRequest,
): Promise<ClosedWorkspaceLoadResponse> => {
  const parsed = closedWorkspaceLoadRequestSchema.parse(request)
  const dataDir = getAppDataDir()
  const filePath = getClosedWorkspaceFilePath(parsed.workspacePath, dataDir)

  try {
    const content = await readFile(filePath, 'utf8')
    const snapshot = closedWorkspaceSnapshotSchema.parse(JSON.parse(content))
    if (
      normalizeWorkspacePathKey(snapshot.column.workspacePath) ===
      normalizeWorkspacePathKey(parsed.workspacePath)
    ) {
      return {
        snapshot: {
          ...snapshot,
          column: normalizeClosedWorkspaceColumn(snapshot.column),
        },
        legacyEntryIds: [],
      }
    }
  } catch {
    // Older versions have no closed-workspace sidecar. Fall through to the
    // bounded history-batch inference so those chats can still be reopened.
  }

  // 症状：旧版没有 closed-workspace sidecar 时，普通“关闭/重开工作区”会
  //   直接走 loadState()，把整个 session-history 目录重新水合进主进程。
  // 根因：2026-08-06 现场已有 8,863 个 sidecar、约 974MB；一次兼容性回退就足以
  //   让 Electron 主进程瞬时暴涨并无日志闪退。
  // 被否决：限制并发或删历史——前者掩盖根因，后者会损害用户数据；这里只读轻量索引。
  const sessionHistory = await loadPersistedSessionHistoryIndex(dataDir)
  return {
    snapshot: null,
    legacyEntryIds: getLegacyClosedWorkspaceEntryIds(sessionHistory, parsed.workspacePath),
  }
}

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
// The full archived messages stay in sidecar files and are loaded on demand.
const preTrimMaxCardMessages = 300

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

  // Do not pre-trim legacy sessionHistory. Its first successful save is the
  // only opportunity to migrate the complete transcript into a sidecar.
}

// ── Public API ────────────────────────────────────────────────────────────────

export const loadState = async () => {
  const dataDir = getAppDataDir()
  startOrphanedTempCleanupOnce(dataDir)
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

/**
 * Lightweight index read for merge decisions: cached lightweight state first,
 * then the raw state.json history array. Never hydrates session-history
 * sidecars — crash capture must stay cheap even on multi-thousand-entry
 * archives (see loadSessionHistorySidecars memory pitfalls).
 */
const loadPersistedSessionHistoryIndex = async (dataDir = getAppDataDir()): Promise<SessionHistoryEntry[]> => {
  const cachedSessionHistory = getCachedStateEntry(dataDir)?.state.sessionHistory
  if (Array.isArray(cachedSessionHistory) && cachedSessionHistory.length > 0) {
    return cachedSessionHistory
  }

  try {
    // Keep the lightweight fallback WAL-aware without hydrating sidecars. A
    // valid WAL is already a complete state payload; promoting it here keeps
    // crash recovery semantics while avoiding the all-sidecar scan below.
    const walRecovered = await recoverFromWal(dataDir)
    if (walRecovered) {
      return walRecovered.sessionHistory
    }

    const file = await readFile(getStateFilePathForDir(dataDir), 'utf8')
    const raw = JSON.parse(file) as Record<string, unknown>
    return normalizePersistedSessionHistory(raw.sessionHistory)
  } catch {
    return []
  }
}

const capSessionHistoryPerWorkspace = (entries: SessionHistoryEntry[]): SessionHistoryEntry[] => {
  const counts = new Map<string, number>()
  return entries.filter((entry) => {
    const key = entry.workspacePath.toLowerCase()
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    return count <= maxSessionHistoryPerWorkspace
  })
}

/**
 * The renderer crash payload deliberately trims heavy state before crossing
 * IPC, and historically it also sliced the session-history index — persisting
 * that truncated index verbatim permanently dropped older archived sessions
 * from state.json (real data loss on 2026-07-04). Union the incoming index
 * with what is already on disk so a crash save can only add entries, never
 * silently forget them. Incoming entries keep their order (newest first);
 * disk-only entries are appended behind them, then the per-workspace cap is
 * re-applied.
 */
const mergeMissingPersistedHistoryEntries = (
  incoming: SessionHistoryEntry[],
  persisted: SessionHistoryEntry[],
): SessionHistoryEntry[] => {
  const seen = new Set(incoming.map((entry) => entry.id))
  const missing = persisted.filter((entry) => !seen.has(entry.id))
  if (missing.length === 0) {
    return incoming
  }

  return capSessionHistoryPerWorkspace([...incoming, ...missing])
}

const mergePersistedSessionHistory = async (state: AppState, dataDir: string): Promise<AppState> => {
  // Renderer startup intentionally receives lightweight history previews while
  // the full archived transcripts live in session-history sidecar files. Saving
  // that renderer state must not hydrate every sidecar back into the main
  // process: large real profiles can carry tens of megabytes of archives, and a
  // routine send/save would otherwise spike packaged Electron memory and exit.
  //
  // Full entries in the incoming state are still written below by
  // writeSessionHistorySidecars(). Preview entries are merged only against the
  // in-process full cache when available; otherwise they stay lightweight in
  // state.json and continue to resolve through their existing sidecar on demand.
  const cachedStateEntry = getCachedStateEntry(dataDir)
  if (
    !cachedStateEntry ||
    cachedStateEntry.sessionHistoryMode !== 'full' ||
    cachedStateEntry.state.sessionHistory.length === 0 ||
    state.sessionHistory.every(isFullSessionHistoryEntry)
  ) {
    return state
  }

  const cachedEntriesById = new Map(
    cachedStateEntry.state.sessionHistory
      .filter(isFullSessionHistoryEntry)
      .map((entry) => [entry.id, entry] as const),
  )

  if (cachedEntriesById.size === 0) {
    return state
  }

  return {
    ...state,
    sessionHistory: state.sessionHistory.map((entry) => {
      if (isFullSessionHistoryEntry(entry)) {
        return entry
      }

      const cachedEntry = cachedEntriesById.get(entry.id)
      const messageCount = getSessionHistoryMessageCount(entry)
      if (!cachedEntry || getSessionHistoryMessageCount(cachedEntry) < messageCount) {
        return entry
      }

      return {
        ...entry,
        messageCount,
        messagesPreview: undefined,
        messages: cachedEntry.messages,
      }
    }),
  }
}

const saveStateToDataDir = async (
  state: AppState,
  dataDir: string,
  options: { allowEmptyOverwrite?: boolean } = {},
) => {
  await mkdir(dataDir, { recursive: true })
  // 症状：多轮 /compact 后，最早历史会被活动卡片 500 条上限永久裁掉。
  // 根因：2026-07-27 实测保存前仍有完整前缀，但 sanitize 先 slice 再落盘。
  // 不能取消上限，否则巨型隐藏历史会重新进入 state.json/IPC；详见 archive-recall-mcp SPEC。
  await persistCompactedCardHistories(state, dataDir).catch((error) => {
    console.warn('[state-store] Failed to persist compacted card history:', error)
  })
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
  if (!hasRealContent && !options.allowEmptyOverwrite) {
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
  // 症状：重置同一卡片后再次 /compact，会把旧会话 sidecar 拼进新会话。
  // 根因：cardId 会复用，而累计归档此前从不随显式空会话落盘清理。
  // 不能在空状态保护前删除，否则一次损坏的空保存会先删归档；详见 compacted-history-scroll-recovery SPEC。
  await pruneResetCompactedCardHistories(state, dataDir).catch((error) => {
    console.warn('[state-store] Failed to prune reset compacted card history:', error)
  })
  if (!shouldSkipRoutineStateSnapshot()) {
    await writeStateSnapshot(content, dataDir)
  }
  return setCachedState(lightweightState, dataDir, await getStateDiskStamp(dataDir))
}

const saveStateToDataDirWithLock = async (state: AppState, dataDir: string) =>
  withWriteLock(() => saveStateToDataDir(state, dataDir))

export const saveState = async (state: AppState) => {
  const dataDir = getAppDataDir()
  latestImmediateSaveRevision = ++stateSaveRevision
  return saveStateToDataDirWithLock(state, dataDir)
}
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

  // The crash payload's history index may be incomplete (renderer-side
  // trimming, partial state at crash time) — union it with the on-disk index
  // before persisting so the crash save never erases older archived sessions.
  state.sessionHistory = mergeMissingPersistedHistoryEntries(
    state.sessionHistory,
    await loadPersistedSessionHistoryIndex(dataDir),
  )

  const taggedRecovery = (() => {
    const runtimeKind = getCurrentDesktopRuntimeKind()
    return runtimeKind
      ? {
          ...recovery,
          runtimeKind,
        }
      : recovery
  })()

  await saveStateToDataDirWithLock(state, dataDir)
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
  // A missing sidecar is a legacy/corruption case, not permission to read all
  // archived transcripts. The state index still carries the entry metadata and
  // preview; returning that bounded fallback keeps recovery usable without
  // repeating the 974MB sidecar fan-out described above.
  const entry = sidecarEntry ?? (await loadPersistedSessionHistoryIndex(dataDir)).find((item) => item.id === request.entryId)

  if (!entry) {
    throw new Error(`Session history entry not found: ${request.entryId}`)
  }

  // Cap the restore payload like live cards before it crosses the IPC bridge —
  // the on-disk sidecar keeps the full archive, but shipping a legacy oversized
  // transcript to the renderer can freeze or OOM the app on open.
  return internalSessionHistoryLoadResponseSchema.parse({
    entry: compactSessionHistoryEntryForTransfer(entry),
  })
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

    await saveStateToDataDirWithLock(selectedState, dataDir)
  }

  await cleanupStartupRecoveryArtifacts(prompt, dataDir)
  return loadStateForRenderer()
}

// ── Queue with async mutex and dynamic circuit breaker ───────────────────────

type PendingStateWrite = { state: AppState; dataDir: string; revision: number }
type PendingStateDrainOptions = {
  force?: boolean
}
type ScheduledStateDrain = {
  dueAtMs: number
  timer: ReturnType<typeof setTimeout>
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

const stateSaveCircuitRequestWindowMs = 10_000
const maxStateSaveRequestsPerWindow = 24
const stateSaveCircuitCooldownMs = 10_000
const slowStateSaveDurationMs = 1_500
const maxConsecutiveSlowStateSaves = 2
const maxPendingStateReplacements = 10
const circuitStateSaveSnapshotMinIntervalMs = 60_000

let pendingState: PendingStateWrite | null = null
let latestQueuedStateWrite: Promise<void> = Promise.resolve()
let activePendingStateDrain: Promise<void> | null = null
let scheduledStateDrain: ScheduledStateDrain | null = null
let stateSaveCircuitOpenUntilMs = 0
let stateSaveRequestTimes: number[] = []
let lastStateSaveRequestAtMs = 0
let consecutiveSlowStateSaves = 0
let pendingStateReplacementCount = 0
let lastCircuitStateSaveSnapshotAtMs = 0
let stateSaveRevision = 0
let latestImmediateSaveRevision = 0

const getStateSaveCircuitDelayMs = (now = Date.now()) =>
  Math.max(0, stateSaveCircuitOpenUntilMs - now)

const shouldSkipRoutineStateSnapshot = (now = Date.now()) => {
  if (getStateSaveCircuitDelayMs(now) <= 0) {
    return false
  }

  if (
    lastCircuitStateSaveSnapshotAtMs > 0 &&
    now - lastCircuitStateSaveSnapshotAtMs < circuitStateSaveSnapshotMinIntervalMs
  ) {
    return true
  }

  lastCircuitStateSaveSnapshotAtMs = now
  return false
}

const openStateSaveCircuit = (reason: string, now = Date.now()) => {
  const openUntilMs = now + stateSaveCircuitCooldownMs
  const wasClosed = getStateSaveCircuitDelayMs(now) === 0
  stateSaveCircuitOpenUntilMs = Math.max(stateSaveCircuitOpenUntilMs, openUntilMs)

  if (wasClosed) {
    console.warn('[state-store] State save circuit opened.', {
      reason,
      cooldownMs: stateSaveCircuitCooldownMs,
    })
  }
}

const recordStateSaveRequest = () => {
  const now = Date.now()
  if (now < lastStateSaveRequestAtMs) {
    stateSaveRequestTimes = []
  }
  lastStateSaveRequestAtMs = now

  stateSaveRequestTimes = stateSaveRequestTimes.filter(
    (requestedAt) => requestedAt <= now && now - requestedAt <= stateSaveCircuitRequestWindowMs,
  )
  stateSaveRequestTimes.push(now)

  if (stateSaveRequestTimes.length > maxStateSaveRequestsPerWindow) {
    openStateSaveCircuit('too-many-save-requests', now)
  }
}

const recordPendingStateReplacement = () => {
  pendingStateReplacementCount += 1

  if (pendingStateReplacementCount > maxPendingStateReplacements) {
    openStateSaveCircuit('pending-state-replaced-too-often')
  }
}

const recordStateSaveFinished = (durationMs: number) => {
  if (durationMs >= slowStateSaveDurationMs) {
    consecutiveSlowStateSaves += 1
    if (consecutiveSlowStateSaves >= maxConsecutiveSlowStateSaves) {
      openStateSaveCircuit('state-save-too-slow')
    }
    return
  }

  consecutiveSlowStateSaves = 0
}

const clearScheduledStateDrain = () => {
  if (!scheduledStateDrain) {
    return null
  }

  const scheduled = scheduledStateDrain
  clearTimeout(scheduled.timer)
  scheduledStateDrain = null
  return scheduled
}

const startPendingStateDrain = (options: PendingStateDrainOptions = {}): Promise<void> => {
  if (activePendingStateDrain) {
    return activePendingStateDrain
  }

  const drain = drainPendingStateWrites(options)
  activePendingStateDrain = drain
  latestQueuedStateWrite = drain.catch(() => undefined)
  void drain.finally(() => {
    if (activePendingStateDrain === drain) {
      activePendingStateDrain = null
    }

    if (pendingState && !options.force) {
      schedulePendingStateDrain()
    }
  }).catch(() => undefined)

  return drain
}

const runScheduledStateDrain = (scheduled: ScheduledStateDrain) => {
  if (scheduledStateDrain !== scheduled) {
    return
  }

  scheduledStateDrain = null
  void startPendingStateDrain()
    .then(scheduled.resolve, scheduled.reject)
}

const scheduleDelayedStateDrain = (delayMs: number) => {
  const dueAtMs = Date.now() + delayMs

  if (!scheduledStateDrain) {
    let resolveScheduled!: () => void
    let rejectScheduled!: (error: unknown) => void
    const promise = new Promise<void>((resolve, reject) => {
      resolveScheduled = resolve
      rejectScheduled = reject
    })
    const scheduled: ScheduledStateDrain = {
      dueAtMs,
      timer: setTimeout(() => runScheduledStateDrain(scheduled), delayMs),
      promise,
      resolve: resolveScheduled,
      reject: rejectScheduled,
    }

    scheduledStateDrain = scheduled
    latestQueuedStateWrite = promise.catch(() => undefined)
    return promise
  }

  if (dueAtMs > scheduledStateDrain.dueAtMs + 10) {
    const scheduled = scheduledStateDrain
    clearTimeout(scheduled.timer)
    scheduled.dueAtMs = dueAtMs
    scheduled.timer = setTimeout(() => runScheduledStateDrain(scheduled), delayMs)
  }

  latestQueuedStateWrite = scheduledStateDrain.promise.catch(() => undefined)
  return scheduledStateDrain.promise
}

const schedulePendingStateDrain = (options: PendingStateDrainOptions = {}) => {
  if (!pendingState) {
    return latestQueuedStateWrite
  }

  if (!options.force) {
    const delayMs = getStateSaveCircuitDelayMs()
    if (delayMs > 0) {
      return scheduleDelayedStateDrain(delayMs)
    }
  }

  return startPendingStateDrain(options)
}

const waitForQueuedStateWrite = async () => {
  while (true) {
    const scheduled = scheduledStateDrain
    if (scheduled) {
      await scheduled.promise
      continue
    }

    const active = activePendingStateDrain
    if (active) {
      await active
      continue
    }

    if (pendingState) {
      await schedulePendingStateDrain()
      continue
    }

    const latestWrite = latestQueuedStateWrite
    await latestWrite

    if (
      latestWrite === latestQueuedStateWrite &&
      !pendingState &&
      !activePendingStateDrain &&
      !scheduledStateDrain
    ) {
      return
    }
  }
}

const drainPendingStateWrites = (options: PendingStateDrainOptions = {}) => withWriteLock(async () => {
  while (pendingState) {
    if (!options.force) {
      const delayMs = getStateSaveCircuitDelayMs()
      if (delayMs > 0) {
        scheduleDelayedStateDrain(delayMs)
        return
      }
    }

    const toWrite = pendingState
    pendingState = null
    pendingStateReplacementCount = 0
    if (toWrite.revision < latestImmediateSaveRevision) {
      continue
    }
    const startedAtMs = Date.now()
    await saveStateToDataDir(toWrite.state, toWrite.dataDir)
    recordStateSaveFinished(Date.now() - startedAtMs)
  }
})

export const queueSaveState = (state: AppState) => {
  const dataDir = getAppDataDir()
  recordStateSaveRequest()

  if (pendingState) {
    recordPendingStateReplacement()
  }

  pendingState = {
    state,
    dataDir,
    revision: ++stateSaveRevision,
  }

  schedulePendingStateDrain()
  const queuedWrite = waitForQueuedStateWrite()
  void queuedWrite.catch(() => undefined)
  return queuedWrite
}

export const waitForPendingStateWrites = async () => {
  const scheduled = clearScheduledStateDrain()

  try {
    while (activePendingStateDrain || pendingState) {
      if (activePendingStateDrain) {
        await activePendingStateDrain
        continue
      }

      if (pendingState) {
        await startPendingStateDrain({ force: true })
      }
    }

    scheduled?.resolve()
  } catch (error) {
    scheduled?.reject(error)
    throw error
  }

  while (true) {
    const activeWrite = latestQueuedStateWrite
    await activeWrite

    if (activeWrite === latestQueuedStateWrite && !pendingState && !activePendingStateDrain) {
      return
    }
  }
}

export const resetState = async () => {
  await dismissRecentCrashRecoveryForDataDir(getAppDataDir())
  const dataDir = getAppDataDir()
  latestImmediateSaveRevision = ++stateSaveRevision
  return withWriteLock(async () => {
    await rm(getClosedWorkspaceDirPath(dataDir), { recursive: true, force: true })
    return saveStateToDataDir(
      createDefaultState(getDefaultWorkspacePath()),
      dataDir,
      { allowEmptyOverwrite: true },
    )
  })
}
