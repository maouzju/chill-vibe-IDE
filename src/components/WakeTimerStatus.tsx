import { useState } from 'react'

import { getLocaleText } from '../../shared/i18n'
import type { AppLanguage, WakeTimerMode } from '../../shared/schema'
import { WakeTimerTargetPicker, type WakeTimerTargetOption } from './WakeTimerTargetPicker'

/** 下拉里多出的「指定会话」不是第四种 wakeTimerMode，只是名单非空时的投影（见 schema 注释）。 */
export type WakeTimerUiMode = WakeTimerMode | 'sessions'

export type WakeTimerStatusProps = {
  language: AppLanguage
  queueLength: number
  conditionText: string
  pendingStatusLabel: string
  queuePreviewText?: string
  wakeNowLabel: string
  cancelLabel: string
  wakeTimerMode: WakeTimerMode
  wakeTimerDurationMinutes: number
  /** 有没有可等的左邻。没有就不让选 left-tab，否则批次会永远等不到。 */
  neighbourAvailable: boolean
  isEmptyState?: boolean
  /** 可以点名等待的会话；不给就不露出「指定会话」。 */
  targetOptions?: readonly WakeTimerTargetOption[]
  /** 卡上配置的名单（`wakeTimerTargetCardIds`）。 */
  targetCardIds?: readonly string[]
  /** 当前批次还在等的卡（`wakeTimerPendingTargetIds`）。 */
  pendingTargetIds?: readonly string[]
  /** 当前批次是超管点名的（`wakeTimerExplicitTargets`），即使卡上没有持久化名单也按「指定会话」显示。 */
  explicitTargets?: boolean
  onChangeMode?: (mode: WakeTimerMode) => void
  onChangeDurationMinutes?: (minutes: number) => void
  onChangeTargetCardIds?: (targetCardIds: string[]) => void
  onWakeNow?: () => void
  onCancel?: () => void
}

/**
 * 待唤醒状态行。
 *
 * 唤醒方式的下拉直接放在这里，而不是只留在设置菜单里：用户看到"还没发车"的
 * 那一刻就是想改期的那一刻，让他为此翻两层菜单等于这个功能不存在。
 * 改动经 `rearmWakeTimerBatchForPatch` 立刻给当前批次重新计时，
 * 见 wake-timer SPEC「随时改条件」。
 */
export const WakeTimerStatus = ({
  language,
  queueLength,
  conditionText,
  pendingStatusLabel,
  queuePreviewText = '',
  wakeNowLabel,
  cancelLabel,
  wakeTimerMode,
  wakeTimerDurationMinutes,
  neighbourAvailable,
  isEmptyState = false,
  targetOptions,
  targetCardIds = [],
  pendingTargetIds = [],
  explicitTargets = false,
  onChangeMode,
  onChangeDurationMinutes,
  onChangeTargetCardIds,
  onWakeNow,
  onCancel,
}: WakeTimerStatusProps) => {
  const text = getLocaleText(language)
  // 选了「指定会话」但还一张没勾时名单为空，投影会立刻跳回原模式，用户根本
  // 来不及勾。用本地态把这一步撑住；一旦换回别的模式就放手。
  const [pickingSessions, setPickingSessions] = useState(false)
  const sessionsAvailable = targetOptions !== undefined
  const uiMode: WakeTimerUiMode =
    sessionsAvailable && (pickingSessions || targetCardIds.length > 0 || explicitTargets)
      ? 'sessions'
      : wakeTimerMode
  const showsPicker = uiMode === 'sessions' && (pickingSessions || targetCardIds.length > 0 || !explicitTargets)
  const showsDuration = uiMode === 'duration' || uiMode === 'sessions'

  return (
    <div
      className={`composer-wake-timer-status${isEmptyState ? ' is-empty-state' : ''}`}
      role="status"
    >
      <span className="composer-wake-timer-copy">
        <strong>{pendingStatusLabel}</strong>
        <span>
          {language === 'en'
            ? `${queueLength} message${queueLength === 1 ? '' : 's'} · ${conditionText}`
            : `${queueLength} 条消息 · ${conditionText}`}
        </span>
        {queuePreviewText ? (
          <span className="composer-wake-timer-preview" title={queuePreviewText}>
            {queuePreviewText}
          </span>
        ) : null}
      </span>
      <select
        className="reasoning-select composer-wake-timer-mode-select"
        aria-label={text.wakeTimerModeLabel}
        title={text.wakeTimerModeLabel}
        value={uiMode}
        disabled={!onChangeMode}
        onChange={(event) => {
          const next = event.target.value as WakeTimerUiMode
          if (next === 'sessions') {
            setPickingSessions(true)
            return
          }
          setPickingSessions(false)
          onChangeMode?.(next)
        }}
      >
        <option value="workspace-agents">{text.wakeTimerModeWorkspace}</option>
        <option value="left-tab" disabled={!neighbourAvailable}>
          {text.wakeTimerModeLeftTab}
        </option>
        <option value="duration">{text.wakeTimerModeDuration}</option>
        {sessionsAvailable ? <option value="sessions">{text.wakeTimerModeSessions}</option> : null}
      </select>
      {showsPicker && targetOptions ? (
        <WakeTimerTargetPicker
          language={language}
          options={targetOptions}
          selectedIds={targetCardIds}
          pendingIds={pendingTargetIds}
          onChange={onChangeTargetCardIds}
        />
      ) : null}
      {showsDuration ? (
        <span
          className="composer-wake-timer-duration-control"
          title={uiMode === 'sessions' ? text.wakeTimerSessionsTimeoutHint : undefined}
        >
          {uiMode === 'sessions' ? <span>{text.wakeTimerSessionsTimeoutLabel}</span> : null}
          <input
            type="number"
            className="control composer-wake-timer-duration-input"
            aria-label={uiMode === 'sessions' ? text.wakeTimerSessionsTimeoutLabel : text.wakeTimerDurationLabel}
            min={1}
            max={10080}
            step={1}
            value={wakeTimerDurationMinutes}
            disabled={!onChangeDurationMinutes}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next)) {
                onChangeDurationMinutes?.(Math.min(Math.max(next, 1), 10080))
              }
            }}
          />
          <span>{text.wakeTimerMinutes}</span>
        </span>
      ) : null}
      <button
        type="button"
        className="composer-queued-send-action"
        onClick={onWakeNow}
        disabled={!onWakeNow}
      >
        {wakeNowLabel}
      </button>
      <button
        type="button"
        className="composer-queued-send-action"
        onClick={onCancel}
        disabled={!onCancel}
      >
        {cancelLabel}
      </button>
    </div>
  )
}
