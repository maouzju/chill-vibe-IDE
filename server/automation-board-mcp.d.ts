import type { WorkspaceAdminCommand, WorkspaceSessionMirror } from '../shared/schema.js'
import type { WorkspaceAdminTranscriptEntry } from './automation-board-bridge.js'

type WorkspaceAdminMcpToolDefinition = {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: false
  }
}

type WorkspaceAdminMcpToolContent = { type: 'text'; text: string }

type WorkspaceAdminMcpToolResult = {
  content: WorkspaceAdminMcpToolContent[]
  isError: boolean
}

type WorkspaceAdminCommandResolution =
  /**
   * `selfArchive` = 这条命令的目标是调用者自己（`move_session_to_lane` 省略
   * cardId 的自我归档）。它不进命令体：命令体是共享 schema 的地盘，而这个标记
   * 只影响返回给模型的文案（自移会中断本回合，不能引导它再查一次）。
   */
  | { command: WorkspaceAdminCommand; selfArchive?: boolean; error?: undefined }
  | { command?: undefined; selfArchive?: undefined; error: string }

type WorkspaceAdminCommandDeliveryOutcome = {
  accepted: boolean
  reason?: string
}

/** Injected IO so tools can be unit-tested without a live bridge or child process. */
type WorkspaceAdminToolContext = {
  /** Empty string = this session has no admin access; the write tools refuse. */
  columnId: string
  /** The requesting card, filtered out of the session listing. */
  selfCardId?: string
  /** Frozen clock for silence math; falls back to Date.now() when omitted. */
  nowMs?: number
  fetchWorkspace: () => Promise<WorkspaceSessionMirror | null>
  fetchSession: (
    cardId: string,
    limit: number,
  ) => Promise<WorkspaceAdminTranscriptEntry[] | null>
  postCommand: (command: WorkspaceAdminCommand) => Promise<WorkspaceAdminCommandDeliveryOutcome>
}

export const workspaceAdminMcpToolDefinitions: WorkspaceAdminMcpToolDefinition[]

export function buildWorkspaceSessionsText(
  mirror: WorkspaceSessionMirror | null | undefined,
  nowMs: number,
  selfCardId?: string,
): string

export function buildSessionTranscriptText(
  cardId: string,
  entries: WorkspaceAdminTranscriptEntry[] | null | undefined,
): string

export function resolveWorkspaceAdminCommandFromToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  columnId: string,
  /**
   * 目标是调用者自己的两条路径要用：`wake_me_when_sessions_finish` 唤醒自己，
   * `move_session_to_lane` 省略 cardId 时把自己归档到 done。
   */
  selfCardId?: string,
): WorkspaceAdminCommandResolution

export function callWorkspaceAdminTool(
  name: string,
  args: Record<string, unknown> | undefined,
  context: WorkspaceAdminToolContext,
): Promise<WorkspaceAdminMcpToolResult>
