import type { ChatMessage } from '../../shared/schema'
import { getAskUserAnswerKey, parseStructuredAskUserMessage } from './chat-card-parsing'

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

  return firstUserAnswer?.content.trim() ?? null
}

export const getAskUserAnsweredOption = (
  messages: ChatMessage[],
  askUserMessage: ChatMessage,
  askUserAnswers: Record<string, string>,
) =>
  askUserAnswers[getAskUserAnswerKey(askUserMessage)] ??
  getLatestUserAnswerAfterAskUserMessage(messages, askUserMessage)
