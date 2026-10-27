import { useLayoutEffect, type RefObject } from 'react'

import { pickTopbarDensityLevel } from './docked-chip-insertion.ts'

const densityLevelCount = 3

const isWrappedToSecondRow = (items: readonly HTMLElement[]): boolean => {
  let minCenter = Infinity
  let maxCenter = -Infinity
  for (const item of items) {
    const rect = item.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      continue
    }
    const center = (rect.top + rect.bottom) / 2
    minCenter = Math.min(minCenter, center)
    maxCenter = Math.max(maxCenter, center)
  }
  return maxCenter - minCenter > 8
}

/**
 * 顶栏页签 + 收起工作区 chip 一行放不下时，先逐档收紧间距 / chip 宽度（data-density 0→2），
 * 最紧一档仍放不下才换到第二行（data-rows="multi"）。
 * 直接写 DOM 属性而不是 React state：量一次、改属性、再量，全在同一个 layout 里完成，不会闪一帧中间态。
 */
export function useTopbarChipDensity(listRef: RefObject<HTMLElement | null>, signature: string): void {
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) {
      return
    }

    const apply = () => {
      const items = Array.from(list.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
      const level = pickTopbarDensityLevel(densityLevelCount, (candidate) => {
        list.dataset.density = String(candidate)
        return !isWrappedToSecondRow(items)
      })
      list.dataset.density = String(level)
      list.dataset.rows = isWrappedToSecondRow(items) ? 'multi' : 'single'
    }

    apply()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    let lastWidth = list.clientWidth
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (list.clientWidth === lastWidth) {
        return
      }
      lastWidth = list.clientWidth
      // apply 会改变列表高度；在 RO 回调里同步改会触发 "ResizeObserver loop" 报错，所以挪到下一帧。
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(apply)
    })
    observer.observe(list)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [listRef, signature])
}
