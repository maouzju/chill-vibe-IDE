// 症状：卡片一直刷 `API Error: 500 user sensitive words detected: <词> (request id: …)`，
//   断线续传 + 无限兜底重试轮番打同一请求，死循环（2026-10-21 用户截图，api.duckcoding.ai）。
// 根因：中转站按词表拦截整段请求，只要上下文里还有这个词，重试必挂；CLI 又给所有 ≥500 加了
//   「server-side issue, usually temporary」后缀，于是被可恢复名单当成瞬时故障。
// 修法：报错里直接点名了被拦的词——Claude 会话把本地存档里的词打码后续传一次；打码后存档里
//   已找不到（词在系统提示词/规则文件里）或非 Claude provider，就停在终态，不再兜底重试。
const rejectionPattern = /sensitive words? detected\s*[:：]\s*([^\n]*?)\s*(?:\(request id|$)/im

export const isSensitiveWordRejection = (message: string) => rejectionPattern.test(message)

export const extractBlockedSensitiveWords = (message: string): string[] => {
  const match = rejectionPattern.exec(message)
  if (!match) {
    return []
  }
  return [...new Set(match[1]!.replace(/[.。]+$/, '').split(/[,，、;；|]+/).map((word) => word.trim()).filter(Boolean))]
}
