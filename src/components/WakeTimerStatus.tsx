import { getLocaleText } from '../../shared/i18n'
import type { AppLanguage, WakeTimerMode } from '../../shared/schema'

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
  onChangeMode?: (mode: WakeTimerMode) => void
  onChangeDurationMinutes?: (minutes: number) => void
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
  onChangeMode,
  onChangeDurationMinutes,
  onWakeNow,
  onCancel,
}: WakeTimerStatusProps) => {
  const text = getLocaleText(language)

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
        value={wakeTimerMode}
        disabled={!onChangeMode}
        onChange={(event) => onChangeMode?.(event.target.value as WakeTimerMode)}
      >
        <option value="workspace-agents">{text.wakeTimerModeWorkspace}</option>
        <option value="left-tab" disabled={!neighbourAvailable}>
          {text.wakeTimerModeLeftTab}
        </option>
        <option value="duration">{text.wakeTimerModeDuration}</option>
      </select>
      {wakeTimerMode === 'duration' ? (
        <span className="composer-wake-timer-duration-control">
          <input
            type="number"
            className="control composer-wake-timer-duration-input"
            aria-label={text.wakeTimerDurationLabel}
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
