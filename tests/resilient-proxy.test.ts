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
})
