import { createCard, createColumn, createDefaultState, createPane } from '../shared/default-state.ts'
import type { AppState, ChatMessage } from '../shared/schema.ts'

export const chatStreamStressColumnCount = 6
export const chatStreamStressTabsPerPane = 14
export const chatStreamStressStreamsPerColumn = [4, 4, 3, 3, 3, 3] as const
export const chatStreamStressConcurrentStreamCount = chatStreamStressStreamsPerColumn.reduce(
  (total, count) => total + count,
  0,
)
export const chatStreamStressVisibleStreamColumnCount = chatStreamStressColumnCount
// Compatibility alias for existing callers that used this value as the
// workspace-column count before the fixture gained multiple live tabs per pane.
export const chatStreamStressCardCount = chatStreamStressColumnCount
export const chatStreamStressInitialStructuredItemCount = 920
export const chatStreamStressInitialMessageCount = 1_154
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

const createDormantMessages = (cardIndex: number, tabIndex: number): ChatMessage[] => {
  const messagePrefix = `chat-stress-${cardIndex}-dormant-${tabIndex}`
  const baseOffset = cardIndex * 100_000 + 80_000 + tabIndex * 10

  return [
    {
      id: `${messagePrefix}-user`,
      role: 'user',
      content: `Saved prompt for column ${cardIndex}, tab ${tabIndex}.`,
      createdAt: isoAt(baseOffset),
    },
    {
      id: `${messagePrefix}-assistant`,
      role: 'assistant',
      content: `Saved answer for column ${cardIndex}, tab ${tabIndex}.`,
      createdAt: isoAt(baseOffset + 1),
    },
  ]
}

export const getChatStreamStressForegroundCardId = (cardIndex: number) =>
  `card-chat-stress-${cardIndex}`

export const getChatStreamStressBackgroundCardId = (cardIndex: number) =>
  `card-chat-stress-background-${cardIndex}`

export const getChatStreamStressMiddleCardId = (cardIndex: number, middleIndex: number) =>
  `card-chat-stress-middle-${cardIndex}-${middleIndex}`

export const getChatStreamStressForegroundTitle = (cardIndex: number) =>
  `Stream ${cardIndex}`

export const getChatStreamStressBackgroundTitle = (cardIndex: number) =>
  `Background ${cardIndex}`

export const getChatStreamStressMiddleTitle = (cardIndex: number, middleIndex: number) =>
  `Agent ${cardIndex}.${middleIndex + 1}`

export const getChatStreamStressDormantTitle = (cardIndex: number, dormantIndex = 1) =>
  `History ${cardIndex}.${dormantIndex}`

export const getChatStreamStressRunningCardIds = (cardIndex: number) => {
  const streamCount = chatStreamStressStreamsPerColumn[cardIndex - 1] ?? 0
  return [
    getChatStreamStressForegroundCardId(cardIndex),
    ...Array.from(
      { length: Math.max(0, streamCount - 2) },
      (_, middleIndex) => getChatStreamStressMiddleCardId(cardIndex, middleIndex + 1),
    ),
    getChatStreamStressBackgroundCardId(cardIndex),
  ]
}

export const getChatStreamStressRunningTitles = (cardIndex: number) => {
  const streamCount = chatStreamStressStreamsPerColumn[cardIndex - 1] ?? 0
  return [
    getChatStreamStressForegroundTitle(cardIndex),
    ...Array.from(
      { length: Math.max(0, streamCount - 2) },
      (_, middleIndex) => getChatStreamStressMiddleTitle(cardIndex, middleIndex + 1),
    ),
    getChatStreamStressBackgroundTitle(cardIndex),
  ]
}

export const createChatStreamStressState = (workspacePath: string): AppState => {
  const state = createDefaultState(workspacePath, 'en')
  state.settings.language = 'en'
  state.settings.theme = 'dark'
  state.settings.cliRoutingEnabled = false
  state.settings.resilientProxyEnabled = false

  state.columns = Array.from({ length: chatStreamStressColumnCount }, (_, zeroBasedIndex) => {
    const cardIndex = zeroBasedIndex + 1
    const streamCount = chatStreamStressStreamsPerColumn[zeroBasedIndex] ?? 0
    const cardId = getChatStreamStressForegroundCardId(cardIndex)
    const backgroundCardId = getChatStreamStressBackgroundCardId(cardIndex)
    const commandCount = cardIndex <= 2
      ? chatStreamStressHeavyCommandCount
      : chatStreamStressLightCommandCount
    const stressCard = {
      ...createCard(getChatStreamStressForegroundTitle(cardIndex), 560, 'codex', state.settings.requestModels.codex, 'medium', 'en'),
      id: cardId,
      title: getChatStreamStressForegroundTitle(cardIndex),
      status: 'idle' as const,
      draft: '',
      messages: createStressMessages(cardIndex, commandCount),
    }
    const middleStreamCards = Array.from(
      { length: Math.max(0, streamCount - 2) },
      (_, middleZeroBasedIndex) => {
        const middleIndex = middleZeroBasedIndex + 1
        const middleCardId = getChatStreamStressMiddleCardId(cardIndex, middleIndex)
        return {
          ...createCard(
            getChatStreamStressMiddleTitle(cardIndex, middleIndex),
            560,
            'codex',
            state.settings.requestModels.codex,
            'medium',
            'en',
          ),
          id: middleCardId,
          title: getChatStreamStressMiddleTitle(cardIndex, middleIndex),
          status: 'idle' as const,
          draft: '',
          messages: createDormantMessages(cardIndex, 50 + middleIndex),
        }
      },
    )
    const dormantCards = Array.from(
      { length: chatStreamStressTabsPerPane - streamCount },
      (_, dormantZeroBasedIndex) => {
        const dormantIndex = dormantZeroBasedIndex + 1
        const dormantCardId = `card-chat-stress-dormant-${cardIndex}-${dormantIndex}`
        return {
          ...createCard(
            getChatStreamStressDormantTitle(cardIndex, dormantIndex),
            560,
            'codex',
            state.settings.requestModels.codex,
            'medium',
            'en',
          ),
          id: dormantCardId,
          title: getChatStreamStressDormantTitle(cardIndex, dormantIndex),
          status: 'idle' as const,
          draft: '',
          messages: createDormantMessages(cardIndex, dormantIndex),
        }
      },
    )
    const backgroundCard = {
      ...createCard(getChatStreamStressBackgroundTitle(cardIndex), 560, 'codex', state.settings.requestModels.codex, 'medium', 'en'),
      id: backgroundCardId,
      title: getChatStreamStressBackgroundTitle(cardIndex),
      status: 'idle' as const,
      draft: '',
      messages: createDormantMessages(cardIndex, chatStreamStressTabsPerPane - 1),
    }
    const runningCards = [stressCard, ...middleStreamCards, backgroundCard]
    const runningPositions = streamCount === 4 ? [0, 4, 9, 13] : [0, 6, 13]
    let dormantCursor = 0
    const tabIds = Array.from({ length: chatStreamStressTabsPerPane }, (_, tabIndex) => {
      const runningIndex = runningPositions.indexOf(tabIndex)
      if (runningIndex >= 0) {
        return runningCards[runningIndex]!.id
      }

      const dormantCard = dormantCards[dormantCursor]
      dormantCursor += 1
      return dormantCard!.id
    })
    const dormantCardEntries = Object.fromEntries(dormantCards.map((card) => [card.id, card]))
    const middleCardEntries = Object.fromEntries(middleStreamCards.map((card) => [card.id, card]))

    return createColumn(
      {
        id: `column-chat-stress-${cardIndex}`,
        title: `Stress ${cardIndex}`,
        provider: 'codex',
        workspacePath,
        model: stressCard.model,
        width: 380,
        layout: createPane(tabIds, cardId, `pane-chat-stress-${cardIndex}`),
        cards: {
          [cardId]: stressCard,
          ...middleCardEntries,
          ...dormantCardEntries,
          [backgroundCardId]: backgroundCard,
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
