type ArchiveRecallMessage = {
  id: string
  role: string
  content?: string
  createdAt: string
  meta?: Record<string, unknown>
}

type ArchiveRecallSnapshotLike = {
  hiddenReason: string
  hiddenMessageCount: number
  messages: ArchiveRecallMessage[]
}

type ArchiveRecallSearchResult = {
  itemId: string
  role: string
  createdAt: string
  excerpt: string
  attachmentNames: string[]
  score: number
}

type ArchiveRecallToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

type ArchiveRecallToolResult = {
  content: ArchiveRecallToolContent[]
  isError: boolean
}

export function searchArchiveMessages(
  snapshot: ArchiveRecallSnapshotLike,
  query: string,
  limit?: number,
): ArchiveRecallSearchResult[]

export function callArchiveRecallTool(
  name: string,
  args: Record<string, unknown> | undefined,
  snapshot: ArchiveRecallSnapshotLike,
  options?: { attachmentsDir?: string },
): Promise<ArchiveRecallToolResult>
