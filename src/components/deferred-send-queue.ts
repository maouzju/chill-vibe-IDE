import type {
  QueuedSendRequest,
  StreamAskUserActivity,
} from '../../shared/schema'

export type { QueuedSendRequest } from '../../shared/schema'

export type SendMessageMode = 'auto' | 'defer' | 'interrupt'
export type SendMessageOrigin = 'user' | 'auto-urge' | 'wake-timer-release'

export type SendMessageOptions = {
  mode?: SendMessageMode
  origin?: SendMessageOrigin
}

export type QueuedSendSummary = {
  count: number
  nextPreview: string
  nextAttachmentCount: number
}

const collapseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

export const getQueuedSendPreview = (request: Pick<QueuedSendRequest, 'prompt'>) =>
  collapseWhitespace(request.prompt).slice(0, 120)

export const summarizeQueuedSends = (
  queue: readonly QueuedSendRequest[] | undefined,
): QueuedSendSummary | undefined => {
  if (!queue || queue.length === 0) {
    return undefined
  }

  const next = queue[0]!
  return {
    count: queue.length,
    nextPreview: getQueuedSendPreview(next),
    nextAttachmentCount: next.attachments.length,
  }
}

type QueuedSendRuntimeCard = {
  id: string
  queuedSends?: readonly QueuedSendRequest[]
}

export const buildQueuedSendRuntimeState = (
  columns: readonly { cards: Record<string, QueuedSendRuntimeCard> }[],
) => {
  const queues = new Map<string, QueuedSendRequest[]>()
  const summaries = new Map<string, QueuedSendSummary>()

  for (const column of columns) {
    for (const card of Object.values(column.cards)) {
      if (!card.queuedSends || card.queuedSends.length === 0) {
        continue
      }

      const queue = card.queuedSends.map((request) => ({
        ...request,
        attachments: request.attachments.map((attachment) => ({ ...attachment })),
      }))
      const summary = summarizeQueuedSends(queue)
      queues.set(card.id, queue)
      if (summary) {
        summaries.set(card.id, summary)
      }
    }
  }

  return { queues, summaries }
}

type QueuedSendTargetColumn = {
  id: string
  workspacePath?: string | null
  cards?: Record<string, unknown>
}

const ownsCardInWorkspace = (column: QueuedSendTargetColumn, cardId: string) =>
  Boolean(column.cards?.[cardId]) && Boolean(column.workspacePath?.trim())

export const resolveQueuedSendTargetColumnId = (
  columns: readonly QueuedSendTargetColumn[],
  fallbackColumnId: string,
  cardId: string,
) => {
  const fallbackColumn = columns.find((column) => column.id === fallbackColumnId)
  if (fallbackColumn && ownsCardInWorkspace(fallbackColumn, cardId)) {
    return fallbackColumn.id
  }

  return columns.find((column) => ownsCardInWorkspace(column, cardId))?.id ?? null
}

export const shouldStopStreamForAskUserActivity = (
  activity: Pick<StreamAskUserActivity, 'planFile' | 'nativeTool'>,
) =>
  // Native CLI tool questions (AskUserQuestion / ExitPlanMode) are auto-answered
  // by the headless CLI, so the run keeps going unless we stop it here. Text-
  // convention ask-user blocks end the turn naturally and must not be stopped.
  activity.nativeTool === true || Boolean(activity.planFile?.trim())

export const shouldSuppressStreamOutputAfterAskUserActivity = (
  activity: Pick<StreamAskUserActivity, 'planFile' | 'nativeTool'>,
) => shouldStopStreamForAskUserActivity(activity)

// 疑似攻击形状检测（设置里的开关，默认关闭）命中时，guard 以退出码 2 真正阻断
// 工具调用，它写进 stderr 的那段说明就是工具结果的 output 原文
// （claude-tool-result.ts 的 `text`）。渲染层不依赖退出码，因为 CLI 不把 hook 的
// 退出码结构化透传，只把 "Exit code N" 这种正文留给解析器。
//
// 症状：曾用中文前缀「检测到已知攻击形状」做判据。
// 根因：stderr 经 cmd 包装层转发，在中文 Windows 上可能被 GBK 解码损坏
//   （本仓库已有 179/179 快照被这样打坏的先例），中文匹配随即静默失配 ——
//   不报错、不停流，拦截功能无声消失。
// 为什么不能换写法：哨兵必须是纯 ASCII 才能在任何单字节编码下原样存活；
//   该常量与 server/codex-destructive-command-guard.js 的 attackPatternStderrMarker
//   保持一致，是本仓库自己写的常量，不随 CLI 版本漂移。
const attackPatternBlockedMarker = 'CHILL_VIBE_ATTACK_PATTERN_BLOCK'
// 哨兵必须独占行尾：guard 把它写在 stderr 第一行「Chill Vibe 安全防护：<哨兵>」，
// 前缀可能被 GBK 打坏但哨兵本身与行尾不变；源码/diff 里出现的哨兵都被引号或
// 等号包住，行尾不是哨兵字面量，不会命中。
const attackPatternBlockedLinePattern = /(^|[^A-Za-z0-9_\x27"\x60])CHILL_VIBE_ATTACK_PATTERN_BLOCK[ \t]*(\r?\n|$)/m

// 症状：2026-09-17 审计 agent 跑 `git diff`，正文印出本文件的哨兵常量，渲染层
//   按 includes 判成 guard 真拦截，整个会话被掐死（自触发误报）。
// 根因：只看子串，不看命令有没有失败、哨兵是不是 guard 写的那一行。
// 为什么不能换写法：hook 退出码不透传到命令卡，只能读正文；所以要求
//   「status=failed（guard 一定让命令失败）」+「哨兵独占行尾」两者同时成立。
export const isAttackPatternBlockedCommand = (
  activity: { output?: string; status?: string },
) =>
  activity.status === 'failed' &&
  typeof activity.output === 'string' &&
  activity.output.includes(attackPatternBlockedMarker) &&
  attackPatternBlockedLinePattern.test(activity.output)

// 症状：2026-09-17 用户在设置里关掉「疑似攻击形状检测」后，误报仍照样掐断会话。
// 根因：开关只下发给后端 hook（CHILL_VIBE_ATTACK_PATTERN_PROTECTION_ENABLED），
//   渲染层 onActivity 里的判定从没读过开关，只要正文里出现哨兵就 requestStop。
// 为什么不能换写法：判定必须留在渲染层（hook 退出码不透传），所以开关也要在
//   这一层再门控一次；用户关闭 = 明确表态「我来承担」，任何命中都不该再停流。
export const shouldStopRunForAttackPattern = (
  activity: { kind?: string; output?: string; status?: string },
  settings: { attackPatternProtectionEnabled?: boolean },
) =>
  settings.attackPatternProtectionEnabled === true &&
  activity.kind === 'command' &&
  isAttackPatternBlockedCommand(activity)
