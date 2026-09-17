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

const isCancellationRejection = (reason: unknown) => {
  if (!(reason instanceof Error)) {
    return false
  }
  // 判据与 Monaco 自己的 isCancellationError 保持一致：name 和 message 必须同时
  // 等于 'Canceled'（CancellationError 的构造函数把 name 设成 message）。
  // 用 `||` 会宽出一整类：普通 `new Error('Canceled')` 的真实崩溃 name 仍是
  // 'Error'，那样会被静默降级成 warn、不再归档，等于吞掉崩溃。
  return reason.name === 'Canceled' && reason.message === 'Canceled'
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

    // 症状：每次换新包启动都弹「本次崩溃记录 / 崩溃摘要: Canceled」。
    // 根因：Monaco 的 restoreViewState 在编辑器卡重建时会以 `Canceled` 拒绝一个
    //       内部 promise（main.log 09-03/09-14/09-16 各一次），应用本身毫发无损，
    //       但这里一律当致命崩溃写 state.crash-recovery.json，下次启动必弹窗。
    // 为什么不在 TextEditorCard 包 try/catch：拒绝发生在异步 contribution 恢复里，
    //       同步 try/catch 抓不到；这里按取消语义过滤是唯一稳的位置。
    if (isCancellationRejection(reason)) {
      sendLogFn('warn', `Ignored cancellation rejection: ${message}`, { stack })
      previousOnUnhandledRejection?.call(target as Window, event)
      return
    }

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
