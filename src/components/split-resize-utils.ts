const minPanePixels = 120

const roundRatio = (value: number) => Math.round(value * 1_000_000_000_000) / 1_000_000_000_000

export const getResizedSplitRatios = (
  startRatios: number[],
  index: number,
  deltaRatio: number,
  totalSize: number,
  minimumPanePixels = minPanePixels,
) => {
  if (totalSize <= 0) {
    return null
  }

  const startBefore = startRatios[index] ?? 0
  const startAfter = startRatios[index + 1] ?? 0
  const combined = startBefore + startAfter
  if (combined <= 0) {
    return null
  }

  const minRatio = Math.min(minimumPanePixels / totalSize, combined / 2)
  const nextBefore = roundRatio(
    Math.min(Math.max(startBefore + deltaRatio, minRatio), combined - minRatio),
  )
  const nextAfter = roundRatio(combined - nextBefore)
  const nextRatios = [...startRatios]
  nextRatios[index] = nextBefore
  nextRatios[index + 1] = nextAfter
  return nextRatios
}
