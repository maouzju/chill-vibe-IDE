import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { automationBoardCommandSchema } from '../shared/schema.js'
import type { AutomationBoardCommand, AutomationBoardMirror } from '../shared/schema.js'

// 自动化看板监工 MCP 的桥接服务：只绑 127.0.0.1 的随机端口 + bearer token，
// 供监工回合启动的 MCP 子进程读实时看板、写三条命令。与 remote-monitor.ts
// 同一条规矩：本服务自身绝不改任何 state —— 写命令一律经 dispatchCommand
// 转发给渲染进程复用电脑端 handler，因此"移到某道"自动带上正确的中断/执行
// 语义，而不是在这里再实现一遍 resolveAutomationBoardTransition。
export type AutomationBoardTranscriptEntry = {
  id: string
  role: string
  content: string
  kind?: string
  createdAt?: string
}

export type AutomationBoardBridgeDeps = {
  /** 实时看板镜像（由渲染进程推送）。null = 这个 boardCardId 不存在（HTTP 404）。 */
  readBoardMirror: (boardCardId: string) => AutomationBoardMirror | null
  /** 单个项的最近转录，走 transfer 压缩后返回有界条数。null = 卡不存在（404）。 */
  readItemTranscript: (
    cardId: string,
    limit: number,
  ) => Promise<AutomationBoardTranscriptEntry[] | null>
  /** 转发写命令给渲染进程；false = 当前没有可接收的窗口（HTTP 503）。 */
  dispatchCommand: (command: AutomationBoardCommand) => boolean
}

export type AutomationBoardBridgeRuntimeInfo = {
  url: string
  port: number
  token: string
}

export type AutomationBoardBridgeStatus = {
  running: boolean
  url?: string
  port?: number
}

export const automationBoardTranscriptDefaultLimit = 20
export const automationBoardTranscriptMaxLimit = 60

/** 监工可以要任意 limit；越界一律夹回去，绝不让它拉出无界转录（pitfall 183）。 */
export const clampAutomationBoardTranscriptLimit = (raw: string | number | null | undefined) => {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) {
    return automationBoardTranscriptDefaultLimit
  }

  return Math.max(1, Math.min(Math.trunc(parsed), automationBoardTranscriptMaxLimit))
}

const maxCommandBodyBytes = 64 * 1024

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

const sendJson = (response: http.ServerResponse, status: number, payload: unknown) => {
  response.writeHead(status, jsonHeaders)
  response.end(JSON.stringify(payload))
}

const readRequestBody = (request: http.IncomingMessage, maxBytes = maxCommandBodyBytes) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0

    request.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('Request body too large.'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

export const isLoopbackHostname = (hostname: string | undefined) => {
  if (!hostname) {
    return false
  }

  const normalized = hostname.startsWith('::ffff:') ? hostname.slice('::ffff:'.length) : hostname
  return normalized === '::1' || normalized === 'localhost' || /^127\./.test(normalized)
}

const isLoopbackHostHeader = (hostHeader: string | undefined) => {
  if (!hostHeader) {
    return false
  }

  try {
    return isLoopbackHostname(new URL(`http://${hostHeader}`).hostname)
  } catch {
    return false
  }
}

const isTokenValid = (candidate: string | null, expected: string) => {
  if (!candidate || candidate.length !== expected.length) {
    return false
  }

  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
}

const readBearerToken = (request: http.IncomingMessage) => {
  const header = request.headers.authorization
  if (typeof header !== 'string') {
    return null
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

const listenOnce = (server: http.Server, port: number, host: string) =>
  new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }

    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })

export const createAutomationBoardBridge = (deps: AutomationBoardBridgeDeps) => {
  let server: http.Server | null = null
  let runtimeInfo: AutomationBoardBridgeRuntimeInfo | null = null

  const handleCommand = (request: http.IncomingMessage, response: http.ServerResponse) => {
    void readRequestBody(request)
      .then((body) => {
        let parsedBody: unknown
        try {
          parsedBody = JSON.parse(body)
        } catch {
          sendJson(response, 400, { message: 'Invalid JSON body.' })
          return
        }

        const command = automationBoardCommandSchema.safeParse(parsedBody)
        if (!command.success) {
          sendJson(response, 400, { message: 'Invalid board command payload.' })
          return
        }

        if (!deps.dispatchCommand(command.data)) {
          sendJson(response, 503, {
            message: 'No desktop window can execute board commands right now.',
          })
          return
        }

        sendJson(response, 200, { accepted: true })
      })
      .catch(() => {
        sendJson(response, 400, { message: 'Unreadable request body.' })
      })
  }

  const handleRequest = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    token: string,
  ) => {
    // 两道门都要过：socket 对端与 Host 头必须是回环（挡住转发/DNS rebinding），
    // token 才决定是不是我们自己启动的那个 MCP 子进程。
    if (!isLoopbackHostname(request.socket.remoteAddress ?? undefined) || !isLoopbackHostHeader(request.headers.host)) {
      sendJson(response, 403, { message: 'Loopback requests only.' })
      return
    }

    if (!isTokenValid(readBearerToken(request), token)) {
      sendJson(response, 401, { message: 'Unauthorized.' })
      return
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    if (url.pathname === '/command') {
      if (request.method !== 'POST') {
        response.writeHead(405, { ...jsonHeaders, Allow: 'POST' })
        response.end(JSON.stringify({ message: 'Command endpoint accepts POST only.' }))
        return
      }

      handleCommand(request, response)
      return
    }

    if (request.method !== 'GET') {
      response.writeHead(405, { ...jsonHeaders, Allow: 'GET' })
      response.end(JSON.stringify({ message: 'Only GET is allowed outside /command.' }))
      return
    }

    if (url.pathname === '/board') {
      const boardCardId = url.searchParams.get('boardCardId')
      if (!boardCardId) {
        sendJson(response, 400, { message: 'boardCardId is required.' })
        return
      }

      const mirror = deps.readBoardMirror(boardCardId)
      if (!mirror) {
        sendJson(response, 404, { message: 'Board not found.' })
        return
      }

      sendJson(response, 200, { mirror })
      return
    }

    if (url.pathname === '/item') {
      const cardId = url.searchParams.get('cardId')
      if (!cardId) {
        sendJson(response, 400, { message: 'cardId is required.' })
        return
      }

      const limit = clampAutomationBoardTranscriptLimit(url.searchParams.get('limit'))
      void deps
        .readItemTranscript(cardId, limit)
        .then((entries) => {
          if (!entries) {
            sendJson(response, 404, { message: 'Board item not found.' })
            return
          }
          sendJson(response, 200, { entries })
        })
        .catch(() => {
          sendJson(response, 500, { message: 'Board item transcript unavailable.' })
        })
      return
    }

    sendJson(response, 404, { message: 'Not found.' })
  }

  return {
    async start(): Promise<AutomationBoardBridgeRuntimeInfo> {
      if (server && runtimeInfo) {
        return runtimeInfo
      }

      const token = crypto.randomBytes(16).toString('hex')
      const nextServer = http.createServer((request, response) => {
        handleRequest(request, response, token)
      })

      await listenOnce(nextServer, 0, '127.0.0.1')

      const port = (nextServer.address() as AddressInfo).port
      server = nextServer
      runtimeInfo = { url: `http://127.0.0.1:${port}`, port, token }

      return runtimeInfo
    },

    async stop() {
      const closingServer = server
      server = null
      runtimeInfo = null

      if (closingServer) {
        await new Promise<void>((resolve) => {
          closingServer.close(() => resolve())
          // close() waits for idle keep-alive sockets; sever them so stop()
          // settles promptly.
          closingServer.closeAllConnections?.()
        })
      }
    },

    status(): AutomationBoardBridgeStatus {
      return {
        running: server !== null,
        url: runtimeInfo?.url,
        port: runtimeInfo?.port,
      }
    },
  }
}

export type AutomationBoardBridge = ReturnType<typeof createAutomationBoardBridge>
