// 转录列表挂载/结构变化后，滚动位置可能在没有 scroll 事件的情况下自己挪动：
// 内容高度一变，浏览器的 scroll anchoring 会主动调整 scrollTop 保持视觉位置，
// 而这个调整**不派发 scroll 事件**。所以只能主动去读 scrollTop 才能发现漂移。
//
// 症状：CPU 吃紧且有长会话在流式输出时切 tab，主线程一次阻塞 1374ms
//   （同一操作无流式只有 659ms）。CDP profile 里这段轮询 self time 617ms。
// 根因：2026-08-11 实测 —— 原实现把轮询直接写在一个依赖 renderableEntryStructureKey
//   （= 所有条目 id 拼接）的 useLayoutEffect 里，流式每冒出一条新气泡该 key 就变一次，
//   于是 18 帧的循环被反复 cancel + 重建、从不结束；而它**每一帧**都读 scrollTop，
//   此时 DOM 正被流式弄脏，每次读都强制重排整个列表（271 个气泡实测约 29ms/帧）。
//   约 21 帧 × 29ms ≈ 610ms，与 profile 的 617ms 吻合。
// 为什么是降采样而不是别的写法：
//   - 不能删：scroll anchoring 的漂移没有事件可监听（见上）。
//   - 不能改成只监听 scroll 事件：同上，那正是它要抓的那一类漂移。
//   - 可以降采样：位置一旦漂移就一直是漂移的，不会自己弹回去，所以晚几帧发现
//     只是把 onDrift 推迟约 33ms，用户无感；而读取次数直接降到 1/3。
//   - 重启改续期：流式下结构 key 高频变化，重建循环既白付 cancel/setup，
//     又让窗口被无限拉长；续期只重置剩余帧数，窗口该收就收。
export const scrollDriftSampleIntervalFrames = 3
export const scrollDriftWatchWindowFrames = 18
export const scrollDriftEpsilonPx = 0.5

export type ScrollDriftWatcherOptions = {
  /** 返回当前 scrollTop；节点已消失时返回 null，watcher 会就此收手。 */
  readScrollTop: () => number | null
  onDrift: (scrollTop: number) => void
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
  sampleIntervalFrames?: number
  watchWindowFrames?: number
}

export type ScrollDriftWatcher = {
  /** 记下基线并开一个新的观察窗口。 */
  start: (scrollTop: number) => void
  /** 结构又变了：把窗口续上，若循环已在跑则不动它。 */
  extend: () => void
  cancel: () => void
  isRunning: () => boolean
}

export const createScrollDriftWatcher = ({
  readScrollTop,
  onDrift,
  requestFrame,
  cancelFrame,
  sampleIntervalFrames = scrollDriftSampleIntervalFrames,
  watchWindowFrames = scrollDriftWatchWindowFrames,
}: ScrollDriftWatcherOptions): ScrollDriftWatcher => {
  const sampleInterval = Math.max(1, Math.floor(sampleIntervalFrames))
  const windowFrames = Math.max(1, Math.floor(watchWindowFrames))

  let observedScrollTop: number | null = null
  let remainingFrames = 0
  let framesSinceSample = 0
  let frameHandle: number | null = null

  const step = () => {
    frameHandle = null
    framesSinceSample += 1

    if (framesSinceSample >= sampleInterval) {
      framesSinceSample = 0
      const currentScrollTop = readScrollTop()
      if (currentScrollTop === null) {
        // 节点没了，继续排帧只是白烧一帧。
        remainingFrames = 0
        return
      }

      if (
        observedScrollTop !== null &&
        Math.abs(currentScrollTop - observedScrollTop) > scrollDriftEpsilonPx
      ) {
        observedScrollTop = currentScrollTop
        onDrift(currentScrollTop)
      }
    }

    remainingFrames -= 1
    if (remainingFrames > 0) {
      frameHandle = requestFrame(step)
    }
  }

  const ensureRunning = () => {
    if (frameHandle === null && remainingFrames > 0) {
      frameHandle = requestFrame(step)
    }
  }

  return {
    start: (scrollTop: number) => {
      observedScrollTop = scrollTop
      remainingFrames = windowFrames
      framesSinceSample = 0
      ensureRunning()
    },
    extend: () => {
      remainingFrames = windowFrames
      ensureRunning()
    },
    cancel: () => {
      if (frameHandle !== null) {
        cancelFrame(frameHandle)
      }
      frameHandle = null
      remainingFrames = 0
    },
    isRunning: () => frameHandle !== null,
  }
}
