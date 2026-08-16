import {
  maxWakeTimerDurationMinutes,
  minWakeTimerDurationMinutes,
  wakeTimerModes,
  type CardStatus,
  type ChatCard,
  type ImageAttachment,
  type QueuedSendRequest,
  type WakeTimerMode,
} from '../../shared/schema'
import { getQueuedSendPreview } from './deferred-send-queue'
import type { SendMessageMode, SendMessageOrigin } from './deferred-send-queue'

export const wakeTimerCompletionStabilityMs = 1200

/**
 * 空闲卡上的右键发送 = 计划唤醒。
 *
 * 症状：新会话写好第一条指令后右键发送，消息立刻发了出去 —— 用户表达的"先别发"
 *   被丢掉，因为 `mode: 'defer'` 只有 `status === 'streaming'` 那一条分支读它。
 * 根因：延后发送队列是为"打断正在跑的回合"设计的，空闲卡上右键与左键完全等价。
 * 被否决：把空闲态右键也塞进 FIFO `queuedSends` —— 那个队列的释放条件是"当前回合
 *   结束"，空闲卡没有回合可等，消息会永远躺在队列里。等待条件必须是计划唤醒的
 *   三选一；见 wake-timer SPEC「右键发送 → 计划唤醒」。
 */
export const shouldArmWakeTimerForDeferSend = ({
  featureEnabled,
  mode,
  origin,
  cardStatus,
  isToolCard = false,
}: {
  featureEnabled: boolean
  mode: SendMessageMode | undefined
  origin: SendMessageOrigin
  cardStatus: CardStatus
  isToolCard?: boolean
}) =>
  featureEnabled &&
  mode === 'defer' &&
  origin === 'user' &&
  cardStatus !== 'streaming' &&
  !isToolCard

/**
 * 从一次卡片 patch 里取出"用户刚选的唤醒方式"，用来更新新会话的默认值。
 *
 * 只认用户交互入口传下来的 patch。看板超管 MCP 的 `admin-set-session-wake-timer`
 * 走的是另一条 `patchItemCard` 路径，不能让 Agent 自己设的模式变成用户偏好。
 */
export const collectWakeTimerDefaultPreference = (
  patch: Partial<ChatCard>,
): { wakeTimerDefaultMode?: WakeTimerMode; wakeTimerDefaultDurationMinutes?: number } | null => {
  const preference: {
    wakeTimerDefaultMode?: WakeTimerMode
    wakeTimerDefaultDurationMinutes?: number
  } = {}

  if (patch.wakeTimerMode && (wakeTimerModes as readonly string[]).includes(patch.wakeTimerMode)) {
    preference.wakeTimerDefaultMode = patch.wakeTimerMode
  }

  const duration = patch.wakeTimerDurationMinutes
  if (
    typeof duration === 'number' &&
    Number.isFinite(duration) &&
    duration >= minWakeTimerDurationMinutes &&
    duration <= maxWakeTimerDurationMinutes
  ) {
    preference.wakeTimerDefaultDurationMinutes = duration
  }

  return Object.keys(preference).length > 0 ? preference : null
}

/**
 * 批次结束后要不要把逐卡开关关回去。
 *
 * 症状：2026-08-16 用户报"会话 streaming 久了之后再输入消息，居然自动变成延后消息"。
 * 根因：右键发送会替用户打开 `wakeTimerActive`，但释放/取消/清空批次的三条路径
 *   都只清队列不碰开关，于是这张卡从此每一次普通回车都被 `shouldQueueWakeTimerSend`
 *   静默吞进待唤醒批次（它只看 cardActive，不看 mode）；卡自己在 streaming 时
 *   释放条件又要求 ownerStatus === 'idle'，消息就一直挂着。
 * 被否决：批次结束一律关开关 —— 用户自己在设置里开的逐卡计时器就该持续攒消息
 *   （wake-timer SPEC 需求 5/9），所以必须靠 `wakeTimerAutoActivated` 区分来源。
 */
export const buildWakeTimerBatchEndPatch = ({
  autoActivated,
}: {
  autoActivated: boolean
}): Pick<ChatCard, 'wakeTimerActive' | 'wakeTimerAutoActivated'> | null =>
  autoActivated ? { wakeTimerActive: false, wakeTimerAutoActivated: false } : null

export const shouldQueueWakeTimerSend = ({
  featureEnabled,
  cardActive,
  origin,
  answersPendingAskUser = false,
  hasContent = true,
  isContinuation = false,
}: {
  featureEnabled: boolean
  cardActive: boolean
  origin: 'user' | 'auto-urge' | 'wake-timer-release'
  answersPendingAskUser?: boolean
  // Plain empty queue entries remain invalid after the 2026-07-26 persistence
  // crash. A user-triggered empty continuation is real work, but it must carry
  // the explicit schema marker before entering the queue.
  hasContent?: boolean
  isContinuation?: boolean
}) =>
  featureEnabled &&
  cardActive &&
  origin === 'user' &&
  !answersPendingAskUser &&
  (hasContent || isContinuation)

export const shouldConfirmWakeTimerCompletion = ({
  normalCompletion,
  statusAfterStability,
  backgroundWorkPending = false,
}: {
  normalCompletion: boolean
  statusAfterStability: CardStatus
  backgroundWorkPending?: boolean
}) => normalCompletion && statusAfterStability === 'idle' && !backgroundWorkPending

export type WakeTimerCardSnapshot = {
  id: string
  status: CardStatus
  isAgent: boolean
  // CardStatus has no "待唤醒" member, so a card holding an unreleased batch is
  // indistinguishable from a finished one by status alone. left-tab chaining
  // needs that distinction; see isWakeTimerTargetBusy.
  hasPendingWakeBatch?: boolean
  backgroundWorkPending?: boolean
}

// 症状：2026-07-28 左邻自己也在待唤醒时，右侧卡把它当成"已完成"立刻发车，链式接力断掉。
// 根因：CardStatus 只有 idle|streaming|error，待唤醒卡就是 idle，条件判定从不查目标的 wakeTimerQueuedSends。
// 被否决：给 CardStatus 加 'pending-wake' 会污染所有 status 分支（发送门控、音效、恢复），
//         而这里只需要"忙不忙"这一个布尔；见 wake-timer SPEC「链式待唤醒」。
const isWakeTimerTargetBusy = (card: WakeTimerCardSnapshot) =>
  card.status === 'streaming' ||
  card.backgroundWorkPending === true ||
  card.hasPendingWakeBatch === true

export type WakeTimerArmResult =
  | {
      ok: true
      armedAt: string
      wakeAt: string | undefined
      pendingTargetIds: string[]
    }
  | { ok: false; reason: 'left-target-unavailable' }

export const armWakeTimerBatch = ({
  mode,
  ownerCardId,
  durationMinutes,
  nowMs,
  cards,
  paneTabIds,
}: {
  mode: WakeTimerMode
  ownerCardId: string
  durationMinutes: number
  nowMs: number
  cards: readonly WakeTimerCardSnapshot[]
  paneTabIds: readonly string[]
}): WakeTimerArmResult => {
  const armedAt = new Date(nowMs).toISOString()

  if (mode === 'duration') {
    return {
      ok: true,
      armedAt,
      wakeAt: new Date(nowMs + durationMinutes * 60_000).toISOString(),
      pendingTargetIds: [],
    }
  }

  if (mode === 'left-tab') {
    const ownerIndex = paneTabIds.indexOf(ownerCardId)
    const leftId = ownerIndex > 0 ? paneTabIds[ownerIndex - 1] : undefined
    const leftCard = leftId ? cards.find((card) => card.id === leftId) : undefined
    if (!leftCard?.isAgent) {
      return { ok: false, reason: 'left-target-unavailable' }
    }

    return {
      ok: true,
      armedAt,
      wakeAt: undefined,
      pendingTargetIds: isWakeTimerTargetBusy(leftCard) ? [leftCard.id] : [],
    }
  }

  // workspace-agents 看真实执行中（streaming 或原生后台等待），但仍不把 hasPendingWakeBatch 算忙：
  // 后者是全对全的“等待发车”，两张卡同时排队会互相等待、永久死锁。
  // left-tab 只指向更小的 Tab 索引，天然无环；见 wake-timer 与 native completion SPEC。
  return {
    ok: true,
    armedAt,
    wakeAt: undefined,
    pendingTargetIds: cards
      .filter((card) => card.id !== ownerCardId && card.isAgent && (
        card.status === 'streaming' || card.backgroundWorkPending === true
      ))
      .map((card) => card.id),
  }
}

/**
 * 挂起中的批次改唤醒方式 = 按新条件重新 arm，而不是"下一批才生效"。
 *
 * 症状：2026-08-15 用户在待唤醒卡上改条件，UI 上模式变了，实际仍按老条件等待。
 * 根因：arm 数据（等待目标 / 到点时间）只在首条消息入队时算一次，之后任何
 *   `wakeTimerMode` / `wakeTimerDurationMinutes` 改动都不回流到 arm 数据。
 * 被否决：继续沿用"配置冻结"（改动只影响下一批）—— 用户改条件的唯一动机就是
 *   给手上这批改期，冻结等于这个交互永远不生效；见 wake-timer SPEC「随时改条件」。
 *   duration 也刻意从"改的这一刻"重新计时，沿用旧 armedAt 会让改期后立刻到点。
 */
export const rearmWakeTimerBatchForPatch = ({
  patch,
  card,
  cards,
  paneTabIds,
  nowMs,
}: {
  patch: Partial<ChatCard>
  card: Pick<
    ChatCard,
    'id' | 'wakeTimerMode' | 'wakeTimerDurationMinutes' | 'wakeTimerQueuedSends'
  >
  cards: readonly WakeTimerCardSnapshot[]
  paneTabIds: readonly string[]
  nowMs: number
}):
  | {
      ok: true
      patch: Pick<
        ChatCard,
        'wakeTimerArmedAt' | 'wakeTimerWakeAt' | 'wakeTimerPendingTargetIds'
      >
    }
  | { ok: false; reason: 'left-target-unavailable' }
  | null => {
  const changesCondition =
    patch.wakeTimerMode !== undefined || patch.wakeTimerDurationMinutes !== undefined
  if (!changesCondition || (card.wakeTimerQueuedSends?.length ?? 0) === 0) {
    return null
  }

  const arm = armWakeTimerBatch({
    mode: patch.wakeTimerMode ?? card.wakeTimerMode ?? 'workspace-agents',
    ownerCardId: card.id,
    durationMinutes: patch.wakeTimerDurationMinutes ?? card.wakeTimerDurationMinutes ?? 30,
    nowMs,
    cards,
    paneTabIds,
  })

  if (!arm.ok) {
    return arm
  }

  return {
    ok: true,
    patch: {
      wakeTimerArmedAt: arm.armedAt,
      wakeTimerWakeAt: arm.wakeAt,
      wakeTimerPendingTargetIds: arm.pendingTargetIds,
    },
  }
}

export const isWakeTimerConditionReady = ({
  mode,
  ownerStatus,
  ownerBackgroundWorkPending = false,
  pendingTargetIds,
  activePeerIds = [],
  wakeAt,
  nowMs,
}: {
  mode: WakeTimerMode
  ownerStatus: CardStatus
  ownerBackgroundWorkPending?: boolean
  pendingTargetIds: readonly string[]
  activePeerIds?: readonly string[]
  wakeAt: string | undefined
  nowMs: number
}) => {
  if (ownerStatus !== 'idle' || ownerBackgroundWorkPending) {
    return false
  }

  if (mode === 'duration') {
    const wakeTimestamp = wakeAt ? Date.parse(wakeAt) : Number.NaN
    return Number.isFinite(wakeTimestamp) && nowMs >= wakeTimestamp
  }

  if (mode === 'workspace-agents' && activePeerIds.length > 0) {
    return false
  }

  return pendingTargetIds.length === 0
}

export const removeCompletedWakeTimerTarget = (
  targetIds: readonly string[],
  completedCardId: string,
) => [...new Set(targetIds.filter((targetId) => targetId !== completedCardId))]

export const shouldReleaseCompletedWakeTimerTarget = ({
  waitingMode,
  completedTargetHasPendingWakeBatch,
  forceRelease = false,
}: {
  waitingMode: WakeTimerMode
  completedTargetHasPendingWakeBatch: boolean
  forceRelease?: boolean
}) =>
  forceRelease ||
  waitingMode !== 'left-tab' ||
  !completedTargetHasPendingWakeBatch

export const mergeWakeTimerRequests = (
  requests: readonly QueuedSendRequest[],
): { prompt: string; attachments: ImageAttachment[] } => ({
  prompt: requests
    .map((request) => request.prompt.trim())
    .filter(Boolean)
    .join('\n\n'),
  attachments: requests.flatMap((request) => request.attachments.map((attachment) => ({ ...attachment }))),
})

/**
 * 待唤醒卡只报"N 条消息 · 条件"，用户回头看不出攒的是哪件事。
 * 摘要走 mergeWakeTimerRequests 而不是 summarizeQueuedSends 的"下一条"：
 * 唤醒是整批合并一次发出，只预览首条会漏掉后面追加的内容。
 */
export const summarizeWakeTimerBatch = (
  requests: readonly QueuedSendRequest[],
): { count: number; preview: string; attachmentCount: number } => {
  const merged = mergeWakeTimerRequests(requests)

  return {
    count: requests.length,
    preview: getQueuedSendPreview({ prompt: merged.prompt }),
    attachmentCount: merged.attachments.length,
  }
}

export const buildCanceledWakeTimerDraft = ({
  requests,
  currentDraft,
  currentDraftAttachments,
}: {
  requests: readonly QueuedSendRequest[]
  currentDraft: string
  currentDraftAttachments: readonly ImageAttachment[]
}): { draft: string; draftAttachments: ImageAttachment[] } => {
  const canceledBatch = mergeWakeTimerRequests(requests)
  const draftParts = [canceledBatch.prompt]
  if (currentDraft.trim()) {
    draftParts.push(currentDraft)
  }

  return {
    draft: draftParts.filter(Boolean).join('\n\n'),
    draftAttachments: [
      ...canceledBatch.attachments,
      ...currentDraftAttachments.map((attachment) => ({ ...attachment })),
    ],
  }
}
