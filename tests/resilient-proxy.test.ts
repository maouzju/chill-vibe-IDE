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
      response.write('data: {"type":"message_start","message":{"id":"msg-1","model":"claude-opus-4-6"}}\n\n')
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
          model: 'claude-opus-4-6',
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
      response.write('data: {"type":"message_start","message":{"id":"msg-terminal","model":"claude-opus-4-6"}}\n\n')
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
          model: 'claude-opus-4-6',
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
})
