import { getLocaleText } from '../../shared/i18n'
import type {
  AppLanguage,
  AutomationBoard,
  AutomationBoardItem,
  AutomationBoardLane,
  ChatCard,
} from '../../shared/schema'
import { automationBoardLaneOrder } from '../../shared/default-state'

export type AutomationBoardLaneView = {
  lane: AutomationBoardLane
  title: string
  hint: string
  items: AutomationBoardItemView[]
}

export type AutomationBoardItemView = {
  item: AutomationBoardItem
  card: ChatCard
  /** Position inside its own lane — this is what "the requirement above" means. */
  laneIndex: number
  /** The lane-ordered card id of the item directly above, if any. */
  aboveCardId: string | undefined
  /** Display title of that item above, for the wake-timer hint. */
  aboveTitle: string | undefined
}

/**
 * 一次遍历把 items 组织成三条泳道的渲染视图，并顺手算出每一项的"上方需求"。
 *
 * 引用了不存在卡片的项被跳过而不是报错：磁盘上的孤儿项由 state-store 归一化
 * 清理，渲染期再撞上一个（例如卡片刚被别的路径删掉）不该炸掉整张看板。
 */
export const buildAutomationBoardLaneViews = (
  board: AutomationBoard | undefined,
  cards: Record<string, ChatCard>,
  language: AppLanguage,
): AutomationBoardLaneView[] => {
  const text = getLocaleText(language)
  const titles: Record<AutomationBoardLane, string> = {
    standby: text.automationBoardLaneStandby,
    running: text.automationBoardLaneRunning,
    done: text.automationBoardLaneDone,
  }
  const hints: Record<AutomationBoardLane, string> = {
    standby: text.automationBoardLaneStandbyHint,
    running: text.automationBoardLaneRunningHint,
    done: text.automationBoardLaneDoneHint,
  }

  const grouped: Record<AutomationBoardLane, AutomationBoardItemView[]> = {
    standby: [],
    running: [],
    done: [],
  }

  for (const item of board?.items ?? []) {
    const card = cards[item.cardId]
    if (!card) {
      continue
    }

    const bucket = grouped[item.lane]
    const above = bucket.at(-1)
    bucket.push({
      item,
      card,
      laneIndex: bucket.length,
      aboveCardId: above?.item.cardId,
      aboveTitle: above ? above.card.title || above.item.requirement : undefined,
    })
  }

  return automationBoardLaneOrder.map((lane) => ({
    lane,
    title: titles[lane],
    hint: hints[lane],
    items: grouped[lane],
  }))
}

/**
 * 项卡片的三态视觉，与普通 agent 聊天卡同源（`.card-shell.is-streaming` /
 * `.is-error`），所以看板上的状态语言和聊天窗口完全一致。
 */
export const resolveAutomationBoardItemStatusClass = (card: ChatCard): string => {
  if (card.status === 'streaming') {
    return 'is-streaming'
  }

  if (card.status === 'error') {
    return 'is-error'
  }

  return card.backgroundWorkPending === true ? 'is-background-pending' : ''
}

/**
 * 分组前先砍掉过老的原始消息。
 *
 * 症状（要防的）：10+ 个并发项各自对全量 messages 跑 `buildRenderableMessages`
 *   ＋ markdown 解析，主线程被同步任务占死（AGENTS.md pitfall 187）。
 * 根因：紧凑卡片只显示末几条，但分组是对整条转录做的，成本与历史长度成正比。
 * 被否决：只在渲染阶段截断 —— 那样解析成本照付；真正要有界的是**输入**。
 * 取 40 是因为一次工具分组极少跨过这么多原始消息，末 6 条渲染窗口不会被切坏。
 */
export const automationBoardItemRawMessageBudget = 40

export const budgetAutomationBoardItemMessages = <T,>(messages: readonly T[]): T[] =>
  messages.length <= automationBoardItemRawMessageBudget
    ? [...messages]
    : messages.slice(messages.length - automationBoardItemRawMessageBudget)

/**
 * 静默时长（分钟），供"超过半小时没下文"这类判断使用。返回 null 表示没有
 * 任何活动时间可依据。
 */
export const resolveAutomationBoardSilenceMinutes = (
  lastActivityAt: string | undefined,
  nowMs: number,
): number | null => {
  if (!lastActivityAt) {
    return null
  }

  const timestamp = Date.parse(lastActivityAt)
  if (!Number.isFinite(timestamp)) {
    return null
  }

  return Math.max(0, Math.round((nowMs - timestamp) / 60_000))
}
