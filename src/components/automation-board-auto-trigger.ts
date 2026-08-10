import type { AutomationBoard, AutomationBoardAutoTrigger } from '../../shared/schema'

export type AutomationBoardCardActivity = {
  status: string
  backgroundWorkPending: boolean
}

export type AutomationBoardAutoTriggerReason =
  | 'disabled'
  | 'not-board-item'
  | 'still-running'
  | 'supervisor-busy'
  | 'throttled'
  | 'ready'

export type AutomationBoardAutoTriggerDecision = {
  fire: boolean
  reason: AutomationBoardAutoTriggerReason
}

const isBusy = (activity: AutomationBoardCardActivity | undefined) =>
  activity != null && (activity.status === 'streaming' || activity.backgroundWorkPending)

/**
 * "最后一个执行中的需求结束了吗" —— 自动触发监工的唯一判定。
 *
 * 挂在既有的"卡片稳定完成"广播上（唤醒链用的同一处），所以"AI 真的结束了"
 * 这个判断复用已经调好的判据（含原生后台等待），不重造一套。
 *
 * 两道防递归是这个函数存在的主要理由：
 *  - 规则 2：监工不在 `board.items` 里，所以它自己结束恒为 `not-board-item`。
 *    没有这一条，监工每答完一轮就会把自己再叫起来，无限自触发。
 *  - 规则 4：监工在跑时不再触发。没有这一条，监工用 MCP 把某个需求移进
 *    running 又很快结束，就能在一轮里叠出多个监工回合。
 */
export const resolveAutomationBoardAutoTriggerDecision = ({
  config,
  board,
  settledCardId,
  cardActivity,
  lastFiredAtMs,
  nowMs,
}: {
  config: AutomationBoardAutoTrigger
  board: AutomationBoard | undefined
  settledCardId: string
  cardActivity: Record<string, AutomationBoardCardActivity>
  lastFiredAtMs: number | null
  nowMs: number
}): AutomationBoardAutoTriggerDecision => {
  if (!config.enabled || !board) {
    return { fire: false, reason: 'disabled' }
  }

  const settledItem = board.items.find(
    (item) => item.cardId === settledCardId && item.lane === 'running',
  )
  if (!settledItem) {
    return { fire: false, reason: 'not-board-item' }
  }

  // 刚结束的那张卡自己不算：稳定窗口触发时它的 status 可能还没落到 idle。
  const stillRunning = board.items.some(
    (item) =>
      item.lane === 'running' &&
      item.cardId !== settledCardId &&
      isBusy(cardActivity[item.cardId]),
  )
  if (stillRunning) {
    return { fire: false, reason: 'still-running' }
  }

  if (board.supervisorCardId && isBusy(cardActivity[board.supervisorCardId])) {
    return { fire: false, reason: 'supervisor-busy' }
  }

  const throttleMs = Math.max(0, config.minIntervalMinutes) * 60_000
  if (throttleMs > 0 && lastFiredAtMs !== null && nowMs - lastFiredAtMs < throttleMs) {
    return { fire: false, reason: 'throttled' }
  }

  return { fire: true, reason: 'ready' }
}
