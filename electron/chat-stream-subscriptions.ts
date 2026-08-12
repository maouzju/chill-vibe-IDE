// 渲染进程 ↔ 后端的聊天流订阅路由表。
//
// 症状 — 旧写法把「哪个 webContents 收这条流」编码成一个闭包，直接塞进
//   `backend.subscribeChatStream(streamId, listener)`，返回的 unsubscribe 函数
//   再被 main.ts 存进 Map。
// 根因 — 2026-08-12：后端要搬进 utilityProcess（同一批 git 操作在主进程单次最长
//   停摆 6827ms / 11 次超 1s / 2 次超 5s，在 utilityProcess 只有 58ms / 0 次），
//   而函数既不能作为入参跨进程传，也不能作为返回值跨回来。跨进程后
//   `if (!unsubscribe)` 会因为返回值变成恒真的 Promise 而永久不可达，
//   "Stream not found" 再也发不出去，同时每次订阅都登记一条永不清理的幽灵条目。
// 为什么不能保留回调形状 — 那要求端口层为函数句柄做反向代理和生命周期管理，
//   等于自建一套分布式 GC。这里改成「调用方生成 subscriptionId + 可序列化返回值
//   + 独立事件通道」：路由表留在主进程（它才认识 webContents），后端只回一个
//   纯数据的 { subscribed }。
export type ChatStreamSubscriptionEvent = {
  subscriptionId: string
  event: string
  data: unknown
}

export type ChatStreamSubscribeResult = {
  subscribed: boolean
}

export type ChatStreamSubscriptionRegistryDeps<Target> = {
  // 跨进程之后这里必然是 Promise。同进程的同步实现继续原样可用。
  subscribe: (
    streamId: string,
    subscriptionId: string,
  ) => ChatStreamSubscribeResult | Promise<ChatStreamSubscribeResult>
  unsubscribe: (subscriptionId: string) => void
  deliver: (target: Target, payload: ChatStreamSubscriptionEvent) => void
}

export const streamNotFoundMessage = 'Stream not found.'

export const createChatStreamSubscriptionRegistry = <Target>(
  deps: ChatStreamSubscriptionRegistryDeps<Target>,
) => {
  const entries = new Map<string, { ownerId: number; target: Target }>()

  const drop = (subscriptionId: string) => {
    entries.delete(subscriptionId)
    deps.unsubscribe(subscriptionId)
  }

  return {
    // 热路径（实测 ≈480 事件/秒）：一次 Map.get + 一次调用，和旧写法的闭包直调
    // 处于同一量级，不引入额外的每事件分配。
    handleEvent(payload: ChatStreamSubscriptionEvent) {
      const entry = entries.get(payload.subscriptionId)
      if (!entry) {
        return
      }

      deps.deliver(entry.target, payload)
    },

    // 登记必须发生在 subscribe **之前**：ChatManager.subscribe 会同步重放 backlog，
    // 事件在 subscribe 返回之前就已经打到事件通道上。先调用后登记 = 整段 backlog
    // 被丢弃。跨进程之后返回值变成 Promise，这个顺序更是唯一正确的写法。
    // 必须是 async：跨进程之后 deps.subscribe 返回 Promise，同步读 `result.subscribed`
    // 在 Promise 上恒为 undefined —— "流不存在"分支会对**每一条**订阅命中，聊天流
    // 全线静默失效。这也是 `ipcMain.handle` 拿到 Promise 后自然会 await 的形状。
    async subscribe(streamId: string, subscriptionId: string, ownerId: number, target: Target) {
      entries.set(subscriptionId, { ownerId, target })

      // 「先登记后调用」的代价：subscribe 抛错时这条路由没有任何清理路径能命中
      // ——后端从未登记过这个 id（unsubscribe 是 no-op），渲染进程拿到的是一个
      // rejected invoke、不会再发显式退订，只剩窗口关闭时的 unsubscribeOwner。
      // 所以必须在这里就地回收，再把错误原样抛给 ipcMain.handle。
      // 跨进程之后这条路会更常走：端口断开 / RPC 超时都从这里抛出来。
      let result: ChatStreamSubscribeResult
      try {
        result = await deps.subscribe(streamId, subscriptionId)
      } catch (error) {
        entries.delete(subscriptionId)
        throw error
      }

      if (!result.subscribed) {
        entries.delete(subscriptionId)
        deps.deliver(target, {
          subscriptionId,
          event: 'error',
          data: { message: streamNotFoundMessage },
        })
      }

      return result
    },

    unsubscribe(subscriptionId: string) {
      drop(subscriptionId)
    },

    unsubscribeOwner(ownerId: number) {
      for (const [subscriptionId, entry] of [...entries]) {
        if (entry.ownerId !== ownerId) {
          continue
        }

        drop(subscriptionId)
      }
    },

    unsubscribeAll() {
      for (const subscriptionId of [...entries.keys()]) {
        drop(subscriptionId)
      }
    },

    // 症状 — 后端进程崩溃重启后，窗口还活着但每张卡永久停在 streaming，且没有任何
    //   报错（比今天"后端死=整个 app 死"更难查）。
    // 根因 — 2026-08-12：ChatManager 的 backlog 与全部 streamId 都住在后端进程里，
    //   随它一起消失；新进程对这些 id 一无所知。
    // 为什么不新开一条渲染端通道 — "Stream not found." 是渲染进程**已经**会处理的
    //   信号（App.tsx 收到后把卡落回 idle），复用它零改动、且和真实的失效流走同一
    //   条代码路径。这里刻意不调 deps.unsubscribe：旧后端已经没了，新后端从没认识
    //   过这些 id，那只是一次白跑的 RPC。
    invalidateAll(message = streamNotFoundMessage) {
      for (const [subscriptionId, entry] of [...entries]) {
        entries.delete(subscriptionId)
        deps.deliver(entry.target, {
          subscriptionId,
          event: 'error',
          data: { message },
        })
      }
    },

    size() {
      return entries.size
    },
  }
}

export type ChatStreamSubscriptionRegistry<Target> = ReturnType<
  typeof createChatStreamSubscriptionRegistry<Target>
>
