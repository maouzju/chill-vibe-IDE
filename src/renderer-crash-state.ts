import type { AppState } from '../shared/schema'
import { captureRendererCrash } from './api'
import { getResolvedAppTheme } from './theme'

type RendererCrashCaptureSource = 'window-error' | 'unhandled-rejection' | 'react-boundary'

let latestKnownState: AppState | null = null
let lastCaptureSignature = ''
let pendingCapture: Promise<Awaited<ReturnType<typeof captureRendererCrash>>> | null = null
const crashCaptureStateMaxLiveMessages = 160
const crashCaptureStateMaxSessionHistoryEntries = 20
const crashCaptureMessageContentChars = 6_000

const trimTextForCrashCapture = (value: string) =>
  value.length <= crashCaptureMessageContentChars
    ? value
    : [
        value.slice(0, crashCaptureMessageContentChars / 2),
        '',
        `[Output truncated while preserving crash recovery state. ${value.length - crashCaptureMessageContentChars} characters omitted.]`,
        '',
        value.slice(-crashCaptureMessageContentChars / 2),
      ].join('\n')

const trimMessageForCrashCapture = (message: AppState['columns'][number]['cards'][string]['messages'][number]) => ({
  ...message,
  content: trimTextForCrashCapture(message.content),
  meta: message.meta?.structuredData
    ? {
        ...message.meta,
        structuredData: trimTextForCrashCapture(message.meta.structuredData),
      }
    : message.meta,
})

export const trimStateForRendererCrashCapture = (state: AppState): AppState => ({
  ...state,
  columns: state.columns.map((column) => ({
    ...column,
    cards: Object.fromEntries(
      Object.entries(column.cards).map(([cardId, card]) => {
        const messages = card.messages.length > crashCaptureStateMaxLiveMessages
          ? card.messages.slice(-crashCaptureStateMaxLiveMessages)
          : card.messages

        return [
          cardId,
          {
            ...card,
            messages: messages.map(trimMessageForCrashCapture),
            messageCount: Math.max(card.messageCount ?? 0, card.messages.length),
          },
        ]
      }),
    ),
  })),
  sessionHistory: state.sessionHistory.slice(0, crashCaptureStateMaxSessionHistoryEntries).map((entry) => ({
    ...entry,
    messages: [],
    messageCount: Math.max(entry.messageCount ?? 0, entry.messages.length),
    messagesPreview: true,
  })),
})

export const updateLatestKnownAppState = (state: AppState) => {
  latestKnownState = state
}

export const getLatestKnownAppPresentation = () => ({
  language: latestKnownState?.settings.language ?? 'zh-CN',
  theme: getResolvedAppTheme(latestKnownState?.settings.theme ?? 'dark'),
})

const buildCrashSignature = (source: RendererCrashCaptureSource, message: string, stack: string) =>
  `${source}::${message}::${stack.slice(0, 240)}`

export const captureFatalRendererCrash = async ({
  source,
  message,
  stack = '',
}: {
  source: RendererCrashCaptureSource
  message: string
  stack?: string
}) => {
  if (!latestKnownState) {
    return null
  }

  const signature = buildCrashSignature(source, message, stack)
  if (pendingCapture && signature === lastCaptureSignature) {
    return pendingCapture
  }

  lastCaptureSignature = signature
  pendingCapture = captureRendererCrash({
    source,
    message,
    stack,
    state: trimStateForRendererCrashCapture(latestKnownState),
  }).finally(() => {
    pendingCapture = null
  })

  return pendingCapture
}
