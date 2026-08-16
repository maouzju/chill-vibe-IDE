import { getLocaleText } from '../../shared/i18n'
import type { AppLanguage, ChatCard, WakeTimerMode } from '../../shared/schema'
import { ComposerSettingsRow } from './ComposerSettingsRow'

/** 等待的那个邻居：普通 tab 是左邻 tab，看板项是同泳道上一项。 */
export type WakeTimerNeighbourTarget = { id: string; title: string } | null

export type WakeTimerSettingsPanelProps = {
  language: AppLanguage
  /**
   * `left-tab` 这个模式在两处语境里等的是同一种东西（"我前面那一个"），
   * 只有方位词不同：composer 里是"左侧 Tab"，看板里是"上方需求"。
   */
  context: 'tab' | 'board'
  card: Pick<ChatCard, 'wakeTimerActive' | 'wakeTimerMode' | 'wakeTimerDurationMinutes'>
  neighbourTarget: WakeTimerNeighbourTarget
  /** 本工作区里除自己以外的 Agent 数量，`workspace-agents` 模式的提示用。 */
  workspaceAgentCount: number
  /**
   * 批次已挂起。2026-08-15 起这不再是"锁住"，而是"改了立刻给这批改期"：
   * 控件保持可用，只补一句说明。见 wake-timer SPEC「随时改条件」。
   */
  locked: boolean
  onPatch: (patch: Partial<ChatCard>) => void
  className?: string
}

/**
 * 计划唤醒的设置面板。
 *
 * 症状：看板项的二级抽屉里只有一个"上方需求"复选框，用户既选不了"等其他 Agent"
 *   也设不了时长，同一个功能在两个入口长得完全不一样。
 * 根因：这块 UI 原本内联在 `ChatCard` 的设置菜单里，看板只能另写一个残缺版。
 * 为什么不能各写各的：唤醒模式是三选一的状态机（`shared/schema.ts` 的
 *   `wakeTimerMode`），任何一侧漏掉一个分支，用户在那个入口就永久够不到那个模式。
 *   所以两处必须共用这一个组件，差异只允许出现在文案（`context`）上。
 */
export const WakeTimerSettingsPanel = ({
  language,
  context,
  card,
  neighbourTarget,
  workspaceAgentCount,
  locked,
  onPatch,
  className,
}: WakeTimerSettingsPanelProps) => {
  const text = getLocaleText(language)
  const mode: WakeTimerMode = card.wakeTimerMode ?? 'workspace-agents'
  const isBoard = context === 'board'
  const neighbourLabel = isBoard ? text.automationBoardWakeAboveLabel : text.wakeTimerModeLeftTab
  const neighbourUnavailable = isBoard
    ? text.automationBoardWakeAboveUnavailable
    : text.wakeTimerLeftUnavailable
  const neighbourMissing = mode === 'left-tab' && !neighbourTarget

  return (
    <div className={['composer-wake-timer-module', className].filter(Boolean).join(' ')}>
      <ComposerSettingsRow label={text.wakeTimerLabel} hint={text.wakeTimerHint}>
        <input
          type="checkbox"
          className="composer-settings-checkbox"
          checked={card.wakeTimerActive === true}
          // 用户自己拨的开关是显式意图：清掉"右键替你开的"标记，批次结束后不再自动关。
          onChange={(event) =>
            onPatch({ wakeTimerActive: event.target.checked, wakeTimerAutoActivated: false })
          }
        />
      </ComposerSettingsRow>
      {card.wakeTimerActive === true ? (
        <>
          <ComposerSettingsRow
            label={text.wakeTimerModeLabel}
            hint={isBoard ? text.automationBoardWakeModeHint : text.wakeTimerModeHint}
          >
            <select
              className="reasoning-select"
              value={mode}
              onChange={(event) => onPatch({ wakeTimerMode: event.target.value as WakeTimerMode })}
            >
              <option value="workspace-agents">{text.wakeTimerModeWorkspace}</option>
              {/* 没有邻居可等时切进去就是把批次埋掉，直接不让选。 */}
              <option value="left-tab" disabled={!neighbourTarget}>{neighbourLabel}</option>
              <option value="duration">{text.wakeTimerModeDuration}</option>
            </select>
          </ComposerSettingsRow>
          {mode === 'duration' ? (
            <ComposerSettingsRow
              className="composer-wake-timer-duration-row"
              label={text.wakeTimerDurationLabel}
              hint={text.wakeTimerDurationHint}
            >
              <span className="composer-wake-timer-duration-control">
                <input
                  type="number"
                  className="control composer-wake-timer-duration-input"
                  min={1}
                  max={10080}
                  step={1}
                  value={card.wakeTimerDurationMinutes ?? 30}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    if (Number.isFinite(next)) {
                      onPatch({ wakeTimerDurationMinutes: Math.min(Math.max(next, 1), 10080) })
                    }
                  }}
                />
                <span>{text.wakeTimerMinutes}</span>
              </span>
            </ComposerSettingsRow>
          ) : null}
          {neighbourMissing ? (
            <div className="composer-settings-note is-warning">{neighbourUnavailable}</div>
          ) : null}
          {mode === 'workspace-agents' ? (
            <div className="composer-settings-note">
              {text.wakeTimerWorkspaceAgentCount(workspaceAgentCount)}
            </div>
          ) : null}
          {locked ? <div className="composer-settings-note">{text.wakeTimerBatchRearms}</div> : null}
        </>
      ) : null}
    </div>
  )
}
