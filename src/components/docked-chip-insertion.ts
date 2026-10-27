export interface DockChipRect {
  id: string
  left: number
  right: number
  top: number
  bottom: number
}

export interface DockInsertion {
  targetId: string
  placement: 'before' | 'after'
}

/**
 * 顶栏收起的 chip 可能换成多行，所以插入位置要先按指针 y 选行、再按 x 在行内找缝：
 * 指针落在哪条缝，就插进哪条缝；落在行首之前 = 插到该行第一个之前，行尾之后 = 插到该行最后一个之后。
 * 被拖的 chip 自己不参与（它所在的缝会因此自然落成"没变"）。
 */
export function resolveDockInsertion(
  chips: readonly DockChipRect[],
  point: { x: number; y: number },
  excludeId?: string,
): DockInsertion | null {
  const candidates = chips
    .filter((chip) => chip.id !== excludeId)
    .sort((a, b) => a.top + a.bottom - (b.top + b.bottom) || a.left - b.left)
  if (candidates.length === 0) {
    return null
  }

  const rows: DockChipRect[][] = []
  for (const chip of candidates) {
    const row = rows.at(-1)
    const first = row?.[0]
    const centerY = (chip.top + chip.bottom) / 2
    if (row && first && Math.abs(centerY - (first.top + first.bottom) / 2) < (chip.bottom - chip.top) / 2) {
      row.push(chip)
    } else {
      rows.push([chip])
    }
  }

  let bestRow = rows[0]
  let bestDistance = Infinity
  for (const row of rows) {
    const first = row[0]
    const distance = Math.abs(point.y - (first.top + first.bottom) / 2)
    if (distance < bestDistance) {
      bestDistance = distance
      bestRow = row
    }
  }

  const ordered = [...bestRow].sort((a, b) => a.left - b.left)
  const after = ordered.find((chip) => point.x < (chip.left + chip.right) / 2)
  if (after) {
    return { targetId: after.id, placement: 'before' }
  }
  return { targetId: ordered[ordered.length - 1].id, placement: 'after' }
}

/** 从最宽松的档开始试，第一档能塞进一行的就用；都塞不下取最紧一档并允许换行。 */
export function pickTopbarDensityLevel(levelCount: number, fitsOnOneRow: (level: number) => boolean): number {
  for (let level = 0; level < levelCount; level += 1) {
    if (fitsOnOneRow(level)) {
      return level
    }
  }
  return levelCount - 1
}
