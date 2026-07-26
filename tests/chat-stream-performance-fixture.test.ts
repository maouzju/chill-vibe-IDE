import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  chatStreamStressCardCount,
  chatStreamStressInitialStructuredItemCount,
  chatStreamStressSerializedStateMinBytes,
  createChatStreamStressState,
  getPercentile,
} from './chat-stream-performance-fixture.ts'

test('chat stream stress fixture matches the heavy multi-agent and fourteen-tab usage shape', () => {
  const state = createChatStreamStressState('D:/stress-workspace')
  const cards = state.columns.flatMap((column) => Object.values(column.cards))
  const foregroundCards = cards.filter((card) => /^card-chat-stress-\d+$/.test(card.id))
  const streamingTargetCards = cards.filter((card) =>
    /^card-chat-stress-(?:\d+|middle-\d+-\d+|background-\d+)$/.test(card.id),
  )
  const structuredMessages = foregroundCards.flatMap((card) => card.messages).filter(
    (message) => message.meta?.kind === 'command' || message.meta?.kind === 'tool',
  )

  assert.equal(state.columns.length, chatStreamStressCardCount)
  assert.ok(
    Buffer.byteLength(JSON.stringify(state), 'utf8') >= chatStreamStressSerializedStateMinBytes,
    'heavy-use fixture should include at least 4MB of synthetic persisted history',
  )
  assert.equal(
    state.columns.reduce(
      (total, column) => total + (column.layout.type === 'pane' ? column.layout.tabs.length : 0),
      0,
    ),
    84,
  )
  assert.deepEqual(
    state.columns.map((column) => column.layout.type === 'pane' ? column.layout.tabs.length : 0),
    [14, 14, 14, 14, 14, 14],
  )
  assert.equal(streamingTargetCards.length, 20)
  assert.deepEqual(
    state.columns.map((column) => Object.values(column.cards).filter((card) =>
      /^card-chat-stress-(?:\d+|middle-\d+-\d+|background-\d+)$/.test(card.id),
    ).length),
    [4, 4, 3, 3, 3, 3],
  )
  assert.equal(foregroundCards.length, chatStreamStressCardCount)
  assert.equal(structuredMessages.length, chatStreamStressInitialStructuredItemCount)
  assert.equal(foregroundCards.reduce((total, card) => total + card.messages.length, 0), 998)
  assert.deepEqual(
    streamingTargetCards.map((card) => card.status),
    Array.from({ length: 20 }, () => 'idle'),
  )
  assert.deepEqual(
    foregroundCards.map((card) => card.messages.filter((message) => message.meta?.kind === 'command').length),
    [320, 320, 70, 70, 70, 70],
  )
})

test('chat stream stress percentiles use the observed latency distribution', () => {
  assert.equal(getPercentile([], 0.95), 0)
  assert.equal(getPercentile([30, 10, 20, 50, 40], 0.5), 30)
  assert.equal(getPercentile([30, 10, 20, 50, 40], 0.95), 50)
})

test('package exposes an independent hidden Electron chat performance gate', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> }

  assert.equal(
    packageJson.scripts?.['test:perf:chat:electron'],
    'powershell -ExecutionPolicy Bypass -File scripts/run-electron-chat-performance.ps1',
  )
})

test('fake Codex stress runtime completes the current safety and managed-policy handshake', async () => {
  const fakeCodexSource = await readFile(
    path.join(process.cwd(), 'tests', 'fixtures', 'fake-codex-chat-stress.cjs'),
    'utf8',
  )

  assert.match(fakeCodexSource, /request\.method === 'configRequirements\/read'/)
  assert.match(fakeCodexSource, /request\.method === 'hooks\/list'/)
  assert.match(fakeCodexSource, /CHILL_VIBE_CODEX_SAFETY_HOOK_COMMAND/)
})
