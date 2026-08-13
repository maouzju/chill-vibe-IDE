export type PaneTabCloseTargets = {
  others: string[]
  toTheLeft: string[]
  toTheRight: string[]
}

const EMPTY_TARGETS: PaneTabCloseTargets = { others: [], toTheLeft: [], toTheRight: [] }

/**
 * tab 右键菜单里「关闭其他 / 关闭左侧 / 关闭右侧」要关掉的 tab 列表。
 *
 * 症状：右键一个已经不属于该 pane 的 tab（拖走后菜单还开着）会把整条 tab 栏关光。
 * 根因：indexOf 未命中返回 -1，`slice(-1 + 1)` 就是 `slice(0)` —— 整个数组。
 * 为什么不内联算：三个方向要共用同一个未命中守卫，抽出来才能被单测钉住。
 */
export const resolvePaneTabCloseTargets = (
  paneTabIds: readonly string[],
  tabId: string,
): PaneTabCloseTargets => {
  const index = paneTabIds.indexOf(tabId)
  if (index < 0) return { ...EMPTY_TARGETS }
  return {
    others: paneTabIds.filter((id) => id !== tabId),
    toTheLeft: paneTabIds.slice(0, index),
    toTheRight: paneTabIds.slice(index + 1),
  }
}
