export type VirtualizedListWindow = {
  isVirtualized: boolean
  startIndex: number
  endIndex: number
  topSpacerHeight: number
  bottomSpacerHeight: number
}

type VirtualizedListWindowOptions = {
  itemCount: number
  itemHeight: number
  viewportHeight: number
  scrollTop: number
  overscan: number
  threshold: number
}

const fallbackVisibleRowCount = 12

export const getVirtualizedListWindow = ({
  itemCount,
  itemHeight,
  viewportHeight,
  scrollTop,
  overscan,
  threshold,
}: VirtualizedListWindowOptions): VirtualizedListWindow => {
  const safeItemCount = Math.max(Math.trunc(itemCount), 0)
  const safeItemHeight = Math.max(itemHeight, 1)
  const safeThreshold = Math.max(Math.trunc(threshold), 1)
  const safeOverscan = Math.max(Math.trunc(overscan), 0)

  if (safeItemCount <= safeThreshold) {
    return {
      isVirtualized: false,
      startIndex: 0,
      endIndex: safeItemCount,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    }
  }

  const safeViewportHeight =
    viewportHeight > 0 ? viewportHeight : safeItemHeight * fallbackVisibleRowCount
  const safeScrollTop = Math.max(scrollTop, 0)
  const startIndex = Math.max(Math.floor(safeScrollTop / safeItemHeight) - safeOverscan, 0)
  const endIndex = Math.min(
    Math.ceil((safeScrollTop + safeViewportHeight) / safeItemHeight) + safeOverscan,
    safeItemCount,
  )
  const clampedEndIndex = Math.max(endIndex, startIndex + 1)

  return {
    isVirtualized: true,
    startIndex,
    endIndex: clampedEndIndex,
    topSpacerHeight: startIndex * safeItemHeight,
    bottomSpacerHeight: Math.max(safeItemCount - clampedEndIndex, 0) * safeItemHeight,
  }
}
