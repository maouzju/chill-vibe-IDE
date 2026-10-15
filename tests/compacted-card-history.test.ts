import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getCompactedPrefix } from '../server/compacted-card-history.ts'

const message = (index: number, valid: boolean) => ({
  id: `m${index}`,
  role: 'user',
  content: `c${index}`,
  ...(valid ? { createdAt: '2026-10-13T00:00:00.000Z' } : {}),
})

test('archive covers exactly the raw prefix that pre-trim drops, even when invalid messages sit in the kept window', () => {
  const raw = Array.from({ length: 400 }, (_, index) => message(index, !(index >= 350 && index < 360)))

  const archived = getCompactedPrefix({ provider: 'claude', messages: raw }, 300)

  assert.deepEqual(
    archived.map((entry) => entry.id),
    raw.slice(0, 100).map((entry) => entry.id),
  )
})
