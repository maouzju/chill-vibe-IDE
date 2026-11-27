import { MODEL_PICKER_HIDDEN_TOOL_MODELS } from '../../shared/models'
import type { ChatCard } from '../../shared/schema'

export type RepeatLoopCompletionKind = 'terminal' | 'background-pending' | 'stopped'

export const getEarliestRepeatLoopPrompt = (
  messages: ChatCard['messages'],
): string | null => {
  const firstUserPrompt = messages.find(
    (message) => message.role === 'user' && message.content.trim().length > 0,
  )

  return firstUserPrompt?.content ?? null
}

const isRepeatLoopWindowTruncated = (card: Pick<ChatCard, 'messages' | 'messageCount'>) =>
  (card.messageCount ?? 0) > card.messages.length

type RepeatLoopCompletionInput = {
  featureEnabled: boolean
  completionKind: RepeatLoopCompletionKind
  card: ChatCard
}

const isRepeatLoopRoundDue = ({ featureEnabled, completionKind, card }: RepeatLoopCompletionInput) =>
  featureEnabled &&
  completionKind === 'terminal' &&
  card.repeatLoopActive === true &&
  !MODEL_PICKER_HIDDEN_TOOL_MODELS.has(card.model) &&
  card.queuedSends.length === 0 &&
  (card.wakeTimerQueuedSends?.length ?? 0) === 0 &&
  !(typeof card.repeatLoopRemaining === 'number' && card.repeatLoopRemaining <= 0)

export const resolveRepeatLoopCompletion = (
  input: RepeatLoopCompletionInput,
): { prompt: string; remainingRepeats?: number } | null => {
  if (!isRepeatLoopRoundDue(input)) {
    return null
  }

  const { card } = input
  // 窗口被裁过：窗口里最早的 user 不是真正的首条（可能是后来补发的），交给归档路径。
  if (isRepeatLoopWindowTruncated(card)) {
    return null
  }
  const prompt = getEarliestRepeatLoopPrompt(card.messages)
  return prompt
    ? {
        prompt,
        ...(typeof card.repeatLoopRemaining === 'number'
          ? { remainingRepeats: card.repeatLoopRemaining }
          : {}),
      }
    : null
}

// 症状（2026-11-27 用户截图）：开着「循环重复」、剩 6 次的长会话跑完一轮，什么都没发生。
// 根因：卡里 343 条消息，读档预裁剪只留最后 300 条（state-store preTrimMaxCardMessages），
//   首条用户提示进了 compacted-card-history 归档；窗口里一条 user 都没有，循环静默跳过。
//   裁过之后用户再发的消息会被误当成「首条」——同一根因，同样走归档。
// 被否决：把首条提示另存一份到卡上——已经被裁掉的旧卡救不回来；归档本来就是完整前缀，按需去取。
//   窗口里没有 user 但 messageCount 没记上裁剪（回合内消息又涨过它）也去归档试一次，取不到再用窗口。
export const needsArchivedRepeatLoopPrompt = (input: RepeatLoopCompletionInput) =>
  isRepeatLoopRoundDue(input) &&
  (isRepeatLoopWindowTruncated(input.card) || getEarliestRepeatLoopPrompt(input.card.messages) === null)
