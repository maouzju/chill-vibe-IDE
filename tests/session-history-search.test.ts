import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createDefaultState } from '../shared/default-state.ts'
import type { SessionHistoryEntry } from '../shared/schema.ts'
import {
  hideInternalSessionHistoryEntries,
  resetSessionHistoryCatalogCacheForTests,
  searchInternalSessionHistory,
} from '../server/session-history-catalog.ts'

const currentWorkspace = 'D:\\Git\\chill-vibe'
const otherWorkspace = 'D:\\Git\\other-project'

const createHistoryEntry = (
  overrides: Partial<SessionHistoryEntry> & Pick<SessionHistoryEntry, 'id' | 'archivedAt'>,
): SessionHistoryEntry => ({
  title: overrides.title ?? 'Archived session',
  sessionId: overrides.sessionId,
  provider: overrides.provider ?? 'codex',
  model: overrides.model ?? 'gpt-5.5',
  workspacePath: overrides.workspacePath ?? currentWorkspace,
  messages: overrides.messages ?? [],
  ...overrides,
})

describe('internal session history catalog search', () => {
  let dataDir = ''
  let sidecarDir = ''

  const writeSidecar = async (entry: SessionHistoryEntry) => {
    const fileName = `${Buffer.from(entry.id, 'utf8').toString('base64url')}.json`
    await writeFile(path.join(sidecarDir, fileName), `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-history-search-'))
    sidecarDir = path.join(dataDir, 'session-history')
    await mkdir(sidecarDir, { recursive: true })
    process.env.CHILL_VIBE_DATA_DIR = dataDir
    resetSessionHistoryCatalogCacheForTests()
  })

  afterEach(async () => {
    resetSessionHistoryCatalogCacheForTests()
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(dataDir, { recursive: true, force: true })
  })

  it('finds middle-message text in an old sidecar outside the recent state index and only returns the current workspace', async () => {
    const recentIndexedEntry = createHistoryEntry({
      id: 'recent-indexed-entry',
      title: 'Recent indexed session',
      archivedAt: '2026-07-15T10:00:00.000Z',
      messages: [
        {
          id: 'recent-message',
          role: 'user',
          content: 'This recent preview does not contain the old search phrase.',
          createdAt: '2026-07-15T09:59:00.000Z',
        },
      ],
    })
    const state = createDefaultState(currentWorkspace)
    state.sessionHistory = [recentIndexedEntry]
    await writeFile(path.join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')

    const oldMessages = Array.from({ length: 11 }, (_, index) => ({
      id: `old-message-${index}`,
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: index === 5 ? 'The forgotten migration checksum is violet-otter-731.' : `Archived filler ${index}`,
      createdAt: `2025-12-01T08:${String(index).padStart(2, '0')}:00.000Z`,
    }))
    const oldCurrentWorkspaceEntry = createHistoryEntry({
      id: 'old-current-workspace-entry',
      title: 'Old archive beyond the recent index',
      sessionId: 'old-current-session',
      archivedAt: '2025-12-01T09:00:00.000Z',
      messages: oldMessages,
    })
    const otherWorkspaceEntry = createHistoryEntry({
      id: 'other-workspace-entry',
      title: 'Other workspace archive',
      sessionId: 'other-workspace-session',
      workspacePath: otherWorkspace,
      archivedAt: '2026-01-01T09:00:00.000Z',
      messages: [
        {
          id: 'other-message',
          role: 'assistant',
          content: 'The forgotten migration checksum is violet-otter-731.',
          createdAt: '2026-01-01T08:59:00.000Z',
        },
      ],
    })
    await Promise.all([writeSidecar(oldCurrentWorkspaceEntry), writeSidecar(otherWorkspaceEntry)])

    const result = await searchInternalSessionHistory({
      workspacePath: currentWorkspace,
      query: 'violet-otter-731',
    })

    assert.equal(
      state.sessionHistory.some((entry) => entry.id === oldCurrentWorkspaceEntry.id),
      false,
      'the proving fixture must not already exist in the recent state.json index',
    )
    assert.deepEqual(result.entries.map((entry) => entry.id), ['old-current-workspace-entry'])
    assert.equal(result.total, 1)
    assert.equal(result.entries[0]?.messageCount, oldMessages.length)
    assert.deepEqual(
      result.entries[0]?.messages,
      [],
      'deep search should return a lightweight summary instead of the full transcript',
    )
  })

  it('keeps only the newest archive for one provider session and persistently hides the logical session after restore', async () => {
    const olderDuplicate = createHistoryEntry({
      id: 'duplicate-session-older',
      title: 'Needle archive older copy',
      sessionId: 'provider-session-shared',
      archivedAt: '2026-02-01T09:00:00.000Z',
      messages: [
        {
          id: 'duplicate-older-message',
          role: 'user',
          content: 'Find the durable-history-needle.',
          createdAt: '2026-02-01T08:59:00.000Z',
        },
      ],
    })
    const newerDuplicate = createHistoryEntry({
      id: 'duplicate-session-newer',
      title: 'Needle archive newest copy',
      sessionId: 'provider-session-shared',
      archivedAt: '2026-03-01T09:00:00.000Z',
      messages: [
        {
          id: 'duplicate-newer-message',
          role: 'assistant',
          content: 'The durable-history-needle is in this newer archive too.',
          createdAt: '2026-03-01T08:59:00.000Z',
        },
      ],
    })
    await Promise.all([writeSidecar(olderDuplicate), writeSidecar(newerDuplicate)])

    const beforeHide = await searchInternalSessionHistory({
      workspacePath: currentWorkspace,
      query: 'durable-history-needle',
    })

    assert.deepEqual(beforeHide.entries.map((entry) => entry.id), ['duplicate-session-newer'])
    assert.equal(beforeHide.total, 1)

    await hideInternalSessionHistoryEntries({
      entryId: newerDuplicate.id,
      provider: newerDuplicate.provider,
      sessionId: newerDuplicate.sessionId,
    })
    resetSessionHistoryCatalogCacheForTests()

    const afterHide = await searchInternalSessionHistory({
      workspacePath: currentWorkspace,
      query: 'durable-history-needle',
    })

    assert.deepEqual(afterHide.entries, [])
    assert.equal(afterHide.total, 0)
  })
})
