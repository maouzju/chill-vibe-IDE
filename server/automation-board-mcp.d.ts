import type { AutomationBoardCommand, AutomationBoardMirror } from '../shared/schema.js'
import type { AutomationBoardTranscriptEntry } from './automation-board-bridge.js'

type BoardMcpToolDefinition = {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: false
  }
}

type BoardMcpToolContent = { type: 'text'; text: string }

type BoardMcpToolResult = {
  content: BoardMcpToolContent[]
  isError: boolean
}

type BoardCommandResolution =
  | { command: AutomationBoardCommand; error?: undefined }
  | { command?: undefined; error: string }

type BoardCommandDeliveryOutcome = {
  accepted: boolean
  reason?: string
}

/** Injected IO so tools can be unit-tested without a live bridge or child process. */
type AutomationBoardToolContext = {
  boardCardId: string
  /** Frozen clock for silence math; falls back to Date.now() when omitted. */
  nowMs?: number
  fetchBoard: () => Promise<AutomationBoardMirror | null>
  fetchItem: (
    cardId: string,
    limit: number,
  ) => Promise<AutomationBoardTranscriptEntry[] | null>
  postCommand: (command: AutomationBoardCommand) => Promise<BoardCommandDeliveryOutcome>
}

export const boardMcpToolDefinitions: BoardMcpToolDefinition[]

export function buildBoardItemsText(
  mirror: AutomationBoardMirror | null | undefined,
  nowMs: number,
): string

export function buildBoardItemTranscriptText(
  cardId: string,
  entries: AutomationBoardTranscriptEntry[] | null | undefined,
): string

export function resolveBoardCommandFromToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  boardCardId: string,
): BoardCommandResolution

export function callAutomationBoardTool(
  name: string,
  args: Record<string, unknown> | undefined,
  context: AutomationBoardToolContext,
): Promise<BoardMcpToolResult>
