import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type ComposerSettingsRowProps = {
  label: string
  /** 悬停后才显示的说明。缺省即这一行没有解释，通不过设置菜单的 hint 覆盖测试。 */
  hint: string
  className?: string
  /** 行内控件是 checkbox 时用 label 包裹（点整行即可切换），select/number 用 div。 */
  as?: 'label' | 'div'
  children: ReactNode
}

const hintDelayMs = 320
const hintWidthPx = 256
const hintGapPx = 8
const hintViewportPaddingPx = 8

type HintPosition = { top: number; left: number }

/**
 * 设置菜单里的一行。
 *
 * 症状：每条说明都常驻在开关下方，八行设置被撑成一屏长文，菜单还会顶到卡片边界。
 * 根因：说明是 `.composer-settings-note` 这种参与布局的块级元素，读一次之后永远占位。
 * 为什么不能换写法：说明不能塞进纯 CSS `:hover` 气泡或 `title` —— 菜单本身是
 * `overflow-y: auto` 的滚动容器（overflow-x 因此计算为 auto），任何在菜单内部绝对定位的
 * 气泡都会被裁掉；`title` 则延迟长、样式不受控、两套主题都对不上。所以走 portal + fixed。
 */
export const ComposerSettingsRow = ({
  label,
  hint,
  className,
  as = 'label',
  children,
}: ComposerSettingsRowProps) => {
  const [position, setPosition] = useState<HintPosition | null>(null)
  const rowRef = useRef<HTMLElement | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hintId = useId()

  const clearScheduledOpen = () => {
    if (timeoutRef.current === null) {
      return
    }

    clearTimeout(timeoutRef.current)
    timeoutRef.current = null
  }

  const show = useCallback(() => {
    const row = rowRef.current
    if (!row) {
      return
    }

    const rect = row.getBoundingClientRect()
    const fitsOnTheLeft = rect.left >= hintWidthPx + hintGapPx + hintViewportPaddingPx
    const left = fitsOnTheLeft
      ? rect.left - hintGapPx - hintWidthPx
      : Math.min(rect.right + hintGapPx, window.innerWidth - hintWidthPx - hintViewportPaddingPx)

    setPosition({
      top: Math.max(hintViewportPaddingPx, rect.top + rect.height / 2),
      left: Math.max(hintViewportPaddingPx, left),
    })
  }, [])

  const scheduleOpen = useCallback(() => {
    clearScheduledOpen()
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null
      show()
    }, hintDelayMs)
  }, [show])

  const hide = useCallback(() => {
    clearScheduledOpen()
    setPosition(null)
  }, [])

  useEffect(() => clearScheduledOpen, [])

  const Row = as
  const rowClassName = ['composer-settings-row', className].filter(Boolean).join(' ')

  return (
    <>
      <Row
        ref={rowRef as never}
        className={rowClassName}
        data-hint={hint}
        aria-describedby={position ? hintId : undefined}
        onMouseEnter={scheduleOpen}
        onMouseLeave={hide}
        onFocus={scheduleOpen}
        onBlur={hide}
      >
        <span className="composer-settings-label">{label}</span>
        {children}
      </Row>
      {position && typeof document !== 'undefined'
        ? createPortal(
            <span
              id={hintId}
              role="tooltip"
              className="composer-settings-hint"
              style={{ top: `${position.top}px`, left: `${position.left}px` }}
            >
              {hint}
            </span>,
            document.body,
          )
        : null}
    </>
  )
}
