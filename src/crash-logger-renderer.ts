import { captureFatalRendererCrash } from './renderer-crash-state'

type RendererWindowTarget = {
  electronAPI?: Window['electronAPI']
  onerror: Window['onerror']
  onunhandledrejection: Window['onunhandledrejection']
}

type InstallRendererCrashLoggerOptions = {
  sendLogFn?: (level: string, message: string, meta?: unknown) => void
  captureFatalRendererCrashFn?: typeof captureFatalRendererCrash
}

const defaultSendLog = (target: RendererWindowTarget, level: string, message: string, meta?: unknown) => {
  target.electronAPI?.logError?.(level, message, meta)
}

export const installRendererCrashLogger = (
  target: RendererWindowTarget,
  {
    sendLogFn = (level, message, meta) => {
      defaultSendLog(target, level, message, meta)
    },
    captureFatalRendererCrashFn = captureFatalRendererCrash,
  }: InstallRendererCrashLoggerOptions = {},
) => {
  const previousOnError = target.onerror
  const previousOnUnhandledRejection = target.onunhandledrejection

  target.onerror = (event, source, lineno, colno, error) => {
    const message = error instanceof Error ? error.message : String(event)
    const stack = error instanceof Error ? error.stack ?? '' : ''

    sendLogFn('error', `Uncaught error: ${message}`, {
      source,
      lineno,
      colno,
      stack,
    })
    void captureFatalRendererCrashFn({
      source: 'window-error',
      message,
      stack,
    }).catch(() => undefined)

    return typeof previousOnError === 'function'
      ? previousOnError.call(target as Window, event, source, lineno, colno, error)
      : false
  }

  target.onunhandledrejection = (event) => {
    const reason = event.reason
    const message = reason instanceof Error ? reason.message : String(reason)
    const stack = reason instanceof Error ? reason.stack ?? '' : ''

    sendLogFn('error', `Unhandled rejection: ${message}`, { stack })
    void captureFatalRendererCrashFn({
      source: 'unhandled-rejection',
      message,
      stack,
    }).catch(() => undefined)

    previousOnUnhandledRejection?.call(target as Window, event)
  }

  return () => {
    target.onerror = previousOnError ?? null
    target.onunhandledrejection = previousOnUnhandledRejection ?? null
  }
}

if (typeof window !== 'undefined') {
  installRendererCrashLogger(window)
}
