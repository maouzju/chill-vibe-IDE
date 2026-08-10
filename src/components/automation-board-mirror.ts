import {
  automationBoardMirrorEntryLimit,
  automationBoardMirrorEntryMaxChars,
  automationBoardMirrorPreviewMaxChars,
  automationBoardMirrorRequirementMaxChars,
  type AutomationBoard,
  type AutomationBoardMirror,
  type AutomationBoardMirrorItem,
  type BoardColumn,
  type ChatCard,
} from '../../shared/schema'

const truncate = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim()

/**
 * 一条转录条目的可读文本。结构化活动（命令/工具/改动）的 content 常常是空的，
 * 真正的信息在 meta.kind 里，所以两者都要带出去 —— 否则监工看到的是一串空条目
 * 而不是"这一轮跑了 3 个命令"。
 */
const describeEntry = (message: ChatCard['messages'][number]) => {
  const kind = message.meta?.kind
  const content = collapse(message.content)

  if (content) {
    return truncate(content, automationBoardMirrorEntryMaxChars)
  }

  return kind ? `[${kind}]` : ''
}

const buildMirrorItem = (
  item: AutomationBoard['items'][number],
  card: ChatCard,
): AutomationBoardMirrorItem => {
  const lastMessage = card.messages.at(-1)

  return {
    cardId: card.id,
    lane: item.lane,
    requirement: truncate(item.requirement, automationBoardMirrorRequirementMaxChars),
    title: card.title,
    provider: card.provider,
    model: card.model,
    status: card.status,
    backgroundWorkPending: card.backgroundWorkPending === true,
    wakeTimerActive: card.wakeTimerActive === true,
    ...(card.wakeTimerWakeAt ? { wakeTimerWakeAt: card.wakeTimerWakeAt } : {}),
    repeatLoopActive: card.repeatLoopActive === true,
    ...(item.startedAt ? { startedAt: item.startedAt } : {}),
    ...(item.completedAt ? { completedAt: item.completedAt } : {}),
    ...(lastMessage?.createdAt ? { lastActivityAt: lastMessage.createdAt } : {}),
    lastMessagePreview: truncate(
      collapse(lastMessage?.content ?? ''),
      automationBoardMirrorPreviewMaxChars,
    ),
    messageCount: card.messages.length,
    recentEntries: card.messages
      .slice(-automationBoardMirrorEntryLimit)
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: describeEntry(message),
        ...(message.meta?.kind ? { kind: message.meta.kind } : {}),
        createdAt: message.createdAt,
      }))
      .filter((entry) => entry.content.length > 0),
  }
}

/**
 * 构建推给主进程的实时看板镜像。
 *
 * 为什么是推而不是让服务端读盘：普通保存在流式期间被刻意节流
 * （AGENTS.md pitfall 54/114），读盘快照对监工来说太旧。
 *
 * 载荷必须有界。这里对 requirement / preview / 每条转录的字符数以及转录条数
 * 全部封顶；session 模块在 publish 时会再执行同一套预算，所以任何绕过这里的
 * 调用方也无法把整段转录送给模型（pitfall 183：整段转录跨进程边界是事故源）。
 */
export const buildAutomationBoardMirror = ({
  column,
  boardCardId,
  generatedAt,
}: {
  column: BoardColumn
  boardCardId: string
  generatedAt: string
}): AutomationBoardMirror | null => {
  const boardCard = column.cards[boardCardId]
  const board = boardCard?.automationBoard
  if (!board) {
    return null
  }

  const supervisorCard = board.supervisorCardId
    ? column.cards[board.supervisorCardId]
    : undefined

  return {
    boardCardId,
    columnId: column.id,
    workspacePath: column.workspacePath,
    generatedAt,
    supervisorCardId: board.supervisorCardId,
    supervisorStatus: supervisorCard?.status ?? 'idle',
    items: board.items.flatMap((item) => {
      const card = column.cards[item.cardId]
      return card ? [buildMirrorItem(item, card)] : []
    }),
  }
}

/**
 * 镜像推送的节流间隔。监工不是延迟敏感的，而流式期间每个 delta 都会改变镜像，
 * 所以宁可陈旧两秒也不要每帧跨一次 IPC。
 */
export const automationBoardMirrorPublishIntervalMs = 2000

/**
 * 只有当镜像里对监工有意义的部分变了才值得推。用一个紧凑签名比对，避免
 * 每次 delta 都跨 IPC 送一份几十 KB 的载荷。
 */
export const getAutomationBoardMirrorSignature = (mirror: AutomationBoardMirror) =>
  [
    mirror.boardCardId,
    mirror.supervisorCardId,
    mirror.supervisorStatus,
    ...mirror.items.map((item) =>
      [
        item.cardId,
        item.lane,
        item.status,
        item.backgroundWorkPending ? '1' : '0',
        item.messageCount,
        item.lastActivityAt ?? '',
      ].join(':'),
    ),
  ].join('|')
