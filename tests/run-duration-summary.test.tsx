import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MessageBubble } from '../src/components/MessageBubble.tsx'
import {
  consumeRunDurationMessage,
  formatRunDuration,
  recordRunStart,
} from '../src/run-duration-summary.ts'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

test('formats a completed agent run as compact localized copy', () => {
  assert.equal(formatRunDuration(204_000, 'zh-CN'), '已运行 3分钟24秒')
  assert.equal(formatRunDuration(204_000, 'en'), 'Ran for 3m 24s')
  assert.equal(formatRunDuration(8_000, 'zh-CN'), '已运行 8秒')
  assert.equal(formatRunDuration(3_661_000, 'zh-CN'), '已运行 1小时1分钟1秒')
  assert.equal(formatRunDuration(3_600_000, 'en'), 'Ran for 1h 0s')
})

test('keeps one start time through retries and consumes exactly one persisted marker', () => {
  const starts = new Map<string, number>()

  recordRunStart(starts, 'card-1', 1_000)
  recordRunStart(starts, 'card-1', 9_000)

  const marker = consumeRunDurationMessage(starts, 'card-1', 205_000)
  assert.equal(marker?.role, 'system')
  assert.equal(marker?.content, '')
  assert.deepEqual(marker?.meta, {
    kind: 'run-duration',
    durationMs: '204000',
  })
  assert.equal(consumeRunDurationMessage(starts, 'card-1', 206_000), undefined)
})

test('renders run duration as one quiet line without normal message chrome', () => {
  const markup = renderToStaticMarkup(
    <MessageBubble
      language="zh-CN"
      message={{
        id: 'duration-1',
        role: 'system',
        content: '',
        createdAt: '2026-07-19T12:00:00.000Z',
        meta: {
          kind: 'run-duration',
          durationMs: '204000',
        },
      }}
      workspacePath="D:/Git/chill-vibe"
      answeredOption={null}
      onSelectAskUserOption={() => {}}
    />,
  )

  assert.match(markup, /class="message-run-duration"/)
  assert.match(markup, />已运行 3分钟24秒</)
  assert.doesNotMatch(markup, /message-topline/)
  assert.doesNotMatch(markup, /message-role/)
})
