import type { BoardColumn, SessionHistoryEntry } from '../shared/schema'

/**
 * 症状（要防的）：统计卡要看全板的 columns + sessionHistory，但它是一张普通卡片，
 *   拿数据的唯一"正规"途径是从 App 一路 props 传到 ChatCard。
 * 根因：那条链上每一层都做了引用记忆化（`src/components/layout-memoization.ts`），
 *   把每帧都换引用的 `columns` 塞进去，等于给所有 pane/tab 的 memo 判等永久投毒
 *   （AGENTS.md pitfall 265），代价远大于这张实验卡本身。
 * 为什么不能换写法：统计卡是只读的旁观者，它不需要参与 React 的更新传播——它自己
 *   每 30 秒主动来取一次就够了。所以这里用一个模块级快照，写入是 O(1) 赋值，
 *   读取按需，完全不进 props。
 */

export type StatsSourceSnapshot = {
  columns: readonly BoardColumn[]
  sessionHistory: readonly SessionHistoryEntry[]
}

const emptySnapshot: StatsSourceSnapshot = { columns: [], sessionHistory: [] }

let snapshot: StatsSourceSnapshot = emptySnapshot

export const publishStatsSource = (
  columns: readonly BoardColumn[],
  sessionHistory: readonly SessionHistoryEntry[],
) => {
  snapshot = { columns, sessionHistory }
}

export const readStatsSource = (): StatsSourceSnapshot => snapshot

/** 仅供测试：把快照还原成初始空状态。 */
export const resetStatsSource = () => {
  snapshot = emptySnapshot
}
