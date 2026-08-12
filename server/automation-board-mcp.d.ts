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
  | { command: WorkspaceAdminCommand; error?: undefined }
  | { command?: undefined; error: string }

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
): WorkspaceAdminCommandResolution

export function callWorkspaceAdminTool(
  name: string,
  args: Record<string, unknown> | undefined,
  context: WorkspaceAdminToolContext,
): Promise<WorkspaceAdminMcpToolResult>
