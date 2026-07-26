import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage, ChatRequest } from '../shared/schema.ts'
import { createClaudeTurnParser } from '../server/providers.ts'
import { resolveStreamedAssistantMessageTarget } from '../src/app-helpers.ts'

// Regression guard for the "Opus 输出流被切碎" report: a single Claude text
// content block streams as many `text_delta` chunks, and the CLI can interleave
// tool/command activity events between those chunks (parallel agents, background
// tool results). The renderer keys streamed prose by the delta's `itemId`; when
// Claude deltas carried no id at all, an activity arriving mid-sentence made the
// renderer start a brand new bubble, splitting one sentence into two ("哪些是空"
// + tool card + "壳。").
const createRecordingSink = () => {
  const record = {
    deltas: [] as { content: string; itemId?: string }[],
    activities: [] as unknown[],
    errors: [] as string[],
    done: false,
  }

  return {
    record,
    sink: {
      onSession: () => {},
      onDelta: (content: string, itemId?: string) => record.deltas.push({ content, itemId }),
      onLog: () => {},
      onAssistantMessage: () => {},
      onActivity: (activity: unknown) => record.activities.push(activity),
      onDone: () => {
        record.done = true
      },
      onError: (message: string) => {
        record.errors.push(message)
      },
    },
  }
}

const createParser = () => {
  const { record, sink } = createRecordingSink()
  const parser = createClaudeTurnParser({
    request: { prompt: 'go', provider: 'claude' } as ChatRequest,
    sink,
    language: 'zh-CN',
    killChild: () => {},
  })
  return { record, parser }
}

const line = (value: unknown) => JSON.stringify(value)

test('Claude text deltas in one content block keep a stable itemId across interleaved activity', () => {
  const { record, parser } = createParser()

  parser.handleLine(line({ type: 'system', subtype: 'init', session_id: 'sess-1' }))
  parser.handleLine(
    line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } }),
  )
  parser.handleLine(
    line({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    }),
  )
  parser.handleLine(
    line({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '我自己核一下"哪些包是真代码、哪些是空' },
      },
    }),
  )

  // A tool result from an earlier, still-open tool lands mid-sentence.
  parser.handleLine(
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_mid', name: 'Read', input: { file_path: 'session.ts' } },
        ],
      },
    }),
  )

  parser.handleLine(
    line({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '壳"。' },
      },
    }),
  )

  const textDeltas = record.deltas.filter((entry) => entry.content.trim())
  assert.equal(textDeltas.length, 2, 'both halves of the sentence should reach the renderer')
  assert.ok(
    textDeltas[0].itemId,
    'Claude text deltas must carry a content-block item id so the renderer can keep appending to one bubble',
  )
  assert.equal(
    textDeltas[0].itemId,
    textDeltas[1].itemId,
    'deltas from the same content block must share one itemId even when activity interleaves',
  )
})

test('Claude text deltas from different content blocks get different itemIds', () => {
  const { record, parser } = createParser()

  parser.handleLine(line({ type: 'system', subtype: 'init', session_id: 'sess-2' }))
  parser.handleLine(
    line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_a' } } }),
  )
  parser.handleLine(
    line({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    }),
  )
  parser.handleLine(
    line({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '先看代码。' } },
    }),
  )
  parser.handleLine(line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }))

  // Second assistant message after the tool round-trip: a genuinely new bubble.
  parser.handleLine(
    line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_b' } } }),
  )
  parser.handleLine(
    line({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    }),
  )
  parser.handleLine(
    line({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '结论如下。' } },
    }),
  )

  const textDeltas = record.deltas.filter((entry) => entry.content.trim())
  assert.equal(textDeltas.length, 2)
  assert.ok(textDeltas[0].itemId && textDeltas[1].itemId)
  assert.notEqual(
    textDeltas[0].itemId,
    textDeltas[1].itemId,
    'separate assistant messages must stay separate bubbles',
  )
})

test('an itemId keeps resolving to the same bubble after activity cleared the active message', () => {
  const itemId = 'msg_1:text:0'
  const first = resolveStreamedAssistantMessageTarget({
    messages: [],
    provider: 'claude',
    streamId: 'stream-1',
    itemId,
    model: 'claude-opus-5',
  })
  assert.ok(first.messageToAppend, 'the first delta of a block opens a bubble')

  const messages: ChatMessage[] = [
    first.messageToAppend as ChatMessage,
    {
      id: 'claude:stream-1:item:toolu_mid',
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    },
  ]

  // onActivity clears activeMessageId/activeItemId so that post-tool prose opens
  // a new bubble. A delta that still carries its block id must ignore that reset
  // and keep appending to the bubble it started.
  const second = resolveStreamedAssistantMessageTarget({
    messages,
    provider: 'claude',
    streamId: 'stream-1',
    itemId,
    activeMessageId: undefined,
    activeItemId: undefined,
    model: 'claude-opus-5',
  })

  assert.equal(second.messageId, first.messageId)
  assert.equal(second.messageToAppend, undefined, 'no second bubble for the same block')
})
