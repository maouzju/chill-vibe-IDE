import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDefaultState } from '../shared/default-state.ts'

const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const originalReadFile = fs.promises.readFile
const originalReaddir = fs.promises.readdir
const observedSidecarReads: string[] = []
const observedSidecarDirectories: string[] = []

const isSessionHistoryPath = (value: unknown) =>
  typeof value === 'string' && value.split(/[\\/]/).includes('session-history')

const tempRoots: string[] = []
const sidecarFileName = (entryId: string) => `${Buffer.from(entryId, 'utf8').toString('base64url')}.json`

const makePreviewFixture = async (label: string) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `chill-vibe-lightweight-${label}-`))
  tempRoots.push(root)
  const workspacePath = path.join(root, 'workspace')
  const requestedId = `${label}-indexed-preview`
  const unrelatedId = `${label}-unrelated-archive`
  const archivedAt = '2026-08-06T01:00:00.000Z'
  const state = createDefaultState(workspacePath)
  state.settings.cliRoutingEnabled = false
  state.settings.resilientProxyEnabled = false
  state.sessionHistory = [{
    id: requestedId,
    title: 'Indexed preview fallback',
    sessionId: `${label}-session`,
    provider: 'codex',
    model: 'gpt-5.5',
    workspacePath,
    messageCount: 1,
    messagesPreview: true,
    messages: [],
    workspaceCloseId: `${label}-close-batch`,
    archivedAt,
  }]
  await writeFile(path.join(root, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')

  const sidecarDir = path.join(root, 'session-history')
  await mkdir(sidecarDir, { recursive: true })
  await writeFile(
    path.join(sidecarDir, sidecarFileName(unrelatedId)),
    `${JSON.stringify({
      id: unrelatedId,
      title: 'Unrelated full archive',
      sessionId: `${label}-unrelated-session`,
      provider: 'codex',
      model: 'gpt-5.5',
      workspacePath,
      messageCount: 1,
      messages: [{
        id: `${label}-unrelated-message`,
        role: 'user',
        content: 'This sidecar must not be hydrated by fallback paths.',
        createdAt: archivedAt,
      }],
      archivedAt,
    }, null, 2)}\n`,
    'utf8',
  )

  return { root, workspacePath, requestedId, unrelatedId, sidecarDir }
}

const setDataDir = (dataDir: string) => {
  process.env.CHILL_VIBE_DATA_DIR = dataDir
  delete process.env.CHILL_VIBE_RUNTIME_KIND
}

after(async () => {
  delete process.env.CHILL_VIBE_DATA_DIR
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

test('runtime and compatibility fallbacks only touch the bounded history index', async () => {
  const { loadState, loadStateForRenderer, loadSessionHistoryEntry, loadClosedWorkspaceSnapshot } =
    await import('../server/state-store.ts')
  const { readCodexManagementPolicy, resolveProviderRuntime } = await import('../server/providers.ts')

  fs.promises.readFile = (async (...args: Parameters<typeof fs.promises.readFile>) => {
    if (isSessionHistoryPath(args[0])) {
      observedSidecarReads.push(path.resolve(String(args[0])))
    }
    return originalReadFile(...args)
  }) as typeof fs.promises.readFile
  fs.promises.readdir = (async (...args: Parameters<typeof fs.promises.readdir>) => {
    if (isSessionHistoryPath(args[0])) {
      observedSidecarDirectories.push(path.resolve(String(args[0])))
    }
    return originalReaddir(...args)
  }) as typeof fs.promises.readdir
  syncBuiltinESMExports()

  try {
    const rendererFixture = await makePreviewFixture('renderer')
    setDataDir(rendererFixture.root)
    observedSidecarReads.length = 0
    observedSidecarDirectories.length = 0
    await loadStateForRenderer()
    assert.equal(observedSidecarReads.length, 0)
    assert.equal(observedSidecarDirectories.length, 0)

    const providerFixture = await makePreviewFixture('provider')
    setDataDir(providerFixture.root)
    observedSidecarReads.length = 0
    observedSidecarDirectories.length = 0
    const runtime = await resolveProviderRuntime('codex')
    assert.deepEqual(runtime.args, [])
    await readCodexManagementPolicy()
    assert.equal(observedSidecarReads.length, 0)
    assert.equal(observedSidecarDirectories.length, 0)

    const restoreFixture = await makePreviewFixture('restore')
    setDataDir(restoreFixture.root)
    observedSidecarReads.length = 0
    observedSidecarDirectories.length = 0
    const restored = await loadSessionHistoryEntry({ entryId: restoreFixture.requestedId })
    assert.equal(restored.entry.id, restoreFixture.requestedId)
    assert.equal(observedSidecarDirectories.length, 0)
    assert.deepEqual(
      observedSidecarReads.map((filePath) => path.basename(filePath)).sort(),
      [
        sidecarFileName(restoreFixture.requestedId),
        `${restoreFixture.requestedId}.json`,
      ].sort(),
    )
    assert.equal(
      observedSidecarReads.some((filePath) => filePath.endsWith(sidecarFileName(restoreFixture.unrelatedId))),
      false,
    )

    const closedFixture = await makePreviewFixture('closed')
    setDataDir(closedFixture.root)
    observedSidecarReads.length = 0
    observedSidecarDirectories.length = 0
    const closed = await loadClosedWorkspaceSnapshot({ workspacePath: closedFixture.workspacePath })
    assert.equal(closed.snapshot, null)
    assert.deepEqual(closed.legacyEntryIds, [closedFixture.requestedId])
    assert.equal(observedSidecarReads.length, 0)
    assert.equal(observedSidecarDirectories.length, 0)

    // Control: the old full loader is intentionally expected to enumerate and
    // read the unrelated archive, proving the spy catches the regression shape.
    const fullFixture = await makePreviewFixture('full-loader-control')
    setDataDir(fullFixture.root)
    observedSidecarReads.length = 0
    observedSidecarDirectories.length = 0
    await loadState()
    assert.ok(observedSidecarDirectories.includes(fullFixture.sidecarDir))
    assert.ok(
      observedSidecarReads.some((filePath) => filePath.endsWith(sidecarFileName(fullFixture.unrelatedId))),
    )
  } finally {
    fs.promises.readFile = originalReadFile as typeof fs.promises.readFile
    fs.promises.readdir = originalReaddir as typeof fs.promises.readdir
    syncBuiltinESMExports()
    delete process.env.CHILL_VIBE_DATA_DIR
  }
})
