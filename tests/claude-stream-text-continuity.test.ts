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

// 症状：气泡「完成。末」下面紧跟一条完整的「已完成。……」（2026-09-16 用户截图，
// 会话 a2621231）。原生 jsonl 里根本没有 msg_011Cf6phFS：上游流吐了几个字就断，
// CLI 在进程内静默重试开了新 message（msg_011Cf6pkDY），旧半截既没有
// content_block_stop 也没有 `assistant` 落盘事件。IDE 按 message_start 正确开了新气泡，
// 却没人收回被重试替代的那半截。
test('a message_start arriving while the previous text block is still open retracts the orphaned partial bubble', () => {
  const retracted: { itemId: string; content: string }[] = []
  const sinkWithRetract = createRecordingSink()
  const retractingParser = createClaudeTurnParser({
    request: { prompt: 'go', provider: 'claude' } as ChatRequest,
    sink: {
      ...sinkWithRetract.sink,
      onAssistantMessage: (message: { itemId: string; content: string }) => retracted.push(message),
    },
    language: 'zh-CN',
    killChild: () => {},
  })

  retractingParser.handleLine(line({ type: 'system', subtype: 'init', session_id: 'sess-3' }))
  retractingParser.handleLine(
    line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_dead' } } }),
  )
  retractingParser.handleLine(
    line({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    }),
  )
  retractingParser.handleLine(
    line({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成。末' } },
    }),
  )
  // No content_block_stop / assistant event: upstream died, CLI retried in-process.
  retractingParser.handleLine(
    line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_alive' } } }),
  )
  retractingParser.handleLine(
    line({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    }),
  )
  retractingParser.handleLine(
    line({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已完成。' } },
    }),
  )

  const deadItemId = sinkWithRetract.record.deltas.find((d) => d.content === '完成。末')?.itemId
  assert.ok(deadItemId, 'the partial text was streamed under an itemId')
  assert.deepEqual(
    retracted,
    [{ itemId: deadItemId, content: '' }],
    'the orphaned block must be retracted exactly once when the retry message starts',
  )
})

test('a properly closed message followed by a new message_start is NOT retracted', () => {
  const retracted: { itemId: string; content: string }[] = []
  const { sink } = createRecordingSink()
  const parser = createClaudeTurnParser({
    request: { prompt: 'go', provider: 'claude' } as ChatRequest,
    sink: {
      ...sink,
      onAssistantMessage: (message: { itemId: string; content: string }) => retracted.push(message),
    },
    language: 'zh-CN',
    killChild: () => {},
  })
  parser.handleLine(line({ type: 'system', subtype: 'init', session_id: 'sess-4' }))
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
  parser.handleLine(
    line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_b' } } }),
  )
  assert.deepEqual(retracted, [])
})

// 症状：卡片永久留着一条把 [SYSTEM NOTIFICATION]/<task-notification> 原样复读的垃圾气泡
//   （2026-10-17，CLI 2.1.280，msg_011Cg88kjJLt3hXn6nVKQbmd:text:0）。
// 根因：CLI 判定该回复无效、不落盘，注入 meta user「The previous response failed to produce
//   a valid tool call. Please retry the tool call now.」让模型重来；IDE 已流出的气泡没人收回。
for (const contentShape of ['string', 'text-blocks'] as const) {
  test(`CLI "failed to produce a valid tool call" retry (${contentShape}) retracts the discarded message bubbles`, () => {
    const retracted: { itemId: string; content: string }[] = []
    const logs: string[] = []
    const base = createRecordingSink()
    const parser = createClaudeTurnParser({
      request: { prompt: 'go', provider: 'claude' } as ChatRequest,
      sink: {
        ...base.sink,
        onLog: (message: string) => logs.push(message),
        onAssistantMessage: (message: { itemId: string; content: string }) => retracted.push(message),
      },
      language: 'zh-CN',
      killChild: () => {},
    })
    parser.handleLine(line({ type: 'system', subtype: 'init', session_id: 'sess-5' }))
    parser.handleLine(
      line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_bad' } } }),
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
          delta: { type: 'text_delta', text: '[SYSTEM NOTIFICATION - NOT USER INPUT] <task-notification>' },
        },
      }),
    )
    parser.handleLine(line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }))
    parser.handleLine(
      line({
        type: 'stream_event',
        event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      }),
    )
    parser.handleLine(line({ type: 'stream_event', event: { type: 'message_stop' } }))
    const retryText =
      'The previous response failed to produce a valid tool call. Please retry the tool call now.'
    parser.handleLine(
      line({
        type: 'user',
        isMeta: true,
        message: {
          role: 'user',
          content: contentShape === 'string' ? retryText : [{ type: 'text', text: retryText }],
        },
      }),
    )
    const badItemId = base.record.deltas[0]?.itemId
    assert.equal(badItemId, 'msg_bad:text:0')
    assert.deepEqual(retracted, [{ itemId: badItemId, content: '' }])
    assert.ok(!logs.some((entry) => entry.includes('failed to produce a valid tool call')))
    assert.ok(!base.record.deltas.some((d) => d.content.includes('failed to produce')))
    assert.ok(
      !JSON.stringify(base.record.activities).includes('failed to produce'),
      'retry nudge must not surface as an activity',
    )
  })
}

test('a real reply after the CLI retry is not swallowed by a half-open tool-call block of the discarded message', () => {
  const base = createRecordingSink()
  const parser = createClaudeTurnParser({
    request: { prompt: 'go', provider: 'claude' } as ChatRequest,
    sink: base.sink,
    language: 'zh-CN',
    killChild: () => {},
  })
  parser.handleLine(line({ type: 'system', subtype: 'init', session_id: 'sess-6' }))
  parser.handleLine(line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_bad' } } }))
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
        delta: { type: 'text_delta', text: '<function_calls>\n<invoke name="AskUserQuestion">' },
      },
    }),
  )
  parser.handleLine(line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }))
  parser.handleLine(line({ type: 'stream_event', event: { type: 'message_stop' } }))
  parser.handleLine(
    line({
      type: 'user',
      isMeta: true,
      message: {
        role: 'user',
        content:
          'The previous response failed to produce a valid tool call. Please retry the tool call now.',
      },
    }),
  )
  parser.handleLine(line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_real' } } }))
  parser.handleLine(
    line({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    }),
  )
  parser.handleLine(
    line({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '真正的回复' } },
    }),
  )
  parser.handleLine(line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }))
  parser.handleLine(line({ type: 'stream_event', event: { type: 'message_stop' } }))
  parser.handleLine(line({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-6' }))

  const visible = base.record.deltas.map((d) => d.content).join('')
  assert.ok(visible.includes('真正的回复'), `real reply was swallowed; visible=${JSON.stringify(visible)}`)
})
