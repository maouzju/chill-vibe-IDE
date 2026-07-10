import crypto from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import type { AddressInfo } from 'node:net'

import type { ActiveStreamView, ChatStreamTapEvent } from './chat-stream-tap.js'
import { renderRemoteMonitorPage } from './remote-monitor-page.js'

// 手机远程监工模式：主进程内的只读 HTTP/SSE 服务。手机浏览器扫码打开后
// 实时镜像所有会话的流式输出与改动卡。整个服务没有任何写路径 —— 它对
// ChatManager 只有 tap（观察）与 backlog 读取，对状态只有轻量快照读取。
export type RemoteMonitorCardSnapshot = {
  id: string
  title: string
  provider: string
  model: string
  status: string
  streamId?: string
  lastMessagePreview?: string
}

export type RemoteMonitorSnapshot = {
  generatedAt: number
  columns: Array<{
    id: string
    title: string
    cards: RemoteMonitorCardSnapshot[]
  }>
}

export type RemoteMonitorDeps = {
  loadSnapshot: () => Promise<RemoteMonitorSnapshot>
  tapStreams: (listener: (event: ChatStreamTapEvent) => void) => () => void
  listActiveStreams: () => ActiveStreamView[]
}

export type RemoteMonitorRuntimeInfo = {
  url: string
  port: number
  token: string
  // True when no LAN IPv4 could be resolved and the advertised URL fell back
  // to a loopback address (reachable from this machine only).
  lanFallback: boolean
}

export type RemoteMonitorStatus = {
  running: boolean
  url?: string
  port?: number
  clientCount: number
}

// 快照来源是 loadStateForRenderer() 的轻量渲染态；这里再压一层，只留卡片
// 元信息 + 最后一条对话文本的前 200 字符 —— 绝不把整段转录发去手机
// （pitfall 183：任何全量转录出程序边界的路径都是事故源）。
type SnapshotSourceCard = {
  id: string
  title: string
  provider: string
  model: string
  status: string
  streamId?: string
  messages: Array<{ role: string; content: string }>
}

// AppState 的 column.cards 是 Record<cardId, card>，不是数组。
type SnapshotSourceState = {
  columns: Array<{
    id: string
    title: string
    cards: Record<string, SnapshotSourceCard>
  }>
}

const previewMaxChars = 200

export const buildRemoteMonitorSnapshot = (state: SnapshotSourceState): RemoteMonitorSnapshot => ({
  generatedAt: Date.now(),
  columns: state.columns.map((column) => ({
    id: column.id,
    title: column.title,
    cards: Object.values(column.cards).map((card) => {
      const lastConversationMessage = card.messages.findLast(
        (message) =>
          (message.role === 'assistant' || message.role === 'user') &&
          message.content.trim().length > 0,
      )

      return {
        id: card.id,
        title: card.title,
        provider: card.provider,
        model: card.model,
        status: card.status,
        streamId: card.streamId,
        lastMessagePreview: lastConversationMessage
          ? lastConversationMessage.content.slice(0, previewMaxChars)
          : undefined,
      }
    }),
  })),
})

const defaultPort = 8791
const sseHeartbeatIntervalMs = 15_000

const resolvePreferredPort = (requested?: number) => {
  if (typeof requested === 'number' && Number.isInteger(requested) && requested >= 0) {
    return requested
  }

  const fromEnv = Number.parseInt(process.env.CHILL_VIBE_REMOTE_MONITOR_PORT ?? '', 10)
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65_536) {
    return fromEnv
  }

  return defaultPort
}

type LanCandidateEntry = { family: string; internal: boolean; address: string }

// 给非 internal IPv4 地址打分挑"手机真能连上"的那一个：
// 家用/办公私有段优先，Clash/VPN 的 TUN 虚拟段（198.18.0.0/15）和
// link-local（169.254.0.0/16）垫底——它们在 os.networkInterfaces() 里
// 常排在真网卡前面，实测会让二维码指向手机根本路由不到的地址。
const scoreLanAddress = (address: string) => {
  if (address.startsWith('192.168.')) {
    return 4
  }
  if (address.startsWith('10.')) {
    return 3
  }
  const octets = address.split('.')
  const second = Number.parseInt(octets[1] ?? '', 10)
  if (octets[0] === '172' && second >= 16 && second <= 31) {
    return 2
  }
  if (address.startsWith('169.254.') || address.startsWith('198.18.') || address.startsWith('198.19.')) {
    return 0
  }
  return 1
}

export const pickLanIPv4 = (
  interfaces: Record<string, LanCandidateEntry[] | undefined>,
): string | null => {
  let best: { address: string; score: number } | null = null

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) {
        continue
      }

      const score = scoreLanAddress(entry.address)
      if (!best || score > best.score) {
        best = { address: entry.address, score }
      }
    }
  }

  return best?.address ?? null
}

export const resolveLanIPv4 = () => pickLanIPv4(os.networkInterfaces())

const isTokenValid = (candidate: string | null, expected: string) => {
  if (!candidate || candidate.length !== expected.length) {
    return false
  }

  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
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

export const createRemoteMonitorManager = (deps: RemoteMonitorDeps) => {
  let server: http.Server | null = null
  let untap: (() => void) | null = null
  let runtimeInfo: RemoteMonitorRuntimeInfo | null = null
  const sseClients = new Set<http.ServerResponse>()
  const heartbeatTimers = new Map<http.ServerResponse, ReturnType<typeof setInterval>>()

  const writeStreamEvent = (response: http.ServerResponse, event: ChatStreamTapEvent) => {
    const payload = {
      streamId: event.streamId,
      cardId: event.cardId,
      event: event.envelope.event,
      data: event.envelope.data,
    }
    response.write(`event: stream\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  const closeSseClient = (response: http.ServerResponse) => {
    const timer = heartbeatTimers.get(response)
    if (timer) {
      clearInterval(timer)
      heartbeatTimers.delete(response)
    }
    sseClients.delete(response)
  }

  const handleRequest = (request: http.IncomingMessage, response: http.ServerResponse, token: string) => {
    const url = new URL(request.url ?? '/', 'http://localhost')

    if (!isTokenValid(url.searchParams.get('token'), token)) {
      response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ message: 'Unauthorized.' }))
      return
    }

    // Read-only surface by construction: everything except GET is refused
    // before any route is considered.
    if (request.method !== 'GET') {
      response.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET' })
      response.end(JSON.stringify({ message: 'Read-only monitor: only GET is allowed.' }))
      return
    }

    if (url.pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      response.end(renderRemoteMonitorPage())
      return
    }

    if (url.pathname === '/api/snapshot') {
      void deps
        .loadSnapshot()
        .then((snapshot) => {
          response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          response.end(JSON.stringify(snapshot))
        })
        .catch(() => {
          response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ message: 'Snapshot unavailable.' }))
        })
      return
    }

    if (url.pathname === '/api/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      response.write('retry: 2000\n\n')

      // Late joiners get the picture so far before live forwarding starts.
      for (const stream of deps.listActiveStreams()) {
        for (const envelope of stream.backlog) {
          writeStreamEvent(response, { streamId: stream.streamId, cardId: stream.cardId, envelope })
        }
      }

      sseClients.add(response)
      const heartbeat = setInterval(() => {
        response.write(': heartbeat\n\n')
      }, sseHeartbeatIntervalMs)
      heartbeatTimers.set(response, heartbeat)

      request.on('close', () => closeSseClient(response))
      return
    }

    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ message: 'Not found.' }))
  }

  return {
    async start(options?: { port?: number; host?: string }): Promise<RemoteMonitorRuntimeInfo> {
      if (server && runtimeInfo) {
        return runtimeInfo
      }

      const token = crypto.randomBytes(16).toString('hex')
      const host = options?.host ?? '0.0.0.0'
      const preferredPort = resolvePreferredPort(options?.port)

      const nextServer = http.createServer((request, response) => {
        handleRequest(request, response, token)
      })

      try {
        await listenOnce(nextServer, preferredPort, host)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EADDRINUSE' || preferredPort === 0) {
          throw error
        }
        // The preferred port belongs to someone else — any free port works,
        // the QR code carries whatever we actually got.
        await listenOnce(nextServer, 0, host)
      }

      const port = (nextServer.address() as AddressInfo).port
      const lanAddress = host === '0.0.0.0' ? resolveLanIPv4() : null
      const advertisedHost = host === '0.0.0.0' ? lanAddress ?? '127.0.0.1' : host
      const lanFallback = host === '0.0.0.0' && !lanAddress

      server = nextServer
      untap = deps.tapStreams((event) => {
        for (const client of sseClients) {
          writeStreamEvent(client, event)
        }
      })

      runtimeInfo = {
        url: `http://${advertisedHost}:${port}/?token=${token}`,
        port,
        token,
        lanFallback,
      }

      return runtimeInfo
    },

    async stop() {
      untap?.()
      untap = null

      for (const client of [...sseClients]) {
        closeSseClient(client)
        client.end()
      }

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

    getStatus(): RemoteMonitorStatus {
      return {
        running: server !== null,
        url: runtimeInfo?.url,
        port: runtimeInfo?.port,
        clientCount: sseClients.size,
      }
    },
  }
}

export type RemoteMonitorManager = ReturnType<typeof createRemoteMonitorManager>
