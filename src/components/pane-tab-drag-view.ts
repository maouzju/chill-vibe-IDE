export type PaneTabDragGesture = {
  tabId: string
  activeTabIdAtPointerDown: string | null
}

export type DragStartActiveTabRestoreInput = {
  draggedTabId: string
  gesture: PaneTabDragGesture | null
  currentActiveTabId: string
  paneTabIds: readonly string[]
}

/**
 * 症状：pane 正显示自动化看板时去拖同一 tab 栏里的另一个 chat tab，看板瞬间被切走，
 * 泳道落点随之消失 —— FR4 的「chat tab 拖进看板」在同 pane 内根本无法完成。
 * 根因：`handleTabPointerDown` 排的 80ms 兜底激活（为丢失 pointerup 的卡死场景保命）
 * 几乎总在 `dragstart` 之前就跑掉了，drag 侧的 `cancelPendingTabSwitch` 来得太晚。
 * 为什么不能换写法：不能删/延长那个兜底（pane-tab-activation.test.ts 守着它），也不能在
 * tab 的 mousedown 上 preventDefault（那会杀掉 dragstart，pitfall 176/454）。所以只能在
 * dragstart 里把「这次手势自己造成的那一次切换」撤回，别的来源的切换一律不碰。
 */
export const decideDragStartActiveTabRestore = ({
  draggedTabId,
  gesture,
  currentActiveTabId,
  paneTabIds,
}: DragStartActiveTabRestoreInput): string | null => {
  if (!gesture || gesture.tabId !== draggedTabId) {
    return null
  }

  const previous = gesture.activeTabIdAtPointerDown
  if (!previous || previous === currentActiveTabId) {
    return null
  }

  // 只撤回「切到了被拖的这个 tab」这一种情况；活动 tab 变成别的东西说明切换来自
  // 快捷键 / rescue / 别的 pane，抢回去只会夺走用户刚选中的内容。
  if (currentActiveTabId !== draggedTabId) {
    return null
  }

  if (!paneTabIds.includes(previous)) {
    return null
  }

  return previous
}
