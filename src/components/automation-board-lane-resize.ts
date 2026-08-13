import { automationBoardLanes } from '../../shared/schema'
import type { AutomationBoardLaneWidths } from '../../shared/schema'

/**
 * 泳道能被拖到的最窄宽度。
 *
 * v2.1 那条 `> 240px` 的回归断言量的是**自动**布局下的可读下限（泳道头部的
 * 「标题 + 计数胶囊」在那以下开始截断）。手动拖窄是用户的明确意图，闸门可以更
 * 低，但不能到 0：一条 0 宽的泳道没有任何 UI 能把它拖回来。
 */
export const AUTOMATION_BOARD_LANE_MIN_WIDTH = 150

const EVEN_SPLIT: number[] = automationBoardLanes.map(() => 1)

/**
 * 读出三条泳道的宽度权重。
 *
 * 任何一条不可用就整组退回均分：局部修补（只把坏的那条改成 1）会让另外两条的
 * 比例凭空放大几百倍，用户看到的是一条几乎不可见的泳道，比"回到默认"更难理解。
 */
export const resolveAutomationBoardLaneWidths = (
  value: AutomationBoardLaneWidths | undefined,
): number[] => {
  if (!value) {
    return EVEN_SPLIT
  }

  const widths = automationBoardLanes.map((lane) => value[lane])

  if (widths.some((width) => typeof width !== 'number' || !Number.isFinite(width) || width <= 0)) {
    return EVEN_SPLIT
  }

  return widths
}

/**
 * 转成 grid 轨道。
 *
 * `minmax(0, …)` 是硬要求而不是习惯：没有它，一条泳道里的长需求标题会把轨道顶
 * 宽，用户拖出来的比例当场作废。
 */
export const getAutomationBoardLaneTracks = (widths: number[]): string =>
  widths.map((width) => `minmax(0, ${width}fr)`).join(' ')

export const toAutomationBoardLaneWidths = (widths: number[]): AutomationBoardLaneWidths => ({
  standby: widths[0] ?? 1,
  running: widths[1] ?? 1,
  done: widths[2] ?? 1,
})
