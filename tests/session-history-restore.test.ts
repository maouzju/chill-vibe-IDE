import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveSessionHistoryEntryForRestore } from '../src/session-history-restore.ts'
import type { SessionHistoryEntry } from '../shared/schema.ts'

const createHistoryEntry = (overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry => ({
  id: overrides.id ?? 'history-entry-1',
  title: overrides.title ?? 'Archived thread',
  sessionId: overrides.sessionId ?? 'provider-session-1',
  provider: overrides.provider ?? 'codex',
  model: overrides.model ?? 'gpt-5.5',
  workspacePath: overrides.workspacePath ?? 'C:/workspace/repo-one',
  messages: overrides.messages ?? [
    {
      id: 'message-1',
      role: 'user',
      content: 'Restore me before the delayed save reaches disk.',
      createdAt: '2026-04-24T08:00:00.000Z',
    },
  ],
  messageCount: overrides.messageCount,
  messagesPreview: overrides.messagesPreview,
  archivedAt: overrides.archivedAt ?? '2026-04-24T08:01:00.000Z',
})

test('restores a complete in-memory history entry before the delayed save reaches disk', async () => {
  const localEntry = createHistoryEntry({ id: 'unsaved-history-entry', messageCount: 1 })
  let diskLoaderCalled = false

  const restored = await resolveSessionHistoryEntryForRestore({
    entryId: localEntry.id,
    state: { sessionHistory: [localEntry] },
    loadEntry: async () => {
      diskLoaderCalled = true
      throw new Error('The queued save has not flushed this history entry to disk yet.')
    },
  })

  assert.equal(restored, localEntry)
  assert.equal(diskLoaderCalled, false)
})

test('loads a full transcript from disk when the renderer only has a lightweight history preview', async () => {
  const previewEntry = createHistoryEntry({
    id: 'preview-history-entry',
    messageCount: 10,
    messagesPreview: true,
    messages: [
      {
        id: 'preview-message-1',
        role: 'user',
        content: 'Preview only',
        createdAt: '2026-04-24T08:00:00.000Z',
      },
    ],
  })
  const fullEntry = createHistoryEntry({
    ...previewEntry,
    messagesPreview: undefined,
    messages: Array.from({ length: 10 }, (_, index) => ({
      id: `full-message-${index + 1}`,
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `Full transcript message ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 3, 24, 8, 0, index)).toISOString(),
    })),
  })
  let requestedEntryId = ''

  const restored = await resolveSessionHistoryEntryForRestore({
    entryId: previewEntry.id,
    state: { sessionHistory: [previewEntry] },
    loadEntry: async (request) => {
      requestedEntryId = request.entryId
      return { entry: fullEntry }
    },
  })

  assert.equal(requestedEntryId, previewEntry.id)
  assert.equal(restored.messages.length, 10)
  assert.equal(restored.messages[9]?.content, 'Full transcript message 10')
})
