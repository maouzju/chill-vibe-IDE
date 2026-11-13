import type { ChatMessage, Provider, StreamContextUsageEvent } from '../../shared/schema'
import {
  attachContextUsageMeta,
  EMPTY_CONTEXT_USAGE,
  markAutoCompactNotCompleted,
  readPersistedContextUsage,
  reduceContextUsage,
  settleRunEndMessages,
  type ContextUsageSnapshot,
} from './context-usage'

// 回合进行中的上下文占用（docs/specs/context-usage-auto-compact）。
//
// 症状（不这么做会怎样）：一个长回合里 CLI 每发一次请求就报一次占用，子 Agent 多的时候
// 几秒一次。走 reducer 的话，每次都会让整张卡重渲染、整份状态重新排队落盘。
//
// 根因：AppState 的任何变化都会进持久化队列，并穿过 ChatCard 的 memo 链
// （pitfall #256 / #265 / #317 都是「高频小更新走 reducer」踩出来的）。
//
// 所以实时值放在 React 之外的小 store 里，只有指示器订阅它；回合结束时才把最后的值
// 记到对话消息上（context-usage.ts 的 attachContextUsageMeta），那才是重启后还在的真相。
//
// 被否决的替代方案：把占用放进卡片状态（card.contextUsage）——见上，更新太频繁；
// 节流后再 dispatch——仍然每秒一次全量落盘，而且指示器会滞后。

const snapshots = new Map<string, ContextUsageSnapshot>()
const listeners = new Map<string, Set<() => void>>()

// 这个回合里 CLI 报没报过「压缩了」（context_usage 的 reset）。
//
// 症状（没有它会怎样）：App 替用户发起的自动压缩收尾时，要凭「到底压没压成」决定边界生不生效
// （chat-card-compaction.ts 的 settlePendingCompactBoundary）。猜错一边是历史被白白折叠，
// 另一边是压完了指示器还显示「快满了」。
// 根因（2026-11-12）：快照上的 awaitingBaseline 当不了这个信号——重连时服务端把整个回合的
// 事件折成一条（shared/context-usage.ts），reset 和压缩后的新占用一起到，应用完
// awaitingBaseline 已经又变回 false 了。
// 被否决的替代方案：从消息里的落盘值反推——落盘值是上一个回合收尾时记下的，这个回合
// 压没压成它不知道；挂着的边界 readPersistedContextUsage 也特意不认（挂着不等于压过）。
const compactedDuringRun = new Set<string>()

const notify = (cardId: string) => {
  const cardListeners = listeners.get(cardId)

  if (!cardListeners) {
    return
  }

  for (const listener of [...cardListeners]) {
    listener()
  }
}

const setSnapshot = (cardId: string, next: ContextUsageSnapshot) => {
  if (snapshots.get(cardId) === next) {
    return
  }

  snapshots.set(cardId, next)
  notify(cardId)
}

export const getContextUsageSnapshot = (cardId: string): ContextUsageSnapshot | undefined =>
  snapshots.get(cardId)

/** 这张卡当前这个回合里，CLI 有没有报过压缩。回合开始（seedContextUsage）时从头算。 */
export const hasContextCompactedDuringRun = (cardId: string) => compactedDuringRun.has(cardId)

export const subscribeContextUsage = (cardId: string, listener: () => void) => {
  let cardListeners = listeners.get(cardId)

  if (!cardListeners) {
    cardListeners = new Set()
    listeners.set(cardId, cardListeners)
  }

  cardListeners.add(listener)

  return () => {
    const current = listeners.get(cardId)

    if (!current) {
      return
    }

    current.delete(listener)

    if (current.size === 0) {
      listeners.delete(cardId)
    }
  }
}

/**
 * 应用一条流事件。
 *
 * `readFallback`：store 里还没有这张卡时的起点（落盘值）。应用重启后接上一个还在跑的回合，
 * 第一条事件往往只带占用、不带窗口——没有这个起点，指示器会从「75%」退化成只显示 token 数。
 */
export const applyContextUsageEvent = (
  cardId: string,
  event: StreamContextUsageEvent,
  readFallback?: () => ContextUsageSnapshot | undefined,
) => {
  // 放在「快照没变就返回」之前：快照本来就在等基线时，再来一条 reset 不改变快照，
  // 但这个回合确实压缩过。
  if (event.reset === true) {
    compactedDuringRun.add(cardId)
  }

  const previous = snapshots.get(cardId) ?? readFallback?.()
  const next = reduceContextUsage(previous, event)

  if (next === (previous ?? EMPTY_CONTEXT_USAGE)) {
    return
  }

  setSnapshot(cardId, next)
}

/**
 * 回合开始时把 store 对齐到这段对话：接着聊就用落盘值做起点，开新会话就传 undefined
 * （= 明确未知）。这样上一个回合留下的值不会串到另一段对话上。
 */
export const seedContextUsage = (cardId: string, snapshot: ContextUsageSnapshot | undefined) => {
  compactedDuringRun.delete(cardId)
  setSnapshot(cardId, snapshot ?? EMPTY_CONTEXT_USAGE)
}

/** 开了新会话：占用明确未知，也不再回落到旧会话的落盘值。 */
export const clearContextUsage = (cardId: string) => {
  seedContextUsage(cardId, undefined)
}

/** 卡片没了：连条目一起删掉。 */
export const forgetContextUsage = (cardId: string) => {
  compactedDuringRun.delete(cardId)

  if (!snapshots.delete(cardId)) {
    return
  }

  notify(cardId)
}

/**
 * 当前该用哪份占用。
 *
 * - 回合进行中：store 的实时值优先（包括「明确未知」），没有条目才回落到落盘值。
 * - 回合之间：只认落盘值。恢复归档、清空对话这些操作会整段替换消息，落盘值跟着消息走，
 *   自然就对了；store 里上一个回合的值这时候可能已经属于另一段对话，不能用。
 */
export const resolveContextUsage = ({
  cardId,
  messages,
  provider,
  streaming,
}: {
  cardId: string
  messages: readonly ChatMessage[]
  provider: Provider
  streaming: boolean
}): ContextUsageSnapshot | undefined =>
  (streaming ? snapshots.get(cardId) : undefined) ?? readPersistedContextUsage(messages, provider)

/**
 * 回合收尾：把这个回合的实时占用和「压没压成」落到消息上。done、出错、等不到服务端确认的停止、
 * 重连时发现回合其实早就跑完——每个出口都走这一步。
 *
 * 症状（各出口各写各的会怎样）：
 * - 只有 done 记占用：上下文超限的回合是以「出错」收尾的，偏偏这种回合最需要把「快满了」记下来，
 *   下一条消息才会先压缩；停止的回合同理，指示器会停在上一回合的数上。
 * - App 发起的压缩没压成时要做三件事（撤销边界、把当时的占用记成基线、告诉用户），
 *   漏掉前两件的后果分别是更早的历史被白白折叠、每隔一条消息白压一次。
 * 根因（2026-11-12 读 src/App.tsx）：收尾的出口有五个，原先只在 onDone 里读 store。
 * 被否决的替代方案：把这一步放进 reducer——reducer 读不到 React 之外的 store；把实时占用搬进
 *   卡片状态又会让每次上报都触发整卡重渲染和落盘（见文件头）。
 *
 * 「压没压成」只认 store 里这个回合的标记，不去猜：应用重启后流也丢了的话 store 里没有这张卡，
 * 这时什么占用都不记（原来的记录原样留着），压缩按没压成处理——最多是下一条消息再压一次。
 */
export const settleRunEndForCard = ({
  cardId,
  messages,
  provider,
  isAutoCompactRun,
  boundary,
  durationMessage,
}: {
  cardId: string
  /** 卡片此刻的消息（缓冲的增量已经刷进去之后）。 */
  messages: ChatMessage[]
  provider: Provider
  /** 这个回合是不是 App 自己发起的压缩（chat-card-compaction.ts 的 isAppAutoCompactRunOnCard）。 */
  isAutoCompactRun: boolean
  /** 要不要把挂着的边界定下来；回合还不算跑完的普通回合（后台任务还挂着）传 undefined。 */
  boundary: { stopped: boolean } | undefined
  /** 这一回合的 run-duration 消息；没有就不传，占用改记到最后一条消息上。 */
  durationMessage?: ChatMessage
}): {
  /** 要改的已有消息，交给 upsertMessages，排在 finishStoppedStream 之前；可能为空。 */
  updates: ChatMessage[]
  /** 记好占用的 run-duration 消息；没传就是 undefined，没东西可记时原样返回。 */
  durationMessage: ChatMessage | undefined
  /** 这是 App 发起的压缩回合，而且没压成。 */
  autoCompactNotCompleted: boolean
} => {
  const compactionObserved = compactedDuringRun.has(cardId)
  const autoCompactNotCompleted = isAutoCompactRun && !compactionObserved
  const liveUsage = snapshots.get(cardId)
  const usage = autoCompactNotCompleted ? markAutoCompactNotCompleted(liveUsage) : liveUsage

  return {
    updates: settleRunEndMessages({
      messages,
      provider,
      boundary: boundary ? { stopped: boundary.stopped, compactionObserved } : undefined,
      usage: durationMessage ? undefined : usage,
    }),
    durationMessage: durationMessage ? attachContextUsageMeta(durationMessage, usage, provider) : undefined,
    autoCompactNotCompleted,
  }
}

export const resetContextUsageStoreForTests = () => {
  snapshots.clear()
  listeners.clear()
  compactedDuringRun.clear()
}
