import type { AutomationBoard, AutomationBoardTemplate } from '../../shared/schema'

export type AutomationBoardCardActivity = {
  status: string
  backgroundWorkPending: boolean
}

export type AutomationBoardTriggerReason =
  | 'disabled'
  | 'not-board-item'
  | 'self-triggered'
  | 'chain-cycle'
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
  triggerChainTemplateIds = [],
}: {
  templates: readonly AutomationBoardTemplate[]
  board: AutomationBoard | undefined
  settledCardId: string
  cardActivity: Record<string, AutomationBoardCardActivity>
  lastFiredAtMs: Record<string, number>
  nowMs: number
  /** 引出 settledCardId 这一轮的触发链上已经触发过的模板（见 createAutomationBoardTriggerChainTracker）。 */
  triggerChainTemplateIds?: readonly string[]
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

    // 症状：两个开着触发器的模板放在同一张看板上，A 的实例答完拉起 B、B 的又拉起 A，无限乒乓烧额度。
    // 根因（2026-11-20 审查）：上面只挡"自己叫醒自己"，隔一层就挡不住；节流按模板各算、默认 1 分钟，比一轮短。
    // 为什么不用次数/深度上限：那要新定一个数值；链上去重不需要数值，链长天然不超过模板数。
    if (triggerChainTemplateIds.includes(template.id)) {
      return decide('chain-cycle')
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

/**
 * 每张实例卡"这一轮是哪条触发链拉起来的"。只在内存里：重启后链断开，最多再多跑一轮。
 *
 * 链在该卡下一次稳定完成时被取走（take 即删），所以用户之后手动给这张卡发消息
 * 跑出来的那一轮是新链的起点，不会被旧链挡住。
 */
export const createAutomationBoardTriggerChainTracker = () => {
  const chains = new Map<string, readonly string[]>()

  return {
    takeForSettledCard(cardId: string): readonly string[] {
      const chain = chains.get(cardId) ?? []
      chains.delete(cardId)
      return chain
    },
    recordFired(instanceCardId: string, parentChain: readonly string[], templateId: string) {
      if (!instanceCardId) {
        return
      }
      chains.set(
        instanceCardId,
        parentChain.includes(templateId) ? [...parentChain] : [...parentChain, templateId],
      )
    },
  }
}
