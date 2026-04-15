import assert from 'node:assert/strict'
import test from 'node:test'

import { syncMessageListElementToBottom } from '../src/components/pane-scroll.ts'

test('syncMessageListElementToBottom scrolls to bottom and notifies listeners', () => {
  const dispatchedEvents: string[] = []
  const target = {
    scrollTop: 12,
    scrollHeight: 680,
    clientHeight: 240,
    dispatchEvent: (event: Event) => {
      dispatchedEvents.push(event.type)
      return true
    },
  }

  const nextScrollTop = syncMessageListElementToBottom(target)

  assert.equal(nextScrollTop, 440)
  assert.equal(target.scrollTop, 440)
  assert.deepEqual(dispatchedEvents, ['scroll'])
})
