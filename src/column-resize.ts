import { minColumnWidth } from '../shared/default-state'

const sumWidths = (widths: number[]) => widths.reduce((sum, width) => sum + width, 0)

const roundGroupToTotal = (widths: number[], targetTotal: number) => {
  const floors = widths.map((width) => Math.floor(width))
  const rounded = [...floors]
  const remainder = targetTotal - sumWidths(floors)

  if (remainder <= 0) {
    return rounded
  }

  const byFraction = widths
    .map((width, index) => ({ index, fraction: width - floors[index]! }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)

  for (let index = 0; index < remainder; index += 1) {
    rounded[byFraction[index]?.index ?? 0] += 1
  }

  return rounded
}

const scaleGroupToTotal = (widths: number[], targetTotal: number, minimumWidth: number) => {
  if (widths.length === 0) {
    return []
  }

  const nextWidths = new Array<number>(widths.length)
  let remaining = widths.map((width, index) => ({ index, width }))
  let remainingTarget = Math.max(widths.length * minimumWidth, targetTotal)

  while (remaining.length > 0) {
    if (remaining.length === 1) {
      nextWidths[remaining[0]!.index] = Math.max(minimumWidth, remainingTarget)
      break
    }

    const remainingBaseTotal = remaining.reduce((sum, item) => sum + item.width, 0)
    const scale = remainingBaseTotal > 0 ? remainingTarget / remainingBaseTotal : 1
    const clamped = remaining.filter((item) => item.width * scale <= minimumWidth)

    if (clamped.length === 0) {
      const scaled = remaining.map((item) => item.width * scale)
      const rounded = roundGroupToTotal(scaled, remainingTarget)
      remaining.forEach((item, index) => {
        nextWidths[item.index] = Math.max(minimumWidth, rounded[index] ?? minimumWidth)
      })
      break
    }

    for (const item of clamped) {
      nextWidths[item.index] = minimumWidth
    }

    remainingTarget -= clamped.length * minimumWidth
    remaining = remaining.filter((item) => item.width * scale > minimumWidth)
  }

  return nextWidths
}

export const resizeColumnGroups = (
  widths: number[],
  dividerIndex: number,
  delta: number,
  minimumWidth = minColumnWidth,
) => {
  const normalized = widths.map((width) => Math.max(minimumWidth, Math.round(width)))

  if (dividerIndex < 0 || dividerIndex >= normalized.length - 1) {
    return normalized
  }

  const leftWidths = normalized.slice(0, dividerIndex + 1)
  const rightWidths = normalized.slice(dividerIndex + 1)

  if (leftWidths.length === 0 || rightWidths.length === 0) {
    return normalized
  }

  const totalWidth = sumWidths(normalized)
  const leftTotal = sumWidths(leftWidths)
  const nextLeftTotal = Math.min(
    totalWidth - rightWidths.length * minimumWidth,
    Math.max(leftWidths.length * minimumWidth, leftTotal + Math.round(delta)),
  )
  const nextRightTotal = totalWidth - nextLeftTotal

  return [
    ...scaleGroupToTotal(leftWidths, nextLeftTotal, minimumWidth),
    ...scaleGroupToTotal(rightWidths, nextRightTotal, minimumWidth),
  ]
}
