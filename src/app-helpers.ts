import { createDefaultState, createMessage, getOrderedColumnCards } from '../shared/default-state'
import type {
  AppLanguage,
  AppState,
  BoardColumn,
  ChatCard,
  ChatMessage,
  LayoutNode,
  LocalModelEntry,
  Provider,
  StreamActivity,
  StreamAssistantMessage,
  StreamCompletion,
} from '../shared/schema'
import { findPaneInLayout } from './state'
import { getLocaleText } from '../shared/i18n'
import { BRAINSTORM_TOOL_MODEL, GIT_TOOL_MODEL, STICKYNOTE_TOOL_MODEL } from '../shared/models'
import type { ChatStreamSource } from './api'

// 什么时候值得去探一次本机 Ollama 状态。两个消费方互不相干：
// · 「路由」页的本地模型条目 —— 模型名下拉要列出已装模型，与自动鞭策没有任何关系；
// · 「设置」页的鞭策判官 —— 只有开了自动鞭策才用得上。
// 漏掉路由页这一支的后果是：打开路由页时状态仍是 null，装了 Ollama 也列不出模型，
// 而离线提示又因为 `undefined === false` 为假而不显示，用户只看到一个空的输入框。
export const shouldSyncOllamaStatus = (settings: {
  activeTopTab: string
  autoUrgeEnabled: boolean
}) =>
  settings.activeTopTab === 'routing' ||
  (settings.activeTopTab === 'settings' && settings.autoUrgeEnabled)

export type LoadStatus = 'loading' | 'ready' | 'error'
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export type ActiveStream = {
  cardId: string
  streamId: string
  provider: Provider
  source: ChatStreamSource
  assistantMessageId?: string
  assistantItemId?: string
  suppressOutputAfterAskUser?: boolean
}

export type OnboardingStage = 'loading' | 'setup' | 'import' | 'complete'
export type OnboardingImportState = 'idle' | 'imported' | 'skipped'

export type ProfileDraft = {
  name: string
  baseUrl: string
  apiKey: string
}

export type StoppedRunReason = 'manual' | 'user-interrupt' | 'ask-user-answer'

export const emptyProfileDraft = (): ProfileDraft => ({
  name: '',
  baseUrl: '',
  apiKey: '',
})

// 「新增本地模型」草稿的初始值。抽成函数是因为 App.tsx 有两处要用（初始化与保存后重置），
// 之前两处各写一份字面量，改默认 harness 时极易只改一处、留下一半旧默认。
// harness 默认与 createLocalModelEntry / localModelEntrySchema 保持一致（codex）。
export const emptyLocalModelDraft = (): Omit<LocalModelEntry, 'id'> => ({
  label: '',
  harness: 'codex',
  baseUrl: '',
  apiKey: '',
  model: '',
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

export const getAllAgentsDoneSoundUrl = (baseUrl?: string) => {
  const resolvedBaseUrl =
    baseUrl ??
    (typeof import.meta !== 'undefined' && typeof import.meta.env?.BASE_URL === 'string'
      ? import.meta.env.BASE_URL
      : '/')

  return `${resolvedBaseUrl.endsWith('/') ? resolvedBaseUrl : `${resolvedBaseUrl}/`}all-agents-done.wav`
}

export const getCompletionSoundPlan = ({
  stopped,
  agentDoneSoundEnabled,
  allAgentsDoneSoundEnabled,
}: {
  stopped: boolean | undefined
  agentDoneSoundEnabled: boolean
  allAgentsDoneSoundEnabled: boolean
}) => ({
  playAgentDone: !stopped && agentDoneSoundEnabled,
  checkAllAgentsDone: !stopped && allAgentsDoneSoundEnabled,
})

export const getStreamDonePlan = ({
  stopped,
  completion,
}: {
  stopped?: boolean
  completion?: StreamCompletion
}) => {
  const kind = stopped
    ? 'stopped'
    : completion === 'background-pending'
      ? 'background-pending'
      : 'terminal'

  return {
    kind,
    finalizeLogicalRun: kind !== 'background-pending',
    runSuccessCallbacks: kind === 'terminal',
  } as const
}

export const isAllAgentWorkComplete = ({
  activeStreamCount,
  queuedSendCount,
  cards,
}: {
  activeStreamCount: number
  queuedSendCount: number
  cards: ReadonlyArray<{
    status: ChatCard['status']
    backgroundWorkPending?: boolean
    wakeTimerQueuedSends?: readonly unknown[]
  }>
}) =>
  activeStreamCount === 0 &&
  queuedSendCount === 0 &&
  cards.every(
    (card) =>
      card.status !== 'streaming' &&
      card.backgroundWorkPending !== true &&
      (card.wakeTimerQueuedSends?.length ?? 0) === 0,
  )

// An untitled chat only gets a real title after its first turn, so a queued
// wake-timer send would otherwise sit behind an anonymous "新会话" tab. Surface
// the waiting state on the tab label until the chat earns its own title.
export const resolvePaneTabTitle = (
  card: {
    title: string
    model: string
    stickyNote?: string
    wakeTimerQueuedSends?: readonly unknown[]
  },
  labels: { fallbackTitle: string; pendingWakeTitle: string },
) => {
  if (card.model === GIT_TOOL_MODEL) {
    return 'Git'
  }

  if (card.model === BRAINSTORM_TOOL_MODEL) {
    return card.title || 'Brainstorm'
  }

  if (card.model === STICKYNOTE_TOOL_MODEL) {
    const firstLine = card.stickyNote?.split(/\r?\n/, 1)[0]?.trim()
    return firstLine || card.title || '便签'
  }

  if (card.title) {
    return card.title
  }

  if ((card.wakeTimerQueuedSends?.length ?? 0) > 0) {
    return labels.pendingWakeTitle
  }

  return labels.fallbackTitle
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

export const getResumeSessionIdForModel = (
  card: Pick<ChatCard, 'sessionId' | 'sessionModel'>,
  model: string,
) => {
  if (!card.sessionId?.trim()) {
    return undefined
  }

  const requestedModel = model.trim()
  const sessionModel = card.sessionModel?.trim()
  if (!sessionModel) {
    return undefined
  }

  return sessionModel === requestedModel ? card.sessionId : undefined
}

// Symptom: after switching a long conversation to another model (Codex -> Claude
// especially), the model answered as if the opening request never existed and
// asked the user to restate the task.
// Root cause: `contextTransfer` marks the first sessionless turn after any model
// switch, but this gate also required `provider === 'codex'`, so a transfer *into*
// Claude/Fable fell back to the generic seeded replay. That replay fills a ~6000
// character budget from the newest message backwards (chat-request-seeding.ts:369),
// so the oldest user turns were dropped outright and replaced with a
// "[Earlier transcript omitted: N messages.]" counter — the original request was
// gone, not merely shortened. 2026-07-28.
// Why not just raise the budget: the budget bounds an unbounded transcript; the
// real fix is marking meaningful user/assistant prose as protected so it survives
// eviction while tool/command detail still competes for the remaining space.
export const resolveChatReplayMode = (
  card: Pick<ChatCard, 'provider' | 'contextTransfer'>,
  resumeSessionId: string | undefined,
): 'fallback' | 'model-transfer' =>
  card.contextTransfer && !resumeSessionId ? 'model-transfer' : 'fallback'

// An empty send means "continue from here": only allowed when the card already
// has something to continue (resumable session or user/assistant history) and
// is not mid-stream. A card holding just a system notice is not continuable.
export const canSendEmptyContinuation = (
  card: Pick<ChatCard, 'messages' | 'sessionId' | 'status'>,
): boolean => {
  if (card.status === 'streaming') {
    return false
  }

  const hasResumableSession = Boolean(card.sessionId?.trim())
  const hasHistory = card.messages.some(
    (message) => message.role === 'user' || message.role === 'assistant',
  )

  return hasResumableSession || hasHistory
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

// 症状：把一张正在跑的卡片拖到另一个工作区后，reducer 会 rebind 卡片（清 session、状态置 idle），
// 但后台进程仍在旧工作区里改文件，之后的回复也只会投递给旧列，用户在新位置什么都看不到。
// 根因：onMoveTab 只是一句 applyAction，跨列移动从来没有停止或迁移后台流（closeTab 一直是有停的）。
// 被否决的替代方案：直接禁止拖动 streaming 标签 —— 那会把 pitfall 176 的 draggable 雷区重新引进来，
// 而且跨列移动本来就必须换工作区重开会话，停掉旧进程才是自洽语义。
// 这里必须先复算一遍 reducer 的接受条件：pane id 过期时 moveTab 整体回退（见 state.ts 的双端校验），
// 那种情况下卡片没搬走，绝不能把用户还在跑的 agent 杀掉。
export const willMoveTabAcrossColumns = (
  state: {
    columns: readonly {
      id: string
      layout: LayoutNode
      cards: Record<string, unknown>
    }[]
  },
  move: {
    sourceColumnId: string
    sourcePaneId: string
    tabId: string
    targetColumnId: string
    targetPaneId: string
  },
): boolean => {
  if (move.sourceColumnId === move.targetColumnId) return false

  const sourceColumn = state.columns.find((column) => column.id === move.sourceColumnId)
  const targetColumn = state.columns.find((column) => column.id === move.targetColumnId)
  if (!sourceColumn || !targetColumn) return false
  if (!sourceColumn.cards[move.tabId]) return false
  if (!findPaneInLayout(sourceColumn.layout, move.sourcePaneId)) return false
  if (!findPaneInLayout(targetColumn.layout, move.targetPaneId)) return false

  return true
}

export type TabMoveSideEffects = {
  stopBackgroundRun: boolean
  clearQueuedSends: boolean
}

/**
 * 症状：跨工作区拖走一张还排着待发送消息的卡片后，那些消息永远发不出去。
 * 根因：2026-08-02 审计——停流用的 `closeStream` 是个纯"拆流"原语，不碰队列；而
 *   `dispatchNextQueuedSend` 的每个调用点都挂在 SSE 的 onDone/onError 上，本地 close
 *   之后再也不会触发。于是"停掉这张卡的运行"实际上是**两个**必须成对出现的动作，
 *   而 closeTab / removeColumn / moveTab 三处各自手写了这对组合，moveTab 漏了后一半。
 * 为什么把它做成返回值而不是直接在 App.tsx 里写两行：成对约束写成散落的调用顺序时，
 *   没有任何东西能阻止下一处新增的停流点再漏一次；做成一个可导入的决策值之后，
 *   "停流必然同时清队列"这条不变量就有了唯一的落点，并被 tests/app-helpers 钉住。
 */
export const resolveTabMoveSideEffects = (
  state: Parameters<typeof willMoveTabAcrossColumns>[0],
  move: Parameters<typeof willMoveTabAcrossColumns>[1],
): TabMoveSideEffects => {
  // 卡片换了工作区、session 也被 reducer 清掉，把旧工作区语境下写的消息投递给新工作区
  // 是错的，所以是 clear 而不是 dispatch——对齐 closeTab 的既有选择。
  const leavesWorkspace = willMoveTabAcrossColumns(state, move)

  return { stopBackgroundRun: leavesWorkspace, clearQueuedSends: leavesWorkspace }
}

export type WorkspaceCloseEffects<TColumn> = {
  cardIds: readonly string[]
  /** 把该卡片还在渲染缓冲区里的助手文本与活动写回 appState（同步、纯数据、可重入）。 */
  flushCardBuffers: (cardId: string) => void
  /** flush 之后重新读这一列——闭包里那份引用已经是过期数据了。 */
  readColumn: () => TColumn | undefined
  shouldSnapshot: (column: TColumn) => boolean
  saveSnapshot: (column: TColumn) => Promise<void>
  clearQueuedSends: (cardId: string) => void
  closeStream: (cardId: string) => Promise<void>
  removeColumn: () => void
}

/**
 * 关闭工作区的三步编排。**顺序被两条互相拉扯的约束同时夹住，这个函数存在的唯一理由
 * 就是给那个顺序一个能被测试钉住的落点**——它在 2026-08-02 之前的半年里坏过两次，
 * 每次都是因为顺序只以"App.tsx 里几行代码的先后"形式存在，一次无害重排就能悄悄打破。
 *
 * 症状 ①（快照排在最后）：快照保存失败时 Agent 已被杀、待发送队列已被清空并同步落盘，
 *   重试也救不回来。
 * 症状 ②（快照排在 flush 之前）：关闭一个正在流式输出的工作区后重开，助手最后一段回复
 *   凭空缺失——渲染缓冲区里积压最长可达 800ms，而点击关闭确认这个动作本身还会触发
 *   120ms 的交互保护去主动推迟 flush，命中概率很高。
 * 根因：flush（纯数据、可逆）过去和杀进程（不可逆）绑在同一次 closeStream 调用里，
 *   于是"快照要晚于 flush"和"快照要早于不可逆操作"直接互斥，怎么排都会漏一头。
 * 为什么不能只调换两行：把 flush 单独拆出来是让两条约束能同时成立的**前提**；顺序本身
 *   则必须有守卫测试，注释挡不住下一次重排（AGENTS.md：决策注释不能替代守卫测试）。
 */
export const runWorkspaceClose = async <TColumn>(
  effects: WorkspaceCloseEffects<TColumn>,
): Promise<void> => {
  effects.cardIds.forEach((cardId) => effects.flushCardBuffers(cardId))

  const column = effects.readColumn()
  if (column && effects.shouldSnapshot(column)) {
    // 故意不 catch：快照失败必须整个中止，一步破坏性操作都不做，这样重试才有意义。
    await effects.saveSnapshot(column)
  }

  effects.cardIds.forEach((cardId) => effects.clearQueuedSends(cardId))
  await Promise.all(effects.cardIds.map((cardId) => effects.closeStream(cardId)))
  effects.removeColumn()
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

export const resolveStreamedAssistantMessageTarget = ({
  messages,
  provider,
  streamId,
  itemId,
  activeMessageId,
  activeItemId,
  model,
}: {
  messages: ChatMessage[]
  provider: Provider
  streamId: string
  itemId?: string
  activeMessageId?: string
  activeItemId?: string
  model?: string
}): {
  messageId: string
  assistantItemId?: string
  messageToAppend?: ChatMessage
} => {
  const normalizedItemId = itemId?.trim()
  if (normalizedItemId) {
    const messageId = createStructuredMessageId(provider, streamId, normalizedItemId)
    if (messages.some((message) => message.id === messageId)) {
      return { messageId, assistantItemId: normalizedItemId }
    }

    const message = createMessage('assistant', '', { provider })
    return {
      messageId,
      assistantItemId: normalizedItemId,
      messageToAppend: {
        ...message,
        id: messageId,
        meta: {
          ...(message.meta ?? {}),
          provider,
          itemId: normalizedItemId,
          ...(model?.trim() ? { model: model.trim() } : {}),
        },
      },
    }
  }

  if (activeMessageId && !activeItemId) {
    return { messageId: activeMessageId }
  }

  const message = createMessage('assistant', '', { provider })
  return {
    messageId: message.id,
    messageToAppend: {
      ...message,
      meta: {
        ...(message.meta ?? {}),
        ...(model?.trim() ? { model: model.trim() } : {}),
      },
    },
  }
}

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
  model?: string,
): ChatMessage => ({
  id: createStructuredMessageId(provider, streamId, getStructuredMessageKey(payload)),
  role: 'assistant',
  content: payload.content,
  createdAt: new Date().toISOString(),
  meta: {
    provider,
    itemId: payload.itemId,
    ...(model?.trim() ? { model: model.trim() } : {}),
  },
})

export const finalizeStreamedAssistantMessage = (
  messages: ChatMessage[],
  streamingMessageId: string | undefined,
  provider: Provider,
  streamId: string,
  payload: StreamAssistantMessage,
  model?: string,
): ChatMessage[] => {
  const normalizedModel = model?.trim()
  if (streamingMessageId) {
    const existingIndex = messages.findIndex((message) => message.id === streamingMessageId)

    if (existingIndex >= 0) {
      const existing = messages[existingIndex]!
      const nextMeta = {
        ...(existing.meta ?? {}),
        provider,
        itemId: payload.itemId,
        ...(normalizedModel ? { model: normalizedModel } : {}),
      }

      if (
        existing.content === payload.content &&
        existing.meta?.provider === provider &&
        existing.meta?.itemId === payload.itemId &&
        (!normalizedModel || existing.meta?.model === normalizedModel)
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

  const nextMessage = createStructuredAssistantMessage(provider, streamId, payload, normalizedModel)
  const existingIndex = messages.findIndex((message) => message.id === nextMessage.id)

  if (existingIndex < 0) {
    return [...messages, nextMessage]
  }

  if (
    messages[existingIndex]?.content === nextMessage.content &&
    messages[existingIndex]?.meta?.provider === nextMessage.meta?.provider &&
    messages[existingIndex]?.meta?.itemId === nextMessage.meta?.itemId &&
    (!normalizedModel || messages[existingIndex]?.meta?.model === normalizedModel)
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

const askUserXmlBlockPattern = /<ask-user-question>\s*[\s\S]*?<\/ask-user-question>/i
const askUserXmlBlockGlobalPattern = /<ask-user-question>\s*[\s\S]*?<\/ask-user-question>/gi
const askUserXmlStartPattern = /<ask-user-question>/i
const emptyMarkdownFencePattern = /```[a-zA-Z0-9]*\s*```/g

const stripAskUserXmlBlocksFromAssistantText = (content: string) =>
  content
    .replace(askUserXmlBlockGlobalPattern, '')
    .replace(/<ask-user-question>[\s\S]*$/i, '')
    .replace(emptyMarkdownFencePattern, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

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
  const streamingHasAskUserXmlBlock =
    payload.kind === 'ask-user' &&
    (askUserXmlBlockPattern.test(streamingContent) || askUserXmlStartPattern.test(streamingContent))
  const strippedStreamingContent =
    streamingHasAskUserXmlBlock
      ? stripAskUserXmlBlocksFromAssistantText(streamingContent)
      : streamingContent
  // Only drop the live streaming bubble when it is purely a synthetic
  // <ask-user-question> XML blob that the structured card is replacing. If Claude
  // produced real prose before that XML, keep the prose and strip only the XML so
  // the user does not lose the context that led to the choice.
  const streamingIsAskUserXmlBlob =
    streamingHasAskUserXmlBlock && strippedStreamingContent.length === 0
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

  if (!shouldReplaceStreaming && streamingHasAskUserXmlBlock && streamingMessageId) {
    const nextStreamingIndex = nextMessages.findIndex((message) => message.id === streamingMessageId)
    const streamingMessage = nextMessages[nextStreamingIndex]

    if (streamingMessage && streamingMessage.content !== strippedStreamingContent) {
      nextMessages[nextStreamingIndex] = {
        ...streamingMessage,
        content: strippedStreamingContent,
      }
    }
  }

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
