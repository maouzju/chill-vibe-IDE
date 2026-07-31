export type CardRecoveryStatus =
  | { kind: 'reconnecting'; attempt: number; max: number | 'unlimited' }
  | { kind: 'resumed' }
  // `streamId` is the stream this failure belongs to. It is what lets a genuinely
  // new stream clear the sticky banner while a late signal from the dead stream
  // still cannot revive it — see shouldClearRecoveryStatusForNewStream.
  | { kind: 'failed'; streamId?: string }

export const computeRecoveryStatusAfterRetryScheduled = (
  currentAttempt: number,
  max: number,
  previous?: CardRecoveryStatus,
): CardRecoveryStatus => ({
  kind: 'reconnecting',
  attempt:
    previous?.kind === 'reconnecting'
      ? Math.max(currentAttempt + 1, previous.attempt + 1)
      : currentAttempt + 1,
  max: Number.isFinite(max) ? max : 'unlimited',
})

export const computeRecoveryStatusAfterSuccess = (
  previous: CardRecoveryStatus | undefined,
): CardRecoveryStatus | undefined => {
  if (!previous) return undefined
  if (previous.kind === 'reconnecting') return { kind: 'resumed' }
  // resumed / failed are terminal for the success path: resumed persists until the
  // clear timer fires; failed must not be silently revived by a late reset signal.
  return previous
}

export const computeRecoveryStatusAfterFinalFailure = (streamId?: string): CardRecoveryStatus => ({
  kind: 'failed',
  ...(streamId ? { streamId } : {}),
})

export const shouldClearRecoveryStatusOnStreamIdle = (
  previous: CardRecoveryStatus | undefined,
): boolean => previous?.kind !== 'failed'

// 症状：卡片显示"重连失败 + 手动续传"，可上面的终端/编辑活动仍在滚动，用户看到
// 的是一张"已经宣告失败却还在干活"的卡。
// 根因：`failed` 是粘性终态（computeRecoveryStatusAfterSuccess 刻意不让迟到信号
// 复活它），而只有 sendMessage / 手动续传 / Stream-not-found / native-completed
// 四条路径会清。Claude keepalive 池里的 CLI 进程在中转站 mid-response 断连后并
// 没有被 kill（result.is_error 路径只 onSettled），它的后台任务跑完自己醒来，
// 通过 unsolicited 流把卡片重新推回 streaming —— 那条路径不在上述四条里。
// 2026-07-31 实测：卡片 03:44:29 判失败（API Error: Connection closed
// mid-response），03:47:15 / 03:52:30 又各结算一轮，一路输出到 03:59:27 仍在跑。
// 为什么不直接在 computeRecoveryStatusAfterSuccess 里让 failed 复活：那会让任何
// 一条来自已死流的迟到 delta 也抹掉横幅，正是它当初被设成终态要防的事。改按
// streamId 归属判定，既让真正的新流清掉横幅，又保留对迟到信号的免疫。
export const shouldClearRecoveryStatusForNewStream = (
  previous: CardRecoveryStatus | undefined,
  streamId: string,
): boolean => previous?.kind === 'failed' && previous.streamId !== streamId


const transientRecoveryPlaceholderPattern = /^reconnecting(?:\s*(?:\.{3}|\u2026))?(?:\s+\d+\s*\/\s*\d+)?$/i

const isTransientRecoveryPlaceholder = (content: string) =>
  transientRecoveryPlaceholderPattern.test(content.trim())

export const shouldShowManualStreamRecoveryControl = ({
  cardStatus,
  recoveryStatus,
  latestAssistantContent,
}: {
  cardStatus: 'idle' | 'streaming' | 'error'
  recoveryStatus?: CardRecoveryStatus
  latestAssistantContent?: string
}) => {
  if (recoveryStatus?.kind === 'failed') {
    return true
  }

  if (cardStatus !== 'streaming') {
    return false
  }

  return (
    recoveryStatus?.kind === 'reconnecting' ||
    (latestAssistantContent ? isTransientRecoveryPlaceholder(latestAssistantContent) : false)
  )
}
