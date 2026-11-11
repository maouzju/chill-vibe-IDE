// 工作区列收进顶栏的过渡动效。见 docs/specs/workspace-column-dock「增补（2026-11-03）」。
//
// 停靠列整棵子树会被卸载（design.md「看板」），所以动效只能在 dispatch 前量好
// 列的位置、在提交后量 chip 的位置，再用一个挂在 body 上的幽灵块从列飞到 chip。
// 全部走 WAAPI 一次性动画、结束即移除 —— 不往 index.css 加任何无限动画
// （tests/idle-animation-budget.test.ts）。

const DOCK_FLIGHT_MS = 420
const DOCK_CHIP_POP_MS = 260
const DOCK_SIBLING_SLIDE_MS = 320
const DOCK_EASE = 'cubic-bezier(0.45, 0, 0.2, 1)'

type ColumnRectMap = Map<string, DOMRect>

export type ColumnDockAnimationSnapshot = {
  columnId: string
  label: string
  sourceRect: DOMRect
  siblingRects: ColumnRectMap
  /** 拖到顶栏松手时：幽灵块已经"在手上"，从松手点直接飞进 chip，不再从列原位重播整段。 */
  fromDropPoint: boolean
}

export type ColumnDockDropPoint = { x: number; y: number }

const DROP_GHOST_WIDTH = 160
const DROP_GHOST_HEIGHT = 32
const DROP_FLIGHT_MS = 220

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const supportsWebAnimations = () =>
  typeof document !== 'undefined' && typeof document.body?.animate === 'function'

const escapeAttributeValue = (value: string) =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/"/g, '\\"')

const findBoardColumn = (columnId: string) =>
  document.querySelector<HTMLElement>(`.workspace-column[data-column-id="${escapeAttributeValue(columnId)}"]`)

const findDockedChip = (columnId: string) =>
  document.querySelector<HTMLElement>(`.app-topbar-docked-column[data-column-id="${escapeAttributeValue(columnId)}"]`)

/** 在 dispatch dockColumn 之前调用：量好要飞走的列和其余列的位置。 */
export const captureColumnDockAnimation = (
  columnId: string,
  dropPoint?: ColumnDockDropPoint | null,
): ColumnDockAnimationSnapshot | null => {
  if (typeof document === 'undefined' || prefersReducedMotion() || !supportsWebAnimations()) {
    return null
  }

  const column = findBoardColumn(columnId)
  if (!column) {
    return null
  }

  const siblingRects: ColumnRectMap = new Map()
  for (const sibling of document.querySelectorAll<HTMLElement>('.workspace-column[data-column-id]')) {
    const id = sibling.dataset.columnId
    if (id && id !== columnId) {
      siblingRects.set(id, sibling.getBoundingClientRect())
    }
  }

  return {
    columnId,
    label: column.querySelector('.column-title-btn')?.textContent?.trim() ?? '',
    // 症状(11-11)：拖到顶栏松手后，幽灵块又从列原位整段飞一遍，像动画从头重播。
    // 根因：拖拽时列已经跟手到了顶栏，起点却仍取列的原始 rect。
    // 拖拽路径改从松手点起飞；右键路径没有跟手过程，仍从列原位起飞。
    sourceRect: dropPoint
      ? new DOMRect(
          dropPoint.x - DROP_GHOST_WIDTH / 2,
          dropPoint.y - DROP_GHOST_HEIGHT / 2,
          DROP_GHOST_WIDTH,
          DROP_GHOST_HEIGHT,
        )
      : column.getBoundingClientRect(),
    siblingRects,
    fromDropPoint: Boolean(dropPoint),
  }
}

const slideSiblingColumns = (siblingRects: ColumnRectMap) => {
  for (const [id, before] of siblingRects) {
    const sibling = findBoardColumn(id)
    if (!sibling) {
      continue
    }

    const after = sibling.getBoundingClientRect()
    const dx = before.left - after.left
    if (Math.abs(dx) < 1 && Math.abs(before.width - after.width) < 1) {
      continue
    }

    // 只做位移，不做宽度插值：列宽变化交给提交后的真实布局，避免整列内容被 scaleX 压扁。
    sibling.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], {
      duration: DOCK_SIBLING_SLIDE_MS,
      easing: DOCK_EASE,
    })
  }
}

const popDockedChip = (chip: HTMLElement, delay: number) => {
  chip.animate(
    [
      { transform: 'scale(0.6)', opacity: 0 },
      { transform: 'scale(1.12)', opacity: 1, offset: 0.6 },
      { transform: 'scale(1)', opacity: 1 },
    ],
    { duration: DOCK_CHIP_POP_MS, delay, easing: 'ease-out', fill: 'backwards' },
  )
}

const flyGhostToChip = (snapshot: ColumnDockAnimationSnapshot, chip: HTMLElement) => {
  const { sourceRect } = snapshot
  const targetRect = chip.getBoundingClientRect()
  if (targetRect.width === 0 || sourceRect.width === 0) {
    popDockedChip(chip, 0)
    return
  }

  const ghost = document.createElement('div')
  ghost.className = 'column-dock-ghost'
  ghost.setAttribute('aria-hidden', 'true')
  ghost.textContent = snapshot.label
  document.body.appendChild(ghost)

  // 插值 left/top/width/height 而不是 transform: scale —— 列和 chip 的宽高比差两个数量级，
  // 非等比缩放会把圆角压成椭圆、把文字压扁。只有这一个 fixed 元素，回流代价可以忽略。
  const frame = (rect: DOMRect | { left: number; top: number; width: number; height: number }) => ({
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
  const midWidth = Math.max(targetRect.width * 2.4, sourceRect.width * 0.32)
  const midHeight = Math.max(targetRect.height * 2.2, sourceRect.height * 0.18)
  const sourceCenterX = sourceRect.left + sourceRect.width / 2
  const targetCenterX = targetRect.left + targetRect.width / 2
  const midCenterX = sourceCenterX + (targetCenterX - sourceCenterX) * 0.45
  const midTop = sourceRect.top + (targetRect.top - sourceRect.top) * 0.35

  if (snapshot.fromDropPoint) {
    const shortFlight = ghost.animate(
      [
        { ...frame(sourceRect), opacity: 0.95, borderRadius: '999px' },
        { ...frame(targetRect), opacity: 0.6, borderRadius: '999px' },
      ],
      { duration: DROP_FLIGHT_MS, easing: 'ease-out', fill: 'forwards' },
    )
    const cleanupShort = () => ghost.remove()
    shortFlight.onfinish = cleanupShort
    shortFlight.oncancel = cleanupShort
    window.setTimeout(cleanupShort, DROP_FLIGHT_MS + 500)
    popDockedChip(chip, Math.round(DROP_FLIGHT_MS * 0.7))
    return
  }

  const flight = ghost.animate(
    [
      { ...frame(sourceRect), opacity: 0.95, borderRadius: '10px' },
      {
        ...frame({ left: midCenterX - midWidth / 2, top: midTop, width: midWidth, height: midHeight }),
        opacity: 0.95,
        borderRadius: '14px',
        offset: 0.5,
      },
      { ...frame(targetRect), opacity: 0.6, borderRadius: '999px' },
    ],
    { duration: DOCK_FLIGHT_MS, easing: DOCK_EASE, fill: 'forwards' },
  )

  const cleanup = () => ghost.remove()
  flight.onfinish = cleanup
  flight.oncancel = cleanup
  // 兜底：后台窗口里 WAAPI 可能被节流到永远不 finish，幽灵块不能常驻。
  window.setTimeout(cleanup, DOCK_FLIGHT_MS + 500)

  popDockedChip(chip, Math.round(DOCK_FLIGHT_MS * 0.8))
}

/** 在 dispatch dockColumn 之后调用：等 React 提交后让列飞进 chip、其余列滑过来补位。 */
export const playColumnDockAnimation = (snapshot: ColumnDockAnimationSnapshot | null) => {
  if (!snapshot) {
    return
  }

  window.requestAnimationFrame(() => {
    const chip = findDockedChip(snapshot.columnId)
    slideSiblingColumns(snapshot.siblingRects)
    if (chip) {
      flyGhostToChip(snapshot, chip)
    }
  })
}
