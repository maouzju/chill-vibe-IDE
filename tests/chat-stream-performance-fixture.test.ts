import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  chatStreamStressCardCount,
  chatStreamStressInitialStructuredItemCount,
  createChatStreamStressState,
  getPercentile,
} from './chat-stream-performance-fixture.ts'

test('chat stream stress fixture matches the six-stream production incident shape', () => {
  const state = createChatStreamStressState('D:/stress-workspace')
  const cards = state.columns.flatMap((column) => Object.values(column.cards))
  const stressCards = cards.filter((card) => /^card-chat-stress-\d+$/.test(card.id))
  const structuredMessages = stressCards.flatMap((card) => card.messages).filter(
    (message) => message.meta?.kind === 'command' || message.meta?.kind === 'tool',
  )

  assert.equal(stressCards.length, chatStreamStressCardCount)
  assert.equal(structuredMessages.length, chatStreamStressInitialStructuredItemCount)
  assert.equal(stressCards.reduce((total, card) => total + card.messages.length, 0), 998)
  assert.deepEqual(
    stressCards.map((card) => card.status),
    Array.from({ length: chatStreamStressCardCount }, () => 'idle'),
  )
  assert.deepEqual(
    stressCards.map((card) => card.messages.filter((message) => message.meta?.kind === 'command').length),
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
