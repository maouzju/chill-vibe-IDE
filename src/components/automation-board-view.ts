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
 * 泳道里"此刻真的在跑"的项，顺序与泳道显示顺序一致。
 *
 * 口径与 `resolveAutomationBoardItemStatusClass` 的 `is-streaming` 完全一致：
 * 只有 `status === 'streaming'` 算在跑。`backgroundWorkPending`（等唤醒）看着
 * 也"没结束"，但它没有占着一个 CLI 进程，把它算进来会让"还剩几个在跑"这个
 * 数字失去它唯一的用处——判断现在能不能走开。
 */
export const collectAutomationBoardRunningCardIds = (
  items: readonly AutomationBoardItemView[],
): string[] =>
  items.filter((view) => view.card.status === 'streaming').map((view) => view.card.id)

/**
 * 逐个定位的下一站。
 *
 * 游标记的是**上一次跳到的 cardId** 而不是下标：正在跑的项随时会跑完并离开这个
 * 列表，记下标会让点击在剩余项之间乱跳。记 id 的话，上一站消失就退回第一个，
 * 走到末尾就绕回开头，点击永远有反应。
 */
export const resolveNextAutomationBoardRunningCardId = (
  runningCardIds: readonly string[],
  lastCardId: string | null | undefined,
): string | null => {
  if (runningCardIds.length === 0) {
    return null
  }

  const lastIndex = lastCardId ? runningCardIds.indexOf(lastCardId) : -1
  return runningCardIds[(lastIndex + 1) % runningCardIds.length] ?? null
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
 * 「加入待命」能不能按下去。
 *
 * 症状（要防的）：粘了一张截图但一个字没打，发送按钮是灰的，需求发不出去。
 * 根因：判据曾经只看 `draft.trim()`，把附件当成文本的附属品而不是内容本身。
 * 被否决：在 composer 里自动补一句占位文本 —— 那会被当成真需求发给模型。
 * 与聊天 composer 的 `sendDisabled` 同一条规矩：文本或附件有其一即可提交。
 */
export const canSubmitAutomationBoardDraft = (draft: string, attachmentCount: number): boolean =>
  draft.trim().length > 0 || attachmentCount > 0

/**
 * 在光标处插入一个换行，返回新文本和新光标位置。
 *
 * 症状：看板需求框里按 Ctrl+回车什么也不发生 —— 既不提交也不换行。
 * 根因：keydown 只是"不拦截 ctrlKey"，指望 textarea 的默认行为换行；但浏览器
 *   里只有 Shift+回车有插入换行的原生行为，Ctrl+回车没有（历史上它是"提交表单"）。
 * 被否决：改用 Shift+回车换行 —— 聊天 composer（ChatCard）早就是 Ctrl+回车换行，
 *   同一个 App 里两种输入框肌肉记忆不能打架。
 */
export const insertNewlineIntoDraft = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; caret: number } => {
  const start = Math.max(0, Math.min(selectionStart, value.length))
  const end = Math.max(start, Math.min(selectionEnd, value.length))
  return { value: `${value.slice(0, start)}\n${value.slice(end)}`, caret: start + 1 }
}

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
