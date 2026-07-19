import { createMessage } from '../shared/default-state'
import type { AppLanguage, ChatMessage } from '../shared/schema'

const runDurationKind = 'run-duration'

const normalizeDurationMs = (durationMs: number) =>
  Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0

export const formatRunDuration = (durationMs: number, language: AppLanguage) => {
  const totalSeconds = Math.max(1, Math.floor(normalizeDurationMs(durationMs) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (language === 'en') {
    const parts = [
      hours > 0 ? `${hours}h` : '',
      minutes > 0 ? `${minutes}m` : '',
      `${seconds}s`,
    ].filter(Boolean)
    return `Ran for ${parts.join(' ')}`
  }

  const parts = [
    hours > 0 ? `${hours}小时` : '',
    minutes > 0 ? `${minutes}分钟` : '',
    `${seconds}秒`,
  ].filter(Boolean)
  return `已运行 ${parts.join('')}`
}

export const readRunDurationMs = (message: ChatMessage) => {
  if (message.meta?.kind !== runDurationKind) {
    return null
  }

  const durationMs = Number(message.meta.durationMs)
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null
}

export const recordRunStart = (
  starts: Map<string, number>,
  cardId: string,
  startedAtMs: number,
) => {
  if (!starts.has(cardId)) {
    starts.set(cardId, Number.isFinite(startedAtMs) ? startedAtMs : Date.now())
  }
}

export const consumeRunDurationMessage = (
  starts: Map<string, number>,
  cardId: string,
  finishedAtMs = Date.now(),
): ChatMessage | undefined => {
  const startedAtMs = starts.get(cardId)
  if (startedAtMs === undefined) {
    return undefined
  }

  starts.delete(cardId)
  const durationMs = normalizeDurationMs(finishedAtMs - startedAtMs)
  return createMessage('system', '', {
    kind: runDurationKind,
    durationMs: String(durationMs),
  })
}
