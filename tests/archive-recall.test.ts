import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { attachImagesToMessageMeta } from '../shared/chat-attachments.ts'
import { createDefaultState, getFirstPane } from '../shared/default-state.ts'
import type { ChatMessage, ChatRequest, ImageAttachment } from '../shared/schema.ts'
import { buildArchiveRecallSnapshot } from '../src/archive-recall.ts'
import { createArchiveRecallRuntimeOverrides } from '../server/archive-recall.ts'

const timestamp = '2026-04-18T01:09:00.000Z'

const createMessage = (
  id: string,
  role: ChatMessage['role'],
  content: string,
  meta?: ChatMessage['meta'],
): ChatMessage => ({
  id,
  role,
  content,
  createdAt: timestamp,
  meta,
})

const imageAttachment: ImageAttachment = {
  id: 'compact-image.png',
  fileName: 'compact-image.png',
  mimeType: 'image/png',
  sizeBytes: 512,
}

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-recall-runtime-'))

after(() => {
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

describe('archive recall snapshot', () => {
  it('captures only the hidden compacted segment before the latest compact boundary', () => {
    const snapshot = buildArchiveRecallSnapshot({
      provider: 'codex',
      status: 'idle',
      messages: [
        createMessage(
          'hidden-user',
          'user',
          'Look at the earlier screenshot.',
          attachImagesToMessageMeta([imageAttachment]),
        ),
        createMessage('hidden-assistant', 'assistant', 'The CI screenshot shows a red build.'),
        createMessage('compact-boundary', 'user', '/compact', {
          provider: 'codex',
          compactBoundary: 'true',
        }),
        createMessage('visible-assistant', 'assistant', 'Compacted summary is now visible.'),
      ],
    })

    assert.ok(snapshot)
    assert.equal(snapshot?.hiddenReason, 'compact')
    assert.equal(snapshot?.hiddenMessageCount, 2)
    assert.deepEqual(snapshot?.messages.map((message) => message.id), ['hidden-user', 'hidden-assistant'])
  })

  it('does not create archive recall state for performance-only windowing', () => {
    const snapshot = buildArchiveRecallSnapshot({
      provider: 'codex',
      status: 'idle',
      messages: Array.from({ length: 260 }, (_, index) =>
        createMessage(
          `message-${index + 1}`,
          index % 2 === 0 ? 'user' : 'assistant',
          `Message ${index + 1}`,
        ),
      ),
    })

    assert.equal(snapshot, undefined)
  })

  it('keeps the earliest history when several compact boundaries exist', () => {
    const snapshot = buildArchiveRecallSnapshot({
      provider: 'codex',
      status: 'idle',
      messages: [
        createMessage('first-user', 'user', 'The first screenshot matters.'),
        createMessage('first-boundary', 'user', '/compact', {
          provider: 'codex',
          compactBoundary: 'true',
        }),
        createMessage('first-summary', 'assistant', 'First compact summary.'),
        createMessage('second-user', 'user', 'Later investigation.'),
        createMessage('second-boundary', 'user', '/compact', {
          provider: 'codex',
          compactBoundary: 'true',
        }),
        createMessage('second-summary', 'assistant', 'Second compact summary.'),
      ],
    })

    assert.ok(snapshot)
    assert.deepEqual(snapshot.messages.map((message) => message.id), [
      'first-user',
      'first-boundary',
      'first-summary',
      'second-user',
    ])
  })
})

describe('archive recall runtime overrides', () => {
  it('writes an ephemeral snapshot file and returns Codex MCP config overrides', async () => {
    process.env.CHILL_VIBE_DATA_DIR = tempDataDir

    const request: ChatRequest = {
      provider: 'codex',
      workspacePath: 'D:\\Git\\chill-vibe',
      model: 'gpt-5.5',
      reasoningEffort: 'max',
      thinkingEnabled: true,
      planMode: false,
      language: 'zh-CN',
      systemPrompt: 'You are helpful.',
      modelPromptRules: [],
      crossProviderSkillReuseEnabled: true,
      prompt: 'Check the earlier screenshot.',
      attachments: [],
      archiveRecall: {
        hiddenReason: 'compact',
        hiddenMessageCount: 1,
        messages: [
          createMessage(
            'hidden-user',
            'user',
            'Earlier screenshot is attached here.',
            attachImagesToMessageMeta([imageAttachment]),
          ),
        ],
      },
    }

    const runtime = await createArchiveRecallRuntimeOverrides(request)

    assert.ok(runtime)
    assert.match(runtime?.runtimeArgs.join(' '), /mcp_servers\.chill_vibe_archive\.command=/)
    assert.match(runtime?.runtimeArgs.join(' '), /archive-recall-mcp\.js/)
    assert.ok(runtime?.contextFilePath)
    assert.equal(fs.existsSync(runtime!.contextFilePath), true)

    await runtime?.cleanup()
    assert.equal(fs.existsSync(runtime!.contextFilePath), false)

    delete process.env.CHILL_VIBE_DATA_DIR
  })

  it('skips runtime overrides when there is no compacted archive payload', async () => {
    const request: ChatRequest = {
      provider: 'codex',
      workspacePath: 'D:\\Git\\chill-vibe',
      model: 'gpt-5.5',
      reasoningEffort: 'max',
      thinkingEnabled: true,
      planMode: false,
      language: 'zh-CN',
      systemPrompt: 'You are helpful.',
      modelPromptRules: [],
      crossProviderSkillReuseEnabled: true,
      prompt: 'hello',
      attachments: [],
      archiveRecall: undefined,
    }

    const runtime = await createArchiveRecallRuntimeOverrides(request)
    assert.equal(runtime, null)
  })

  it('recalls the earliest compacted history after active-card persistence trims to 500 messages', async () => {
    process.env.CHILL_VIBE_DATA_DIR = tempDataDir
    const { saveState } = await import('../server/state-store.ts')
    const state = createDefaultState('D:\\Git\\chill-vibe')
    const column = state.columns[0]!
    const cardId = getFirstPane(column.layout).tabs[0]!
    const card = column.cards[cardId]!
    card.messages = [
      createMessage('earliest-hidden', 'user', 'The very first compacted screenshot.'),
      ...Array.from({ length: 620 }, (_, index) =>
        createMessage(`old-${index}`, index % 2 === 0 ? 'assistant' : 'user', `Old ${index}`),
      ),
      createMessage('latest-boundary', 'user', '/compact', {
        provider: 'codex',
        compactBoundary: 'true',
      }),
      createMessage('visible-summary', 'assistant', 'Visible compact summary.'),
    ]

    await saveState(state)

    const request: ChatRequest = {
      provider: 'codex',
      cardId,
      workspacePath: 'D:\\Git\\chill-vibe',
      model: 'gpt-5.5',
      reasoningEffort: 'max',
      thinkingEnabled: true,
      planMode: false,
      language: 'zh-CN',
      systemPrompt: 'You are helpful.',
      modelPromptRules: [],
      crossProviderSkillReuseEnabled: true,
      prompt: 'Find the first screenshot.',
      attachments: [],
    }

    const runtime = await createArchiveRecallRuntimeOverrides(request)
    assert.ok(runtime)
    const persistedSnapshot = JSON.parse(fs.readFileSync(runtime!.contextFilePath, 'utf8')) as {
      messages: ChatMessage[]
    }
    assert.equal(persistedSnapshot.messages[0]?.id, 'earliest-hidden')
    assert.equal(persistedSnapshot.messages.some((message) => message.id === 'old-0'), true)

    await runtime?.cleanup()
    delete process.env.CHILL_VIBE_DATA_DIR
  })

  it('does not let a later trimmed save shorten the cumulative compacted archive', async () => {
    process.env.CHILL_VIBE_DATA_DIR = tempDataDir
    const { saveState } = await import('../server/state-store.ts')
    const state = createDefaultState('D:\\Git\\chill-vibe')
    const column = state.columns[0]!
    const cardId = getFirstPane(column.layout).tabs[0]!
    const card = column.cards[cardId]!
    card.messages = [
      createMessage('preserved-earliest', 'user', 'Keep this after later saves.'),
      ...Array.from({ length: 510 }, (_, index) =>
        createMessage(`history-${index}`, 'assistant', `History ${index}`),
      ),
      createMessage('boundary', 'user', '/compact', {
        provider: 'codex',
        compactBoundary: 'true',
      }),
      createMessage('summary', 'assistant', 'Summary.'),
    ]
    await saveState(state)

    card.messages = card.messages.slice(-500)
    await saveState(state)

    const runtime = await createArchiveRecallRuntimeOverrides({
      provider: 'codex',
      cardId,
      workspacePath: 'D:\\Git\\chill-vibe',
      model: 'gpt-5.5',
      reasoningEffort: 'max',
      thinkingEnabled: true,
      planMode: false,
      language: 'zh-CN',
      systemPrompt: 'You are helpful.',
      modelPromptRules: [],
      crossProviderSkillReuseEnabled: true,
      prompt: 'Find the earliest message.',
      attachments: [],
    })

    assert.ok(runtime)
    const persistedSnapshot = JSON.parse(fs.readFileSync(runtime!.contextFilePath, 'utf8')) as {
      messages: ChatMessage[]
    }
    assert.equal(persistedSnapshot.messages.some((message) => message.id === 'preserved-earliest'), true)

    await runtime?.cleanup()
    delete process.env.CHILL_VIBE_DATA_DIR
  })

  it('removes a compacted-history sidecar when the owning card is reset', async () => {
    process.env.CHILL_VIBE_DATA_DIR = tempDataDir
    const { saveState } = await import('../server/state-store.ts')
    const { loadCompactedCardHistorySnapshot } = await import('../server/compacted-card-history.ts')
    const state = createDefaultState('D:\\Git\\chill-vibe')
    const column = state.columns[0]!
    const cardId = getFirstPane(column.layout).tabs[0]!
    const card = column.cards[cardId]!
    card.messages = [
      createMessage('reset-archived', 'user', 'This belongs to the old conversation.'),
      createMessage('reset-boundary', 'user', '/compact', {
        provider: 'codex',
        compactBoundary: 'true',
      }),
      createMessage('reset-summary', 'assistant', 'Old compact summary.'),
    ]

    await saveState(state)
    assert.ok(await loadCompactedCardHistorySnapshot(tempDataDir, cardId))

    card.messages = []
    card.messageCount = 0
    card.sessionId = undefined
    await saveState(state)

    assert.equal(await loadCompactedCardHistorySnapshot(tempDataDir, cardId), undefined)
    delete process.env.CHILL_VIBE_DATA_DIR
  })
})
