import type {
  CardStatus,
  ImageAttachment,
  QueuedSendRequest,
  WakeTimerMode,
} from '../../shared/schema'

export const wakeTimerCompletionStabilityMs = 1200

export const shouldQueueWakeTimerSend = ({
  featureEnabled,
  cardActive,
  origin,
  answersPendingAskUser = false,
  hasContent = true,
}: {
  featureEnabled: boolean
  cardActive: boolean
  origin: 'user' | 'auto-urge' | 'wake-timer-release'
  answersPendingAskUser?: boolean
  // The queue replays real sends later, so an entry with nothing to send is
  // useless — and worse, it fails persistence validation and takes the whole
  // save down with it (crash of 2026-07-26 21:10).
  hasContent?: boolean
}) =>
  featureEnabled && cardActive && origin === 'user' && !answersPendingAskUser && hasContent

export const shouldConfirmWakeTimerCompletion = ({
  normalCompletion,
  statusAfterStability,
}: {
  normalCompletion: boolean
  statusAfterStability: CardStatus
}) => normalCompletion && statusAfterStability === 'idle'

export type WakeTimerCardSnapshot = {
  id: string
  status: CardStatus
  isAgent: boolean
  // CardStatus has no "待唤醒" member, so a card holding an unreleased batch is
  // indistinguishable from a finished one by status alone. left-tab chaining
  // needs that distinction; see isWakeTimerTargetBusy.
  hasPendingWakeBatch?: boolean
}

// 症状：2026-07-28 左邻自己也在待唤醒时，右侧卡把它当成"已完成"立刻发车，链式接力断掉。
// 根因：CardStatus 只有 idle|streaming|error，待唤醒卡就是 idle，条件判定从不查目标的 wakeTimerQueuedSends。
// 被否决：给 CardStatus 加 'pending-wake' 会污染所有 status 分支（发送门控、音效、恢复），
//         而这里只需要"忙不忙"这一个布尔；见 wake-timer SPEC「链式待唤醒」。
const isWakeTimerTargetBusy = (card: WakeTimerCardSnapshot) =>
  card.status === 'streaming' || card.hasPendingWakeBatch === true

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

  // workspace-agents 刻意只看 streaming：这里的等待是全对全的，把待唤醒 peer 也算作忙，
  // 同列两张卡同时排队就会互相等待、永久死锁。left-tab 只指向更小的 Tab 索引，天然无环。
  return {
    ok: true,
    armedAt,
    wakeAt: undefined,
    pendingTargetIds: cards
      .filter((card) => card.id !== ownerCardId && card.isAgent && card.status === 'streaming')
      .map((card) => card.id),
  }
}

export const isWakeTimerConditionReady = ({
  mode,
  ownerStatus,
  pendingTargetIds,
  activePeerIds = [],
  wakeAt,
  nowMs,
}: {
  mode: WakeTimerMode
  ownerStatus: CardStatus
  pendingTargetIds: readonly string[]
  activePeerIds?: readonly string[]
  wakeAt: string | undefined
  nowMs: number
}) => {
  if (ownerStatus !== 'idle') {
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

export const mergeWakeTimerRequests = (
  requests: readonly QueuedSendRequest[],
): { prompt: string; attachments: ImageAttachment[] } => ({
  prompt: requests
    .map((request) => request.prompt.trim())
    .filter(Boolean)
    .join('\n\n'),
  attachments: requests.flatMap((request) => request.attachments.map((attachment) => ({ ...attachment }))),
})

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
