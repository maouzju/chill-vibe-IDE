export type PaneTabDragGesture = {
  tabId: string
  activeTabIdAtPointerDown: string | null
}

export type DragStartActiveTabRestoreInput = {
  draggedTabId: string
  gesture: PaneTabDragGesture | null
  currentActiveTabId: string
  paneTabIds: readonly string[]
  /** 本 pane 里哪些 tab 是自动化看板卡（顺序同 paneTabIds）。 */
  boardTabIds?: readonly string[]
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
export const decideDragStartActiveTabRestore = (
  input: DragStartActiveTabRestoreInput,
): string | null =>
  decideDragStartGestureUndo(input) ?? decideDragStartBoardReveal(input)

const decideDragStartGestureUndo = ({
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

/**
 * 症状：把看板项「拖出为独立 tab」之后再想拖回看板，全程 no-drop 光标。
 * 根因：拖出那一刻弹出的卡就成了 pane 的活动 tab（state.ts 的
 *   `moveAutomationBoardItemToPane` 刻意如此，用户要立刻看到它），于是看板面板
 *   `hidden` 且组件根本不挂载 —— 泳道落点不在 DOM 里。上面那条撤回逻辑只管
 *   「这次手势自己造成的切换」，而这里手势什么都没切，所以一次也没起作用。
 * 为什么不能换写法：不能让看板 tab 在非活动时保持挂载（`cardKeepsPaneRuntimeWhenInactive`
 *   只给 git 工具卡开了这个口子，看板挂着十几张项卡的转录，代价是主线程）；
 *   也不能靠 dragover 时才切换（拖拽已经开始，Chromium 会继续把事件派发给旧的
 *   命中目标，见 dnd.ts 里那条陈旧命中测试的注释）。所以只能在 dragstart 里
 *   先把落点亮出来，再由 dragend 还原。
 */
const decideDragStartBoardReveal = ({
  draggedTabId,
  currentActiveTabId,
  paneTabIds,
  boardTabIds = [],
}: DragStartActiveTabRestoreInput): string | null => {
  // 只在「拖的正是 pane 当前显示的东西」时才让位：其他情况下视图里已经有别的
  // 内容（可能就是看板本身），替用户换掉它属于越权。
  if (currentActiveTabId !== draggedTabId) {
    return null
  }

  return (
    boardTabIds.find((tabId) => tabId !== draggedTabId && paneTabIds.includes(tabId)) ?? null
  )
}
