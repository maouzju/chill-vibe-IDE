import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { describe, it } from 'node:test'

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

describe('internal resilient proxy', () => {
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
})
