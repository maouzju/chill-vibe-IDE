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
