import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { workspaceAdminCommandSchema } from '../shared/schema.js'
import type { WorkspaceAdminCommand, WorkspaceSessionMirror } from '../shared/schema.js'

// 超管权限 MCP 的桥接服务：只绑 127.0.0.1 的随机端口 + bearer token，
// 供带 `card.adminAccess` 的回合启动的 MCP 子进程读实时工作区、写三条命令。
// 与 remote-monitor.ts 同一条规矩：本服务自身绝不改任何 state —— 写命令一律
// 经 dispatchCommand 转发给渲染进程复用电脑端 handler，因此"移到某道"自动带上
// 正确的中断/执行语义，而不是在这里再实现一遍 resolveAutomationBoardTransition。
export type WorkspaceAdminTranscriptEntry = {
  id: string
  role: string
  content: string
  kind?: string
  createdAt?: string
}

export type WorkspaceAdminBridgeDeps = {
  /** 实时工作区镜像（由渲染进程推送）。null = 这个 columnId 不存在（HTTP 404）。 */
  readWorkspaceMirror: (columnId: string) => WorkspaceSessionMirror | null
  /** 单个会话的最近转录，走 transfer 压缩后返回有界条数。null = 卡不存在（404）。 */
  readSessionTranscript: (
    cardId: string,
    limit: number,
  ) => Promise<WorkspaceAdminTranscriptEntry[] | null>
  /**
   * 转发写命令给渲染进程；false = 当前没有可接收的窗口（HTTP 503）。
   * 允许返回 Promise：宿主把后端搬进 utilityProcess 后，"哪个窗口收下了" 只有
   * 主进程知道，投递结果只能异步回来（同步实现继续原样可用）。
   */
  dispatchCommand: (command: WorkspaceAdminCommand) => boolean | Promise<boolean>
}

export type WorkspaceAdminBridgeRuntimeInfo = {
  url: string
  port: number
  token: string
}

export type WorkspaceAdminBridgeStatus = {
  running: boolean
  url?: string
  port?: number
}

export const workspaceAdminTranscriptDefaultLimit = 20
export const workspaceAdminTranscriptMaxLimit = 60

/** 超管可以要任意 limit；越界一律夹回去，绝不让它拉出无界转录（pitfall 183）。 */
export const clampWorkspaceAdminTranscriptLimit = (raw: string | number | null | undefined) => {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) {
    return workspaceAdminTranscriptDefaultLimit
  }

  return Math.max(1, Math.min(Math.trunc(parsed), workspaceAdminTranscriptMaxLimit))
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

export const createWorkspaceAdminBridge = (deps: WorkspaceAdminBridgeDeps) => {
  let server: http.Server | null = null
  let runtimeInfo: WorkspaceAdminBridgeRuntimeInfo | null = null

  // 症状：写命令送不到时超管的 MCP 子进程仍收到 accepted:true，它以为改动生效了。
  // 根因：2026-08-12 —— 后端要整体搬进 utilityProcess（同一批 git 操作跑主进程时
  //       窗口单次停摆 6827ms / 11 次超 1s / 2 次超 5s，搬进 utilityProcess 只剩 58ms），
  //       跨进程后 dispatchCommand 只能返回 Promise，而 `!promise` 恒为 false → 恒 200。
  // 被否决：让主进程预推"当前有没有窗口"的缓存标志、保住同步签名 —— 那是猜测不是
  //         投递事实，窗口刚崩的一瞬会把 503 静默说成 200，正是要根除的静默错分支。
  const handleCommand = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    let body: string
    try {
      body = await readRequestBody(request)
    } catch {
      sendJson(response, 400, { message: 'Unreadable request body.' })
      return
    }

    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(body)
    } catch {
      sendJson(response, 400, { message: 'Invalid JSON body.' })
      return
    }

    const command = workspaceAdminCommandSchema.safeParse(parsedBody)
    if (!command.success) {
      sendJson(response, 400, { message: 'Invalid workspace admin command payload.' })
      return
    }

    let dispatched = false
    try {
      dispatched = await deps.dispatchCommand(command.data)
    } catch {
      // 投递本身失败＝命令没送到，与"没有窗口"同一类，仍回 503；关键是必须有
      // 响应——跨进程调用 reject 时绝不能让 MCP 子进程挂在这个请求上。
      sendJson(response, 503, { message: 'Workspace admin command dispatch failed.' })
      return
    }

    if (!dispatched) {
      sendJson(response, 503, {
        message: 'No desktop window can execute workspace admin commands right now.',
      })
      return
    }

    sendJson(response, 200, { accepted: true })
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

      void handleCommand(request, response).catch(() => {
        // 最后一道兜底：无论如何都要把这个请求结掉，不留悬挂连接。
        if (!response.headersSent) {
          sendJson(response, 500, { message: 'Command handling failed.' })
          return
        }
        response.end()
      })
      return
    }

    if (request.method !== 'GET') {
      response.writeHead(405, { ...jsonHeaders, Allow: 'GET' })
      response.end(JSON.stringify({ message: 'Only GET is allowed outside /command.' }))
      return
    }

    if (url.pathname === '/workspace') {
      const columnId = url.searchParams.get('columnId')
      if (!columnId) {
        sendJson(response, 400, { message: 'columnId is required.' })
        return
      }

      const mirror = deps.readWorkspaceMirror(columnId)
      if (!mirror) {
        sendJson(response, 404, { message: 'Workspace not found.' })
        return
      }

      sendJson(response, 200, { mirror })
      return
    }

    if (url.pathname === '/session') {
      const cardId = url.searchParams.get('cardId')
      if (!cardId) {
        sendJson(response, 400, { message: 'cardId is required.' })
        return
      }

      const limit = clampWorkspaceAdminTranscriptLimit(url.searchParams.get('limit'))
      void deps
        .readSessionTranscript(cardId, limit)
        .then((entries) => {
          if (!entries) {
            sendJson(response, 404, { message: 'Session not found.' })
            return
          }
          sendJson(response, 200, { entries })
        })
        .catch(() => {
          sendJson(response, 500, { message: 'Session transcript unavailable.' })
        })
      return
    }

    sendJson(response, 404, { message: 'Not found.' })
  }

  return {
    async start(): Promise<WorkspaceAdminBridgeRuntimeInfo> {
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

    status(): WorkspaceAdminBridgeStatus {
      return {
        running: server !== null,
        url: runtimeInfo?.url,
        port: runtimeInfo?.port,
      }
    },
  }
}

export type WorkspaceAdminBridge = ReturnType<typeof createWorkspaceAdminBridge>
