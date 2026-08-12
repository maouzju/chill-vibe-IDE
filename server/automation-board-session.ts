import process from 'node:process'

import {
  workspaceMirrorEntryLimit,
  workspaceMirrorEntryMaxChars,
  workspaceMirrorPreviewMaxChars,
  workspaceMirrorRequirementMaxChars,
  type ChatRequest,
  type WorkspaceAdminCommand,
  type WorkspaceSessionMirror,
} from '../shared/schema.js'
import {
  createWorkspaceAdminBridge,
  type WorkspaceAdminBridge,
  type WorkspaceAdminBridgeRuntimeInfo,
  type WorkspaceAdminTranscriptEntry,
} from './automation-board-bridge.js'
import {
  buildWorkspaceAdminClaudeMcpConfig,
  buildWorkspaceAdminCodexRuntimeArgs,
  getWorkspaceAdminInstruction,
  getWorkspaceAdminMcpScriptPath,
  type WorkspaceAdminClaudeMcpConfig,
} from './automation-board-runtime.js'

/**
 * 超管权限运行时的进程内状态。
 *
 * 三条刻意的设计约束：
 *  1. **懒启动**：桥接的 HTTP 监听只在第一次真正有超管回合时才创建，普通用户
 *     从不开超管权限就永远不会多出一个监听端口（照 pitfall 77/79 的教训，
 *     任何在 import 期就动手的单例都会绕过 Electron 的运行时环境准备）。
 *  2. **镜像截断在接收端也跑一遍**：requirement / preview / 转录条目的字符与
 *     条数预算都在 publish 里重跑，发送端已经跑过一遍也不省 —— 否则新增一个
 *     调用方就能绕过上限把整段转录送出程序边界（pitfall 183/258）。
 *  3. **桥接自身绝不改 state**：写命令一律经 dispatcher 转发给渲染进程复用
 *     电脑端 handler —— 与手机监工同一条规矩。
 *
 * 镜像的键是 **columnId**（一整个工作区列），不是某一张看板：超管权限的语义
 * 是"操作其他会话"，普通 tab 里的会话同样在内。
 */
const mirrors = new Map<string, WorkspaceSessionMirror>()

let bridge: WorkspaceAdminBridge | null = null
let bridgeStartup: Promise<WorkspaceAdminBridgeRuntimeInfo> | null = null
// 允许 Promise：后端搬进 utilityProcess 后投递结果只能异步回来（同步实现照旧可用）。
let commandDispatcher: ((command: WorkspaceAdminCommand) => boolean | Promise<boolean>) | null = null

export const setWorkspaceAdminCommandDispatcher = (
  dispatcher: ((command: WorkspaceAdminCommand) => boolean | Promise<boolean>) | null,
) => {
  commandDispatcher = dispatcher
}

const truncate = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`

export const publishWorkspaceSessionMirror = (mirror: WorkspaceSessionMirror) => {
  mirrors.set(mirror.columnId, {
    ...mirror,
    sessions: mirror.sessions.map((session) => ({
      ...session,
      ...(session.board
        ? {
            board: {
              ...session.board,
              requirement: truncate(session.board.requirement, workspaceMirrorRequirementMaxChars),
            },
          }
        : {}),
      lastMessagePreview: truncate(session.lastMessagePreview, workspaceMirrorPreviewMaxChars),
      recentEntries: session.recentEntries
        .slice(-workspaceMirrorEntryLimit)
        .map((entry) => ({
          ...entry,
          content: truncate(entry.content, workspaceMirrorEntryMaxChars),
        })),
    })),
  })
}

export const forgetWorkspaceSessionMirror = (columnId: string) => {
  mirrors.delete(columnId)
}

export const readWorkspaceSessionMirror = (columnId: string): WorkspaceSessionMirror | null =>
  mirrors.get(columnId) ?? null

const readWorkspaceSessionTranscript = async (
  cardId: string,
  limit: number,
): Promise<WorkspaceAdminTranscriptEntry[] | null> => {
  for (const mirror of mirrors.values()) {
    const session = mirror.sessions.find((entry) => entry.cardId === cardId)
    if (session) {
      return session.recentEntries.slice(-limit)
    }
  }

  return null
}

const ensureWorkspaceAdminBridge = async (): Promise<WorkspaceAdminBridgeRuntimeInfo> => {
  if (!bridge) {
    bridge = createWorkspaceAdminBridge({
      readWorkspaceMirror: readWorkspaceSessionMirror,
      readSessionTranscript: readWorkspaceSessionTranscript,
      dispatchCommand: (command) => commandDispatcher?.(command) ?? false,
    })
  }

  bridgeStartup ??= bridge.start()

  try {
    return await bridgeStartup
  } catch (error) {
    // 启动失败不能把失败的 promise 永久缓存住，否则一次瞬时的端口问题会让
    // 之后每次超管回合都直接复用同一个 rejection。
    bridgeStartup = null
    throw error
  }
}

export const stopWorkspaceAdminBridge = async () => {
  const current = bridge
  bridge = null
  bridgeStartup = null
  mirrors.clear()
  await current?.stop()
}

export type WorkspaceAdminRuntime = {
  /** codex：追加到 `codex app-server` argv 的 `-c mcp_servers.*` 组。 */
  codexRuntimeArgs: string[]
  /** claude：`--mcp-config` 的 JSON 载荷。 */
  claudeMcpConfig: WorkspaceAdminClaudeMcpConfig
  /** 追加到系统提示的一段说明（工具怎么用、"鞭策"是什么意思）。 */
  instruction: string
}

/**
 * 只对 `card.adminAccess` 开着的回合生效（请求上表现为 `request.adminAccess`）
 * —— 普通聊天卡永远拿不到工作区工具，**这是权限边界，不是优化**。
 */
export const createWorkspaceAdminRuntime = async (
  request: ChatRequest,
): Promise<WorkspaceAdminRuntime | null> => {
  if (!request.adminAccess) {
    return null
  }

  const runtimeInfo = await ensureWorkspaceAdminBridge()
  const launch = {
    url: runtimeInfo.url,
    token: runtimeInfo.token,
    columnId: request.adminAccess.columnId,
    selfCardId: request.adminAccess.selfCardId,
    scriptPath: getWorkspaceAdminMcpScriptPath(),
    execPath: process.execPath,
    isElectron: Boolean(process.versions.electron),
  }

  return {
    codexRuntimeArgs: buildWorkspaceAdminCodexRuntimeArgs(launch),
    claudeMcpConfig: buildWorkspaceAdminClaudeMcpConfig(launch),
    instruction: getWorkspaceAdminInstruction(request.language),
  }
}
