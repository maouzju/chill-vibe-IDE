import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRemoteMonitorSnapshot,
  createRemoteMonitorManager,
  pickLanIPv4,
  type RemoteMonitorSnapshot,
} from '../server/remote-monitor.ts'
import type { ChatStreamTapEvent } from '../server/chat-stream-tap.ts'

const sampleSnapshot: RemoteMonitorSnapshot = {
  generatedAt: 1,
  columns: [
    {
      id: 'col-1',
      title: '工作区 A',
      cards: [
        {
          id: 'card-1',
          title: '修复登录',
          provider: 'claude',
          model: 'claude-fable-5',
          status: 'streaming',
          streamId: 's-1',
          lastMessagePreview: '正在修…',
        },
      ],
    },
  ],
}

type Harness = {
  manager: ReturnType<typeof createRemoteMonitorManager>
  emitTap: (event: ChatStreamTapEvent) => void
  tapCount: () => number
}

const createHarness = (options?: {
  activeStreams?: Array<{ streamId: string; cardId?: string; backlog: Array<{ event: string; data: unknown }> }>
}): Harness => {
  const listeners = new Set<(event: ChatStreamTapEvent) => void>()

  const manager = createRemoteMonitorManager({
    loadSnapshot: async () => sampleSnapshot,
    tapStreams: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listActiveStreams: () =>
      (options?.activeStreams ?? []).map((stream) => ({
        streamId: stream.streamId,
        cardId: stream.cardId,
        backlog: stream.backlog as ChatStreamTapEvent['envelope'][],
      })),
  })

  return {
    manager,
    emitTap: (event) => {
      for (const listener of listeners) {
        listener(event)
      }
    },
    tapCount: () => listeners.size,
  }
}

const startOnLoopback = (harness: Harness) =>
  harness.manager.start({ host: '127.0.0.1', port: 0 })

const readSseEvents = async (
  response: Response,
  expectedCount: number,
  timeoutMs = 5000,
): Promise<Array<{ streamId: string; cardId?: string; event: string; data: unknown }>> => {
  assert.ok(response.body, 'SSE response should expose a body stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: Array<{ streamId: string; cardId?: string; event: string; data: unknown }> = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs

  while (events.length < expectedCount) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${expectedCount} SSE events, got ${events.length}`)
    }

    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })

    let separatorIndex = buffer.indexOf('\n\n')
    while (separatorIndex >= 0) {
      const frame = buffer.slice(0, separatorIndex)
      buffer = buffer.slice(separatorIndex + 2)

      const dataLines = frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))

      if (dataLines.length > 0 && frame.includes('event: stream')) {
        events.push(JSON.parse(dataLines.join('\n')))
      }

      separatorIndex = buffer.indexOf('\n\n')
    }
  }

  void reader.cancel().catch(() => undefined)
  return events
}

test('remote monitor rejects missing or wrong tokens and non-GET methods', async () => {
  const harness = createHarness()
  const info = await startOnLoopback(harness)

  try {
    const noToken = await fetch(`http://127.0.0.1:${info.port}/api/snapshot`)
    assert.equal(noToken.status, 401)

    const wrongToken = await fetch(`http://127.0.0.1:${info.port}/api/snapshot?token=nope`)
    assert.equal(wrongToken.status, 401)

    const post = await fetch(`http://127.0.0.1:${info.port}/api/snapshot?token=${info.token}`, {
      method: 'POST',
    })
    assert.equal(post.status, 405)
  } finally {
    await harness.manager.stop()
  }
})

test('remote monitor serves the read-only snapshot with a valid token', async () => {
  const harness = createHarness()
  const info = await startOnLoopback(harness)

  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/snapshot?token=${info.token}`)
    assert.equal(response.status, 200)
    const payload = (await response.json()) as RemoteMonitorSnapshot
    assert.deepEqual(payload, sampleSnapshot)
  } finally {
    await harness.manager.stop()
  }
})

test('remote monitor serves the mobile page shell with a valid token', async () => {
  const harness = createHarness()
  const info = await startOnLoopback(harness)

  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/?token=${info.token}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
    const html = await response.text()
    assert.match(html, /Chill Vibe/)
    assert.match(html, /api\/events/)
  } finally {
    await harness.manager.stop()
  }
})

test('remote monitor SSE replays active stream backlog before forwarding live tap events', async () => {
  const harness = createHarness({
    activeStreams: [
      {
        streamId: 's-1',
        cardId: 'card-1',
        backlog: [
          { event: 'delta', data: { content: 'earlier ' } },
          { event: 'delta', data: { content: 'text' } },
        ],
      },
    ],
  })
  const info = await startOnLoopback(harness)

  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/events?token=${info.token}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)

    // Live events raced against connection setup are the SSE writer's problem,
    // not the test's: emit only after the server has registered the client.
    const waitForClient = async () => {
      const deadline = Date.now() + 5000
      while (harness.manager.getStatus().clientCount < 1) {
        if (Date.now() > deadline) {
          throw new Error('SSE client never registered')
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    const eventsPromise = readSseEvents(response, 4)
    await waitForClient()
    harness.emitTap({
      streamId: 's-1',
      cardId: 'card-1',
      envelope: { event: 'delta', data: { content: ' live' } },
    })
    harness.emitTap({
      streamId: 's-1',
      cardId: 'card-1',
      envelope: { event: 'done', data: {} },
    })

    const events = await eventsPromise
    assert.deepEqual(
      events.map((entry) => ({ streamId: entry.streamId, event: entry.event })),
      [
        { streamId: 's-1', event: 'delta' },
        { streamId: 's-1', event: 'delta' },
        { streamId: 's-1', event: 'delta' },
        { streamId: 's-1', event: 'done' },
      ],
    )
    assert.deepEqual(events[0]?.data, { content: 'earlier ' })
    assert.deepEqual(events[2]?.data, { content: ' live' })
  } finally {
    await harness.manager.stop()
  }
})

test('remote monitor stop closes the server and releases the stream tap', async () => {
  const harness = createHarness()
  const info = await startOnLoopback(harness)
  assert.equal(harness.tapCount(), 1)

  await harness.manager.stop()

  assert.equal(harness.tapCount(), 0)
  assert.equal(harness.manager.getStatus().running, false)
  await assert.rejects(fetch(`http://127.0.0.1:${info.port}/api/snapshot?token=${info.token}`))
})

test('buildRemoteMonitorSnapshot maps cards to a lightweight preview without full transcripts', () => {
  const snapshot = buildRemoteMonitorSnapshot({
    columns: [
      {
        id: 'col-1',
        title: '工作区',
        cards: {
          'card-1': {
            id: 'card-1',
            title: '长任务',
            provider: 'claude',
            model: 'claude-fable-5',
            status: 'streaming',
            streamId: 's-9',
            messages: [
              { role: 'user', content: '开始干活' },
              { role: 'assistant', content: `好的，${'字'.repeat(500)}` },
              { role: 'system', content: '内部噪音不应成为预览' },
            ],
          },
        },
      },
    ],
  })

  assert.equal(snapshot.columns.length, 1)
  const card = snapshot.columns[0]?.cards[0]
  assert.ok(card)
  assert.equal(card.id, 'card-1')
  assert.equal(card.streamId, 's-9')
  assert.ok(card.lastMessagePreview?.startsWith('好的，'))
  assert.ok((card.lastMessagePreview?.length ?? 0) <= 200)
  assert.ok(!('messages' in card), 'snapshot cards must not carry full transcripts')
  assert.ok(snapshot.generatedAt > 0)
})

test('pickLanIPv4 prefers real private LAN addresses over VPN/benchmark ranges', () => {
  // Clash/代理 TUN 网卡常占用 198.18.0.0/15 保留段，真机扫码连不上它。
  const withVpnFirst = {
    'Clash Tunnel': [{ family: 'IPv4' as const, internal: false, address: '198.18.0.1' }],
    WLAN: [{ family: 'IPv4' as const, internal: false, address: '192.168.31.25' }],
  }
  assert.equal(pickLanIPv4(withVpnFirst), '192.168.31.25')

  const linkLocalOnlyPlusTen = {
    Ethernet: [{ family: 'IPv4' as const, internal: false, address: '169.254.10.9' }],
    Corp: [{ family: 'IPv4' as const, internal: false, address: '10.4.2.8' }],
  }
  assert.equal(pickLanIPv4(linkLocalOnlyPlusTen), '10.4.2.8')

  const vpnOnly = {
    'Clash Tunnel': [{ family: 'IPv4' as const, internal: false, address: '198.18.0.1' }],
  }
  // 没有更好的选择时仍然返回它（好过直接退回 127.0.0.1）。
  assert.equal(pickLanIPv4(vpnOnly), '198.18.0.1')

  assert.equal(pickLanIPv4({}), null)
})

test('remote monitor start is idempotent and reports status', async () => {
  const harness = createHarness()
  const first = await startOnLoopback(harness)
  const second = await startOnLoopback(harness)

  try {
    assert.equal(first.port, second.port)
    assert.equal(first.token, second.token)
    assert.equal(harness.tapCount(), 1)
    const status = harness.manager.getStatus()
    assert.equal(status.running, true)
    assert.equal(status.port, first.port)
  } finally {
    await harness.manager.stop()
  }
})
