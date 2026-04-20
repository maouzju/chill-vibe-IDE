import type { AppState } from '../shared/schema'
import { captureRendererCrash } from './api'
import { getResolvedAppTheme } from './theme'

type RendererCrashCaptureSource = 'window-error' | 'unhandled-rejection' | 'react-boundary'

let latestKnownState: AppState | null = null
let lastCaptureSignature = ''
let pendingCapture: Promise<Awaited<ReturnType<typeof captureRendererCrash>>> | null = null

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
    state: latestKnownState,
  }).finally(() => {
    pendingCapture = null
  })

  return pendingCapture
}
