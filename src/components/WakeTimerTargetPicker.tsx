import { getLocaleText } from '../../shared/i18n'
import type { AppLanguage } from '../../shared/schema'

export type WakeTimerTargetOption = { id: string; title: string }

/**
 * 「指定会话」的勾选名单。
 *
 * 症状：2026-09-20 用户反馈待唤醒只能"等其他 Agent 完成"，用户自己正在聊的窗口
 *   也算 Agent，一张无关的长跑卡就能把等待压住；超管虽然能用 MCP 点名，但界面
 *   上既看不到点了谁、也改不了名单。
 * 根因：等待名单只有超管 MCP 一条写入口，UI 下拉硬编码三项。
 * 被否决：在下拉里给每张卡生成一个选项 —— 名单是多选，`<select>` 表达不了；
 *   弹层则会在看板抽屉与 composer 状态行两个入口各写一份。这里做成一个纯受控
 *   组件，两处共用，差异只在容器样式。
 */
export const WakeTimerTargetPicker = ({
  language,
  options,
  selectedIds,
  pendingIds = [],
  disabled = false,
  onChange,
}: {
  language: AppLanguage
  options: readonly WakeTimerTargetOption[]
  selectedIds: readonly string[]
  /** 当前批次仍在等的那几张；名单里已经结束的会话不再高亮。 */
  pendingIds?: readonly string[]
  disabled?: boolean
  onChange?: (nextIds: string[]) => void
}) => {
  const text = getLocaleText(language)
  const selected = new Set(selectedIds)
  const pending = new Set(pendingIds)

  if (options.length === 0) {
    return <div className="composer-settings-note is-warning">{text.wakeTimerSessionsEmpty}</div>
  }

  return (
    <div className="composer-wake-timer-target-picker" role="group" aria-label={text.wakeTimerModeSessions}>
      {options.map((option) => {
        const checked = selected.has(option.id)
        return (
          <label
            key={option.id}
            className={`composer-wake-timer-target-option${checked ? ' is-selected' : ''}${
              checked && pending.has(option.id) ? ' is-pending' : ''
            }`}
            title={option.title}
          >
            <input
              type="checkbox"
              className="composer-settings-checkbox"
              value={option.id}
              checked={checked}
              disabled={disabled || !onChange}
              onChange={(event) => {
                const next = new Set(selected)
                if (event.target.checked) {
                  next.add(option.id)
                } else {
                  next.delete(option.id)
                }
                // 按 options 顺序输出，避免名单随点击顺序抖动。
                onChange?.(options.filter((entry) => next.has(entry.id)).map((entry) => entry.id))
              }}
            />
            <span className="composer-wake-timer-target-title">{option.title || option.id}</span>
          </label>
        )
      })}
    </div>
  )
}
