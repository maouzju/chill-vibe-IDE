import type { AutomationBoard, AutomationBoardLane, ChatCard } from '../../shared/schema'

/**
 * 一张卡当前的"展现容器"。看板项与普通 tab 是同一张 ChatCard 的两种容器，
 * 所以搬运语义只由这两端决定，与卡片内容无关。
 */
export type AutomationBoardLocation =
  | { kind: 'lane'; lane: AutomationBoardLane }
  | { kind: 'tab' }

export type AutomationBoardTransitionEffects = {
  /** 请求中断当前运行（等价用户点停止）。 */
  interrupt: boolean
  /** 中断后如何处置该卡的排队消息。 */
  queue: 'keep' | 'clear'
  /** 搬运落地后要不要发起一次发送，以及发什么。 */
  send: 'none' | 'requirement' | 'continue'
  /** 要不要给看板项打时间戳（监工靠它判断"多久没下文"）。 */
  stamp: 'none' | 'started' | 'completed'
}

const inert: AutomationBoardTransitionEffects = {
  interrupt: false,
  queue: 'keep',
  send: 'none',
  stamp: 'none',
}

const sameLocation = (left: AutomationBoardLocation, right: AutomationBoardLocation) =>
  left.kind === 'tab' ? right.kind === 'tab' : right.kind === 'lane' && left.lane === right.lane

/**
 * 搬运一张卡时**唯一**的副作用决策出口。
 *
 * 症状（要防的）：停流与队列处置散落在每个调用点，漏一个就出现"卡片消失/
 *   排队消息永久停摆"这类只在某条路径上复现的 bug。
 * 根因：`moveTab` / `closeTab` / `removeColumn` 历史上各自手写过这对组合，
 *   跨工作区 moveTab 就漏了后一半（AGENTS.md pitfall 246）。
 * 被否决：把判断塞进 reducer —— reducer 是纯的，发不了请求也停不了流；
 *   把判断塞进各个拖放 handler —— 那正是上面那个 bug 的形态。
 *
 * `queue` 恒为 `keep`：看板搬运不跨工作区，排队消息的语境仍然有效。留这个
 * 字段是为了让"以后真要清"有唯一落点，而不是又散回调用点。
 */
export const resolveAutomationBoardTransition = ({
  from,
  to,
  isStreaming,
  hasHistory,
}: {
  from: AutomationBoardLocation
  to: AutomationBoardLocation
  isStreaming: boolean
  hasHistory: boolean
}): AutomationBoardTransitionEffects => {
  if (sameLocation(from, to)) {
    return inert
  }

  // 出到 tab 永远零副作用 —— 这就是"无缝"的定义。
  if (to.kind === 'tab') {
    return inert
  }

  if (to.lane === 'running') {
    return {
      interrupt: false,
      queue: 'keep',
      // 已经在跑就别再发一遍：拖进执行中只是换位置，必须幂等。
      send: isStreaming ? 'none' : hasHistory ? 'continue' : 'requirement',
      stamp: 'started',
    }
  }

  return {
    interrupt: isStreaming,
    queue: 'keep',
    send: 'none',
    stamp: to.lane === 'done' ? 'completed' : 'none',
  }
}

/**
 * "这张卡跑过吗" —— 决定进入执行中时是重发需求还是空续传。
 *
 * 只有 system 消息（启动期提示气泡等）不算跑过，否则空续传会被发给一个
 * 从没收到过需求的会话，模型只能反问"要我做什么"。
 */
export const hasAutomationBoardHistory = (card: ChatCard | undefined): boolean => {
  if (!card) {
    return false
  }

  if (card.sessionId?.trim()) {
    return true
  }

  return card.messages.some((message) => message.role === 'user' || message.role === 'assistant')
}

/**
 * 一条泳道内的有序 cardId 列表。
 *
 * 这个数组直接当 `armWakeTimerBatch` 的 `paneTabIds` 参数用：它按
 * `indexOf(owner) - 1` 取"左邻"，在看板语境下那就是**上方需求**。所以
 * "左侧 tab → 上方需求"只是换传参和换文案，唤醒判定逻辑一个字符都不改。
 */
export const getAutomationBoardLaneCardIds = (
  board: AutomationBoard | undefined,
  lane: AutomationBoardLane,
): string[] =>
  (board?.items ?? []).filter((item) => item.lane === lane).map((item) => item.cardId)

const isCardActive = (card: ChatCard | undefined) =>
  card != null && (card.status === 'streaming' || card.backgroundWorkPending === true)

/**
 * 承载看板的那个 tab 该不该显示橙色运行态。
 *
 * 症状（要防的）：把看板卡片的 `status` 写成 `'streaming'` 来点亮那个橙色，
 *   会在磁盘上留下一张永远没有 streamId 的假 streaming 卡；重启恢复路径会
 *   把它当成待重连的中断会话（AGENTS.md pitfall 113）。
 * 根因：`is-streaming` 这个 class 在 PaneView 里本来就只从 `card.status` 推导，
 *   于是"想点亮"最省事的写法正好是污染持久化状态。
 * 被否决：给 CardStatus 加成员 —— 那会污染所有 status 分支（发送门控、音效、
 *   恢复、唤醒判定），而这里只需要"亮不亮"这一个布尔。所以纯派生。
 *
 * 只算 running 道：待命/已完成道里的卡如果还在收尾（拖进去那一刻刚请求中断），
 * 不该让整个看板看起来在干活。
 */
export const automationBoardHasActiveRun = (
  board: AutomationBoard | undefined,
  cards: Record<string, ChatCard>,
): boolean => {
  if (!board) {
    return false
  }

  if (board.supervisorCardId && isCardActive(cards[board.supervisorCardId])) {
    return true
  }

  return board.items.some((item) => item.lane === 'running' && isCardActive(cards[item.cardId]))
}

/**
 * 紧凑项卡片只渲染最近若干条。裁剪必须发生在 markdown 解析**之前**，
 * 否则 10+ 并发项会把渲染线程压死（AGENTS.md NFR/pitfall 187）。
 */
export const automationBoardItemMessageWindow = <T,>(
  entries: readonly T[],
  limit: number,
): { visible: T[]; hiddenCount: number } => {
  const effectiveLimit = Math.max(1, Math.trunc(limit))

  if (entries.length <= effectiveLimit) {
    return { visible: [...entries], hiddenCount: 0 }
  }

  return {
    visible: entries.slice(entries.length - effectiveLimit),
    hiddenCount: entries.length - effectiveLimit,
  }
}

export const defaultAutomationBoardItemMessageLimit = 6
