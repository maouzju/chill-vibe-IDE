type TimeoutHandle = ReturnType<typeof setTimeout> | number

type DraftSyncSchedulerOptions = {
  idleMs?: number
  onSync: (draft: string) => void
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimeoutHandle
  clearTimeoutFn?: (handle: TimeoutHandle) => void
}

export const draftSyncIdleMs = 3_000

export const createDraftSyncScheduler = ({
  idleMs = draftSyncIdleMs,
  onSync,
  setTimeoutFn = (callback, nextDelayMs) => setTimeout(callback, nextDelayMs),
  clearTimeoutFn = (handle) => clearTimeout(handle),
}: DraftSyncSchedulerOptions) => {
  let pendingDraft: string | null = null
  let timeoutHandle: TimeoutHandle | null = null

  const clearPendingTimer = () => {
    if (timeoutHandle === null) {
      return
    }

    clearTimeoutFn(timeoutHandle)
    timeoutHandle = null
  }

  const flush = () => {
    clearPendingTimer()

    if (pendingDraft === null) {
      return false
    }

    const draft = pendingDraft
    pendingDraft = null
    onSync(draft)
    return true
  }

  return {
    schedule(draft: string) {
      pendingDraft = draft
      clearPendingTimer()
      if (idleMs <= 0) {
        return
      }
      timeoutHandle = setTimeoutFn(() => {
        void flush()
      }, idleMs)
    },
    markPending(draft: string) {
      pendingDraft = draft
      clearPendingTimer()
    },
    flush,
    cancel() {
      pendingDraft = null
      clearPendingTimer()
    },
    hasPending() {
      return pendingDraft !== null
    },
  }
}

// 症状：多卡流式渲染变慢时，停顿 3 秒后接着打字，开头一两个字被回滚、光标跳到末尾。
// 根因（2026-11-20 审查）：空闲同步把 v 推给 App，card.draft 回写 effect 晚一拍才跑，
//   这期间又敲了字，effect 看到 card.draft(v) ≠ 本地(v+x) 就把输入框改回 v。
// 决策：只认领「自己刚推出去的值」这一种回声；外部改动（清空、恢复、换卡）照旧回写。
//   没用 scheduler.hasPending 判断：外部清空草稿时本地也可能有 pending，那样会挡住正当的回写。
export const createDraftEchoTracker = () => {
  let observedCardDraft: string | null = null
  let outgoing: string[] = []

  return {
    noteOutgoing(draft: string) {
      if (draft !== observedCardDraft) {
        outgoing.push(draft)
      }
    },
    /** 返回 true 表示这次 card.draft 变化只是自己同步出去的值回来了。 */
    consumeIncoming(nextCardDraft: string) {
      observedCardDraft = nextCardDraft
      const index = outgoing.indexOf(nextCardDraft)
      outgoing = index >= 0 ? outgoing.slice(index + 1) : []
      return index >= 0
    },
  }
}
