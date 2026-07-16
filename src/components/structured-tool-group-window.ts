export const structuredToolGroupVisibleTailCount = 60
export const structuredToolGroupRevealBatchCount = 60

const normalizeCount = (value: number) => {
  if (value === Number.POSITIVE_INFINITY) {
    return value
  }

  return Number.isFinite(value) ? Math.max(Math.trunc(value), 0) : 0
}

export const getStructuredToolGroupRenderWindow = <Item>(
  items: Item[],
  revealedOlderItemCount = 0,
  visibleTailCount = structuredToolGroupVisibleTailCount,
) => {
  const normalizedTailCount = Math.max(normalizeCount(visibleTailCount), 1)
  const normalizedRevealedCount = normalizeCount(revealedOlderItemCount)
  const visibleItemCount = Math.min(
    items.length,
    normalizedRevealedCount === Number.POSITIVE_INFINITY
      ? items.length
      : normalizedTailCount + normalizedRevealedCount,
  )
  const hiddenItemCount = Math.max(items.length - visibleItemCount, 0)

  return {
    hiddenItemCount,
    visibleItems: items.slice(hiddenItemCount),
  }
}
