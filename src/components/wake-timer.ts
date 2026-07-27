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
}

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
      pendingTargetIds: leftCard.status === 'streaming' ? [leftCard.id] : [],
    }
  }

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
