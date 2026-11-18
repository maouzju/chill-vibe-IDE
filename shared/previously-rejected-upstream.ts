// 症状：卡片连刷 `API Error: 400 这段内容此前被上游拒绝过且高度相似，不再重试。请修改内容。`，
//   断线续传 / 兜底重试轮番打同一请求，每轮跑十几秒就挂（2026-11-18 用户截图，三轮 4~5 个工具后都 400）。
// 根因：中转站有「上游拒绝过的内容 + 高度相似 → 直接 400」的去重缓存，且文案有中英两版；
//   识别只写了英文 `previously rejected by the upstream provider`，中文版整句漏判，
//   于是继续复用池内进程、反复重试同一请求。识别它只用于停掉进程重用，不代表要丢聊天历史。
// 为什么不能只加一个字符串：前端（src/stream-recovery）与服务端（server/provider-stream-recovery）
//   各有一份判据，必须共用同一个函数，否则下次中转站换文案又只修一半。
const previouslyRejectedUpstreamPatterns = [
  'previously rejected by the upstream provider',
  // 中文版：「此前被上游拒绝过」+「不再重试」同现；不单拿「高度相似」，避免误伤普通文本。
  /此前被上游拒绝/,
] as const

export const isPreviouslyRejectedUpstreamMessage = (message: string) => {
  const normalized = message.toLowerCase()
  return previouslyRejectedUpstreamPatterns.some((pattern) =>
    typeof pattern === 'string' ? normalized.includes(pattern) : pattern.test(message),
  )
}