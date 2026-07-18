import { createCard, createColumn, createDefaultState, createPane } from '../shared/default-state.ts'
import type { AppState, ChatMessage } from '../shared/schema.ts'

export const chatStreamStressCardCount = 6
export const chatStreamStressInitialStructuredItemCount = 920
export const chatStreamStressInitialMessageCount = 998
export const chatStreamStressHeavyCommandCount = 320
export const chatStreamStressLightCommandCount = 70
export const chatStreamStressInteractionIntervalMs = 2_500
export const chatStreamStressActivityIntervalMs = 250
export const chatStreamStressDeltaIntervalMs = 100
export const chatStreamStressHeartbeatIntervalMs = 50

const isoAt = (offsetMs: number) => new Date(Date.UTC(2026, 6, 16, 0, 0, 0, offsetMs)).toISOString()

const createConversationPrefix = (cardIndex: number): ChatMessage[] =>
  Array.from({ length: 6 }, (_, turnIndex) => {
    const turnNumber = turnIndex + 1
    const baseOffset = cardIndex * 100_000 + turnIndex * 2_000

    return [
      {
        id: `chat-stress-${cardIndex}-user-${turnNumber}`,
        role: 'user' as const,
        content: `Historical prompt ${turnNumber} for stress card ${cardIndex}.`,
        createdAt: isoAt(baseOffset),
      },
      {
        id: `chat-stress-${cardIndex}-assistant-${turnNumber}`,
        role: 'assistant' as const,
        content: `Historical answer ${turnNumber} for stress card ${cardIndex}. ${'context '.repeat(24)}`,
        createdAt: isoAt(baseOffset + 1_000),
      },
    ]
  }).flat()

const createCommandMessages = (cardIndex: number, commandCount: number): ChatMessage[] =>
  Array.from({ length: commandCount }, (_, commandIndex) => {
    const itemId = `chat-stress-${cardIndex}-command-${commandIndex + 1}`
    const command = `node -e "console.log('stress ${cardIndex}:${commandIndex + 1}')"`

    return {
      id: itemId,
      role: 'assistant' as const,
      content: '',
      createdAt: isoAt(cardIndex * 100_000 + 20_000 + commandIndex),
      meta: {
        kind: 'command',
        provider: 'codex',
        itemId,
        structuredData: JSON.stringify({
          itemId,
          status: commandIndex === commandCount - 1 ? 'in_progress' : 'completed',
          command,
          output: commandIndex % 8 === 0 ? `stress output ${'x'.repeat(180)}` : '',
          exitCode: commandIndex === commandCount - 1 ? null : 0,
        }),
      },
    }
  })

const createStressMessages = (cardIndex: number, commandCount: number): ChatMessage[] => [
  ...createConversationPrefix(cardIndex),
  {
    id: `chat-stress-${cardIndex}-long-turn-user`,
    role: 'user',
    content: `Run the long structured workload for stress card ${cardIndex}.`,
    createdAt: isoAt(cardIndex * 100_000 + 19_000),
  },
  ...createCommandMessages(cardIndex, commandCount),
]

export const createChatStreamStressState = (workspacePath: string): AppState => {
  const state = createDefaultState(workspacePath, 'en')
  state.settings.language = 'en'
  state.settings.theme = 'dark'
  state.settings.cliRoutingEnabled = false
  state.settings.resilientProxyEnabled = false

  state.columns = Array.from({ length: chatStreamStressCardCount }, (_, zeroBasedIndex) => {
    const cardIndex = zeroBasedIndex + 1
    const cardId = `card-chat-stress-${cardIndex}`
    const standbyCardId = `card-chat-stress-standby-${cardIndex}`
    const commandCount = cardIndex <= 2
      ? chatStreamStressHeavyCommandCount
      : chatStreamStressLightCommandCount
    const stressCard = {
      ...createCard(`Stream ${cardIndex}`, 560, 'codex', state.settings.requestModels.codex, 'medium', 'en'),
      id: cardId,
      title: `Stream ${cardIndex}`,
      status: 'idle' as const,
      draft: '',
      messages: createStressMessages(cardIndex, commandCount),
    }
    const standbyCard = {
      ...createCard(`Standby ${cardIndex}`, 560, 'codex', state.settings.requestModels.codex, 'medium', 'en'),
      id: standbyCardId,
      title: `Standby ${cardIndex}`,
      status: 'idle' as const,
      draft: '',
      messages: [],
    }

    return createColumn(
      {
        id: `column-chat-stress-${cardIndex}`,
        title: `Stress ${cardIndex}`,
        provider: 'codex',
        workspacePath,
        model: stressCard.model,
        width: 380,
        layout: createPane([cardId, standbyCardId], cardId, `pane-chat-stress-${cardIndex}`),
        cards: {
          [cardId]: stressCard,
          [standbyCardId]: standbyCard,
        },
      },
      'en',
    )
  })
  state.updatedAt = new Date().toISOString()

  return state
}

export const getPercentile = (values: number[], percentile: number) => {
  if (values.length === 0) {
    return 0
  }

  const sorted = [...values].sort((left, right) => left - right)
  const boundedPercentile = Math.min(1, Math.max(0, percentile))
  const index = Math.max(0, Math.ceil(sorted.length * boundedPercentile) - 1)
  return sorted[index] ?? 0
}
