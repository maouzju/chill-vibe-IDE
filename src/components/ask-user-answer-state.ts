import type { ChatMessage } from '../../shared/schema'
import { getAskUserAnswerKey } from './chat-card-parsing'

export const getLatestUserAnswerAfterAskUserMessage = (
  messages: ChatMessage[],
  askUserMessage: ChatMessage,
) => {
  const askUserIndex = messages.findIndex((message) => message.id === askUserMessage.id)

  if (askUserIndex < 0) {
    return null
  }

  const nextAskUserIndex = messages.findIndex(
    (message, index) => index > askUserIndex && message.meta?.kind === 'ask-user',
  )
  const boundaryIndex = nextAskUserIndex >= 0 ? nextAskUserIndex : messages.length
  const firstUserAnswer = messages
    .slice(askUserIndex + 1, boundaryIndex)
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
