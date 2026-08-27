import { isToolCardModel } from '../../shared/models'
import type {
  AutoUrgeJudgeMode,
  AutoUrgeProfile,
  CardStatus,
  ChatMessage,
} from '../../shared/schema'
import { canSendEmptyContinuation } from '../app-helpers'

export type AutoUrgeEvaluation =
  | { kind: 'skip' }
  | { kind: 'disable' }
  | { kind: 'send'; message: string }
  | { kind: 'judge'; message: string }

type AutoUrgeState = {
  active: boolean
  enabled: boolean
  message: string
  successKeyword: string
  messages: ChatMessage[]
  canSendEmptyContinuation?: boolean
  judgeMode?: AutoUrgeJudgeMode
  backgroundWorkPending?: boolean
}

type StreamFinishedTrigger = {
  type: 'stream-finished'
  previousStatus: CardStatus
  status: CardStatus
}

type ManualActivationTrigger = {
  type: 'manual-activation'
  status: CardStatus
  source?: 'card' | 'global'
}

export type AutoUrgeTrigger = StreamFinishedTrigger | ManualActivationTrigger

type AutoUrgeToggleState = {
  featureEnabled: boolean
  chatActive: boolean
  status: CardStatus
}

type AutoUrgeToggleResult = {
  featureEnabled: boolean
  chatActive: boolean
  shouldSendImmediately: boolean
}

const findLastUserMessageIndex = (messages: ChatMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return index
    }
  }

  return -1
}

const latestAssistantTurnContainsSuccessKeyword = (
  messages: ChatMessage[],
  successKeyword: string,
) => {
  const latestUserMessageIndex = findLastUserMessageIndex(messages)

  return messages
    .slice(latestUserMessageIndex + 1)
    .some(
      (entry) =>
        entry.role === 'assistant' &&
        entry.meta?.kind !== 'ask-user' &&
        typeof entry.content === 'string' &&
        entry.content.includes(successKeyword),
    )
}

export const latestTurnHasPendingAskUser = (messages: ChatMessage[]) => {
  const latestUserMessageIndex = findLastUserMessageIndex(messages)

  return messages
    .slice(latestUserMessageIndex + 1)
    .some((entry) => entry.meta?.kind === 'ask-user')
}

export const latestTurnEndedByManualStop = (messages: ChatMessage[]) => {
  const latestUserMessageIndex = findLastUserMessageIndex(messages)

  return messages
    .slice(latestUserMessageIndex + 1)
    .some(
      (entry) =>
        entry.meta?.kind === 'run-stopped' && entry.meta?.stopReason !== 'ask-user-answer',
    )
}

const judgeTextTailLimit = 4000

export const getLatestAssistantTurnText = (messages: ChatMessage[]) => {
  const latestUserMessageIndex = findLastUserMessageIndex(messages)
  const turnMessages = messages.slice(latestUserMessageIndex + 1)

  for (let index = turnMessages.length - 1; index >= 0; index -= 1) {
    const entry = turnMessages[index]
    if (
      entry?.role === 'assistant' &&
      entry.meta?.kind !== 'ask-user' &&
      typeof entry.content === 'string' &&
      entry.content.trim()
    ) {
      const content = entry.content.trim()
      return content.length > judgeTextTailLimit ? content.slice(-judgeTextTailLimit) : content
    }
  }

  return ''
}

export type EffectiveAutoUrgeSource = 'card' | 'global' | 'none'

export type EffectiveAutoUrge = {
  active: boolean
  profileId: string
  source: EffectiveAutoUrgeSource
}

export const resolveEffectiveAutoUrge = ({
  cardAutoUrgeActive,
  cardAutoUrgeProfileId,
  globalUrgeActive,
  globalUrgeProfileId,
  isToolCard,
}: {
  cardAutoUrgeActive: boolean
  cardAutoUrgeProfileId: string
  globalUrgeActive: boolean
  globalUrgeProfileId: string
  isToolCard: boolean
}): EffectiveAutoUrge => {
  if (cardAutoUrgeActive) {
    return { active: true, profileId: cardAutoUrgeProfileId, source: 'card' }
  }

  if (globalUrgeActive && !isToolCard) {
    return { active: true, profileId: globalUrgeProfileId, source: 'global' }
  }

  return { active: false, profileId: cardAutoUrgeProfileId, source: 'none' }
}

export const getNextAutoUrgeToggleState = ({
  featureEnabled,
  chatActive,
  status,
}: AutoUrgeToggleState): AutoUrgeToggleResult => {
  const nextFeatureEnabled = true
  const nextChatActive = featureEnabled ? !chatActive : true

  return {
    featureEnabled: nextFeatureEnabled,
    chatActive: nextChatActive,
    shouldSendImmediately: nextChatActive && status === 'idle',
  }
}

export type AutoUrgeCardInput = {
  messages: ChatMessage[]
  sessionId?: string
  status: CardStatus
  model: string
  autoUrgeActive?: boolean
  autoUrgeProfileId: string
  backgroundWorkPending?: boolean
  repeatLoopActive?: boolean
}

export type AutoUrgeSettingsInput = {
  autoUrgeEnabled: boolean
  autoUrgeProfiles: AutoUrgeProfile[]
  autoUrgeMessage: string
  autoUrgeSuccessKeyword: string
  autoUrgeGlobalControlEnabled: boolean
  autoUrgeGlobalActive: boolean
  autoUrgeGlobalProfileId: string
  repeatLoopEnabled: boolean
}

export type AutoUrgeCardPlan =
  | { kind: 'skip' }
  | { kind: 'disable'; source: EffectiveAutoUrgeSource; judgeModel: string }
  | { kind: 'send'; message: string; source: EffectiveAutoUrgeSource; judgeModel: string }
  | { kind: 'judge'; message: string; source: EffectiveAutoUrgeSource; judgeModel: string }

/**
 * 症状：开着鞭策的卡在**非活动 tab** 上跑完，就再也不会被鞭策 —— 没命中成功词也停着不动
 *   （2026-08-27 用户 state.json 实证：工作区 3 的 pane 有 5 个 tab，armed 卡不是
 *   activeTabId，status 已 idle，末尾写着「尚未解决：…」）。
 * 根因：判定原先只挂在 ChatCard 的 streaming→idle effect 上，而非活动 tab 的 ChatCard
 *   整棵子树会被卸载（只有 Git 卡在 `cardKeepsPaneRuntimeWhenInactive` 白名单里），
 *   于是那次状态跳变根本没有观察者；切回去也不补发（`prevCardStatusRef` 重挂载即为 idle）。
 * 被否决：把聊天卡加进常驻白名单 —— 所有非活动卡都常驻渲染，会重开 streaming textarea
 *   抢焦点那一族老坑（见 `docs/specs/composer-focus-loss/`）。
 * 因此判定必须是一个不依赖组件挂载的纯函数，由 App 层的稳定完成广播驱动。
 */
export const planAutoUrgeForCompletedCard = (
  card: AutoUrgeCardInput,
  settings: AutoUrgeSettingsInput,
): AutoUrgeCardPlan => {
  const repeatLoopControlsAutomation =
    settings.repeatLoopEnabled && card.repeatLoopActive === true
  const isToolCard = isToolCardModel(card.model)
  const effectiveUrge = resolveEffectiveAutoUrge({
    cardAutoUrgeActive: card.autoUrgeActive === true && !repeatLoopControlsAutomation,
    cardAutoUrgeProfileId: card.autoUrgeProfileId,
    globalUrgeActive:
      settings.autoUrgeGlobalControlEnabled &&
      settings.autoUrgeGlobalActive &&
      !repeatLoopControlsAutomation,
    globalUrgeProfileId: settings.autoUrgeGlobalProfileId,
    isToolCard,
  })

  const profile =
    settings.autoUrgeProfiles.find((entry) => entry.id === effectiveUrge.profileId) ??
    settings.autoUrgeProfiles[0] ??
    null

  const evaluation = evaluateAutoUrge(
    { type: 'stream-finished', previousStatus: 'streaming', status: card.status },
    {
      active: effectiveUrge.active,
      enabled: settings.autoUrgeEnabled,
      message: profile?.message ?? settings.autoUrgeMessage,
      successKeyword: profile?.successKeyword ?? settings.autoUrgeSuccessKeyword,
      messages: card.messages,
      canSendEmptyContinuation:
        !isToolCard &&
        canSendEmptyContinuation({
          messages: card.messages,
          sessionId: card.sessionId,
          status: card.status,
        }),
      judgeMode: profile?.judgeMode ?? 'keyword',
      backgroundWorkPending: card.backgroundWorkPending === true,
    },
  )

  if (evaluation.kind === 'skip') {
    return { kind: 'skip' }
  }

  return {
    ...evaluation,
    source: effectiveUrge.source,
    judgeModel: profile?.judgeModel ?? '',
  }
}

export const evaluateAutoUrge = (
  trigger: AutoUrgeTrigger,
  state: AutoUrgeState,
): AutoUrgeEvaluation => {
  if (trigger.type === 'stream-finished') {
    if (trigger.previousStatus !== 'streaming' || trigger.status !== 'idle') {
      return { kind: 'skip' }
    }
    if (state.backgroundWorkPending) {
      return { kind: 'skip' }
    }
  } else {
    if (trigger.status !== 'idle') {
      return { kind: 'skip' }
    }
  }

  if (!state.active || !state.enabled) {
    return { kind: 'skip' }
  }

  // A pending question to the user always wins: never urge over an
  // unanswered ask-user, regardless of trigger or judge mode.
  if (latestTurnHasPendingAskUser(state.messages)) {
    return { kind: 'skip' }
  }

  // A turn the user stopped by hand is a deliberate "wait" — neither the
  // stream-finished path nor a global-urge sweep may override it. Only an
  // explicit card-level re-activation counts as a new user instruction.
  const respectsManualStop =
    trigger.type === 'stream-finished' ||
    (trigger.type === 'manual-activation' && trigger.source === 'global')
  if (respectsManualStop && latestTurnEndedByManualStop(state.messages)) {
    return { kind: 'skip' }
  }

  const trimmedMessage = state.message.trim()
  const canSendBlankContinuation =
    state.canSendEmptyContinuation ??
    state.messages.some((message) => message.role === 'user' || message.role === 'assistant')
  if (!trimmedMessage && !canSendBlankContinuation) {
    return { kind: 'skip' }
  }

  if (trigger.type === 'stream-finished') {
    if (state.judgeMode === 'local-model') {
      return { kind: 'judge', message: trimmedMessage }
    }

    const trimmedSuccessKeyword = state.successKeyword.trim()
    const successFound =
      trimmedSuccessKeyword.length > 0 &&
      latestAssistantTurnContainsSuccessKeyword(state.messages, trimmedSuccessKeyword)

    if (successFound) {
      return { kind: 'disable' }
    }
  }

  return {
    kind: 'send',
    message: trimmedMessage,
  }
}
