import http from 'node:http'
import type { AddressInfo } from 'node:net'

// Gemini 专用的本地「流清洗」代理（docs/specs/gemini-cli-provider/design.md「中转站心跳」）。
//
// 症状：Gemini 卡读文件很顺，一到写文件 / 长回答就报 `[API Error: Incomplete JSON segment at the end]`，
//   自动重试多少次都一样，看起来像「只会反复读文件、永远写不出东西」。
// 根因：2026-11-26 抓包坐实（出事会话副本重放，首字 20.9s）——中转站在首字慢时先发 SSE 注释心跳
//   `: ping\n\n` 保活（协议允许）；gemini-cli 0.24.5 内置 @google/genai 的 processStreamResponse 用
//   `/^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/` 锚在缓冲开头，开头是 `: ping` 就永远不匹配，整段回复堆到流结束后抛错。
//   首字快（<15s，没有心跳）的请求不受影响，所以读文件能过、生成大段内容必挂——确定性失败，不是网络抖动。
// 被否决：把这句报错放进快速续传名单——重试同样慢、同样带心跳，只会更快地重复失败；
//   也不能等 CLI 上游修（用户钉着的 CLI 版本不会自己变）。这里只做协议规整，不重试、不改内容。
// 已知限制：心跳被吞掉后，CLI 在首字到达前收不到任何字节（无法发它能忽略的保活字节），
//   靠 Node fetch 默认 300s 的分块间隔超时兜底；首字超过 5 分钟的请求仍会断。

type Logger = Pick<Console, 'log' | 'warn'>

const eventBoundaryPattern = /\r\n\r\n|\n\n|\r\r/
const lineBreakPattern = /\r\n|\n|\r/
const ignoredFieldPattern = /^(?:event|id|retry):/

type ParsedEvent = { data: string[]; comments: number; unknown: boolean }

const parseEvent = (raw: string): ParsedEvent => {
  const parsed: ParsedEvent = { data: [], comments: 0, unknown: false }
  for (const line of raw.split(lineBreakPattern)) {
    if (!line) {
      continue
    }
    if (line.startsWith(':')) {
      parsed.comments += 1
    } else if (line.startsWith('data:')) {
      parsed.data.push(line.slice(5).replace(/^ /, ''))
    } else if (!ignoredFieldPattern.test(line)) {
      parsed.unknown = true
    }
  }
  return parsed
}

const renderData = (data: string[]) => `data: ${data.join('\n')}\n\n`

const isJson = (text: string) => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

// 增量喂入 SSE 文本，只吐出规整成 `data: <payload>\n\n` 的事件；注释心跳和 event/id/retry 字段丢弃。
// 认不出的内容（例如挂着 event-stream 头的裸 JSON 报错体）原样放行——宁可不规整，也不能吞掉上游的报错。
export const createSseCommentStripper = () => {
  let buffer = ''
  let strippedComments = 0

  return {
    push: (chunk: string) => {
      buffer += chunk
      let output = ''
      let boundary = eventBoundaryPattern.exec(buffer)
      while (boundary) {
        const raw = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const parsed = parseEvent(raw)
        strippedComments += parsed.comments
        if (parsed.unknown) {
          output += raw + boundary[0]
        } else if (parsed.data.length > 0) {
          output += renderData(parsed.data)
        }
        boundary = eventBoundaryPattern.exec(buffer)
      }
      return output
    },
    // 流结束：最后一个事件只是少了结尾空行且内容是完整 JSON 时补齐；真被截断的保持原样，
    // 让 CLI 照常报断流（那是真断，应当进续传）。
    flush: () => {
      const rest = buffer
      buffer = ''
      if (!rest.trim()) {
        return ''
      }
      const parsed = parseEvent(rest)
      if (parsed.unknown) {
        return rest
      }
      strippedComments += parsed.comments
      if (parsed.data.length === 0) {
        return ''
      }
      return isJson(parsed.data.join('\n')) ? renderData(parsed.data) : rest
    },
    strippedComments: () => strippedComments,
  }
}

const normalizeBaseUrl = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, '')

// 逐跳头不转发；正文长度和编码由两端各自重算（fetch 已替我们解压，下游拿到的是明文）。
const droppedRequestHeaders = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'expect',
])

const droppedResponseHeaders = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
])

const readRequestBody = (request: http.IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => parts.push(part))
    request.on('end', () => resolve(Buffer.concat(parts)))
    request.on('error', reject)
  })

const writeChunk = (response: http.ServerResponse, chunk: string | Uint8Array) =>
  new Promise<void>((resolve) => {
    if (response.write(chunk)) {
      resolve()
      return
    }
    response.once('drain', resolve)
    response.once('close', resolve)
  })

export type RunningGeminiSseProxyServer = {
  clientBaseUrl: string
  stop: () => Promise<void>
}

export const startGeminiSseProxyServer = async (options: {
  upstreamBaseUrl: string
  logger?: Logger
}): Promise<RunningGeminiSseProxyServer> => {
  const upstreamBaseUrl = normalizeBaseUrl(options.upstreamBaseUrl)
  const logger = options.logger ?? console

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const abort = new AbortController()
    // 用户点停止 / CLI 退出时把上游也掐掉，别让中转站白算。
    response.on('close', () => {
      if (!response.writableEnded) {
        abort.abort()
      }
    })

    try {
      const body = await readRequestBody(request)
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || droppedRequestHeaders.has(name.toLowerCase())) {
          continue
        }
        headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      headers.set('accept-encoding', 'identity')

      const method = request.method ?? 'GET'
      const upstream = await fetch(`${upstreamBaseUrl}${request.url ?? '/'}`, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' || body.length === 0 ? undefined : new Uint8Array(body),
        signal: abort.signal,
        redirect: 'manual',
      })

      const responseHeaders: Record<string, string> = {}
      upstream.headers.forEach((value, name) => {
        if (!droppedResponseHeaders.has(name.toLowerCase())) {
          responseHeaders[name] = value
        }
      })
      response.writeHead(upstream.status, responseHeaders)

      if (!upstream.body) {
        response.end()
        return
      }

      const reader = upstream.body.getReader()
      const isEventStream = /text\/event-stream/i.test(upstream.headers.get('content-type') ?? '')
      if (!isEventStream) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          await writeChunk(response, value)
        }
        response.end()
        return
      }

      const stripper = createSseCommentStripper()
      const decoder = new TextDecoder('utf-8')
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        const cleaned = stripper.push(decoder.decode(value, { stream: true }))
        if (cleaned) {
          await writeChunk(response, cleaned)
        }
      }
      const tail = stripper.push(decoder.decode()) + stripper.flush()
      if (tail) {
        await writeChunk(response, tail)
      }
      response.end()
      if (stripper.strippedComments() > 0) {
        logger.log(`[gemini-sse-proxy] stripped ${stripper.strippedComments()} heartbeat comment(s) from a streamed reply`)
      }
    } catch (error) {
      if (abort.signal.aborted) {
        response.destroy()
        return
      }
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
      const message = `${error instanceof Error ? error.message : String(error)}${cause}`
      logger.warn(`[gemini-sse-proxy] upstream request failed: ${message}`)
      if (response.headersSent) {
        // 回复已经开始：直接断开，让 CLI 看到真实的断流。
        response.destroy()
        return
      }
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 502, message: `Upstream request failed: ${message}`, status: 'UNAVAILABLE' } }))
    }
  }

  const server = http.createServer((request, response) => {
    void handle(request, response)
  })
  // 首字前的静默可能很长（心跳已被吞），别让 Node 自己的请求超时先动手。
  server.requestTimeout = 0
  server.headersTimeout = 0

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.unref()

  const { port } = server.address() as AddressInfo
  return {
    clientBaseUrl: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

class GeminiSseProxyPool {
  private readonly servers = new Map<string, Promise<RunningGeminiSseProxyServer>>()

  async resolveBaseUrl(upstreamBaseUrl: string) {
    const key = normalizeBaseUrl(upstreamBaseUrl)
    let pending = this.servers.get(key)
    if (!pending) {
      pending = startGeminiSseProxyServer({ upstreamBaseUrl: key }).catch((error) => {
        this.servers.delete(key)
        throw error
      })
      this.servers.set(key, pending)
    }
    return (await pending).clientBaseUrl
  }

  async dispose() {
    const entries = [...this.servers.values()]
    this.servers.clear()
    await Promise.all(
      entries.map(async (entry) => {
        const running = await entry.catch(() => undefined)
        await running?.stop().catch(() => undefined)
      }),
    )
  }
}

export const geminiSseProxyPool = new GeminiSseProxyPool()
