import type { PointerEvent } from 'react'

import { getResizedSplitRatios } from './split-resize-utils'

type SplitResizeHandleProps = {
  direction: 'horizontal' | 'vertical'
  splitId: string
  index: number
  ratios: number[]
  onResize: (splitId: string, ratios: number[]) => void
}

export const SplitResizeHandle = ({
  direction,
  splitId,
  index,
  ratios,
  onResize,
}: SplitResizeHandleProps) => {
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()

    const container = event.currentTarget.parentElement
    if (!container) {
      return
    }

    const rect = container.getBoundingClientRect()
    const totalSize = direction === 'horizontal' ? rect.width : rect.height
    if (totalSize <= 0) {
      return
    }

    const startPosition = direction === 'horizontal' ? event.clientX : event.clientY
    const startRatios = [...ratios]
    const startBefore = startRatios[index] ?? 0
    const startAfter = startRatios[index + 1] ?? 0
    const combined = startBefore + startAfter
    if (combined <= 0) {
      return
    }

    document.body.classList.add('is-pane-resizing', `is-pane-resizing-${direction}`)

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const currentPosition = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY
      const deltaRatio = (currentPosition - startPosition) / totalSize
      const nextRatios = getResizedSplitRatios(startRatios, index, deltaRatio, totalSize)
      if (nextRatios) {
        onResize(splitId, nextRatios)
      }
    }

    const handleStop = () => {
      document.body.classList.remove('is-pane-resizing', `is-pane-resizing-${direction}`)
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleStop)
      window.removeEventListener('pointercancel', handleStop)
      window.removeEventListener('blur', handleStop)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleStop)
    window.addEventListener('pointercancel', handleStop)
    window.addEventListener('blur', handleStop)
  }

  return (
    <div
      className={`split-resize-handle is-${direction}`}
      onPointerDown={handlePointerDown}
      role="separator"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-label="Resize panes"
    />
  )
}
