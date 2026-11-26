import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, describe, it } from 'node:test'

import { createSseCommentStripper, startGeminiSseProxyServer } from '../server/gemini-sse-proxy.ts'

// 2026-11-26 抓包实样（诊断抓包目录里的第 5 份响应）：首字 20.9s 的回复前面先来了两个 `: ping`。
const pingedStream =
  ': ping\n\n: ping\n\ndata: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}\n\n' +
  'data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}]}\n\n'

const cleanStream =
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}\n\n' +
  'data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}]}\n\n'

// gemini-cli 0.24.5 内置 @google/genai 的 processStreamResponse 原样逻辑：正则锚在 `^data: `，
// 开头只要不是它就永远不匹配，流结束时抛 Incomplete JSON segment。用它当「CLI 能不能读」的判据。
const parseLikeGenai = (chunks: string[]) => {
  const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/
  const events: unknown[] = []
  let chunkString = ''
  for (const chunk of chunks) {
    chunkString += chunk
    let match = chunkString.match(responseLineRE)
    while (match) {
      events.push(JSON.parse(match[1]))
      chunkString = chunkString.slice(match[0].length)
      match = chunkString.match(responseLineRE)
    }
  }
  if (chunkString.trim().length > 0) {
    throw new Error('Incomplete JSON segment at the end')
  }
  return events
}

const strip = (chunks: string[]) => {
  const stripper = createSseCommentStripper()
  const out = chunks.map((chunk) => stripper.push(chunk))
  out.push(stripper.flush())
  return out.filter(Boolean)
}

describe('gemini sse comment stripper', () => {
  it('reproduces the CLI failure on a relay heartbeat, and the stripped stream parses', () => {
    assert.throws(() => parseLikeGenai([pingedStream]), /Incomplete JSON segment/)
    assert.equal(parseLikeGenai(strip([pingedStream])).length, 2)
    assert.equal(strip([pingedStream]).join(''), cleanStream)
  })

  it('drops heartbeats that arrive mid-stream and in separate chunks', () => {
    const chunks = [': ping\n\n', 'data: {"a":1}\n\n', ': ping\n\n', ': keep-alive\n\n', 'data: {"b":2}\n\n']
    assert.deepEqual(parseLikeGenai(strip(chunks)), [{ a: 1 }, { b: 2 }])
  })

  it('reassembles events split at arbitrary byte boundaries', () => {
    for (let size = 1; size <= 9; size += 1) {
      const chunks: string[] = []
      for (let index = 0; index < pingedStream.length; index += size) {
        chunks.push(pingedStream.slice(index, index + size))
      }
      assert.equal(strip(chunks).join(''), cleanStream, `chunk size ${size}`)
    }
  })

  it('normalizes CRLF framing and drops event/id/retry fields', () => {
    const stream = ': ping\r\n\r\nevent: message\r\nid: 7\r\nretry: 3000\r\ndata: {"a":1}\r\n\r\n'
    assert.equal(strip([stream]).join(''), 'data: {"a":1}\n\n')
  })

  it('accepts a data field without the space after the colon', () => {
    assert.equal(strip(['data:{"a":1}\n\n']).join(''), 'data: {"a":1}\n\n')
  })

  it('passes a bare JSON error body through untouched so the CLI still sees the upstream error', () => {
    const body = '{"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}'
    assert.equal(strip([body]).join(''), body)
  })

  it('completes a final event that is valid JSON but lost its trailing blank line', () => {
    assert.deepEqual(parseLikeGenai(strip([': ping\n\ndata: {"a":1}\n\ndata: {"b":2}'])), [{ a: 1 }, { b: 2 }])
  })

  it('leaves a genuinely truncated final event broken so the cut-off is still reported', () => {
    const out = strip(['data: {"a":1}\n\ndata: {"b":'])
    assert.throws(() => parseLikeGenai(out), /Incomplete JSON segment/)
  })
})

describe('gemini sse proxy server', () => {
  // Windows + --test-force-exit：客户端 fetch 的 socket 还在关闭时进程被强退，会撞 libuv 断言（UV_HANDLE_CLOSING）。
  // 与代理实现无关（最小复现里等 50ms 即不崩），收尾前让出一小段时间。
  after(() => new Promise<void>((resolve) => setTimeout(resolve, 100)))

  const startUpstream = async (
    handler: (request: http.IncomingMessage, body: string, response: http.ServerResponse) => void,
  ) => {
    const server = http.createServer((request, response) => {
      const parts: Buffer[] = []
      request.on('data', (part: Buffer) => parts.push(part))
      request.on('end', () => handler(request, Buffer.concat(parts).toString('utf8'), response))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return {
      origin: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    }
  }

  it('forwards the request and strips heartbeats from the streamed reply', async () => {
    const seen: Array<{ method?: string; url?: string; key?: string | string[]; body: string }> = []
    const upstream = await startUpstream((request, body, response) => {
      seen.push({ method: request.method, url: request.url, key: request.headers['x-goog-api-key'], body })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': ping\n\n')
      setTimeout(() => {
        response.write(': ping\n\n')
        response.end(cleanStream)
      }, 30)
    })
    const proxy = await startGeminiSseProxyServer({ upstreamBaseUrl: `${upstream.origin}/relay/` })
    try {
      const response = await fetch(
        `${proxy.clientBaseUrl}/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse`,
        { method: 'POST', headers: { 'x-goog-api-key': 'k', 'content-type': 'application/json' }, body: '{"q":1}' },
      )
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
      assert.equal(await response.text(), cleanStream)
      assert.deepEqual(seen, [
        {
          method: 'POST',
          url: '/relay/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse',
          key: 'k',
          body: '{"q":1}',
        },
      ])
    } finally {
      await proxy.stop()
      await upstream.close()
    }
  })

  it('passes non-stream replies and upstream status codes through unchanged', async () => {
    const errorBody = '{"error":{"code":503,"message":": ping is not a comment here"}}'
    const upstream = await startUpstream((_request, _body, response) => {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(errorBody)
    })
    const proxy = await startGeminiSseProxyServer({ upstreamBaseUrl: upstream.origin })
    try {
      const response = await fetch(`${proxy.clientBaseUrl}/v1beta/models`)
      assert.equal(response.status, 503)
      assert.equal(await response.text(), errorBody)
    } finally {
      await proxy.stop()
      await upstream.close()
    }
  })

  it('answers 502 instead of hanging when the upstream is unreachable', async () => {
    const upstream = await startUpstream(() => undefined)
    const deadOrigin = upstream.origin
    await upstream.close()
    const proxy = await startGeminiSseProxyServer({ upstreamBaseUrl: deadOrigin })
    try {
      const response = await fetch(`${proxy.clientBaseUrl}/v1beta/models`)
      assert.equal(response.status, 502)
      assert.match(await response.text(), /"error"/)
    } finally {
      await proxy.stop()
    }
  })
})
