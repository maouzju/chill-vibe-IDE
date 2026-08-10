export type ChatStreamPayload = {
  subscriptionId: string
  event: string
  data: unknown
}

type ChatStreamBatcherOptions = {
  // 注入调度器而不是直接用 setTimeout：测试要能确定性地推进「窗口到期」这一步，
  // 真实计时器会让批处理断言变成 flaky。
  schedule: (callback: () => void) => void
  deliver: (senderKey: number, items: ChatStreamPayload[]) => void
}

// 症状：并发多路流式输出时整个窗口卡死 1~19 秒，主进程 CPU 为 0 却挂在 IPC 上。
// 根因：2026-08-10 实测，卡顿的 890ms 里主进程做了 426 次 IPC 操作 / 6MB，平均每次仅
//       14KB —— 瓶颈不是单条载荷大，而是每个流式 delta 都单独走一次跨进程往返
//       （≈480 次/秒，且随并发路数线性叠加，用户多开 Opus 后频率明显上升）。
// 被否决：截断大输出 —— 平均 14KB 说明根本没有「巨型单条」，截断既伤可读性又治不了频率。
//       改为按帧窗口合并：一个字都不丢，只把 N 次往返压成 1 次。
export const createChatStreamBatcher = ({ schedule, deliver }: ChatStreamBatcherOptions) => {
  const queues = new Map<number, ChatStreamPayload[]>()
  let flushScheduled = false

  const flush = () => {
    flushScheduled = false
    if (queues.size === 0) {
      return
    }

    // 先取出再清空：deliver 过程中若又有事件入队，它们属于下一个窗口，
    // 否则会在同一次遍历里被漏发或重复发。
    const batches = [...queues.entries()]
    queues.clear()

    for (const [senderKey, items] of batches) {
      if (items.length === 0) {
        continue
      }
      deliver(senderKey, items)
    }
  }

  return {
    enqueue(senderKey: number, payload: ChatStreamPayload) {
      const queue = queues.get(senderKey)
      if (queue) {
        queue.push(payload)
      } else {
        queues.set(senderKey, [payload])
      }

      if (!flushScheduled) {
        flushScheduled = true
        schedule(flush)
      }
    },

    // webContents 销毁后再 send 会抛错，残留队列也是内存泄漏。
    dropSender(senderKey: number) {
      queues.delete(senderKey)
    },

    // 轮次收尾等关键节点可以不等窗口到期，避免最后几个字迟到。
    flushNow() {
      flush()
    },
  }
}

export type ChatStreamBatcher = ReturnType<typeof createChatStreamBatcher>
