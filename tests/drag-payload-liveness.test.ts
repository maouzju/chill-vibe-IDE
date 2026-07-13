import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearDragPayload,
  markDragActivity,
  peekDragPayload,
  readDragPayload,
  releaseDragPayloadIfStale,
  writeDragPayload,
} from '../src/dnd.ts'

// During a native HTML5 drag, browsers hide dataTransfer contents from
// dragover handlers — getData() returns ''. This mirrors that protected mode,
// so readDragPayload can only succeed through the module-level payload.
const createProtectedDragEvent = () => {
  const store = new Map<string, string>()
  return {
    dataTransfer: {
      effectAllowed: '',
      setData: (key: string, value: string) => {
        store.set(key, value)
      },
      getData: () => '',
    },
  } as never
}

const tabPayload = {
  type: 'tab',
  columnId: 'column-1',
  paneId: 'pane-1',
  tabId: 'tab-1',
} as const

test('watchdog expiry keeps the payload while the drag session is still alive', () => {
  clearDragPayload()
  writeDragPayload(createProtectedDragEvent(), tabPayload)

  const t0 = 10_000
  markDragActivity(t0)

  // Hint watchdog fires while document-level drag activity is recent:
  // the payload must survive so later dragover/drop handlers still work.
  assert.equal(releaseDragPayloadIfStale(t0 + 300), false)
  assert.deepEqual(readDragPayload(createProtectedDragEvent()), tabPayload)

  clearDragPayload()
})

test('a drag kept alive by periodic activity survives repeated watchdog expiries', () => {
  clearDragPayload()
  writeDragPayload(createProtectedDragEvent(), tabPayload)

  // The HTML5 spec re-fires dragover roughly every 350ms while dragging,
  // so a live drag keeps marking activity between watchdog checks.
  let now = 50_000
  for (let round = 0; round < 5; round += 1) {
    markDragActivity(now)
    now += 350
    assert.equal(releaseDragPayloadIfStale(now), false, `round ${round}`)
  }

  assert.deepEqual(peekDragPayload(), tabPayload)
  clearDragPayload()
})

test('watchdog expiry releases the payload once drag activity has gone quiet', () => {
  clearDragPayload()
  writeDragPayload(createProtectedDragEvent(), tabPayload)

  const t0 = 90_000
  markDragActivity(t0)

  // No dragover/drag events for well over any activity heartbeat: the drag
  // died without dragend/drop (the pitfall-132 case) — now the payload may go.
  assert.equal(releaseDragPayloadIfStale(t0 + 5_000), true)
  assert.equal(peekDragPayload(), null)
  assert.equal(readDragPayload(createProtectedDragEvent()), null)
})

test('releaseDragPayloadIfStale reports released when no payload exists', () => {
  clearDragPayload()
  assert.equal(releaseDragPayloadIfStale(123_456), true)
  assert.equal(peekDragPayload(), null)
})
