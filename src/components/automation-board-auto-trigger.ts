import type { AutomationBoard, AutomationBoardTemplate } from '../../shared/schema'

export type AutomationBoardCardActivity = {
  status: string
  backgroundWorkPending: boolean
}

export type AutomationBoardTriggerReason =
  | 'disabled'
  | 'not-board-item'
  | 'self-triggered'
  | 'still-running'
  | 'throttled'
  | 'ready'

export type AutomationBoardTemplateTriggerDecision = {
  templateId: string
  fire: boolean
  reason: AutomationBoardTriggerReason
}

const isBusy = (activity: AutomationBoardCardActivity | undefined) =>
  activity != null && (activity.status === 'streaming' || activity.backgroundWorkPending)

/**
 * "最后一个执行中的需求结束了吗" —— 模板触发器的唯一判定。
 *
 * 挂在既有的"卡片稳定完成"广播上（唤醒链用的同一处），所以"AI 真的结束了"
 * 这个判断复用已经调好的判据（含原生后台等待），不重造一套。
 *
 * 症状（要防的）：监工每答完一轮就把自己再叫起来，无限自触发烧钱。
 * 根因：v1 的监工是一张不在 `board.items` 里的特殊卡，所以"它自己结束"天然
 *   落进 `not-board-item` 分支被挡住；v2 把监工降级成 running 道的**普通项**
 *   之后那道隐式免疫就没了。
 * 被否决：拿 `template.instanceCardId` 比对 —— 那张卡被拖出看板再拖回来后
 *   指针可能已经作废，但它仍然是这个模板生的，漏判就会自触发。所以认的是
 *   项自己带的 `templateId`（reducer 在实例化时写死，搬运不会改）。
 */
export const resolveAutomationBoardTemplateTriggerDecisions = ({
  templates,
  board,
  settledCardId,
  cardActivity,
  lastFiredAtMs,
  nowMs,
}: {
  templates: readonly AutomationBoardTemplate[]
  board: AutomationBoard | undefined
  settledCardId: string
  cardActivity: Record<string, AutomationBoardCardActivity>
  lastFiredAtMs: Record<string, number>
  nowMs: number
}): AutomationBoardTemplateTriggerDecision[] => {
  const settledItem = board?.items.find(
    (item) => item.cardId === settledCardId && item.lane === 'running',
  )

  // 刚结束的那张卡自己不算：稳定窗口触发时它的 status 可能还没落到 idle。
  const stillRunning =
    board?.items.some(
      (item) =>
        item.lane === 'running' &&
        item.cardId !== settledCardId &&
        isBusy(cardActivity[item.cardId]),
    ) ?? false

  return templates.map((template) => {
    const decide = (reason: AutomationBoardTriggerReason): AutomationBoardTemplateTriggerDecision =>
      ({ templateId: template.id, fire: reason === 'ready', reason })

    if (!template.trigger.enabled || !board) {
      return decide('disabled')
    }

    if (!settledItem) {
      return decide('not-board-item')
    }

    if (settledItem.templateId && settledItem.templateId === template.id) {
      return decide('self-triggered')
    }

    if (stillRunning) {
      return decide('still-running')
    }

    const throttleMs = Math.max(0, template.trigger.minIntervalMinutes) * 60_000
    const lastFiredAt = lastFiredAtMs[template.id]
    if (throttleMs > 0 && typeof lastFiredAt === 'number' && nowMs - lastFiredAt < throttleMs) {
      return decide('throttled')
    }

    return decide('ready')
  })
}

/**
 * 触发时该复用哪张实例卡 —— 空串表示"新建一张"。
 *
 * 症状（要防的）：每次触发都新建，看板的 running 道很快堆满一排监工，而且
 *   每一张都从零开始看板，跨轮上下文全丢。
 * 根因：`instanceCardId` 只在触发路径写，用户**手动**把同一个模板拖进泳道
 *   得到的那张卡不会被记录，于是触发时又造一张，两张并存。
 * 被否决：让手动拖也去写 `instanceCardId` —— 那会让"我只是想再跑一个同款
 *   需求"这个正当操作悄悄改掉自动化的目标。改成回退到项自带的 `templateId`：
 *   指针失效时认血缘，取最后一张，语义是"这个模板在场上的那一个"。
 */
export const resolveAutomationBoardTemplateInstanceCardId = ({
  board,
  templateId,
  instanceCardId,
}: {
  board: AutomationBoard | undefined
  templateId: string
  instanceCardId: string
}): string => {
  if (!board) {
    return ''
  }

  if (instanceCardId && board.items.some((item) => item.cardId === instanceCardId)) {
    return instanceCardId
  }

  if (!templateId) {
    return ''
  }

  return board.items.filter((item) => item.templateId === templateId).at(-1)?.cardId ?? ''
}
