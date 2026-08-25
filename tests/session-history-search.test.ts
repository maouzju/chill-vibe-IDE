import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createDefaultState } from '../shared/default-state.ts'
import type { SessionHistoryEntry } from '../shared/schema.ts'
import { deleteSessionHistoryEntry } from '../server/state-store.ts'
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

  it('deletes one archived session sidecar and keeps it out of catalog search without touching its neighbours', async () => {
    const doomed = createHistoryEntry({
      id: 'doomed-entry',
      title: 'Archive the user deleted',
      sessionId: 'doomed-session',
      archivedAt: '2026-05-01T09:00:00.000Z',
      messages: [
        {
          id: 'doomed-message',
          role: 'user',
          content: 'Contains the delete-me-needle phrase.',
          createdAt: '2026-05-01T08:59:00.000Z',
        },
      ],
    })
    const survivor = createHistoryEntry({
      id: 'survivor-entry',
      title: 'Archive that must survive',
      sessionId: 'survivor-session',
      archivedAt: '2026-05-02T09:00:00.000Z',
      messages: [
        {
          id: 'survivor-message',
          role: 'assistant',
          content: 'Also contains the delete-me-needle phrase.',
          createdAt: '2026-05-02T08:59:00.000Z',
        },
      ],
    })
    await Promise.all([writeSidecar(doomed), writeSidecar(survivor)])

    const before = await searchInternalSessionHistory({
      workspacePath: currentWorkspace,
      query: 'delete-me-needle',
    })
    assert.deepEqual(
      before.entries.map((entry) => entry.id).sort(),
      ['doomed-entry', 'survivor-entry'],
    )

    await deleteSessionHistoryEntry({
      entryId: doomed.id,
      provider: doomed.provider,
      sessionId: doomed.sessionId,
    })

    const doomedPath = path.join(
      sidecarDir,
      `${Buffer.from(doomed.id, 'utf8').toString('base64url')}.json`,
    )
    const survivorPath = path.join(
      sidecarDir,
      `${Buffer.from(survivor.id, 'utf8').toString('base64url')}.json`,
    )
    assert.equal(
      await stat(doomedPath).then(() => true).catch(() => false),
      false,
      'deleting an archived session must reclaim its sidecar file, not only hide it',
    )
    assert.equal(
      await stat(survivorPath).then(() => true).catch(() => false),
      true,
      'deleting one archive must not touch the neighbouring sidecar',
    )

    // No cache reset here on purpose: deletion must invalidate the in-process
    // catalog cache itself, otherwise the same session keeps listing the entry
    // until the app restarts.
    const after = await searchInternalSessionHistory({
      workspacePath: currentWorkspace,
      query: 'delete-me-needle',
    })
    assert.deepEqual(after.entries.map((entry) => entry.id), ['survivor-entry'])

    const hiddenRaw = await readFile(path.join(sidecarDir, 'catalog-hidden.json'), 'utf8')
    assert.match(
      hiddenRaw,
      /doomed-entry/,
      'a deleted entry must stay on the hidden list so catalog rebuilds cannot resurrect it',
    )
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

  it('re-indexes a previously skipped sidecar once its content is repaired under the same file name', async () => {
    const brokenPath = path.join(sidecarDir, 'repairable.json')
    await writeFile(brokenPath, '{ broken on the first index', 'utf8')

    const initial = await runSessionHistoryCatalogMaintenanceSlice({ dataDir })
    assert.equal(initial.phase, 'degraded')
    assert.equal(initial.skipped, 1)

    const repaired = createHistoryEntry({
      id: 'repaired-sidecar-entry',
      title: 'Repaired archive',
      archivedAt: '2026-06-05T09:00:00.000Z',
    })
    await writeFile(brokenPath, `${JSON.stringify(repaired, null, 2)}\n`, 'utf8')
    resetSessionHistoryCatalogCacheForTests()

    const afterRepair = await runSessionHistoryCatalogMaintenanceSlice({ dataDir })

    assert.equal(afterRepair.phase, 'complete', 'a repaired sidecar must leave the degraded phase without deleting the file')
    assert.equal(afterRepair.skipped, 0)
    const listed = await listInternalSessionHistory({
      dataDir,
      workspacePath: currentWorkspace,
      query: '',
    })
    assert.deepEqual(listed.entries.map((entry) => entry.id), ['repaired-sidecar-entry'])
  })

  it('retries a repaired sidecar recorded by a legacy catalog manifest that has no skip stamps', async () => {
    const brokenPath = path.join(sidecarDir, 'legacy-broken.json')
    await writeFile(brokenPath, '{ legacy broken sidecar', 'utf8')
    await writeSidecar(createHistoryEntry({
      id: 'legacy-valid-entry',
      title: 'Valid archive indexed before the repair',
      archivedAt: '2026-06-06T09:00:00.000Z',
    }))

    const initial = await runSessionHistoryCatalogMaintenanceSlice({ dataDir })
    assert.equal(initial.phase, 'degraded')

    const catalogPath = path.join(sidecarDir, 'catalog.json')
    const legacyManifest = JSON.parse(await readFile(catalogPath, 'utf8')) as Record<string, unknown>
    delete legacyManifest.skippedFileStamps
    assert.deepEqual(
      legacyManifest.skippedFileNames,
      ['legacy-broken.json'],
      'legacy manifests must keep storing skipped sidecars as plain file names',
    )
    await writeFile(catalogPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, 'utf8')

    const repaired = createHistoryEntry({
      id: 'legacy-repaired-entry',
      title: 'Repaired legacy archive',
      archivedAt: '2026-06-07T09:00:00.000Z',
    })
    await writeFile(brokenPath, `${JSON.stringify(repaired, null, 2)}\n`, 'utf8')
    resetSessionHistoryCatalogCacheForTests()

    const afterRepair = await runSessionHistoryCatalogMaintenanceSlice({ dataDir })

    assert.equal(afterRepair.phase, 'complete')
    assert.equal(
      afterRepair.total,
      1,
      'a legacy manifest must stay readable so already indexed sidecars are not rescanned',
    )
    const listed = await listInternalSessionHistory({
      dataDir,
      workspacePath: currentWorkspace,
      query: '',
    })
    assert.deepEqual(
      listed.entries.map((entry) => entry.id).sort(),
      ['legacy-repaired-entry', 'legacy-valid-entry'],
    )
  })

  it('stops re-running the catalog slice when an oversized sidecar is rewritten, and re-indexes it once it shrinks', async () => {
    await writeSidecar(createHistoryEntry({
      id: 'oversize-neighbour-entry',
      title: 'Healthy neighbour archive',
      archivedAt: '2026-06-08T09:00:00.000Z',
    }))
    const oversizedPath = path.join(sidecarDir, 'oversized-rewritten.json')
    await writeFile(oversizedPath, 'x'.repeat(4096), 'utf8')
    const limits = { maxFilesPerSlice: 10, maxFileBytes: 1024, maxBytesPerSlice: 8192, maxElapsedMs: 60_000 }

    const initial = await runSessionHistoryCatalogMaintenanceSlice({ dataDir, limits })
    assert.equal(initial.phase, 'degraded')
    assert.equal(initial.skipped, 1)

    const catalogPath = path.join(sidecarDir, 'catalog.json')
    const catalogAfterInitial = await readFile(catalogPath, 'utf8')

    // state-store rewrites every existing sidecar on each save, so both mtimeMs and size move even
    // though the file is still far too large to index.
    await writeFile(oversizedPath, 'y'.repeat(5000), 'utf8')

    const afterRewrite = await runSessionHistoryCatalogMaintenanceSlice({ dataDir, limits })

    assert.equal(afterRewrite.phase, 'degraded')
    assert.equal(
      afterRewrite.lastSliceProcessed,
      0,
      'rewriting an oversized sidecar must not schedule another catalog slice',
    )
    assert.equal(
      await readFile(catalogPath, 'utf8'),
      catalogAfterInitial,
      'shouldRun must stay false for an oversized sidecar, so the manifest is never rewritten',
    )

    const shrunk = createHistoryEntry({
      id: 'oversize-shrunk-entry',
      title: 'Archive that finally fits the size budget',
      archivedAt: '2026-06-09T09:00:00.000Z',
    })
    await writeFile(oversizedPath, `${JSON.stringify(shrunk, null, 2)}\n`, 'utf8')
    resetSessionHistoryCatalogCacheForTests()

    const afterShrink = await runSessionHistoryCatalogMaintenanceSlice({ dataDir, limits })

    assert.equal(afterShrink.phase, 'complete')
    assert.equal(afterShrink.skipped, 0)
    const listed = await listInternalSessionHistory({
      dataDir,
      workspacePath: currentWorkspace,
      query: '',
    })
    assert.deepEqual(
      listed.entries.map((entry) => entry.id).sort(),
      ['oversize-neighbour-entry', 'oversize-shrunk-entry'],
    )
  })

  it('rotates the skipped-sidecar recheck window so a repaired file past the first 64 names is retried', async () => {
    const brokenNames = Array.from({ length: 70 }, (_, index) => `broken-${String(index).padStart(2, '0')}.json`)
    for (const name of brokenNames) {
      await writeFile(path.join(sidecarDir, name), `{ broken ${name}`, 'utf8')
    }
    const limits = { maxElapsedMs: 60_000 }

    let status = await runSessionHistoryCatalogMaintenanceSlice({ dataDir, limits })
    for (let index = 0; index < 4 && status.phase === 'running'; index += 1) {
      status = await runSessionHistoryCatalogMaintenanceSlice({ dataDir, limits })
    }
    assert.equal(status.phase, 'degraded')
    assert.equal(status.skipped, brokenNames.length)

    // The last name sorts past the 64-entry recheck window, so a fixed prefix window would never retry it.
    const lateName = brokenNames.at(-1) ?? ''
    const repaired = createHistoryEntry({
      id: 'late-repaired-entry',
      title: 'Repaired archive outside the first recheck window',
      archivedAt: '2026-06-10T09:00:00.000Z',
    })
    await writeFile(path.join(sidecarDir, lateName), `${JSON.stringify(repaired, null, 2)}\n`, 'utf8')

    let listedIds: string[] = []
    for (let index = 0; index < 6 && !listedIds.includes('late-repaired-entry'); index += 1) {
      await runSessionHistoryCatalogMaintenanceSlice({ dataDir, limits })
      resetSessionHistoryCatalogCacheForTests()
      listedIds = (await listInternalSessionHistory({
        dataDir,
        workspacePath: currentWorkspace,
        query: '',
      })).entries.map((entry) => entry.id)
    }

    assert.deepEqual(
      listedIds,
      ['late-repaired-entry'],
      'consecutive slices must rotate through the whole skip set instead of rechecking the same prefix',
    )
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
