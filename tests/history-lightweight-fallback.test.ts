import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDefaultState } from '../shared/default-state.ts'
import type { ChatRequest } from '../shared/schema.ts'

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

// 2026-11-20 审查：模型自动发现（每次启动几秒后）和 JEV（每轮对话）只要 settings，却走全量
// loadState()：整目录 sidecar 并发读进主进程，缓存变成 full 后下一次保存又把每个 sidecar 重写一遍。
test('settings-only callers never hydrate sidecars and the next save leaves existing sidecars alone', async () => {
  const { loadStateForRenderer, loadSessionHistoryEntry, saveState } = await import('../server/state-store.ts')
  const { createJevRuntime } = await import('../server/jev-runtime.ts')

  const fixture = await makePreviewFixture('settings-only')
  const statePath = path.join(fixture.root, 'state.json')
  const persisted = JSON.parse(await originalReadFile(statePath, 'utf8')) as {
    settings: Record<string, unknown>
  }
  persisted.settings.jevApiKey = 'jev-key-from-settings'
  await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8')

  // The indexed preview entry owns a complete transcript on disk, like every
  // archived session in a real profile.
  const indexedSidecarPath = path.join(fixture.sidecarDir, sidecarFileName(fixture.requestedId))
  const indexedSidecarContent = `${JSON.stringify({
    id: fixture.requestedId,
    title: 'Indexed preview fallback',
    sessionId: 'settings-only-session',
    provider: 'codex',
    model: 'gpt-5.5',
    workspacePath: fixture.workspacePath,
    messageCount: 1,
    messages: [{
      id: 'settings-only-indexed-message',
      role: 'user',
      content: 'Full transcript that must stay on disk untouched.',
      createdAt: '2026-08-06T01:00:00.000Z',
    }],
    archivedAt: '2026-08-06T01:00:00.000Z',
  }, null, 2)}\n`
  await writeFile(indexedSidecarPath, indexedSidecarContent, 'utf8')

  const originalWriteFile = fs.promises.writeFile
  const originalRename = fs.promises.rename
  // readdir is deliberately not spied here: the settings loader also kicks off
  // the orphaned .tmp cleanup, which lists file names (never contents).
  const sidecarReads: string[] = []
  const sidecarWrites: string[] = []

  fs.promises.readFile = (async (...args: Parameters<typeof fs.promises.readFile>) => {
    if (isSessionHistoryPath(args[0])) {
      sidecarReads.push(path.basename(String(args[0])))
    }
    return originalReadFile(...args)
  }) as typeof fs.promises.readFile
  fs.promises.writeFile = (async (...args: Parameters<typeof fs.promises.writeFile>) => {
    if (isSessionHistoryPath(args[0])) {
      sidecarWrites.push(path.basename(String(args[0])))
    }
    return originalWriteFile(...args)
  }) as typeof fs.promises.writeFile
  fs.promises.rename = (async (...args: Parameters<typeof fs.promises.rename>) => {
    if (isSessionHistoryPath(args[1])) {
      sidecarWrites.push(path.basename(String(args[1])))
    }
    return originalRename(...args)
  }) as typeof fs.promises.rename
  syncBuiltinESMExports()

  try {
    setDataDir(fixture.root)

    const keyFilePath = path.join(fixture.root, 'jev', 'api-key')
    const runtime = await createJevRuntime(
      {
        provider: 'claude',
        workspacePath: fixture.workspacePath,
        language: 'zh-CN',
        jevEnabled: true,
      } as ChatRequest,
      { keyFilePath },
    )
    assert.ok(runtime, 'the JEV key must still be read from persisted settings')
    assert.equal(await originalReadFile(keyFilePath, 'utf8'), 'jev-key-from-settings')
    const readsAfterSettingsLoad = [...sidecarReads]

    // The renderer's next routine save carries preview history only.
    const { state } = await loadStateForRenderer()
    await saveState(state)

    assert.deepEqual(
      {
        sidecarReads: readsAfterSettingsLoad,
        sidecarWritesOnNextSave: sidecarWrites,
      },
      { sidecarReads: [], sidecarWritesOnNextSave: [] },
      'reading settings must not hydrate session-history sidecars, and the following save must not rewrite them',
    )
    assert.equal(await originalReadFile(indexedSidecarPath, 'utf8'), indexedSidecarContent)

    // Pitfall 53: the preview save must not cost the archived transcript.
    const restored = await loadSessionHistoryEntry({ entryId: fixture.requestedId })
    assert.equal(restored.entry.messages[0]?.content, 'Full transcript that must stay on disk untouched.')
  } finally {
    fs.promises.readFile = originalReadFile as typeof fs.promises.readFile
    fs.promises.writeFile = originalWriteFile as typeof fs.promises.writeFile
    fs.promises.rename = originalRename as typeof fs.promises.rename
    syncBuiltinESMExports()
    delete process.env.CHILL_VIBE_DATA_DIR
  }
})

test('no production module reaches for the full loadState() loader', async () => {
  const offenders: string[] = []
  for (const dirName of ['server', 'electron']) {
    const dirPath = path.join(process.cwd(), dirName)
    const fileNames = await originalReaddir(dirPath, { recursive: true })
    for (const fileName of fileNames) {
      if (!fileName.endsWith('.ts') || path.basename(fileName) === 'state-store.ts') {
        continue
      }
      const source = await originalReadFile(path.join(dirPath, fileName), 'utf8')
      if (/\bawait loadState\(\)/.test(source)) {
        offenders.push(`${dirName}/${fileName.replace(/\\/g, '/')}`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'loadState() hydrates every session-history sidecar (pitfall 253); settings-only callers must use loadPersistedSettings()',
  )
})
