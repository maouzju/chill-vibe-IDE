import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react'

type HoverTooltipProps = {
  content: string
  children: ReactElement
}

const tooltipDelayMs = 500

// 2026-11-24 用户截图：窄分栏的 Git 卡里，hover「同步」弹出的说明气泡左右都被卡片裁掉
// （「先拉取远程改动」只剩「对远程改动」，「推送。」没了）。气泡以锚点为中心展开、宽度
// 12–18rem，比卡片还宽时必然越过 .card-shell 的 overflow: hidden（同 pitfall #418，那次
// 只给 composer 圆环写了 CSS 特例）。纯 CSS 的 absolute 无法把「居中气泡」夹在祖先盒子
// 内，所以打开时量一次几何：宽度收缩到裁剪祖先的可用宽，再把水平/垂直偏移写进 CSS 变量。
const clampTooltipToAncestors = (tooltip: HTMLElement) => {
  tooltip.style.removeProperty('--git-tooltip-shift-x')
  tooltip.style.removeProperty('--git-tooltip-shift-y')
  tooltip.style.removeProperty('min-width')
  tooltip.style.removeProperty('max-width')

  const viewportInset = 8
  let bounds = {
    left: viewportInset,
    right: window.innerWidth - viewportInset,
    top: viewportInset,
    bottom: window.innerHeight - viewportInset,
  }

  // 只统计真正会裁掉子孙的祖先（hidden / clip / auto / scroll），并把边界向里收 2px
  // 当缓冲，避免亚像素误差让气泡压在 border 上。
  for (let parent = tooltip.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)

    if (!/hidden|clip|auto|scroll/.test(`${style.overflowX} ${style.overflowY}`)) {
      continue
    }

    const box = parent.getBoundingClientRect()
    bounds = {
      left: Math.max(bounds.left, box.left + 2),
      right: Math.min(bounds.right, box.right - 2),
      top: Math.max(bounds.top, box.top + 2),
      bottom: Math.min(bounds.bottom, box.bottom - 2),
    }
  }

  const availableWidth = Math.max(0, bounds.right - bounds.left)
  let rect = tooltip.getBoundingClientRect()

  if (rect.width > availableWidth) {
    tooltip.style.minWidth = '0px'
    tooltip.style.maxWidth = `${availableWidth}px`
    rect = tooltip.getBoundingClientRect()
  }

  // 先按越界的那一侧回推；两侧都越界时左缘优先（长文本换行后会自然长高而不是继续横向溢出）。
  let shiftX = 0

  if (rect.right > bounds.right) {
    shiftX = bounds.right - rect.right
  }

  if (rect.left + shiftX < bounds.left) {
    shiftX = bounds.left - rect.left
  }

  let shiftY = 0

  if (rect.top < bounds.top) {
    shiftY = bounds.top - rect.top
  }

  if (shiftX !== 0) {
    tooltip.style.setProperty('--git-tooltip-shift-x', `${shiftX}px`)
  }

  if (shiftY !== 0) {
    tooltip.style.setProperty('--git-tooltip-shift-y', `${shiftY}px`)
  }
}

export const HoverTooltip = ({ content, children }: HoverTooltipProps) => {
  const [open, setOpen] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tooltipRef = useRef<HTMLSpanElement | null>(null)
  const tooltipId = useId()

  const clearScheduledOpen = () => {
    if (timeoutRef.current === null) {
      return
    }

    clearTimeout(timeoutRef.current)
    timeoutRef.current = null
  }

  const scheduleOpen = () => {
    clearScheduledOpen()

    timeoutRef.current = setTimeout(() => {
      setOpen(true)
      timeoutRef.current = null
    }, tooltipDelayMs)
  }

  const hide = () => {
    clearScheduledOpen()
    setOpen(false)
  }

  useEffect(
    () => () => {
      clearScheduledOpen()
    },
    [],
  )

  useLayoutEffect(() => {
    if (!open) {
      return
    }

    const tooltip = tooltipRef.current

    if (!tooltip) {
      return
    }

    clampTooltipToAncestors(tooltip)

    const reposition = () => clampTooltipToAncestors(tooltip)
    window.addEventListener('resize', reposition)

    return () => {
      window.removeEventListener('resize', reposition)
    }
  }, [open, content])

  const child =
    isValidElement(children)
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          'aria-describedby': open ? tooltipId : undefined,
        })
      : children

  return (
    <span
      className="git-hover-tooltip-anchor"
      onMouseEnter={scheduleOpen}
      onMouseLeave={hide}
      onFocus={scheduleOpen}
      onBlur={hide}
    >
      {child}
      {open ? (
        <span id={tooltipId} role="tooltip" className="git-hover-tooltip" ref={tooltipRef}>
          {content}
        </span>
      ) : null}
    </span>
  )
}
