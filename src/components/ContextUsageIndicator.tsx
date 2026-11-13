import { memo, useCallback, useMemo, useSyncExternalStore } from 'react'

import type { AppLanguage, ChatMessage, Provider } from '../../shared/schema'
import {
  describeContextUsage,
  readPersistedContextUsage,
  supportsContextUsage,
} from './context-usage'
import { getContextUsageSnapshot, subscribeContextUsage } from './context-usage-store'
import { HoverTooltip } from './HoverTooltip'

export type ContextUsageIndicatorProps = {
  cardId: string
  messages: readonly ChatMessage[]
  provider: Provider
  /** 这张卡有回合在跑。 */
  streaming: boolean
  /** 这张卡还连着一个 CLI 会话。会话没了，记在对话里的旧数字就不再代表什么。 */
  hasSession: boolean
  language: AppLanguage
  autoCompactEnabled: boolean
  autoCompactThresholdPercent?: number
}

const ringRadius = 6
const ringCircumference = 2 * Math.PI * ringRadius

/**
 * 输入框旁的上下文占用：一个小圆环加百分比（docs/specs/context-usage-auto-compact）。
 *
 * 回合进行中订阅 context-usage-store 的实时值——只有这个小组件跟着重渲染，整张卡不动；
 * 回合之间读记在对话里的值。
 */
export const ContextUsageIndicator = memo(function ContextUsageIndicator({
  cardId,
  messages,
  provider,
  streaming,
  hasSession,
  language,
  autoCompactEnabled,
  autoCompactThresholdPercent,
}: ContextUsageIndicatorProps) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeContextUsage(cardId, listener),
    [cardId],
  )
  const getSnapshot = useCallback(() => getContextUsageSnapshot(cardId), [cardId])
  const live = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const liveForTurn = streaming ? live : undefined
  const supported = supportsContextUsage(provider)

  const display = useMemo(() => {
    if (!supported || (!streaming && !hasSession)) {
      return undefined
    }

    return describeContextUsage({
      snapshot: liveForTurn ?? readPersistedContextUsage(messages, provider),
      language,
      autoCompactEnabled,
      autoCompactThresholdPercent,
    })
  }, [
    supported,
    streaming,
    hasSession,
    liveForTurn,
    messages,
    provider,
    language,
    autoCompactEnabled,
    autoCompactThresholdPercent,
  ])

  if (!display) {
    return null
  }

  return (
    <HoverTooltip content={display.tooltip}>
      <span
        className="composer-context-usage"
        data-level={display.level}
        role="img"
        aria-label={display.summary}
      >
        {display.percent === undefined ? null : (
          <svg className="composer-context-usage-ring" viewBox="0 0 16 16" aria-hidden="true">
            <circle className="composer-context-usage-track" cx="8" cy="8" r={ringRadius} />
            <circle
              className="composer-context-usage-fill"
              cx="8"
              cy="8"
              r={ringRadius}
              strokeDasharray={`${(display.percent / 100) * ringCircumference} ${ringCircumference}`}
              transform="rotate(-90 8 8)"
            />
          </svg>
        )}
        <span className="composer-context-usage-value">{display.valueLabel}</span>
      </span>
    </HoverTooltip>
  )
})
