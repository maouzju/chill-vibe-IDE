import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { attachImagesToMessageMeta } from '../shared/chat-attachments.ts'
import { createCard, createDefaultState, createPane, getFirstPane } from '../shared/default-state.ts'
import { BRAINSTORM_TOOL_MODEL, DEFAULT_CODEX_MODEL, PM_TOOL_MODEL } from '../shared/models.ts'

// We test the module-level functions by setting the env var before importing.
// Each test gets a fresh temp directory.

describe('state-store persistence', () => {
  let tmpDir: string

  const getFirstCard = (state: ReturnType<typeof createDefaultState>, columnIndex = 0) => {
    const column = state.columns[columnIndex]
    const firstTabId = column ? getFirstPane(column.layout).tabs[0] : ''
    return firstTabId ? column?.cards[firstTabId] : undefined
  }

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `chill-vibe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    process.env.CHILL_VIBE_DATA_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('saveState produces a valid JSON file', async () => {
    const { saveState, loadState } = await import('../server/state-store.ts')
    const state = createDefaultState('')
    await saveState(state)

    const loaded = await loadState()
    assert.equal(loaded.version, 1)
    assert.ok(loaded.columns.length > 0)
  })

  it('loadState returns defaults when file is missing', async () => {
    const { loadState } = await import('../server/state-store.ts')
    const loaded = await loadState()
    assert.equal(loaded.version, 1)
    assert.ok(loaded.columns.length > 0)
  })

  it('loadState recovers from corrupted JSON', async () => {
    const stateFile = path.join(tmpDir, 'state.json')
    await writeFile(stateFile, '{ broken json!!!', 'utf8')

    const { loadState } = await import('../server/state-store.ts')
    const loaded = await loadState()
    assert.equal(loaded.version, 1, 'should fall back to defaults')
  })

  it('loadState reuses the in-process snapshot after a successful load when the file later becomes unreadable', async () => {
    const { saveState, loadState } = await import('../server/state-store.ts')
    const state = createDefaultState('')
    state.columns[0].title = 'Cached workspace'

    await saveState(state)

    const initial = await loadState()
    assert.equal(initial.columns[0].title, 'Cached workspace')

    await writeFile(path.join(tmpDir, 'state.json'), '{ broken after cache warmup', 'utf8')

    const loaded = await loadState()
    assert.equal(
      loaded.columns[0].title,
      'Cached workspace',
      'hot-path reads should prefer the last good in-process snapshot over a transient unreadable file',
    )
  })

  it('loadState refreshes from disk when the on-disk state changes after cache warmup', async () => {
    const { saveState, loadState } = await import('../server/state-store.ts')
    const initial = createDefaultState('')
    initial.columns[0].title = 'Before external edit'
    await saveState(initial)

    const warmed = await loadState()
    assert.equal(warmed.columns[0].title, 'Before external edit')

    const nextState = createDefaultState('')
    nextState.columns[0].title = 'After external edit'
    await writeFile(path.join(tmpDir, 'state.json'), JSON.stringify(nextState, null, 2), 'utf8')

    const loaded = await loadState()
    assert.equal(loaded.columns[0].title, 'After external edit')
  })

  it('resets board columns when it encounters legacy array-backed cards', async () => {
    const stateFile = path.join(tmpDir, 'state.json')
    const baseState = createDefaultState('D:/legacy')
    const legacyState = structuredClone(baseState) as Record<string, unknown>
    const legacySettings = legacyState.settings as Record<string, unknown>
    const legacyColumns = legacyState.columns as Array<Record<string, unknown>>

    legacySettings.language = 'en'
    legacySettings.theme = 'light'
    legacyColumns[0] = {
      ...legacyColumns[0],
      title: 'Legacy workspace',
      cards: Object.values(baseState.columns[0].cards),
    }
    delete legacyColumns[0].layout

    await writeFile(stateFile, JSON.stringify(legacyState, null, 2), 'utf8')

    const { loadState } = await import('../server/state-store.ts')
    const loaded = await loadState()
    const firstColumn = loaded.columns[0]
    const firstPane = getFirstPane(firstColumn.layout)

    assert.equal(loaded.settings.theme, 'light', 'non-board settings should still survive the reset')
    assert.notEqual(firstColumn.title, 'Legacy workspace', 'legacy board content should be reset instead of half-migrated')
    assert.ok(firstPane.tabs.length > 0, 'reset board should still provide a usable starter tab')
    assert.ok(
      firstPane.tabs.every((tabId) => firstColumn.cards[tabId]?.id === tabId),
      'restored pane tabs should map directly to persisted card ids',
    )
  })

  it('loadState strips archived brainstorm cards from persisted panes', async () => {
    const stateFile = path.join(tmpDir, 'state.json')
    const state = createDefaultState('D:/brainstorm-archive')
    const firstColumn = state.columns[0]
    const firstPane = getFirstPane(firstColumn.layout)
    const brainstormCard = createCard('Brainstorm', 440, 'codex', BRAINSTORM_TOOL_MODEL, undefined, 'en')

    firstColumn.cards[brainstormCard.id] = brainstormCard
    firstColumn.layout = {
      ...firstPane,
      tabs: [...firstPane.tabs, brainstormCard.id],
      activeTabId: brainstormCard.id,
    }

    await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8')

    const { loadState } = await import('../server/state-store.ts')
    const loaded = await loadState()
    const restoredFirstColumn = loaded.columns[0]
    const restoredFirstPane = getFirstPane(restoredFirstColumn.layout)

    assert.ok(
      Object.values(restoredFirstColumn.cards).every((card) => card.model !== BRAINSTORM_TOOL_MODEL),
      'archived brainstorm cards should not be restored into the live board',
    )
    assert.equal(
      restoredFirstPane.tabs.includes(brainstormCard.id),
      false,
      'archived brainstorm tabs should be removed from the restored layout',
    )
  })

  it('loadState demotes legacy Dream cards into normal Codex chats', async () => {
    const stateFile = path.join(tmpDir, 'state.json')
    const state = createDefaultState('D:/legacy-dream')
    const firstColumn = state.columns[0]
    const firstPane = getFirstPane(firstColumn.layout)
    const legacyDreamCardId = firstPane.tabs[0]!
    const persistedState = structuredClone(state) as Record<string, unknown>
    const persistedColumns = persistedState.columns as Array<Record<string, unknown>>
    const persistedCards = persistedColumns[0]?.cards as Record<string, Record<string, unknown>>
    const persistedLegacyDreamCard = persistedCards[legacyDreamCardId]

    assert.ok(persistedLegacyDreamCard, 'expected the starter card to exist before injecting legacy Dream data')

    persistedLegacyDreamCard.title = 'Dream'
    persistedLegacyDreamCard.model = '__dream_tool__'
    persistedLegacyDreamCard.dream = {
      prompt: 'Reflect on the repo while idle.',
      enabled: true,
      idleMinutes: 12,
      lastDreamAt: '2026-04-11T09:40:00.000Z',
      entries: [],
    }

    await writeFile(stateFile, JSON.stringify(persistedState, null, 2), 'utf8')

    const { loadState } = await import('../server/state-store.ts')
    const loaded = await loadState()
    const restoredCard = loaded.columns[0]?.cards[legacyDreamCardId]

    assert.equal(restoredCard?.model, DEFAULT_CODEX_MODEL)
    assert.equal((restoredCard as { dream?: unknown } | undefined)?.dream, undefined)
  })

  it('loadState migrates untouched empty chats to the configured provider model', async () => {
    const stateFile = path.join(tmpDir, 'state.json')
    const state = createDefaultState('D:/remembered-model')
    state.settings.requestModels.claude = 'claude-sonnet-4-6'

    const reviewColumn = state.columns[1]
    const reviewPane = getFirstPane(reviewColumn.layout)
    const untouchedCardId = reviewPane.tabs[1]!
    const pinnedCardId = reviewPane.tabs[0]!

    reviewColumn.cards[pinnedCardId]!.title = 'Pinned Opus Chat'
    reviewColumn.cards[pinnedCardId]!.messages = [
      {
        id: 'msg-keep-opus',
        role: 'assistant',
        content: 'Keep using Opus for this thread.',
        createdAt: new Date().toISOString(),
      },
    ]

    reviewColumn.cards[untouchedCardId]!.title = ''
    reviewColumn.cards[untouchedCardId]!.messages = []

    await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8')

    const { loadState } = await import('../server/state-store.ts')
    const loaded = await loadState()
    const loadedReviewColumn = loaded.columns[1]

    assert.equal(loadedReviewColumn.model, 'claude-sonnet-4-6')
    assert.equal(loadedReviewColumn.cards[untouchedCardId]?.model, 'claude-sonnet-4-6')
    assert.equal(loadedReviewColumn.cards[pinnedCardId]?.model, 'claude-opus-4-6')
  })

  it('loadState prefers lastModel over provider defaults for untouched starter chats on startup', async () => {
    const stateFile = path.join(tmpDir, 'state.json')
    const state = createDefaultState('D:/remembered-last-model')
    state.settings.requestModels.claude = 'claude-opus-4-6'
    state.settings.lastModel = { provider: 'claude', model: 'claude-sonnet-4-6' }

    const reviewColumn = state.columns[1]
    const reviewPane = getFirstPane(reviewColumn.layout)
    const untouchedCardId = reviewPane.tabs[1]!
    const pinnedCardId = reviewPane.tabs[0]!

    reviewColumn.cards[pinnedCardId]!.title = 'Keep using Opus here'
    reviewColumn.cards[pinnedCardId]!.messages = [
      {
        id: 'msg-keep-opus',
        role: 'assistant',
        content: 'This thread should keep its existing model.',
        createdAt: new Date().toISOString(),
      },
    ]
    reviewColumn.cards[pinnedCardId]!.model = 'claude-opus-4-6'
    reviewColumn.cards[untouchedCardId]!.title = ''
    reviewColumn.cards[untouchedCardId]!.messages = []
    reviewColumn.cards[untouchedCardId]!.model = 'claude-opus-4-6'
    reviewColumn.model = 'claude-opus-4-6'

    await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8')

    const { loadState } = await import('../server/state-store.ts')
    const loaded = await loadState()
    const loadedReviewColumn = loaded.columns[1]

    assert.equal(loadedReviewColumn.model, 'claude-sonnet-4-6')
    assert.equal(loadedReviewColumn.cards[untouchedCardId]?.model, 'claude-sonnet-4-6')
    assert.equal(loadedReviewColumn.cards[pinnedCardId]?.model, 'claude-opus-4-6')
  })

  it('loadState drops persisted session ids for idle chats with historical image attachments', async () => {
    const stateFile = path.join(tmpDir, 'state.json')
    const state = createDefaultState('D:/image-session-replay')
    const firstCard = getFirstCard(state)
    assert.ok(firstCard, 'expected a default card to exist in the first column')

    firstCard.sessionId = 'resume-image-session'
    firstCard.providerSessions = {
      codex: 'resume-image-session',
      claude: 'resume-image-session-claude',
    }
    firstCard.messages = [
      {
        id: 'msg-user-image',
        role: 'user',
        content: 'Compare this attached sketch with the current UI.',
        createdAt: new Date('2026-04-11T07:00:00.000Z').toISOString(),
        meta: attachImagesToMessageMeta([
          {
            id: 'image-1',
            fileName: 'sketch.png',
            mimeType: 'image/png',
            sizeBytes: 1024,
          },
        ]),
      },
      {
        id: 'msg-assistant-image',
        role: 'assistant',
        content: 'The attached sketch has a tighter header.',
        createdAt: new Date('2026-04-11T07:00:01.000Z').toISOString(),
      },
    ]

    await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8')

    const { loadState } = await import('../server/state-store.ts')
    const loaded = await loadState()
    const loadedFirstCard = getFirstCard(loaded)

    assert.equal(
      loadedFirstCard?.sessionId,
      undefined,
      'image-bearing chats should replay into a fresh CLI session after app restart',
    )
    assert.deepEqual(
      loadedFirstCard?.providerSessions,
      {},
      'provider-specific resume sessions should also be discarded for image-bearing chats',
    )
    assert.equal(
      loadedFirstCard?.messages[0]?.meta?.imageAttachments,
      firstCard.messages[0]?.meta?.imageAttachments,
      'replayed chats should keep their persisted image attachment metadata',
    )
  })

  it('loadState keeps recoverable streaming session ids even when the chat includes image attachments', async () => {
    const stateFile = path.join(tmpDir, 'state.json')
    const state = createDefaultState('D:/image-session-stream')
    const firstCard = getFirstCard(state)
    assert.ok(firstCard, 'expected a default card to exist in the first column')

    firstCard.status = 'streaming'
    firstCard.streamId = 'stream-image-session'
    firstCard.sessionId = 'resume-image-session'
    firstCard.messages = [
      {
        id: 'msg-user-image',
        role: 'user',
        content: 'Inspect this attached sketch while the reply streams.',
        createdAt: new Date('2026-04-11T07:10:00.000Z').toISOString(),
        meta: attachImagesToMessageMeta([
          {
            id: 'image-2',
            fileName: 'wireframe.png',
            mimeType: 'image/png',
            sizeBytes: 2048,
          },
        ]),
      },
    ]

    await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8')

    const { loadState } = await import('../server/state-store.ts')
    const loaded = await loadState()
    const loadedFirstCard = getFirstCard(loaded)

    assert.equal(
      loadedFirstCard?.sessionId,
      'resume-image-session',
      'recoverable in-flight streams should keep their session id for interrupted-session recovery',
    )
    assert.equal(loadedFirstCard?.streamId, 'stream-image-session')
    assert.equal(loadedFirstCard?.status, 'streaming')
  })

  it('loadState demotes persisted PM cards into normal chats and clears PM ownership links', async () => {
    const stateFile = path.join(tmpDir, 'state.json')
    const state = createDefaultState('D:/pm-removal')
    const firstColumn = state.columns[0]
    const firstPane = getFirstPane(firstColumn.layout)
    const originalChatId = firstPane.tabs[0]!
    const pmCard = createCard('PM', 560, 'codex', PM_TOOL_MODEL, undefined, 'en')
    const taskCard = createCard('Task', 560, 'codex', 'gpt-5.4', undefined, 'en')

    pmCard.id = 'pm-card'
    pmCard.pmTaskCardId = 'task-card'
    pmCard.messages = [
      {
        id: 'pm-user-1',
        role: 'user',
        content: 'Track this task for me.',
        createdAt: new Date('2026-04-11T08:00:00.000Z').toISOString(),
      },
    ]
    taskCard.id = 'task-card'
    taskCard.pmOwnerCardId = 'pm-card'

    firstColumn.cards[pmCard.id] = pmCard
    firstColumn.cards[taskCard.id] = taskCard
    firstColumn.layout = createPane([originalChatId, pmCard.id, taskCard.id], pmCard.id, firstPane.id)

    await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8')

    const { loadState } = await import('../server/state-store.ts')
    const loaded = await loadState()
    const loadedFirstColumn = loaded.columns[0]
    const loadedPmCard = loadedFirstColumn.cards['pm-card']
    const loadedTaskCard = loadedFirstColumn.cards['task-card']

    assert.ok(loadedPmCard, 'expected the persisted PM card to stay visible as a normal chat')
    assert.equal(loadedPmCard?.model, 'gpt-5.4')
    assert.equal(loadedPmCard?.pmTaskCardId, '')
    assert.equal(loadedTaskCard?.pmOwnerCardId, '')
  })

  it('loadState compacts oversized persisted command output metadata for release safety', async () => {
    const stateFile = path.join(tmpDir, 'state.json')
    const state = createDefaultState('D:/release-white-screen')
    const firstCard = getFirstCard(state)
    assert.ok(firstCard, 'expected a default card to exist in the first column')

    const hugeOutput = `${'A'.repeat(120_000)}${'Z'.repeat(120_000)}`
    firstCard.messages = [
      {
        id: 'assistant-command',
        role: 'assistant',
        content: '',
        createdAt: new Date('2026-04-11T05:00:00.000Z').toISOString(),
        meta: {
          provider: 'codex',
          kind: 'command',
          itemId: 'item-command',
          structuredData: JSON.stringify({
            type: 'activity',
            itemId: 'item-command',
            kind: 'command',
            status: 'completed',
            command: 'pnpm test',
            output: hugeOutput,
            exitCode: 0,
          }),
        },
      },
    ]

    const originalContent = JSON.stringify(state, null, 2)
    await writeFile(stateFile, originalContent, 'utf8')

    const { loadState } = await import('../server/state-store.ts')
    const loaded = await loadState()
    const loadedFirstCard = getFirstCard(loaded)
    assert.ok(loadedFirstCard, 'expected the saved card to load back')

    const structuredData = loadedFirstCard.messages[0]?.meta?.structuredData
    assert.ok(structuredData, 'expected structured command metadata to survive load')

    const payload = JSON.parse(structuredData) as {
      command: string
      exitCode: number | null
      output: string
      status: string
    }

    assert.equal(payload.command, 'pnpm test')
    assert.equal(payload.exitCode, 0)
    assert.equal(payload.status, 'completed')
    assert.match(payload.output, /Output truncated in saved state/i)
    assert.ok(payload.output.startsWith('AAAA'), 'the compacted output should preserve the head')
    assert.ok(payload.output.endsWith('ZZZZ'), 'the compacted output should preserve the tail')
    assert.ok(payload.output.length < hugeOutput.length, 'the compacted output should be smaller than the original')

    const compactedContent = await readFile(stateFile, 'utf8')
    assert.ok(
      Buffer.byteLength(compactedContent, 'utf8') < Buffer.byteLength(originalContent, 'utf8'),
      'loading should rewrite the persisted state with compacted command output metadata',
    )
  })

  it('loadState compacts oversized session history command output metadata for release safety', async () => {
    const stateFile = path.join(tmpDir, 'state.json')
    const state = createDefaultState('D:/release-white-screen')
    const hugeOutput = `${'A'.repeat(120_000)}${'Z'.repeat(120_000)}`

    state.sessionHistory = [
      {
        id: 'history-command',
        title: 'Archived release debug session',
        sessionId: 'session-command',
        provider: 'codex',
        model: 'gpt-5.4',
        workspacePath: 'D:/release-white-screen',
        archivedAt: new Date('2026-04-11T05:10:00.000Z').toISOString(),
        messages: [
          {
            id: 'assistant-command',
            role: 'assistant',
            content: '',
            createdAt: new Date('2026-04-11T05:09:00.000Z').toISOString(),
            meta: {
              provider: 'codex',
              kind: 'command',
              itemId: 'item-command',
              structuredData: JSON.stringify({
                type: 'activity',
                itemId: 'item-command',
                kind: 'command',
                status: 'completed',
                command: 'pnpm test',
                output: hugeOutput,
                exitCode: 0,
              }),
            },
          },
        ],
      },
    ]

    const originalContent = JSON.stringify(state, null, 2)
    await writeFile(stateFile, originalContent, 'utf8')

    const { loadState } = await import('../server/state-store.ts')
    const loaded = await loadState()
    const structuredData = loaded.sessionHistory[0]?.messages[0]?.meta?.structuredData
    assert.ok(structuredData, 'expected structured command metadata to survive session history load')

    const payload = JSON.parse(structuredData) as {
      command: string
      exitCode: number | null
      output: string
      status: string
    }

    assert.equal(payload.command, 'pnpm test')
    assert.equal(payload.exitCode, 0)
    assert.equal(payload.status, 'completed')
    assert.match(payload.output, /Output truncated in saved state/i)
    assert.ok(payload.output.startsWith('AAAA'), 'the compacted output should preserve the head')
    assert.ok(payload.output.endsWith('ZZZZ'), 'the compacted output should preserve the tail')
    assert.ok(payload.output.length < hugeOutput.length, 'the compacted output should be smaller than the original')

    const compactedContent = await readFile(stateFile, 'utf8')
    assert.ok(
      Buffer.byteLength(compactedContent, 'utf8') < Buffer.byteLength(originalContent, 'utf8'),
      'loading should rewrite the persisted state with compacted session history command metadata',
    )
  })

  it('saveState re-compacts legacy 32KB command output chunks to the current release-safe budget', async () => {
    const stateFile = path.join(tmpDir, 'state.json')
    const { saveState, loadState } = await import('../server/state-store.ts')
    const state = createDefaultState('D:/release-white-screen')
    const firstCard = getFirstCard(state)
    assert.ok(firstCard, 'expected a default card to exist in the first column')

    const legacyCompactedOutput = [
      'A'.repeat(24 * 1024),
      '',
      '[Output truncated in saved state. 180224 characters omitted.]',
      '',
      'Z'.repeat(8 * 1024),
    ].join('\n')
    const buildMessage = (id: string, createdAt: string) => ({
      id,
      role: 'assistant' as const,
      content: '',
      createdAt,
      meta: {
        provider: 'codex',
        kind: 'command',
        itemId: `item-${id}`,
        structuredData: JSON.stringify({
          type: 'activity',
          itemId: `item-${id}`,
          kind: 'command',
          status: 'completed',
          command: 'rg -n release-safety',
          output: legacyCompactedOutput,
          exitCode: 0,
        }),
      },
    })

    firstCard.messages = Array.from({ length: 18 }, (_, index) =>
      buildMessage(`live-${index}`, new Date(`2026-04-11T05:${String(index).padStart(2, '0')}:00.000Z`).toISOString()),
    )
    state.sessionHistory = [
      {
        id: 'history-command',
        title: 'Archived release debug session',
        sessionId: 'session-command',
        provider: 'codex',
        model: 'gpt-5.4',
        workspacePath: 'D:/release-white-screen',
        archivedAt: new Date('2026-04-11T06:00:00.000Z').toISOString(),
        messages: Array.from({ length: 18 }, (_, index) =>
          buildMessage(
            `history-${index}`,
            new Date(`2026-04-11T06:${String(index).padStart(2, '0')}:00.000Z`).toISOString(),
          ),
        ),
      },
    ]

    const originalContent = `${JSON.stringify(state, null, 2)}\n`
    assert.ok(
      Buffer.byteLength(originalContent, 'utf8') > 1_000_000,
      'the fixture should be large enough to catch release-safety regressions',
    )

    await saveState(state)

    const persisted = await readFile(stateFile, 'utf8')
    assert.ok(
      Buffer.byteLength(persisted, 'utf8') < Buffer.byteLength(originalContent, 'utf8') / 3,
      'saving should aggressively shrink legacy medium-size command payloads before they bloat release state',
    )

    const loaded = await loadState()
    const loadedFirstCard = getFirstCard(loaded)
    assert.ok(loadedFirstCard, 'expected the saved card to load back')

    const liveOutput = JSON.parse(loadedFirstCard.messages[0]?.meta?.structuredData ?? '{}').output as string
    const historyOutput = JSON.parse(loaded.sessionHistory[0]?.messages[0]?.meta?.structuredData ?? '{}').output as string

    for (const output of [liveOutput, historyOutput]) {
      assert.match(output, /Output truncated in saved state/i)
      assert.ok(output.startsWith('AAAA'), 'the compacted output should preserve the head')
      assert.ok(output.endsWith('ZZZZ'), 'the compacted output should preserve the tail')
      assert.ok(
        output.length < legacyCompactedOutput.length / 4,
        'legacy medium-size command payloads should be re-compacted to the current budget',
      )
    }
  })

  it('saveState creates backup when overwriting real content with empty state', async () => {
    const { saveState } = await import('../server/state-store.ts')

    // Write a state file with lots of messages so it's significantly larger than empty
    const realState = createDefaultState('')
    const messages = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message content number ${i} with enough text to make the file large`,
      createdAt: new Date().toISOString(),
    }))
    const firstCard = getFirstCard(realState)
    assert.ok(firstCard, 'expected a default card to exist in the first column')
    firstCard.messages = messages
    const realContent = JSON.stringify(realState, null, 2)
    await writeFile(path.join(tmpDir, 'state.json'), realContent, 'utf8')

    // Now save an empty state (no messages) through saveState
    const emptyState = createDefaultState('')
    await saveState(emptyState)

    // Check that a backup was created
    const files = await readdir(tmpDir)
    const backups = files.filter(f => f.startsWith('state.backup-'))
    assert.ok(backups.length > 0, 'a backup file should be created when overwriting real content')
  })

  it('saveState keeps recent successful snapshots and prunes older ones', async () => {
    const { saveState } = await import('../server/state-store.ts')

    for (let index = 0; index < 12; index += 1) {
      const state = createDefaultState('')
      state.columns[0].title = `Snapshot-${index}`
      await saveState(state)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }

    const files = await readdir(tmpDir)
    const snapshots = files
      .filter((fileName) => fileName.startsWith('state.snapshot-') && fileName.endsWith('.json'))
      .sort()

    assert.ok(snapshots.length > 0, 'successful saves should leave routine snapshots behind')
    assert.ok(snapshots.length <= 8, 'older routine snapshots should be pruned automatically')

    const latestSnapshot = snapshots.at(-1)
    assert.ok(latestSnapshot, 'expected the newest snapshot file to exist')
    const latestSnapshotContent = await readFile(path.join(tmpDir, latestSnapshot!), 'utf8')

    assert.match(latestSnapshotContent, /Snapshot-11/, 'the newest snapshot should track the latest successful save')
  })

  it('atomic write does not leave partial files on disk', async () => {
    const { saveState } = await import('../server/state-store.ts')
    const state = createDefaultState('')
    await saveState(state)

    // After save, there should be state.json but no .tmp files
    const files = await readdir(tmpDir)
    const tmpFiles = files.filter(f => f.endsWith('.tmp'))
    assert.equal(tmpFiles.length, 0, 'no temp files should remain after successful save')
  })

  it('WAL file is cleaned up after successful save', async () => {
    const { saveState } = await import('../server/state-store.ts')
    const state = createDefaultState('')
    await saveState(state)

    const files = await readdir(tmpDir)
    const walFiles = files.filter(f => f.endsWith('.wal'))
    assert.equal(walFiles.length, 0, 'WAL file should be cleaned up after successful save')
  })

  it('loadStateForRenderer surfaces a corrupted WAL instead of silently deleting it', async () => {
    const { saveState, loadStateForRenderer } = await import('../server/state-store.ts')
    const state = createDefaultState('')
    state.columns[0].title = 'Current state'
    await saveState(state)
    await writeFile(path.join(tmpDir, 'state.wal'), '{ broken wal', 'utf8')

    const loaded = await loadStateForRenderer()

    assert.equal(loaded.state.columns[0].title, 'Current state')
    assert.equal(
      loaded.recovery.startup?.issues.some((issue) => issue.kind === 'corrupted-wal'),
      true,
      'startup recovery metadata should point out a corrupted WAL file',
    )

    const files = await readdir(tmpDir)
    assert.ok(files.includes('state.wal'), 'the corrupted WAL should remain until the user makes a recovery choice')
  })

  it('loadStateForRenderer promotes a valid WAL before returning the startup preview state', async () => {
    const { saveState, loadStateForRenderer } = await import('../server/state-store.ts')
    const currentState = createDefaultState('')
    currentState.columns[0].title = 'Current state'
    await saveState(currentState)

    const walState = createDefaultState('')
    walState.columns[0].title = 'Recovered from WAL'
    await writeFile(path.join(tmpDir, 'state.wal'), `${JSON.stringify(walState, null, 2)}\n`, 'utf8')

    const loaded = await loadStateForRenderer()

    assert.equal(loaded.state.columns[0].title, 'Recovered from WAL')
    const files = await readdir(tmpDir)
    assert.ok(!files.includes('state.wal'), 'a valid WAL should be promoted and cleared before renderer startup returns')
    const persisted = await readFile(path.join(tmpDir, 'state.json'), 'utf8')
    assert.match(persisted, /Recovered from WAL/)
  })

  it('loadStateForRenderer avoids main-process response revalidation', async () => {
    const source = await readFile(path.join(process.cwd(), 'server', 'state-store.ts'), 'utf8')
    const loadStateForRendererBlock =
      source.match(
        /export const loadStateForRenderer = async[\s\S]*?(?=\nexport const loadSessionHistoryEntry = async)/,
      )?.[0] ?? ''

    assert.ok(loadStateForRendererBlock.includes('export const loadStateForRenderer = async'))
    assert.equal(
      loadStateForRendererBlock.includes('appStateLoadResponseSchema.parse'),
      false,
      'startup response validation should happen in the renderer bridge, not by re-parsing the full payload in the main process',
    )
  })

  it('loadStateForRenderer avoids hydrating archived history through loadState', async () => {
    const source = await readFile(path.join(process.cwd(), 'server', 'state-store.ts'), 'utf8')
    const loadStateForRendererBlock =
      source.match(
        /export const loadStateForRenderer = async[\s\S]*?(?=\nexport const loadSessionHistoryEntry = async)/,
      )?.[0] ?? ''

    assert.equal(
      loadStateForRendererBlock.includes('await loadState()'),
      false,
      'startup renderer hydration should not route through the full loadState() path because archived history can blow up packaged startup memory',
    )
  })

  it('renderer preview saves avoid rehydrating the full app state just to merge archived history', async () => {
    const source = await readFile(path.join(process.cwd(), 'server', 'state-store.ts'), 'utf8')
    const mergePersistedSessionHistoryBlock =
      source.match(
        /const mergePersistedSessionHistory = async[\s\S]*?(?=\nconst saveStateToDataDir = async)/,
      )?.[0] ?? ''

    assert.ok(mergePersistedSessionHistoryBlock.includes('const mergePersistedSessionHistory = async'))
    assert.equal(
      mergePersistedSessionHistoryBlock.includes('await loadState()'),
      false,
      'saving a renderer preview should not route through loadState() because the first post-startup tab switch would hydrate full archived history and can OOM the packaged main process',
    )
    assert.ok(
      mergePersistedSessionHistoryBlock.includes('await loadPersistedSessionHistory(dataDir)'),
      'renderer preview saves should recover archived transcripts through the lightweight session-history loader instead',
    )
  })

  it('loadSessionHistoryEntry reads archived history without hydrating the full app state', async () => {
    const source = await readFile(path.join(process.cwd(), 'server', 'state-store.ts'), 'utf8')
    const loadSessionHistoryEntryBlock =
      source.match(
        /export const loadSessionHistoryEntry = async[\s\S]*?(?=\nexport const resolveStateRecoveryOption = async)/,
      )?.[0] ?? ''

    assert.ok(loadSessionHistoryEntryBlock.includes('export const loadSessionHistoryEntry = async'))
    assert.equal(
      loadSessionHistoryEntryBlock.includes('await loadState()'),
      false,
      'loading one archived session should not pay the cost of hydrating the entire persisted app state',
    )
  })

  it('loadSessionHistoryEntry promotes a valid WAL before reading archived sessions', async () => {
    const { saveState, loadSessionHistoryEntry } = await import('../server/state-store.ts')
    const currentState = createDefaultState('D:/wal-history')
    await saveState(currentState)

    const walState = createDefaultState('D:/wal-history')
    walState.sessionHistory = [
      {
        id: 'wal-history-entry',
        title: 'Recovered archived session',
        sessionId: 'wal-history-session',
        provider: 'codex',
        model: 'gpt-5.4',
        workspacePath: 'D:/wal-history',
        archivedAt: new Date('2026-04-12T01:00:00.000Z').toISOString(),
        messages: [
          {
            id: 'wal-history-message',
            role: 'user',
            content: 'Recover me from WAL',
            createdAt: new Date('2026-04-12T01:00:00.000Z').toISOString(),
          },
        ],
      },
    ]
    await writeFile(path.join(tmpDir, 'state.wal'), `${JSON.stringify(walState, null, 2)}\n`, 'utf8')

    const loaded = await loadSessionHistoryEntry({ entryId: 'wal-history-entry' })

    assert.equal(loaded.entry.title, 'Recovered archived session')
    const files = await readdir(tmpDir)
    assert.ok(!files.includes('state.wal'), 'a valid WAL should be cleared after archived-session recovery promotes it')
    const persisted = await readFile(path.join(tmpDir, 'state.json'), 'utf8')
    assert.match(persisted, /Recovered archived session/)
  })

  it('server /api/state reuses the renderer startup loader instead of calling loadState directly', async () => {
    const source = await readFile(path.join(process.cwd(), 'server', 'index.ts'), 'utf8')
    const stateRouteBlock =
      source.match(
        /app\.get\('\/api\/state', async \(_request, response\) => \{[\s\S]*?\n\}\)/,
      )?.[0] ?? ''

    assert.ok(stateRouteBlock.includes("app.get('/api/state'"))
    assert.equal(
      stateRouteBlock.includes('await loadState()'),
      false,
      'the HTTP state route should not rehydrate the full app state just to build a lightweight startup payload',
    )
    assert.ok(
      stateRouteBlock.includes('await loadStateForRenderer()'),
      'the HTTP state route should share the same lightweight startup loader as the Electron bridge',
    )
  })

  it('loadStateForRenderer offers a newer temp state and resolveStateRecoveryOption restores it', async () => {
    const { saveState, loadStateForRenderer, resolveStateRecoveryOption } = await import('../server/state-store.ts')
    const currentState = createDefaultState('')
    currentState.columns[0].title = 'Current state'
    await saveState(currentState)
    await new Promise((resolve) => setTimeout(resolve, 5))

    const tempState = createDefaultState('')
    tempState.columns[0].title = 'Recovered from temp file'
    const tempFile = path.join(tmpDir, `state.tmp.${Date.now()}`)
    await writeFile(tempFile, `${JSON.stringify(tempState, null, 2)}\n`, 'utf8')

    const loaded = await loadStateForRenderer()
    const tempOption = loaded.recovery.startup?.options.find((option) => option.source === 'temp-state')
    assert.ok(tempOption, 'the newer temp state should be offered as a recovery choice')

    const resolved = await resolveStateRecoveryOption(tempOption!.id)
    assert.equal(resolved.recovery.startup, null, 'the prompt should disappear after resolving recovery')
    assert.equal(resolved.state.columns[0].title, 'Recovered from temp file')

    const persisted = await readFile(path.join(tmpDir, 'state.json'), 'utf8')
    assert.match(persisted, /Recovered from temp file/)
  })

  it('queueSaveState batches rapid saves without data loss', async () => {
    const { queueSaveState, loadState } = await import('../server/state-store.ts')

    // Fire many rapid saves
    let queued: Promise<void> | undefined
    for (let i = 0; i < 10; i++) {
      const state = createDefaultState('')
      state.columns[0].title = `Workspace-${i}`
      queued = queueSaveState(state)
    }

    // Wait for queue to flush
    await queued

    const loaded = await loadState()
    // The last queued state should win
    assert.equal(loaded.columns[0].title, 'Workspace-9', 'last queued state should be persisted')
  })

  it('waitForPendingStateWrites drains queued saves before quit-sensitive flows continue', async () => {
    const { queueSaveState, waitForPendingStateWrites, loadState } = await import('../server/state-store.ts')
    const state = createDefaultState('')
    state.columns[0].title = 'Queued before update quit'

    void queueSaveState(state)
    await waitForPendingStateWrites()

    const loaded = await loadState()
    assert.equal(
      loaded.columns[0].title,
      'Queued before update quit',
      'quit-sensitive flows should be able to wait for the queued state write to reach disk',
    )

    const files = await readdir(tmpDir)
    assert.equal(files.filter((fileName) => fileName.endsWith('.wal')).length, 0)
  })

  it('concurrent queueSaveState calls do not corrupt the file', async () => {
    const { queueSaveState, loadState } = await import('../server/state-store.ts')

    // Simulate concurrent saves from different "events"
    let queued: Promise<void> | undefined
    for (let i = 0; i < 20; i++) {
      const state = createDefaultState('')
      state.columns[0].title = `Concurrent-${i}`
      queued = queueSaveState(state)
    }

    await queued

    const loaded = await loadState()
    // File should be valid JSON and parseable
    assert.equal(loaded.version, 1)
    assert.ok(loaded.columns[0].title.startsWith('Concurrent-'))
  })

  it('keeps queued writes in the data directory active when they were queued', async () => {
    const { queueSaveState } = await import('../server/state-store.ts')
    const queuedDir = tmpDir
    const laterDir = path.join(os.tmpdir(), `chill-vibe-later-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(laterDir, { recursive: true })

    try {
      const state = createDefaultState('')
      state.columns[0].title = 'Queued temp only'

      const queued = queueSaveState(state)
      process.env.CHILL_VIBE_DATA_DIR = laterDir

      await queued

      const queuedRaw = await readFile(path.join(queuedDir, 'state.json'), 'utf8')
      assert.ok(queuedRaw.includes('Queued temp only'), 'queued write should stay in the original temp dir')

      await assert.rejects(
        readFile(path.join(laterDir, 'state.json'), 'utf8'),
        /ENOENT/,
        'queued write should not follow later CHILL_VIBE_DATA_DIR changes',
      )
    } finally {
      process.env.CHILL_VIBE_DATA_DIR = queuedDir
      await rm(laterDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('survives sustained queued writes with large payloads and keeps only the newest snapshot', async () => {
    const { queueSaveState, loadState } = await import('../server/state-store.ts')

    const burstCount = 12
    const writesPerBurst = 15
    const messageCount = 40
    let expectedTitle = ''
    let expectedLastMessageId = ''
    let queued: Promise<void> | undefined

    for (let burstIndex = 0; burstIndex < burstCount; burstIndex++) {
      for (let writeIndex = 0; writeIndex < writesPerBurst; writeIndex++) {
        const iteration = burstIndex * writesPerBurst + writeIndex
        const title = `Stress-${iteration}`
        const state = createDefaultState('')

        state.updatedAt = `2026-04-07T10:${String(Math.floor(iteration / 60)).padStart(2, '0')}:${String(
          iteration % 60,
        ).padStart(2, '0')}.000Z`
        state.columns[0].title = title
        const firstCard = getFirstCard(state)
        assert.ok(firstCard, 'expected a default card to exist in the first column')
        firstCard.messages = Array.from({ length: messageCount }, (_, messageIndex) => ({
          id: `${title}-message-${messageIndex}`,
          role: messageIndex % 2 === 0 ? 'user' : 'assistant',
          content: `${title} payload ${messageIndex} ${'x'.repeat(256)}`,
          createdAt: new Date(Date.UTC(2026, 3, 7, 10, 0, 0, iteration * messageCount + messageIndex)).toISOString(),
        }))

        expectedTitle = title
        expectedLastMessageId = `${title}-message-${messageCount - 1}`
        queued = queueSaveState(state)
      }

      await new Promise(resolve => setTimeout(resolve, 0))
    }

    await queued

    const loaded = await loadState()

    assert.equal(loaded.columns[0].title, expectedTitle, 'latest queued state should win even under sustained pressure')
    const loadedFirstCard = getFirstCard(loaded)
    assert.ok(loadedFirstCard, 'expected a persisted card to exist in the first column')
    assert.equal(loadedFirstCard.messages.at(-1)?.id, expectedLastMessageId, 'latest queued payload should be persisted without truncation')
    assert.equal(loadedFirstCard.messages.length, messageCount)

    const files = await readdir(tmpDir)
    assert.equal(files.filter(f => f.endsWith('.tmp')).length, 0, 'stress writes should not leak temp files')
    assert.equal(files.filter(f => f.endsWith('.wal')).length, 0, 'stress writes should not leave WAL files behind')
  })

  it('captureRendererCrash archives recent chats into session history and exposes a one-click recovery hint', async () => {
    const { saveState, captureRendererCrash, loadStateForRenderer } = await import('../server/state-store.ts')
    const state = createDefaultState('D:/crash-recovery')
    const firstCard = getFirstCard(state)
    assert.ok(firstCard, 'expected a default card to exist in the first column')
    firstCard.title = 'Morning incident thread'
    firstCard.messages = [
      {
        id: 'msg-user',
        role: 'user',
        content: 'We need the latest release build restored.',
        createdAt: new Date('2026-04-11T05:20:00.000Z').toISOString(),
      },
      {
        id: 'msg-assistant',
        role: 'assistant',
        content: 'Checking the persistence layer now.',
        createdAt: new Date('2026-04-11T05:21:00.000Z').toISOString(),
      },
    ]
    await saveState(state)

    const recentCrash = await captureRendererCrash({
      source: 'react-boundary',
      message: 'ReferenceError: renderBoard is not defined',
      stack: 'ReferenceError: renderBoard is not defined',
      state,
    })

    assert.ok(recentCrash, 'renderer crash capture should persist recent-session recovery metadata')
    assert.equal(recentCrash?.sessionHistoryEntryIds.length, 1)

    const loaded = await loadStateForRenderer()
    assert.equal(loaded.state.sessionHistory.length, 1, 'captured crash sessions should be copied into session history')
    assert.deepEqual(loaded.recovery.recentCrash, recentCrash)
    assert.match(loaded.recovery.recentCrash?.errorSummary ?? '', /renderBoard is not defined/i)
  })

  it('recent crash recovery stays isolated to the current desktop runtime kind', async () => {
    process.env.CHILL_VIBE_RUNTIME_KIND = 'dev'

    const { saveState, captureRendererCrash, loadStateForRenderer } = await import('../server/state-store.ts')
    const state = createDefaultState('D:/crash-runtime-isolation')
    const firstCard = getFirstCard(state)
    assert.ok(firstCard, 'expected a default card to exist in the first column')
    firstCard.messages = [
      {
        id: 'msg-user-runtime',
        role: 'user',
        content: 'Keep this crash recovery inside the dev runtime only.',
        createdAt: new Date('2026-04-13T00:15:00.000Z').toISOString(),
      },
    ]

    await saveState(state)

    const recentCrash = await captureRendererCrash({
      source: 'react-boundary',
      message: 'ReferenceError: sessionHistory is not defined',
      stack: 'ReferenceError: sessionHistory is not defined',
      state,
    })

    assert.equal(recentCrash?.runtimeKind, 'dev')

    process.env.CHILL_VIBE_RUNTIME_KIND = 'release'
    const releaseLoaded = await loadStateForRenderer()
    assert.equal(
      releaseLoaded.recovery.recentCrash,
      null,
      'release runtime should ignore dev crash recovery markers even when the data dir is shared',
    )

    process.env.CHILL_VIBE_RUNTIME_KIND = 'dev'
    const devLoaded = await loadStateForRenderer()
    assert.equal(devLoaded.recovery.recentCrash?.runtimeKind, 'dev')
    assert.equal(devLoaded.recovery.recentCrash?.sessionHistoryEntryIds.length, 1)
  })

  it('loadStateForRenderer keeps only a lightweight archived-session payload while full restore data stays available on demand', async () => {
    const { saveState, loadStateForRenderer, loadSessionHistoryEntry } = await import('../server/state-store.ts')
    const state = createDefaultState('D:/history-renderer-trim')

    state.sessionHistory = [
      {
        id: 'history-trim-1',
        title: 'Archived release investigation',
        sessionId: 'history-trim-session-1',
        provider: 'codex',
        model: 'gpt-5.4',
        workspacePath: 'D:/history-renderer-trim',
        messageCount: 12,
        messages: Array.from({ length: 12 }, (_, index) => ({
          id: `history-trim-message-${index + 1}`,
          role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `Archived renderer trim message ${index + 1}`,
          createdAt: new Date(Date.UTC(2026, 3, 11, 6, 0, index)).toISOString(),
          meta: index === 11
            ? {
                provider: 'codex',
                kind: 'command',
                itemId: 'history-trim-command',
                structuredData: JSON.stringify({
                  type: 'activity',
                  itemId: 'history-trim-command',
                  kind: 'command',
                  status: 'completed',
                  command: 'pnpm test',
                  output: 'trim me',
                  exitCode: 0,
                }),
              }
            : undefined,
        })),
        archivedAt: new Date('2026-04-11T06:20:00.000Z').toISOString(),
      },
    ]

    await saveState(state)

    const loaded = await loadStateForRenderer()
    const archivedEntry = loaded.state.sessionHistory[0]

    assert.ok(archivedEntry, 'expected archived session history to be returned to the renderer')
    assert.equal(archivedEntry?.messageCount, 12)
    assert.ok(
      (archivedEntry?.messages.length ?? 12) < 12,
      'renderer startup payload should not hydrate the full archived transcript',
    )
    assert.ok(
      archivedEntry?.messages.every((message) => message.meta === undefined),
      'renderer preview payload should drop structured archived message metadata',
    )

    const restored = await loadSessionHistoryEntry({ entryId: 'history-trim-1' })
    assert.equal(restored.entry.messageCount, 12)
    assert.equal(restored.entry.messages.length, 12)
    assert.match(restored.entry.messages[11]?.meta?.structuredData ?? '', /"command":"pnpm test"/)
  })

  it('saveState preserves full archived session transcripts when the renderer only sends lightweight history previews', async () => {
    const { saveState, loadState } = await import('../server/state-store.ts')
    const state = createDefaultState('D:/history-save-merge')

    state.sessionHistory = [
      {
        id: 'history-merge-1',
        title: 'Archived merge target',
        sessionId: 'history-merge-session-1',
        provider: 'codex',
        model: 'gpt-5.4',
        workspacePath: 'D:/history-save-merge',
        messageCount: 10,
        messages: Array.from({ length: 10 }, (_, index) => ({
          id: `history-merge-message-${index + 1}`,
          role: index % 2 === 0 ? ('assistant' as const) : ('user' as const),
          content: `Archived save merge message ${index + 1}`,
          createdAt: new Date(Date.UTC(2026, 3, 11, 7, 0, index)).toISOString(),
        })),
        archivedAt: new Date('2026-04-11T07:20:00.000Z').toISOString(),
      },
    ]

    await saveState(state)

    const rendererPreview = structuredClone(state)
    rendererPreview.columns[0].title = 'Updated after lightweight save'
    rendererPreview.sessionHistory = [
      {
        ...rendererPreview.sessionHistory[0]!,
        messageCount: 10,
        messages: rendererPreview.sessionHistory[0]!.messages.slice(0, 2).map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
        })),
      },
    ]

    await saveState(rendererPreview)

    const loaded = await loadState()
    assert.equal(loaded.columns[0].title, 'Updated after lightweight save')
    assert.equal(loaded.sessionHistory[0]?.messageCount, 10)
    assert.equal(
      loaded.sessionHistory[0]?.messages.length,
      10,
      'saving renderer previews should preserve the full archived transcript on disk',
    )
    assert.equal(loaded.sessionHistory[0]?.messages[9]?.content, 'Archived save merge message 10')
  })

  it('loadStateForRenderer exposes interrupted running sessions for startup recovery', async () => {
    const { saveState, loadStateForRenderer } = await import('../server/state-store.ts')
    const state = createDefaultState('D:/resume-recovery')
    const firstCard = getFirstCard(state)
    assert.ok(firstCard, 'expected a default card to exist in the first column')

    firstCard.status = 'streaming'
    firstCard.streamId = 'stream-interrupted-1'
    firstCard.sessionId = 'session-interrupted-1'
    firstCard.title = 'Resume me'
    firstCard.messages = [
      {
        id: 'msg-command',
        role: 'assistant',
        content: '',
        meta: {
          kind: 'command',
          provider: firstCard.provider,
          structuredData: JSON.stringify({
            itemId: 'cmd-1',
            status: 'in_progress',
            command: 'rg -n "resume"',
            output: '',
            exitCode: null,
          }),
        },
        createdAt: new Date('2026-04-11T05:59:30.000Z').toISOString(),
      },
      {
        id: 'msg-user',
        role: 'user',
        content: 'Keep going.',
        meta: attachImagesToMessageMeta([
          {
            id: 'image-1',
            fileName: 'repro.png',
            mimeType: 'image/png',
            sizeBytes: 2048,
          },
        ]),
        createdAt: new Date('2026-04-11T06:00:00.000Z').toISOString(),
      },
    ]

    await saveState(state)

    const loaded = await loadStateForRenderer()
    const loadedFirstCard = getFirstCard(loaded.state)

    assert.ok(loadedFirstCard, 'expected the recovered state to keep the original card')
    assert.equal(
      loadedFirstCard.status,
      'idle',
      'interrupted cards should render as idle until the user explicitly resumes them',
    )
    assert.equal(
      loadedFirstCard.streamId,
      undefined,
      'interrupted cards should not keep an active stream id before the user resumes them',
    )
    assert.match(
      loadedFirstCard.messages[0]?.meta?.structuredData ?? '',
      /"status":"declined"/,
      'interrupted in-progress command blocks should stop rendering as actively running on startup',
    )

    assert.equal(loaded.recovery.interruptedSessions?.entries.length, 1)
    assert.deepEqual(loaded.recovery.interruptedSessions?.entries[0], {
      columnId: state.columns[0]?.id,
      cardId: firstCard.id,
      title: 'Resume me',
      provider: firstCard.provider,
      sessionId: 'session-interrupted-1',
      recoverable: true,
      resumeMode: 'resume',
      resumePrompt: '',
      resumeAttachments: [],
    })
  })

  it('loadStateForRenderer keeps retryable pre-session interruptions resumable', async () => {
    const { saveState, loadStateForRenderer } = await import('../server/state-store.ts')
    const state = createDefaultState('D:/resume-recovery-no-session')
    const firstCard = getFirstCard(state)
    assert.ok(firstCard, 'expected a default card to exist in the first column')

    firstCard.status = 'streaming'
    firstCard.streamId = 'stream-interrupted-pre-session-1'
    firstCard.sessionId = undefined
    firstCard.title = 'Retry last message'
    firstCard.messages = [
      {
        id: 'msg-user',
        role: 'user',
        content: 'Retry the last repair step',
        meta: attachImagesToMessageMeta([
          {
            id: 'image-2',
            fileName: 'retry.png',
            mimeType: 'image/png',
            sizeBytes: 4096,
          },
        ]),
        createdAt: new Date('2026-04-11T06:05:00.000Z').toISOString(),
      },
    ]

    await saveState(state)

    const loaded = await loadStateForRenderer()

    assert.equal(loaded.recovery.interruptedSessions?.entries.length, 1)
    assert.deepEqual(loaded.recovery.interruptedSessions?.entries[0], {
      columnId: state.columns[0]?.id,
      cardId: firstCard.id,
      title: 'Retry last message',
      provider: firstCard.provider,
      sessionId: undefined,
      recoverable: true,
      resumeMode: 'retry-last-user-message',
      resumePrompt: 'Retry the last repair step',
      resumeAttachments: [
        {
          id: 'image-2',
          fileName: 'retry.png',
          mimeType: 'image/png',
          sizeBytes: 4096,
        },
      ],
    })
  })
})
