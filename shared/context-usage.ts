import type { StreamContextUsageEvent } from './schema.js'

// 上下文占用事件的折叠（docs/specs/context-usage-auto-compact）。
//
// 服务端 backlog 只留一条 context_usage（长回合会报几百次，逐条留会把真正的消息挤出
// backlog），所以需要「把先后两条折成一条」且效果等同于依次应用。渲染端的 store 用同一套
// 语义：reset 先清掉旧占用，再应用这条事件自己带的 used / size。

/**
 * 把先后两条 context_usage 事件折成一条。
 *
 * - `next.reset`：压缩发生在 `previous` 之后，旧占用作废；窗口大小不受压缩影响，保留。
 * - 没带 `size` 的事件沿用之前的窗口（Claude 只有 result 才报窗口）。
 */
export const mergeContextUsageEvents = (
  previous: StreamContextUsageEvent,
  next: StreamContextUsageEvent,
): StreamContextUsageEvent => {
  const reset = next.reset === true || previous.reset === true
  const used = next.used ?? (next.reset ? undefined : previous.used)
  const size = next.size ?? previous.size

  return {
    ...(reset ? { reset: true as const } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(size !== undefined ? { size } : {}),
  }
}
