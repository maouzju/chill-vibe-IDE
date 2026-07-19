import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createDefaultState } from '../shared/default-state.ts'
import type { SessionHistoryEntry } from '../shared/schema.ts'
import {
  hideInternalSessionHistoryEntries,
  listInternalSessionHistory,
  revealInternalSessionHistorySession,
  resetSessionHistoryCatalogCacheForTests,
  runSessionHistoryCatalogMaintenanceSlice,
  searchInternalSessionHistory,
} from '../server/session-history-catalog.ts'
import { filterCatalogSessionHistoryForWorkspace } from '../src/components/workspace-column-history.ts'

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

  it('keeps catalog entries whose Windows workspace path only differs by slash style or a trailing separator', () => {
    const entry = createHistoryEntry({
      id: 'normalized-workspace-entry',
      archivedAt: '2026-07-19T00:00:00.000Z',
      workspacePath: 'D:\\Git\\chill-vibe',
    })

    assert.deepEqual(
      filterCatalogSessionHistoryForWorkspace([entry], 'd:/git/chill-vibe/').map((item) => item.id),
      ['normalized-workspace-entry'],
    )
  })

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

    const rearchived = createHistoryEntry({
      ...newerDuplicate,
      id: 'duplicate-session-rearchived',
      title: 'Needle archive after a new close',
      archivedAt: '2026-04-01T09:00:00.000Z',
    })
    await writeSidecar(rearchived)
    await revealInternalSessionHistorySession({
      provider: rearchived.provider,
      sessionId: rearchived.sessionId,
      dataDir,
    })
    const afterNewArchive = await searchInternalSessionHistory({
      workspacePath: currentWorkspace,
      query: 'durable-history-needle',
    })
    assert.deepEqual(afterNewArchive.entries.map((entry) => entry.id), ['duplicate-session-rearchived'])
  })

  it('rebuilds orphaned sidecars through resumable one-file slices and lists the newest logical sessions without state.json entries', async () => {
    const olderDuplicate = createHistoryEntry({
      id: 'orphan-older',
      title: 'Older orphan archive',
      sessionId: 'orphan-shared-session',
      archivedAt: '2026-04-01T09:00:00.000Z',
      messages: [{
        id: 'orphan-older-message',
        role: 'user',
        content: 'Older body',
        createdAt: '2026-04-01T08:59:00.000Z',
      }],
    })
    const newerDuplicate = createHistoryEntry({
      id: 'orphan-newer',
      title: 'Newest orphan archive',
      sessionId: 'orphan-shared-session',
      archivedAt: '2026-05-01T09:00:00.000Z',
      messages: Array.from({ length: 12 }, (_, index) => ({
        id: `orphan-newer-message-${index}`,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `Newer body ${index}`,
        createdAt: `2026-05-01T08:${String(index).padStart(2, '0')}:00.000Z`,
      })),
    })
    const otherWorkspaceEntry = createHistoryEntry({
      id: 'orphan-other-workspace',
      title: 'Other workspace orphan',
      workspacePath: otherWorkspace,
      archivedAt: '2026-06-01T09:00:00.000Z',
    })
    await Promise.all([
      writeSidecar(olderDuplicate),
      writeSidecar(newerDuplicate),
      writeSidecar(otherWorkspaceEntry),
    ])

    let status = await runSessionHistoryCatalogMaintenanceSlice({
      dataDir,
      limits: { maxFilesPerSlice: 1 },
    })
    assert.equal(status.lastSliceProcessed, 1)
    assert.equal(status.phase, 'running')

    for (let index = 0; index < 5 && status.phase === 'running'; index += 1) {
      status = await runSessionHistoryCatalogMaintenanceSlice({
        dataDir,
        limits: { maxFilesPerSlice: 1 },
      })
    }

    assert.equal(status.phase, 'complete')
    assert.equal(status.processed, 3)
    const listed = await listInternalSessionHistory({
      dataDir,
      workspacePath: currentWorkspace,
      query: '',
    })
    assert.deepEqual(listed.entries.map((entry) => entry.id), ['orphan-newer'])
    assert.equal(listed.entries[0]?.messageCount, 12)
    assert.deepEqual(listed.entries[0]?.messages, [])
    assert.equal(listed.maintenance.phase, 'complete')
    assert.equal(
      (await readdir(sidecarDir)).some((name) => name.startsWith('catalog-segment-')),
      false,
      'derived catalog segments must stay outside session-history so older versions never parse them as transcripts',
    )
    assert.ok(
      (await readdir(path.join(dataDir, 'maintenance', 'session-history-catalog')))
        .some((name) => name.startsWith('catalog-segment-')),
    )

    const laterEntry = createHistoryEntry({
      id: 'orphan-later-entry',
      title: 'One later archive',
      archivedAt: '2026-07-01T09:00:00.000Z',
    })
    await writeSidecar(laterEntry)
    const incremental = await runSessionHistoryCatalogMaintenanceSlice({ dataDir })
    assert.equal(incremental.lastSliceProcessed, 1)
    assert.equal(incremental.total, 1, 'a new archive should not trigger a full rescan of known sidecars')
    const afterIncremental = await listInternalSessionHistory({
      dataDir,
      workspacePath: currentWorkspace,
      query: '',
    })
    assert.deepEqual(afterIncremental.entries.map((entry) => entry.id), [
      'orphan-later-entry',
      'orphan-newer',
    ])
  })

  it('skips malformed and oversized sidecars within hard limits instead of failing or parsing them', async () => {
    const validEntry = createHistoryEntry({
      id: 'safe-valid-entry',
      title: 'Safe valid archive',
      archivedAt: '2026-06-02T09:00:00.000Z',
    })
    await writeSidecar(validEntry)
    await writeFile(path.join(sidecarDir, 'malformed.json'), '{ definitely not json', 'utf8')
    await writeFile(path.join(sidecarDir, 'oversized.json'), 'x'.repeat(2048), 'utf8')

    const status = await runSessionHistoryCatalogMaintenanceSlice({
      dataDir,
      limits: {
        maxFilesPerSlice: 10,
        maxFileBytes: 1024,
        maxBytesPerSlice: 4096,
      },
    })

    assert.equal(status.phase, 'degraded')
    assert.equal(status.processed, 3)
    assert.equal(status.skipped, 2)
    const listed = await listInternalSessionHistory({
      dataDir,
      workspacePath: currentWorkspace,
      query: '',
    })
    assert.deepEqual(listed.entries.map((entry) => entry.id), ['safe-valid-entry'])
  })

  it('keeps maintenance degraded while a previously skipped sidecar still exists', async () => {
    const malformedPath = path.join(sidecarDir, 'still-malformed.json')
    await writeFile(malformedPath, '{ still invalid json', 'utf8')

    const initial = await runSessionHistoryCatalogMaintenanceSlice({ dataDir })
    assert.equal(initial.phase, 'degraded')
    assert.equal(initial.skipped, 1)

    await writeSidecar(createHistoryEntry({
      id: 'valid-after-malformed',
      title: 'Valid archive added later',
      archivedAt: '2026-06-02T10:00:00.000Z',
    }))
    const afterValidArchive = await runSessionHistoryCatalogMaintenanceSlice({ dataDir })

    assert.equal(afterValidArchive.phase, 'degraded')
    assert.equal(afterValidArchive.skipped, 1)

    await rm(malformedPath)
    const afterBadArchiveRemoval = await runSessionHistoryCatalogMaintenanceSlice({ dataDir })
    assert.equal(afterBadArchiveRemoval.phase, 'complete')
    assert.equal(afterBadArchiveRemoval.skipped, 0)
  })

  it('keeps the previous validated catalog when atomic replacement fails', async () => {
    const firstEntry = createHistoryEntry({
      id: 'catalog-stable-entry',
      title: 'Stable catalog entry',
      archivedAt: '2026-06-03T09:00:00.000Z',
    })
    await writeSidecar(firstEntry)
    await runSessionHistoryCatalogMaintenanceSlice({ dataDir })
    const catalogPath = path.join(sidecarDir, 'catalog.json')
    const before = await readFile(catalogPath, 'utf8')

    const secondEntry = createHistoryEntry({
      id: 'catalog-new-entry',
      title: 'New entry whose catalog write fails',
      archivedAt: '2026-06-04T09:00:00.000Z',
    })
    await writeSidecar(secondEntry)
    const failed = await runSessionHistoryCatalogMaintenanceSlice({
      dataDir,
      fileOps: {
        async rename() {
          throw new Error('injected catalog rename failure')
        },
      },
    })

    assert.equal(failed.phase, 'degraded')
    assert.match(failed.lastError ?? '', /injected catalog rename failure/)
    assert.equal(await readFile(catalogPath, 'utf8'), before)
    assert.ok((await stat(catalogPath)).size > 0)
    const listed = await listInternalSessionHistory({
      dataDir,
      workspacePath: currentWorkspace,
      query: '',
    })
    assert.deepEqual(listed.entries.map((entry) => entry.id), ['catalog-stable-entry'])
  })
})
