import { getAutomationBoard } from '../../shared/default-state'
import type { AutomationBoardLane, ChatCard } from '../../shared/schema'

export type TabAbsorbTarget = {
  boardCardId: string
  lane: AutomationBoardLane
}

/**
 * 「把这个 tab 收进看板」该落到哪张看板的哪条泳道 —— null 表示这一列没有可收的
 * 去处（或者这个 tab 本身就是一张看板）。
 *
 * 症状：看板项（典型是监工）「拖出为独立 tab」之后放不回去。
 * 根因：拖回去要求泳道落点当场可见，而拖出那一刻弹出的卡就成了 pane 的活动
 *   tab，看板面板 hidden 且组件不挂载 —— 落点根本不在 DOM 里。dragstart 侧已经
 *   补了「让位亮出看板」（见 pane-tab-drag-view.ts），但那只救得了同一个 pane，
 *   而且仍然要求用户把拖拽走完。
 * 为什么不能换写法：泳道在 v2 自带副作用语义（transitions 表），所以这条出口不能
 *   固定落某一条道——正在流的卡落 standby/done 会被打断，空闲卡落 running 会被
 *   自动补一条"继续"。按卡片当下状态选道，两种情况都落在零副作用的格子上。
 */
export const resolveTabAbsorbTarget = ({
  tabId,
  paneTabIds,
  columnTabIds,
  cards,
}: {
  tabId: string
  /** 被右键那个 tab 所在 pane 的 tabs，优先在这里找看板（视线最近）。 */
  paneTabIds: readonly string[]
  /** 整列的 tab 顺序，本 pane 没有看板时的退路。 */
  columnTabIds: readonly string[]
  cards: Record<string, ChatCard>
}): TabAbsorbTarget | null => {
  const card = cards[tabId]
  // 看板不能吞掉另一张看板（拥有关系会成环，reducer 也会拒）。
  if (!card || getAutomationBoard(card)) {
    return null
  }

  const isBoard = (candidateId: string) =>
    candidateId !== tabId && Boolean(getAutomationBoard(cards[candidateId]))

  const boardCardId = paneTabIds.find(isBoard) ?? columnTabIds.find(isBoard)
  if (!boardCardId) {
    return null
  }

  return { boardCardId, lane: card.status === 'streaming' ? 'running' : 'standby' }
}
