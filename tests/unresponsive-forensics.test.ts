import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeUnresponsiveCallStack } from '../electron/unresponsive-forensics'

// Forensic dump 2026-07-07T14-50 + main.log proved the severe stuck shape:
// `BrowserWindow became unresponsive` (renderer main thread blocked), page fully
// non-interactive, never `responsive again`. The plain event never said WHAT was
// blocking. These tests pin the formatter that turns the captured JS call stack
// into an actionable, log-friendly summary.

test('a populated call stack is available and keeps the top frames', () => {
  const summary = summarizeUnresponsiveCallStack({
    windowId: 1,
    capturedAtIso: '2026-07-07T14:50:00.000Z',
    rawCallStack: 'at getLiveChatContentChars\nat persistQueued\nat dispatch',
  })
  assert.equal(summary.available, true)
  assert.equal(summary.frameCount, 3)
  assert.equal(summary.windowId, 1)
  assert.match(summary.callStack, /getLiveChatContentChars/)
})

test('an empty call stack means blocked in native/GC, not app JS', () => {
  // collectJavaScriptCallStack resolves to '' when the main thread is stuck
  // outside JS (native call, GC, sync IO) — a real and different signal, not an
  // error. available:false records that distinction.
  const summary = summarizeUnresponsiveCallStack({
    windowId: 1,
    capturedAtIso: '2026-07-07T14:50:00.000Z',
    rawCallStack: '',
  })
  assert.equal(summary.available, false)
  assert.equal(summary.frameCount, 0)
})

test('a null call stack (API unavailable / promise rejected) is handled', () => {
  const summary = summarizeUnresponsiveCallStack({
    windowId: 2,
    capturedAtIso: '2026-07-07T14:50:00.000Z',
    rawCallStack: null,
  })
  assert.equal(summary.available, false)
  assert.equal(summary.frameCount, 0)
})

test('an over-long stack is truncated with an explicit omitted-frame marker', () => {
  const frames = Array.from({ length: 40 }, (_, i) => `at frame${i}`).join('\n')
  const summary = summarizeUnresponsiveCallStack({
    windowId: 1,
    capturedAtIso: '2026-07-07T14:50:00.000Z',
    rawCallStack: frames,
    maxFrames: 24,
  })
  assert.equal(summary.frameCount, 40)
  assert.match(summary.callStack, /\[\+16 more frames omitted\]/)
  // The top frame (where the blocking work sits) must survive truncation.
  assert.match(summary.callStack, /at frame0\n/)
})

test('blank lines in the raw stack are ignored', () => {
  const summary = summarizeUnresponsiveCallStack({
    windowId: 1,
    capturedAtIso: '2026-07-07T14:50:00.000Z',
    rawCallStack: 'at a\n\n  \nat b\n',
  })
  assert.equal(summary.frameCount, 2)
})
