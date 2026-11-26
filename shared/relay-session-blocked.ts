// 症状：一张卡怎么点「重连」都连不上，其它卡都正常（2026-11-26 用户截图）。
// 根因：中转站回 `403 该会话因触发上游 AI 研究类拒答已被暂时屏蔽，请开启新会话`（另一版文案是
//   「该会话已被网络安全策略屏蔽，请开启新会话」）。屏蔽按对话内容算、不按会话号：同日实测
//   `--resume <id> --fork-session`（新会话号、同一段历史）照样 403，只有用可见历史重开才通。
//   CLI 又给 403 统一加 "Failed to authenticate." 前缀，被当成鉴权失败直接停在终态。
// 被否决：不拿裸 403 或单独的「开启新会话」当判据——额度不足也是 403，模型自己的回复里也会
//   出现「开启新会话」。必须「屏蔽 / blocked」与「开启新会话 / start a new session」同现在一行里。
const relaySessionBlockedPatterns = [
  /会话[^\n]{0,60}屏蔽[^\n]{0,20}开启新会话/,
  /session is[^\n]{0,80}blocked[^\n]{0,80}start a new session/i,
] as const

export const isRelaySessionBlockedMessage = (message: string) =>
  relaySessionBlockedPatterns.some((pattern) => pattern.test(message))
