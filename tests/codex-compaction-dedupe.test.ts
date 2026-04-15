import assert from 'node:assert/strict'
import test from 'node:test'

import { createCodexCompactionActivityDeduper } from '../server/codex-compaction-dedupe.ts'

const createCompactionActivity = (itemId: string) => ({
  itemId,
  kind: 'compaction' as const,
  status: 'completed' as const,
  trigger: 'auto' as const,
})

test('suppresses a thread/compacted notification that immediately follows a contextCompaction item', () => {
  const deduper = createCodexCompactionActivityDeduper()

  assert.equal(
    deduper.shouldEmit(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'compact-item-1',
            type: 'contextCompaction',
          },
        },
      },
      createCompactionActivity('compact-item-1'),
    ),
    true,
  )

  assert.equal(
    deduper.shouldEmit(
      {
        method: 'thread/compacted',
        params: {
          turnId: 'turn-1',
        },
      },
      createCompactionActivity('turn-1'),
    ),
    false,
  )
})

test('suppresses the reverse duplicate ordering too', () => {
  const deduper = createCodexCompactionActivityDeduper()

  assert.equal(
    deduper.shouldEmit(
      {
        method: 'thread/compacted',
        params: {
          turnId: 'turn-1',
        },
      },
      createCompactionActivity('turn-1'),
    ),
    true,
  )

  assert.equal(
    deduper.shouldEmit(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'compact-item-1',
            type: 'contextCompaction',
          },
        },
      },
      createCompactionActivity('compact-item-1'),
    ),
    false,
  )
})

test('allows a later compaction again after the stream moves on', () => {
  const deduper = createCodexCompactionActivityDeduper()

  assert.equal(
    deduper.shouldEmit(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'compact-item-1',
            type: 'contextCompaction',
          },
        },
      },
      createCompactionActivity('compact-item-1'),
    ),
    true,
  )

  deduper.reset()

  assert.equal(
    deduper.shouldEmit(
      {
        method: 'thread/compacted',
        params: {
          turnId: 'turn-2',
        },
      },
      createCompactionActivity('turn-2'),
    ),
    true,
  )
})

test('suppresses an exact duplicate compaction event with the same source and item id', () => {
  const deduper = createCodexCompactionActivityDeduper()

  assert.equal(
    deduper.shouldEmit(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'compact-item-1',
            type: 'contextCompaction',
          },
        },
      },
      createCompactionActivity('compact-item-1'),
    ),
    true,
  )

  assert.equal(
    deduper.shouldEmit(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'compact-item-1',
            type: 'contextCompaction',
          },
        },
      },
      createCompactionActivity('compact-item-1'),
    ),
    false,
  )
})
