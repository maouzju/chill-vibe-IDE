import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement } from 'react'

type HoverTooltipProps = {
  content: string
  children: ReactElement
}

const tooltipDelayMs = 500

export const HoverTooltip = ({ content, children }: HoverTooltipProps) => {
  const [open, setOpen] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
        <span id={tooltipId} role="tooltip" className="git-hover-tooltip">
          {content}
        </span>
      ) : null}
    </span>
  )
}
