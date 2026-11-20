import type { ChatMessage } from '../../shared/schema'
import { getAskUserAnswerKey, parseStructuredAskUserMessage } from './chat-card-parsing'

// User replies sent by clicking an option are wrapped by formatAskUserFollowUpPrompt
// when the label starts with `-` or `/`. Strip those wrappers before matching.
const askUserChoicePrefixes = ['我选择：', 'My choice: ']

const stripAskUserChoicePrefix = (text: string) => {
  for (const prefix of askUserChoicePrefixes) {
    if (text.startsWith(prefix)) {
      return text.slice(prefix.length).trim()
    }
  }
  return text
}

// Approving a plan-approval card must also flip the card out of plan mode before
// the follow-up send. Resuming with `--permission-mode plan` would make the
// headless CLI intercept the model's next ExitPlanMode call again, re-emitting
// the same approval card in an endless loop. `planApproval` marks current cards;
// `planFile` keeps cards persisted before that flag existed working.
export const shouldExitPlanModeForAskUserAnswer = (
  messages: ChatMessage[],
  prompt: string,
): boolean => {
  const lastAskUserIndex = messages.findLastIndex((message) => message.meta?.kind === 'ask-user')
  if (lastAskUserIndex < 0) {
    return false
  }

  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
  if (lastUserIndex > lastAskUserIndex) {
    return false
  }

  const askUserMessage = messages[lastAskUserIndex]!
  const rawStructuredData = askUserMessage.meta?.structuredData
  if (!rawStructuredData) {
    return false
  }

  let payload: Record<string, unknown>
  try {
    const parsedPayload = JSON.parse(rawStructuredData) as unknown
    if (typeof parsedPayload !== 'object' || parsedPayload === null) {
      return false
    }
    payload = parsedPayload as Record<string, unknown>
  } catch {
    return false
  }

  const isPlanApprovalCard =
    payload.planApproval === true ||
    (typeof payload.planFile === 'string' && payload.planFile.trim().length > 0)
  if (!isPlanApprovalCard) {
    return false
  }

  const approveLabel = parseStructuredAskUserMessage(askUserMessage)?.options[0]?.label.trim()
  if (!approveLabel) {
    return false
  }

  return stripAskUserChoicePrefix(prompt.trim()) === approveLabel
}

// A restored transcript reply only counts as an answer to a given ask-user card
// when its content is recognizably one of that card's options. Otherwise an
// unrelated follow-up message ("继续", "look at this file", …) that simply happens
// to come after the card would be mistaken for the user's selection — silently
// locking the card and, for plan-approval cards, fabricating a "rejected" verdict.
const matchesAskUserOption = (content: string, askUserMessage: ChatMessage): boolean => {
  const parsed = parseStructuredAskUserMessage(askUserMessage)
  if (!parsed) {
    return false
  }

  const knownLabels = new Set<string>()
  for (const question of parsed.questions) {
    for (const option of question.options) {
      const label = option.label.trim()
      if (label) {
        knownLabels.add(label)
      }
    }
  }

  if (knownLabels.size === 0) {
    return false
  }

  const trimmed = content.trim()

  // Single-question reply: the label itself, optionally wrapped with a choice prefix.
  if (knownLabels.has(stripAskUserChoicePrefix(trimmed))) {
    return true
  }

  // Multi-question reply: one `[n] question → label` line per answered question.
  // Accept both the `→` separator emitted today and the legacy `->` form by
  // normalizing `->` to `→` before splitting on the final arrow.
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length > 1 && lines.every((line) => /^\[\d+\]\s.*\s(?:→|->)\s/.test(line))) {
    return lines.every((line) => {
      const answer = line.replace(/->/g, '→')
      return knownLabels.has(answer.slice(answer.lastIndexOf('→') + 1).trim())
    })
  }

  return false
}

export const getLatestUserAnswerAfterAskUserMessage = (
  messages: ChatMessage[],
  askUserMessage: ChatMessage,
) => {
  const askUserIndex = messages.findIndex((message) => message.id === askUserMessage.id)

  if (askUserIndex < 0) {
    return null
  }

  const parsedAskUser = parseStructuredAskUserMessage(askUserMessage)
  const questionCount = parsedAskUser?.questions.length ?? 1
  let answerSearchStartIndex = askUserIndex + 1

  if (questionCount > 1) {
    let remainingMergedQuestions = questionCount - 1
    while (
      remainingMergedQuestions > 0 &&
      messages[answerSearchStartIndex]?.meta?.kind === 'ask-user'
    ) {
      answerSearchStartIndex += 1
      remainingMergedQuestions -= 1
    }
  }

  const nextAskUserIndex = messages.findIndex(
    (message, index) => index >= answerSearchStartIndex && message.meta?.kind === 'ask-user',
  )
  const boundaryIndex = nextAskUserIndex >= 0 ? nextAskUserIndex : messages.length
  const firstUserAnswer = messages
    .slice(answerSearchStartIndex, boundaryIndex)
    .find((message) => message.role === 'user' && message.content.trim().length > 0)

  if (!firstUserAnswer) {
    return null
  }

  const content = firstUserAnswer.content.trim()
  return matchesAskUserOption(content, askUserMessage) ? content : null
}

export const getAskUserAnsweredOption = (
  messages: ChatMessage[],
  askUserMessage: ChatMessage,
  askUserAnswers: Record<string, string>,
) =>
  askUserAnswers[getAskUserAnswerKey(askUserMessage)] ??
  getLatestUserAnswerAfterAskUserMessage(messages, askUserMessage)

// 选择题卡在 window 上监听 Enter / 方向键（点选项后焦点在隐藏 radio 上，也可能没有焦点）。
// 焦点在可输入文字的控件里时这些键属于那个控件：输入框按 Enter 发消息不能连带提交选项。
// radio / checkbox / button 不算可编辑，否则「点选项再按 Enter」就失效了。
const NON_TEXT_INPUT_TYPES = new Set(['radio', 'checkbox', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'])

export const isAskUserKeyTargetEditable = (
  target: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined,
): boolean => {
  if (!target) return false
  if (target.isContentEditable === true) return true
  const tagName = (target.tagName ?? '').toUpperCase()
  if (tagName === 'TEXTAREA' || tagName === 'SELECT') return true
  if (tagName === 'INPUT') return !NON_TEXT_INPUT_TYPES.has((target.type || 'text').toLowerCase())
  return false
}

// 按键落在可编辑控件里时选择题卡不响应；唯一例外是本卡自己的「其他」单行输入框里按 Enter 仍然提交
// （原有用法），输入法上屏的那次 Enter 不算，方向键留给输入框移动光标。
export const shouldAskUserIgnoreKey = (input: {
  key: string
  isComposing: boolean
  targetEditable: boolean
  targetIsOwnOtherInput: boolean
}): boolean => {
  if (!input.targetEditable) return false
  return !(input.targetIsOwnOtherInput && input.key === 'Enter' && !input.isComposing)
}

// 同屏多张未答选择题卡只让一张响应：焦点所在的那张优先，否则取最后一张可见的未答卡。
// 非活动 tab 的卡仍挂在 DOM 里（hidden），不参与。
export const pickAskUserKeyboardOwnerIndex = (
  cards: ReadonlyArray<{ answered: boolean; hidden: boolean; containsTarget: boolean }>,
): number => {
  const focused = cards.findIndex((card) => !card.answered && card.containsTarget)
  if (focused >= 0) return focused
  return cards.findLastIndex((card) => !card.answered && !card.hidden)
}
