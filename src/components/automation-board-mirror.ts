import {
  workspaceMirrorEntryLimit,
  workspaceMirrorEntryMaxChars,
  workspaceMirrorPreviewMaxChars,
  workspaceMirrorRequirementMaxChars,
  type AutomationBoardItem,
  type BoardColumn,
  type ChatCard,
  type LayoutNode,
  type WorkspaceSessionMirror,
  type WorkspaceSessionMirrorItem,
} from '../../shared/schema'
import { getAutomationBoard } from '../../shared/default-state'
import { MODEL_PICKER_HIDDEN_TOOL_MODELS } from '../../shared/models'

const truncate = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim()

/**
 * 一条转录条目的可读文本。结构化活动（命令/工具/改动）的 content 常常是空的，
 * 真正的信息在 meta.kind 里，所以两者都要带出去 —— 否则超管会话看到的是一串
 * 空条目而不是"这一轮跑了 3 个命令"。
 */
const describeEntry = (message: ChatCard['messages'][number]) => {
  const kind = message.meta?.kind
  const content = collapse(message.content)

  if (content) {
    return truncate(content, workspaceMirrorEntryMaxChars)
  }

  return kind ? `[${kind}]` : ''
}

const collectPaneTabIds = (node: LayoutNode, tabs: Set<string>): Set<string> => {
  if (node.type === 'pane') {
    for (const tabId of node.tabs) {
      tabs.add(tabId)
    }
    return tabs
  }

  for (const child of node.children) {
    collectPaneTabIds(child, tabs)
  }

  return tabs
}

type BoardPlacement = { boardCardId: string; item: AutomationBoardItem }

const buildMirrorSession = (
  card: ChatCard,
  placement: BoardPlacement | undefined,
  isTab: boolean,
): WorkspaceSessionMirrorItem => {
  const lastMessage = card.messages.at(-1)

  return {
    cardId: card.id,
    title: card.title,
    provider: card.provider,
    model: card.model,
    status: card.status,
    backgroundWorkPending: card.backgroundWorkPending === true,
    ...(placement
      ? {
          board: {
            boardCardId: placement.boardCardId,
            lane: placement.item.lane,
            requirement: truncate(placement.item.requirement, workspaceMirrorRequirementMaxChars),
            ...(placement.item.startedAt ? { startedAt: placement.item.startedAt } : {}),
            ...(placement.item.completedAt ? { completedAt: placement.item.completedAt } : {}),
          },
        }
      : {}),
    isTab,
    wakeTimerActive: card.wakeTimerActive === true,
    ...(card.wakeTimerWakeAt ? { wakeTimerWakeAt: card.wakeTimerWakeAt } : {}),
    repeatLoopActive: card.repeatLoopActive === true,
    ...(lastMessage?.createdAt ? { lastActivityAt: lastMessage.createdAt } : {}),
    lastMessagePreview: truncate(
      collapse(lastMessage?.content ?? ''),
      workspaceMirrorPreviewMaxChars,
    ),
    messageCount: card.messages.length,
    recentEntries: card.messages
      .slice(-workspaceMirrorEntryLimit)
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
 * 构建推给主进程的实时会话镜像。
 *
 * 作用域是**一整列工作区**而不是某张看板：超管权限的语义是"操作这个工作区的
 * 其他会话"，普通 tab 会话同样在内（design.md「MCP 作用域」）。
 *
 * 为什么是推而不是让服务端读盘：普通保存在流式期间被刻意节流
 * （AGENTS.md pitfall 54/114），读盘快照对超管会话来说太旧。
 *
 * 载荷必须有界。这里对 requirement / preview / 每条转录的字符数以及转录条数
 * 全部封顶；session 模块在 publish 时会再执行同一套预算，所以任何绕过这里的
 * 调用方也无法把整段转录送给模型（pitfall 183：整段转录跨进程边界是事故源）。
 */
export const buildWorkspaceSessionMirror = ({
  column,
  generatedAt,
}: {
  column: BoardColumn
  generatedAt: string
}): WorkspaceSessionMirror | null => {
  const cards = Object.values(column.cards)
  const boardCardIds: string[] = []
  const placements = new Map<string, BoardPlacement>()

  for (const card of cards) {
    const board = getAutomationBoard(card)
    if (!board) {
      continue
    }

    boardCardIds.push(card.id)
    for (const item of board.items) {
      placements.set(item.cardId, { boardCardId: card.id, item })
    }
  }

  const tabIds = collectPaneTabIds(column.layout, new Set<string>())

  // 工具卡（看板容器卡自己也在内）不进镜像：模型对它们没有可操作语义。
  const sessions = cards
    .filter((card) => !MODEL_PICKER_HIDDEN_TOOL_MODELS.has(card.model))
    .map((card) => buildMirrorSession(card, placements.get(card.id), tabIds.has(card.id)))

  if (sessions.length === 0 && boardCardIds.length === 0) {
    return null
  }

  return {
    columnId: column.id,
    workspacePath: column.workspacePath,
    generatedAt,
    boardCardIds,
    sessions,
  }
}

/**
 * 镜像推送的节流间隔。超管会话不是延迟敏感的，而流式期间每个 delta 都会改变
 * 镜像，所以宁可陈旧两秒也不要每帧跨一次 IPC。
 */
export const workspaceSessionMirrorPublishIntervalMs = 2000

/**
 * 只有当镜像里对超管会话有意义的部分变了才值得推。
 *
 * 症状（要防的）：每个流式 delta 都跨一次 IPC 送几十 KB 载荷，节流白做。
 * 根因：单条消息正文会随 delta 不断增长，把它算进签名等于"每帧都变"。
 * 被否决：直接对整份镜像做 JSON 比较 —— 那正好把正文增长算进去（pitfall 258）。
 */
export const getWorkspaceSessionMirrorSignature = (mirror: WorkspaceSessionMirror) =>
  [
    mirror.columnId,
    ...mirror.sessions.map((session) =>
      [
        session.cardId,
        session.board?.lane ?? '',
        session.isTab ? '1' : '0',
        session.status,
        session.backgroundWorkPending ? '1' : '0',
        session.messageCount,
        session.lastActivityAt ?? '',
      ].join(':'),
    ),
  ].join('|')
