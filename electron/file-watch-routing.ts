// 文件监听事件的路由决策：subscriptionId → 哪个渲染进程，以及"那个渲染进程已经
// 死了"要怎么收尾。
//
// 症状 — FileWatcherManager 里的订阅（及其共享目录的 fs.watch 句柄）永远不被回收。
// 根因 — 2026-08-12：路由表改成进程级 sink 之后，死渲染进程这条分支从"只是
//   return、条目留着等窗口关闭统一清理"变成了就地 delete；而
//   cleanupSubscriptionsForContentsId 正是按这张表遍历的 —— 条目一删它就再也
//   找不到这条订阅。退订必须**在**删之前。
// 为什么抽成纯函数 — 这条约束原来靠对 main.ts 源码做 indexOf 比先后来"保证"，
//   那既证明不了运行时行为，也会因为一次无害的重命名误红（pitfall 248）。
//   注入副作用之后可以直接断言真实调用顺序。

export type FileWatchRouteOutcome = 'unknown' | 'dropped-dead-renderer' | 'delivered' | 'send-failed'

export type FileWatchRoutingDeps<Target> = {
  lookup: (subscriptionId: string) => Target | undefined
  isSenderDead: (target: Target) => boolean
  unwatch: (subscriptionId: string) => void
  forget: (subscriptionId: string) => void
  deliver: (target: Target, subscriptionId: string) => void
  onDeliveryFailed?: (subscriptionId: string, error: unknown) => void
}

export const routeFileWatchEvent = <Target>(
  deps: FileWatchRoutingDeps<Target>,
  subscriptionId: string,
): FileWatchRouteOutcome => {
  const target = deps.lookup(subscriptionId)
  // 未知 id 是过期退订，不是错误。
  if (target === undefined) {
    return 'unknown'
  }

  if (deps.isSenderDead(target)) {
    deps.unwatch(subscriptionId)
    deps.forget(subscriptionId)
    return 'dropped-dead-renderer'
  }

  try {
    deps.deliver(target, subscriptionId)
  } catch (error) {
    deps.onDeliveryFailed?.(subscriptionId, error)
    return 'send-failed'
  }

  return 'delivered'
}
