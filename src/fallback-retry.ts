import type { ChatMessage } from '../shared/schema'

// 兜底重试：断线续传（短间隔、有预算）兜不住的终态报错不再停在「错误中断」，
// 而是按 5 → 10 → … → 30 分钟（封顶）的间隔无限自动续传，直到成功或用户接手。
// 2026-10-16 用户需求：永远不要真正的错误中断状态。
const fallbackRetryStepMs = 5 * 60_000
const fallbackRetryMaxMs = 30 * 60_000

/** `failureCount` 是第几次兜底级失败（1 起）：1 → 5 分钟，每多失败一次 +5，封顶 30。 */
export const getFallbackRetryDelayMs = (failureCount: number) =>
  Math.min(fallbackRetryMaxMs, fallbackRetryStepMs * Math.max(1, Math.floor(failureCount)))

// 报错有两种形态：不带 meta.kind 的普通 system 消息，以及 CLI 直接写成 assistant 气泡的
// 「API Error: …」（2026-10-16 state.json 实测 16 段连续重复，多数是后者）。run-duration 等
// 同一轮内的同文报错不论中间隔着什么都算重复（见下方 isDuplicateAfter）。
const isPlainSystemMessage = (message: ChatMessage) =>
  message.role === 'system' && !message.meta?.kind

const isErrorMessage = (message: ChatMessage) =>
  isPlainSystemMessage(message) ||
  (message.role === 'assistant' && !message.meta?.structuredData && /^\s*API Error\b/i.test(message.content))

// 中转站每次失败的 request id 都不同，但对用户是同一句报错，比较前剥掉。
const errorKey = (message: ChatMessage) =>
  message.content.replace(/\s*\(request id:[^)]*\)/gi, '').trim()

// 症状：429/503 中转抽风时，每次兜底续传 CLI 都先做几步工具/命令再撞上同一句报错，
//   2026-11-18 截图一轮里堆了 15 条同文「API Error: …(429)」，聊天流被刷屏。
// 根因：原先只把「中间只隔着空气泡/run-duration」的同文报错算重复，隔着工具/命令就当「有进展、
//   是新信息」放行——但报错文本一字不差，对用户没有新信息；重试次数横幅已经说明了失败了几次。
// 决策：以「当前这一轮」（上一条用户消息之后）为范围，同文报错只留第一条，不管中间有无进展。
// 被否决：只放宽到再隔几条——隔多少条没有道理；全卡范围去重——新一轮的同一句报错该重新露面。
const isDuplicateAfter = (messages: ChatMessage[], endIndex: number, addition: ChatMessage) => {
  if (!isErrorMessage(addition)) {
    return false
  }
  const key = errorKey(addition)
  if (!key) {
    return false
  }
  for (let index = endIndex; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'user') {
      return false
    }
    if (isErrorMessage(message) && errorKey(message) === key) {
      return true
    }
  }
  return false
}

export const isDuplicateTrailingErrorMessage = (messages: ChatMessage[], addition: ChatMessage) =>
  isDuplicateAfter(messages, messages.length - 1, addition)

/** 去掉连续重复的报错，只保留每段连续重复里的第一条；没有可剥离时原样返回同一个数组。 */
export const stripConsecutiveDuplicateErrorMessages = (messages: ChatMessage[]) => {
  let kept: ChatMessage[] | null = null
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    const duplicate = kept
      ? isDuplicateAfter(kept, kept.length - 1, message)
      : isDuplicateAfter(messages, index - 1, message)
    if (duplicate) {
      kept ??= messages.slice(0, index)
      continue
    }
    kept?.push(message)
  }
  return kept ?? messages
}
