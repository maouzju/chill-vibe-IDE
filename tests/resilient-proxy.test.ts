import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import zlib from 'node:zlib'

import { startResilientProxyServer } from '../server/resilient-proxy.ts'

const readJsonBody = async (request: http.IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

const parseSseDeltaText = (payload: string) => {
  const deltas: string[] = []
  for (const block of payload.split(/\r?\n\r?\n/)) {
    const dataLine = block
      .split(/\r?\n/)
      .find((line) => line.startsWith('data: '))
    if (!dataLine) {
      continue
    }

    const data = dataLine.slice(6)
    if (!data || data === '[DONE]') {
      continue
    }

    try {
      const parsed = JSON.parse(data) as Record<string, unknown>
      if (
        parsed.type === 'content_block_delta' &&
        typeof parsed.delta === 'object' &&
        parsed.delta !== null &&
        'text' in parsed.delta &&
        typeof parsed.delta.text === 'string'
      ) {
        deltas.push(parsed.delta.text)
      }
    } catch {
      // Ignore unrelated SSE blocks.
    }
  }

  return deltas.join('')
}

const parseResponsesSseDeltaText = (payload: string) => {
  const deltas: string[] = []
  for (const block of payload.split(/\r?\n\r?\n/)) {
    const dataLine = block
      .split(/\r?\n/)
      .find((line) => line.startsWith('data: '))
    if (!dataLine) {
      continue
    }

    const data = dataLine.slice(6)
    if (!data || data === '[DONE]') {
      continue
    }

    try {
      const parsed = JSON.parse(data) as Record<string, unknown>
      if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
        deltas.push(parsed.delta)
      }
    } catch {
      // Ignore unrelated SSE blocks.
    }
  }

  return deltas.join('')
}

const hasResponsesCompletedEvent = (payload: string) => {
  for (const block of payload.split(/\r?\n\r?\n/)) {
    const dataLine = block
      .split(/\r?\n/)
      .find((line) => line.startsWith('data: '))
    if (!dataLine) {
      continue
    }

    const data = dataLine.slice(6)
    if (!data || data === '[DONE]') {
      continue
    }

    try {
      const parsed = JSON.parse(data) as Record<string, unknown>
      if (parsed.type === 'response.completed') {
        return true
      }
    } catch {
      // Ignore unrelated SSE blocks.
    }
  }

  return false
}

const parseSseEvents = (payload: string) => {
  const events: Array<Record<string, unknown>> = []
  for (const block of payload.split(/\r?\n\r?\n/)) {
    const dataLine = block.split(/\r?\n/).find((line) => line.startsWith('data: '))
    const data = dataLine?.slice(6)
    if (!data || data === '[DONE]') {
      continue
    }

    events.push(JSON.parse(data) as Record<string, unknown>)
  }

  return events
}

const writeSseEvents = (response: http.ServerResponse, events: Array<Record<string, unknown>>) => {
  for (const event of events) {
    response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the test condition.')
    }

    await delay(5)
  }
}

const drainRequest = async (request: http.IncomingMessage) => {
  for await (const chunk of request) {
    void chunk
  }
}

const listenOnLoopback = async (server: http.Server) => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind upstream test server.')
  }

  return `http://127.0.0.1:${address.port}`
}

const closeServer = async (server: http.Server) => {
  server.closeAllConnections()
  server.close()
  await once(server, 'close').catch(() => undefined)
}

describe('internal resilient proxy', () => {

  it('strips content-encoding from gzip upstream streams so clients never hit ZlibError', async () => {
    let upstreamAcceptEncoding: string | undefined

    const upstream = http.createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/messages') {
        response.statusCode = 404
        response.end('not found')
        return
      }

      upstreamAcceptEncoding = request.headers['accept-encoding'] as string | undefined
      await readJsonBody(request)

      const sse = [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg-1","model":"claude-opus-4-7"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello gzip"}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n')

      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream')
      response.setHeader('Content-Encoding', 'gzip')
      response.end(zlib.gzipSync(sse))
    })

    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind upstream test server.')
    }

    const proxy = await startResilientProxyServer({
      provider: 'claude',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      maxRecoveryRetries: 0,
    })

    try {
      const response = await fetch(`${proxy.clientBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip, deflate, br',
          'x-api-key': 'sk-test',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })

      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-encoding'), null)
      assert.equal(parseSseDeltaText(await response.text()), 'Hello gzip')
      assert.equal(upstreamAcceptEncoding, 'identity')
    } finally {
      await proxy.stop()
      upstream.close()
      await once(upstream, 'close').catch(() => undefined)
    }
  })

  it('honors unlimited recovery retries for long-running streams', async () => {
    let requestCount = 0

    const upstream = http.createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/messages') {
        response.statusCode = 404
        response.end('not found')
        return
      }

      requestCount += 1
      await readJsonBody(request)

      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream')
      response.write('event: message_start\n')
      response.write('data: {"type":"message_start","message":{"id":"msg-1","model":"claude-opus-4-7"}}\n\n')

      if (requestCount < 4) {
        response.write('event: content_block_delta\n')
        response.write(`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"part-${requestCount} "}}\n\n`)
        response.end()
        return
      }

      response.write('event: content_block_delta\n')
      response.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}\n\n')
      response.write('event: message_delta\n')
      response.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n')
      response.end()
    })

    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind upstream test server.')
    }

    const proxy = await startResilientProxyServer({
      provider: 'claude',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      maxRecoveryRetries: -1,
    })

    try {
      const response = await fetch(`${proxy.clientBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'sk-test',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          stream: true,
          messages: [
            {
              role: 'user',
              content: 'Keep going until done',
            },
          ],
        }),
      })

      assert.equal(response.status, 200)
      assert.equal(parseSseDeltaText(await response.text()), 'part-1 part-2 part-3 done')
      assert.equal(requestCount, 4)
    } finally {
      await proxy.stop()
      upstream.close()
      await once(upstream, 'close').catch(() => undefined)
    }
  })

  it('retries interrupted Claude message streams without duplicating delivered text', async () => {
    const requests: Record<string, unknown>[] = []
    let requestCount = 0

    const upstream = http.createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/messages') {
        response.statusCode = 404
        response.end('not found')
        return
      }

      requestCount += 1
      const body = await readJsonBody(request)
      requests.push(body)

      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream')
      response.write('event: message_start\n')
      response.write('data: {"type":"message_start","message":{"id":"msg-1","model":"claude-opus-4-7"}}\n\n')
      response.write('event: content_block_start\n')
      response.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')

      if (requestCount === 1) {
        response.write('event: content_block_delta\n')
        response.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n')
        response.end()
        return
      }

      response.write('event: content_block_delta\n')
      response.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}\n\n')
      response.write('event: message_stop\n')
      response.write('data: {"type":"message_stop"}\n\n')
      response.end()
    })

    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind upstream test server.')
    }

    const proxy = await startResilientProxyServer({
      provider: 'claude',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      maxRecoveryRetries: 2,
    })

    try {
      const response = await fetch(`${proxy.clientBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'sk-test',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          stream: true,
          messages: [
            {
              role: 'user',
              content: 'Say hello',
            },
          ],
        }),
      })

      assert.equal(response.status, 200)
      const payload = await response.text()

      assert.equal(parseSseDeltaText(payload), 'Hello world')
      assert.equal(requests.length, 2)
      assert.deepEqual((requests[0]?.messages as unknown[])?.length, 1)
      assert.deepEqual((requests[1]?.messages as unknown[])?.length, 2)
      assert.deepEqual((requests[1]?.messages as Array<Record<string, unknown>>)?.at(-1), {
        role: 'assistant',
        content: 'Hello ',
      })
    } finally {
      await proxy.stop()
      upstream.close()
      await once(upstream, 'close').catch(() => undefined)
    }
  })

  it('treats a terminal Claude message_delta as a completed stream even when message_stop is omitted', async () => {
    const requests: Record<string, unknown>[] = []

    const upstream = http.createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/messages') {
        response.statusCode = 404
        response.end('not found')
        return
      }

      const body = await readJsonBody(request)
      requests.push(body)

      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream')
      response.write('event: message_start\n')
      response.write('data: {"type":"message_start","message":{"id":"msg-terminal","model":"claude-opus-4-7"}}\n\n')
      response.write('event: content_block_start\n')
      response.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
      response.write('event: content_block_delta\n')
      response.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}\n\n')
      response.write('event: message_delta\n')
      response.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n')
      response.end()
    })

    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind upstream test server.')
    }

    const proxy = await startResilientProxyServer({
      provider: 'claude',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      maxRecoveryRetries: 2,
    })

    try {
      const response = await fetch(`${proxy.clientBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'sk-test',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          stream: true,
          messages: [
            {
              role: 'user',
              content: 'Say hello',
            },
          ],
        }),
      })

      assert.equal(response.status, 200)
      const payload = await response.text()

      assert.equal(parseSseDeltaText(payload), 'Hello world')
      assert.equal(requests.length, 1)
      assert.deepEqual((requests[0]?.messages as unknown[])?.length, 1)
    } finally {
      await proxy.stop()
      upstream.close()
      await once(upstream, 'close').catch(() => undefined)
    }
  })

  it('recovers completed OpenAI responses when the stream closes before response.completed', async () => {
    const requests: Record<string, unknown>[] = []
    let getCount = 0

    const upstream = http.createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/v1/responses') {
        const body = await readJsonBody(request)
        requests.push(body)

        response.statusCode = 200
        response.setHeader('Content-Type', 'text/event-stream')
        response.write('event: response.created\n')
        response.write(
          'data: {"type":"response.created","response":{"id":"resp-1","model":"gpt-5.5","status":"in_progress"}}\n\n',
        )
        response.write('event: response.output_item.added\n')
        response.write(
          'data: {"type":"response.output_item.added","response_id":"resp-1","output_index":0,"item":{"id":"msg-1","type":"message","status":"in_progress","role":"assistant","content":[]}}\n\n',
        )
        response.write('event: response.output_text.delta\n')
        response.write(
          'data: {"type":"response.output_text.delta","response_id":"resp-1","item_id":"msg-1","output_index":0,"content_index":0,"delta":"Hello "}\n\n',
        )
        response.end()
        return
      }

      if (request.method === 'GET' && request.url === '/v1/responses/resp-1') {
        getCount += 1
        response.statusCode = 200
        response.setHeader('Content-Type', 'application/json')
        response.end(
          JSON.stringify({
            id: 'resp-1',
            object: 'response',
            model: 'gpt-5.5',
            status: 'completed',
            output: [
              {
                id: 'msg-1',
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: 'Hello world',
                  },
                ],
              },
            ],
          }),
        )
        return
      }

      response.statusCode = 404
      response.end('not found')
    })

    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind upstream test server.')
    }

    const proxy = await startResilientProxyServer({
      provider: 'codex',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      maxRecoveryRetries: 2,
    })

    try {
      const response = await fetch(`${proxy.clientBaseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk-test',
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: true,
          input: 'Say hello',
        }),
      })

      assert.equal(response.status, 200)
      const payload = await response.text()

      assert.equal(parseResponsesSseDeltaText(payload), 'Hello world')
      assert.equal(hasResponsesCompletedEvent(payload), true)
      assert.equal(requests.length, 1)
      assert.equal(getCount, 1)
    } finally {
      await proxy.stop()
      upstream.close()
      await once(upstream, 'close').catch(() => undefined)
    }
  })

  // 僵尸重试守卫（Known Pitfalls #430）：客户端已经走了，代理就不许再替它向上游发任何请求。
  const clientGoneScenarios = [
    {
      name: 'Claude messages',
      provider: 'claude' as const,
      path: '/v1/messages',
      body: { model: 'claude-fable-5-2', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    },
    {
      name: 'OpenAI responses',
      provider: 'codex' as const,
      path: '/v1/responses',
      body: { model: 'gpt-6.2', stream: true, input: 'hi' },
    },
    {
      name: 'chat completions',
      provider: 'codex' as const,
      path: '/v1/chat/completions',
      body: { model: 'gpt-6.2', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    },
  ]

  for (const scenario of clientGoneScenarios) {
    it(`stops retrying a failing upstream once the ${scenario.name} client has gone away`, async () => {
      let requestCount = 0

      const upstream = http.createServer(async (request, response) => {
        requestCount += 1
        await drainRequest(request)
        response.statusCode = 500
        response.setHeader('Content-Type', 'application/json')
        response.end('{"error":{"message":"Internal server error"}}')
      })

      const upstreamBaseUrl = await listenOnLoopback(upstream)
      const proxy = await startResilientProxyServer({
        provider: scenario.provider,
        upstreamBaseUrl,
        maxRecoveryRetries: -1,
        retryDelayBaseMs: 2,
      })

      try {
        const client = new AbortController()
        const pending = fetch(`${proxy.origin}${scenario.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-test' },
          body: JSON.stringify(scenario.body),
          signal: client.signal,
        })
          .then((response) => response.text())
          .catch(() => undefined)

        // 代理已经在替这个请求重试了，此时客户端放弃（CLI 超时 / 用户点停止）。
        await waitFor(() => requestCount >= 2)
        client.abort()
        await pending
        await delay(100)

        const countWhenClientLeft = requestCount
        await delay(700)

        assert.equal(
          requestCount,
          countWhenClientLeft,
          'the proxy kept hammering the upstream for a client that already left',
        )
      } finally {
        await proxy.stop()
        await closeServer(upstream)
      }
    })
  }

  it('cancels the in-flight upstream generation once the client has gone away mid-stream', async () => {
    let requestCount = 0
    let upstreamCancelled = 0

    const upstream = http.createServer(async (request, response) => {
      requestCount += 1
      await drainRequest(request)
      response.on('close', () => {
        if (!response.writableEnded) {
          upstreamCancelled += 1
        }
      })

      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream')
      response.write('event: message_start\n')
      response.write('data: {"type":"message_start","message":{"id":"msg-1","model":"claude-fable-5-2"}}\n\n')
      response.write('event: content_block_delta\n')
      response.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial "}}\n\n')
      // 故意不结束：模拟一段还在生成中的长回复。
    })

    const upstreamBaseUrl = await listenOnLoopback(upstream)
    const proxy = await startResilientProxyServer({
      provider: 'claude',
      upstreamBaseUrl,
      maxRecoveryRetries: -1,
      retryDelayBaseMs: 2,
      stallTimeoutMs: 150,
    })

    try {
      const client = new AbortController()
      const response = await fetch(`${proxy.origin}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify({
          model: 'claude-fable-5-2',
          stream: true,
          messages: [{ role: 'user', content: 'write something long' }],
        }),
        signal: client.signal,
      })

      const reader = response.body!.getReader()
      await reader.read()
      client.abort()
      await reader.read().catch(() => undefined)

      await delay(700)

      assert.equal(requestCount, 1, 'the proxy re-sent the request for a client that already left')
      assert.equal(upstreamCancelled, 1, 'the abandoned upstream generation was left running')
    } finally {
      await proxy.stop()
      await closeServer(upstream)
    }
  })

  it('cancels a stalled upstream stream before retrying so two generations never run at once', async () => {
    let requestCount = 0
    let stalledStreamCancelled = false
    let stalledStreamStillOpenAtRetry: boolean | null = null

    const upstream = http.createServer(async (request, response) => {
      requestCount += 1
      await drainRequest(request)

      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream')
      response.write('event: message_start\n')
      response.write('data: {"type":"message_start","message":{"id":"msg-1","model":"claude-fable-5-2"}}\n\n')

      if (requestCount === 1) {
        response.on('close', () => {
          stalledStreamCancelled = true
        })
        // 第一次卡住不动：既不出字也不结束。
        return
      }

      stalledStreamStillOpenAtRetry = !stalledStreamCancelled
      response.write('event: content_block_delta\n')
      response.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n')
      response.write('event: message_stop\n')
      response.write('data: {"type":"message_stop"}\n\n')
      response.end()
    })

    const upstreamBaseUrl = await listenOnLoopback(upstream)
    const proxy = await startResilientProxyServer({
      provider: 'claude',
      upstreamBaseUrl,
      maxRecoveryRetries: 2,
      retryDelayBaseMs: 40,
      stallTimeoutMs: 120,
    })

    try {
      const response = await fetch(`${proxy.origin}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify({
          model: 'claude-fable-5-2',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })

      assert.equal(parseSseDeltaText(await response.text()), 'done')
      assert.equal(requestCount, 2)
      assert.equal(
        stalledStreamStillOpenAtRetry,
        false,
        'the stalled generation was still running upstream when the retry was sent',
      )
    } finally {
      await proxy.stop()
      await closeServer(upstream)
    }
  })

  it('never regenerates a reply whose client left before the upstream finished it', async () => {
    let requestCount = 0

    const upstream = http.createServer(async (request, response) => {
      requestCount += 1
      await drainRequest(request)

      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream')
      response.write('event: message_start\n')
      response.write('data: {"type":"message_start","message":{"id":"msg-1","model":"claude-fable-5-2"}}\n\n')
      response.write('event: content_block_delta\n')
      response.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first "}}\n\n')

      await delay(80)
      if (response.destroyed) {
        return
      }

      response.write('event: content_block_delta\n')
      response.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"second"}}\n\n')
      response.write('event: message_stop\n')
      response.write('data: {"type":"message_stop"}\n\n')
      response.end()
    })

    const upstreamBaseUrl = await listenOnLoopback(upstream)
    const proxy = await startResilientProxyServer({
      provider: 'claude',
      upstreamBaseUrl,
      maxRecoveryRetries: -1,
      retryDelayBaseMs: 2,
    })

    try {
      const client = new AbortController()
      const response = await fetch(`${proxy.origin}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify({
          model: 'claude-fable-5-2',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: client.signal,
      })

      const reader = response.body!.getReader()
      await reader.read()
      client.abort()
      await reader.read().catch(() => undefined)

      await delay(700)

      assert.equal(requestCount, 1, 'the proxy paid for the same reply again with nobody listening')
    } finally {
      await proxy.stop()
      await closeServer(upstream)
    }
  })

  // ── 重试不许把两次生成拼在一起（2026-11-20 审查）────────────────────────────────

  const postStream = async (origin: string, path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-test' },
      body: JSON.stringify(body),
    })

    return parseSseEvents(await response.text())
  }

  const messagesBody = {
    model: 'claude-fable-5-2',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  }

  const fullThinkingReply = [
    { type: 'message_start', message: { id: 'msg-2', model: 'claude-fable-5-2' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Second attempt thoughts.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-second' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu-2', name: 'Bash', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } },
    { type: 'message_stop' },
  ]

  const unreplayableMessagesScenarios = [
    {
      name: 'a thinking block',
      firstAttempt: [
        { type: 'message_start', message: { id: 'msg-1', model: 'claude-fable-5-2' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'First attempt th' } },
      ],
    },
    {
      name: 'tool_use input',
      firstAttempt: [
        { type: 'message_start', message: { id: 'msg-1', model: 'claude-fable-5-2' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Running it.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu-1', name: 'Bash', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"comm' } },
      ],
    },
  ]

  for (const scenario of unreplayableMessagesScenarios) {
    it(`never splices a regenerated Claude reply onto ${scenario.name} the client already half-received`, async () => {
      let requestCount = 0

      const upstream = http.createServer(async (request, response) => {
        requestCount += 1
        await drainRequest(request)
        response.statusCode = 200
        response.setHeader('Content-Type', 'text/event-stream')
        writeSseEvents(response, requestCount === 1 ? scenario.firstAttempt : fullThinkingReply)
        response.end()
      })

      const upstreamBaseUrl = await listenOnLoopback(upstream)
      const proxy = await startResilientProxyServer({
        provider: 'claude',
        upstreamBaseUrl,
        maxRecoveryRetries: 2,
        retryDelayBaseMs: 2,
      })

      try {
        const events = await postStream(proxy.origin, '/v1/messages', messagesBody)
        const deltas = events
          .filter((event) => event.type === 'content_block_delta')
          .map((event) => event.delta as Record<string, unknown>)

        assert.equal(requestCount, 1, 'the proxy regenerated the reply on top of a half-delivered block')
        assert.equal(
          deltas.map((delta) => delta.thinking ?? '').join(''),
          scenario.name === 'a thinking block' ? 'First attempt th' : '',
        )
        assert.equal(
          deltas.map((delta) => delta.partial_json ?? '').join(''),
          scenario.name === 'tool_use input' ? '{"comm' : '',
        )
        assert.equal(deltas.some((delta) => delta.type === 'signature_delta'), false)
        assert.equal(events.at(-1)?.type, 'error', 'the client must be told the stream failed')
      } finally {
        await proxy.stop()
        await closeServer(upstream)
      }
    })
  }

  it('fails the stream when a retried Claude reply opens with thinking over a text block the client already holds', async () => {
    let requestCount = 0

    const upstream = http.createServer(async (request, response) => {
      requestCount += 1
      await drainRequest(request)
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream')
      writeSseEvents(
        response,
        requestCount === 1
          ? [
              { type: 'message_start', message: { id: 'msg-1', model: 'claude-fable-5-2' } },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sure, ' } },
            ]
          : fullThinkingReply,
      )
      response.end()
    })

    const upstreamBaseUrl = await listenOnLoopback(upstream)
    const proxy = await startResilientProxyServer({
      provider: 'claude',
      upstreamBaseUrl,
      maxRecoveryRetries: 3,
      retryDelayBaseMs: 2,
    })

    try {
      const events = await postStream(proxy.origin, '/v1/messages', messagesBody)
      const deltaTypes = events
        .filter((event) => event.type === 'content_block_delta')
        .map((event) => (event.delta as Record<string, unknown>).type)

      assert.deepEqual(deltaTypes, ['text_delta'], 'thinking was appended to the open text block')
      assert.equal(requestCount, 2)
      assert.equal(events.at(-1)?.type, 'error', 'the client must be told the stream failed')
    } finally {
      await proxy.stop()
      await closeServer(upstream)
    }
  })

  it('still delivers message_start and the first block start when the first Claude attempt failed before streaming', async () => {
    let requestCount = 0

    const upstream = http.createServer(async (request, response) => {
      requestCount += 1
      await drainRequest(request)
      if (requestCount === 1) {
        response.statusCode = 500
        response.end('{"error":{"message":"Internal server error"}}')
        return
      }

      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream')
      writeSseEvents(response, fullThinkingReply)
      response.end()
    })

    const upstreamBaseUrl = await listenOnLoopback(upstream)
    const proxy = await startResilientProxyServer({
      provider: 'claude',
      upstreamBaseUrl,
      maxRecoveryRetries: 2,
      retryDelayBaseMs: 2,
    })

    try {
      const events = await postStream(proxy.origin, '/v1/messages', messagesBody)

      assert.equal(requestCount, 2)
      assert.deepEqual(
        events.map((event) => event.type),
        fullThinkingReply.map((event) => event.type),
        'a retry after a pre-stream failure must relay the reply untouched',
      )
    } finally {
      await proxy.stop()
      await closeServer(upstream)
    }
  })

  const responsesBody = { model: 'gpt-6.2', stream: true, input: 'hi' }

  const startResponsesUpstream = async (attempts: Array<Array<Record<string, unknown>> | number>, tail?: Record<string, unknown>) => {
    const counts = { post: 0, get: 0 }

    const upstream = http.createServer(async (request, response) => {
      await drainRequest(request)
      if (request.method === 'GET') {
        counts.get += 1
        response.statusCode = tail ? 200 : 404
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(tail ?? { error: { message: 'not found' } }))
        return
      }

      const attempt = attempts[Math.min(counts.post, attempts.length - 1)]
      counts.post += 1
      if (typeof attempt === 'number') {
        response.statusCode = attempt
        response.end('{"error":{"message":"Internal server error"}}')
        return
      }

      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream')
      writeSseEvents(response, attempt)
      response.end()
    })

    const upstreamBaseUrl = await listenOnLoopback(upstream)
    const proxy = await startResilientProxyServer({
      provider: 'codex',
      upstreamBaseUrl,
      maxRecoveryRetries: 2,
      retryDelayBaseMs: 2,
    })

    return {
      counts,
      proxy,
      stop: async () => {
        await proxy.stop()
        await closeServer(upstream)
      },
    }
  }

  const regeneratedResponse = [
    { type: 'response.created', response: { id: 'resp-2', model: 'gpt-6.2', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg-2', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg-2', output_index: 0, content_index: 0, delta: 'Hello world' },
    { type: 'response.output_text.done', item_id: 'msg-2', output_index: 0, content_index: 0, text: 'Hello world' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'msg-2', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world' }] },
    },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'fc-2', type: 'function_call', name: 'shell', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc-2', output_index: 1, delta: '{"cmd":"ls"}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc-2', output_index: 1, arguments: '{"cmd":"ls"}' },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: { id: 'fc-2', type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'call-2' },
    },
    { type: 'response.completed', response: { id: 'resp-2', model: 'gpt-6.2', status: 'completed' } },
  ]

  const doneItemIds = (events: Array<Record<string, unknown>>) =>
    events
      .filter((event) => event.type === 'response.output_item.done')
      .map((event) => (event.item as Record<string, unknown>).id)

  it('delivers output_item.done and function call events from a retried Codex response', async () => {
    const harness = await startResponsesUpstream([
      [
        { type: 'response.created', response: { id: 'resp-1', model: 'gpt-6.2', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { id: 'msg-1', type: 'message', role: 'assistant', content: [] } },
        { type: 'response.output_text.delta', item_id: 'msg-1', output_index: 0, content_index: 0, delta: 'Hello ' },
      ],
      regeneratedResponse,
    ])

    try {
      const events = await postStream(harness.proxy.origin, '/v1/responses', responsesBody)
      const types = events.map((event) => event.type)

      assert.equal(harness.counts.post, 2)
      assert.deepEqual(doneItemIds(events), ['msg-2', 'fc-2'], 'the retried items never reached the client')
      assert.equal(
        events
          .filter((event) => event.type === 'response.output_text.delta')
          .map((event) => event.delta)
          .join(''),
        'Hello world',
      )
      assert.equal(types.filter((type) => type === 'response.created').length, 1)
      assert.deepEqual(
        events
          .filter((event) => event.type === 'response.output_item.added')
          .map((event) => (event.item as Record<string, unknown>).id),
        ['msg-1', 'fc-2'],
      )
      assert.equal(types.includes('response.function_call_arguments.delta'), true)
      assert.equal(types.includes('response.function_call_arguments.done'), true)
      assert.equal(types.at(-1), 'response.completed')
    } finally {
      await harness.stop()
    }
  })

  it('completes a half-streamed Codex function call from its done events instead of appending new argument deltas', async () => {
    const harness = await startResponsesUpstream([
      [
        { type: 'response.created', response: { id: 'resp-1', model: 'gpt-6.2', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { id: 'fc-1', type: 'function_call', name: 'shell', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc-1', output_index: 0, delta: '{"cmd":"l' },
      ],
      [
        { type: 'response.created', response: { id: 'resp-2', model: 'gpt-6.2', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { id: 'fc-2', type: 'function_call', name: 'shell', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc-2', output_index: 0, delta: '{"cmd":"ls"}' },
        { type: 'response.function_call_arguments.done', item_id: 'fc-2', output_index: 0, arguments: '{"cmd":"ls"}' },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { id: 'fc-2', type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'call-2' },
        },
        { type: 'response.completed', response: { id: 'resp-2', model: 'gpt-6.2', status: 'completed' } },
      ],
    ])

    try {
      const events = await postStream(harness.proxy.origin, '/v1/responses', responsesBody)

      assert.deepEqual(doneItemIds(events), ['fc-2'])
      assert.equal(
        events
          .filter((event) => event.type === 'response.function_call_arguments.delta')
          .map((event) => event.delta)
          .join(''),
        '{"cmd":"l',
        'regenerated argument deltas were appended to the half-delivered ones',
      )
      assert.equal(
        events.find((event) => event.type === 'response.function_call_arguments.done')?.arguments,
        '{"cmd":"ls"}',
      )
      assert.equal(events.filter((event) => event.type === 'response.output_item.added').length, 1)
    } finally {
      await harness.stop()
    }
  })

  const committedFirstAttempt = [
    { type: 'response.created', response: { id: 'resp-1', model: 'gpt-6.2', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'rs-1', type: 'reasoning', summary: [] } },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'rs-1', type: 'reasoning', summary: [] } },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'msg-1', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg-1', output_index: 1, content_index: 0, delta: 'Hello ' },
  ]

  it('does not regenerate a Codex response after the client already committed one of its items', async () => {
    const harness = await startResponsesUpstream([committedFirstAttempt, regeneratedResponse])

    try {
      const events = await postStream(harness.proxy.origin, '/v1/responses', responsesBody)

      assert.equal(harness.counts.post, 1, 'a second generation was mixed into items the client already recorded')
      assert.deepEqual(doneItemIds(events), ['rs-1'])
      assert.equal(events.at(-1)?.type, 'error', 'the client must be told the stream failed')
    } finally {
      await harness.stop()
    }
  })

  it('replays the missing output_item.done events when a Codex response is recovered from its tail', async () => {
    const harness = await startResponsesUpstream([committedFirstAttempt], {
      id: 'resp-1',
      object: 'response',
      model: 'gpt-6.2',
      status: 'completed',
      output: [
        { id: 'rs-1', type: 'reasoning', summary: [] },
        { id: 'msg-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world' }] },
        { id: 'fc-1', type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'call-1' },
      ],
    })

    try {
      const events = await postStream(harness.proxy.origin, '/v1/responses', responsesBody)

      assert.equal(harness.counts.post, 1)
      assert.deepEqual(doneItemIds(events), ['rs-1', 'msg-1', 'fc-1'])
      assert.deepEqual(
        events.filter((event) => event.type === 'response.output_item.done').map((event) => event.output_index),
        [0, 1, 2],
      )
      assert.equal(events.at(-1)?.type, 'response.completed')
    } finally {
      await harness.stop()
    }
  })

  it('still delivers response.created and item starts when the first Codex attempt failed before streaming', async () => {
    const harness = await startResponsesUpstream([500, regeneratedResponse])

    try {
      const events = await postStream(harness.proxy.origin, '/v1/responses', responsesBody)

      assert.equal(harness.counts.post, 2)
      assert.deepEqual(
        events.map((event) => event.type),
        regeneratedResponse.map((event) => event.type),
        'a retry after a pre-stream failure must relay the response untouched',
      )
    } finally {
      await harness.stop()
    }
  })

  it('never splices regenerated chat completion tool call arguments onto half-delivered ones', async () => {
    let requestCount = 0
    const toolCallChunk = (args: string) => ({
      id: 'chatcmpl-1',
      model: 'gpt-6.2',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'shell', arguments: args } }] },
          finish_reason: null,
        },
      ],
    })

    const upstream = http.createServer(async (request, response) => {
      requestCount += 1
      await drainRequest(request)
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream')
      if (requestCount === 1) {
        response.end(`data: ${JSON.stringify(toolCallChunk('{"cmd":"l'))}\n\n`)
        return
      }

      response.write(`data: ${JSON.stringify(toolCallChunk('{"cmd":"ls"}'))}\n\n`)
      response.write(
        `data: ${JSON.stringify({ id: 'chatcmpl-1', model: 'gpt-6.2', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    })

    const upstreamBaseUrl = await listenOnLoopback(upstream)
    const proxy = await startResilientProxyServer({
      provider: 'codex',
      upstreamBaseUrl,
      maxRecoveryRetries: 2,
      retryDelayBaseMs: 2,
    })

    try {
      const events = await postStream(proxy.origin, '/v1/chat/completions', {
        model: 'gpt-6.2',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      })

      assert.equal(requestCount, 1, 'the proxy regenerated the reply on top of a half-delivered tool call')
      assert.equal(events.at(-1)?.type, 'error', 'the client must be told the stream failed')
    } finally {
      await proxy.stop()
      await closeServer(upstream)
    }
  })
})
