import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { URL } from 'node:url'

import type { Provider } from '../shared/schema.js'
import { proxyStats, type ProxyStatsSummary } from './proxy-stats-store.js'

const localHost = '127.0.0.1'
const retryDelayBaseMs = 1_000
const retryDelayCapMs = 30_000
const retryDelayBackoff = 1.5
const defaultMaxRecoveryRetries = 6
const defaultFirstByteTimeoutMs = 90_000
const defaultStallTimeoutMs = 60_000
const defaultResponsesTailFetchTimeoutMs = 20_000
const defaultMaxRequestBodyBytes = 32 * 1024 * 1024
const defaultSafeResumeBodyBytes = 19 * 1024 * 1024

type Logger = Pick<Console, 'info' | 'warn' | 'error'>

type StartResilientProxyServerOptions = {
  provider: Provider
  upstreamBaseUrl: string
  firstByteTimeoutMs?: number
  stallTimeoutMs?: number
  responsesTailFetchTimeoutMs?: number
  maxRecoveryRetries?: number
  maxRequestBodyBytes?: number
  safeResumeBodyBytes?: number
  logger?: Logger
}

export type ResilientProxyRuntimeConfig = {
  firstByteTimeoutMs?: number
  stallTimeoutMs?: number
  maxRecoveryRetries?: number
}

export type RunningResilientProxyServer = {
  provider: Provider
  origin: string
  clientBaseUrl: string
  upstreamBaseUrl: string
  stop: () => Promise<void>
}

type StreamState = {
  accumulatedText: string
  skipPrefix: string
  completed: boolean
  isFirstAttempt: boolean
  responseId: string
  responseItemId: string
  messageId: string
  model: string
  awaitingToolResult: boolean
  toolNames: string[]
}

type ParsedSseBlock = {
  rawEventType?: string
  eventType: string
  dataString: string
}

class RetryableProxyError extends Error {}

class StreamTimeoutError extends RetryableProxyError {}

class UpstreamServerError extends RetryableProxyError {
  status: number
  bodyText: string
  contentType: string

  constructor(status: number, bodyText: string, contentType: string) {
    super(`HTTP ${status}`)
    this.status = status
    this.bodyText = bodyText
    this.contentType = contentType
  }
}

class UpstreamClientError extends Error {
  status: number
  bodyText: string
  contentType: string

  constructor(status: number, bodyText: string, contentType: string) {
    super(`HTTP ${status}`)
    this.status = status
    this.bodyText = bodyText
    this.contentType = contentType
  }
}

// ── Stats tracker ────────────────────────────────────────────────────────────

const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/g, '')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const cloneJson = <T>(value: T): T => structuredClone(value)

const retryDelayMs = (attempt: number) =>
  Math.min(retryDelayCapMs, Math.round(retryDelayBaseMs * retryDelayBackoff ** Math.min(attempt, 20)))

const hasNonWhitespaceText = (value: string) => value.trim().length > 0

const jsonBodySizeBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

const allowProxyBodyGrowth = (
  originalBody: unknown,
  candidateBody: unknown,
  safeResumeBodyBytes: number,
) => {
  const originalSize = jsonBodySizeBytes(originalBody)
  const candidateSize = jsonBodySizeBytes(candidateBody)

  if (candidateSize <= originalSize) {
    return true
  }

  return originalSize < safeResumeBodyBytes && candidateSize <= safeResumeBodyBytes
}

const appendUnique = (items: string[], value: unknown) => {
  if (typeof value !== 'string') {
    return
  }

  const normalized = value.trim()
  if (normalized && !items.includes(normalized)) {
    items.push(normalized)
  }
}

const filterRetryDelta = (state: StreamState, delta: string) => {
  if (!delta || !state.skipPrefix) {
    return delta
  }

  const remaining = state.skipPrefix
  let matched = 0
  const maxMatch = Math.min(delta.length, remaining.length)

  while (matched < maxMatch && delta[matched] === remaining[matched]) {
    matched += 1
  }

  if (matched === 0) {
    state.skipPrefix = ''
    return delta
  }

  if (matched === delta.length) {
    state.skipPrefix = remaining.slice(matched)
    return ''
  }

  if (matched === remaining.length) {
    state.skipPrefix = ''
    return delta.slice(matched)
  }

  state.skipPrefix = ''
  return delta
}

export { filterRetryDelta }

const computeMissingSuffix = (currentText: string, fullText: string) => {
  if (!fullText) {
    return ''
  }

  if (fullText.startsWith(currentText)) {
    return fullText.slice(currentText.length)
  }

  let overlap = Math.min(currentText.length, fullText.length)
  while (overlap > 0) {
    if (currentText.slice(-overlap) === fullText.slice(0, overlap)) {
      return fullText.slice(overlap)
    }

    overlap -= 1
  }

  return fullText
}

export { computeMissingSuffix }

const withMessagesAssistantPrefill = (
  body: Record<string, unknown>,
  partialText: string,
  safeResumeBodyBytes: number,
) => {
  const messages = Array.isArray(body.messages) ? cloneJson(body.messages) : []
  messages.push({
    role: 'assistant',
    content: partialText,
  })

  const patched = {
    ...cloneJson(body),
    messages,
  }

  return allowProxyBodyGrowth(body, patched, safeResumeBodyBytes) ? patched : null
}

export { withMessagesAssistantPrefill }

const withChatCompletionsAssistantPrefill = (
  body: Record<string, unknown>,
  partialText: string,
  safeResumeBodyBytes: number,
) => {
  const messages = Array.isArray(body.messages) ? cloneJson(body.messages) : []
  messages.push({
    role: 'assistant',
    content: partialText,
  })

  const patched = {
    ...cloneJson(body),
    messages,
  }

  return allowProxyBodyGrowth(body, patched, safeResumeBodyBytes) ? patched : null
}

const looksLikePrefillRejection = (bodyText: string) => {
  const normalized = bodyText.toLowerCase()
  if (normalized.includes('prefill') || normalized.includes('must end with a user message')) {
    return true
  }

  return (
    normalized.includes('latest assistant message cannot be modified') ||
    normalized.includes('must remain as they were in the original response')
  )
}

const summarizeStreamFailure = (error: unknown) => {
  if (error instanceof UpstreamClientError) {
    return error.bodyText || error.message
  }

  if (error instanceof UpstreamServerError) {
    return error.bodyText || error.message
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'Stream recovery failed.'
}

const classifyProxyError = (error: unknown): string => {
  if (error instanceof StreamTimeoutError) return 'timeout'
  if (error instanceof UpstreamServerError) return `upstream_${error.status}`
  if (error instanceof RetryableProxyError && error.message.includes('client disconnected')) return 'client_disconnect'
  if (error instanceof RetryableProxyError) return 'stream_interrupted'
  return 'unknown'
}

const createStreamState = (): StreamState => ({
  accumulatedText: '',
  skipPrefix: '',
  completed: false,
  isFirstAttempt: true,
  responseId: '',
  responseItemId: '',
  messageId: '',
  model: '',
  awaitingToolResult: false,
  toolNames: [],
})

const writeChunks = async (response: http.ServerResponse, text: string) => {
  if (response.destroyed || response.writableEnded) {
    return
  }

  if (!response.write(text)) {
    await once(response, 'drain')
  }
}

const parseSseBlock = (block: string): ParsedSseBlock => {
  let rawEventType: string | undefined
  const dataLines: string[] = []

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      rawEventType = line.slice(6).trim()
      continue
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  const dataString = dataLines.join('\n')
  return {
    rawEventType,
    eventType: rawEventType ?? '',
    dataString,
  }
}

const isResponsesToolCallType = (itemType: string) => {
  const normalized = itemType.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  if (
    normalized === 'function_call' ||
    normalized === 'computer_call' ||
    normalized === 'mcp_call' ||
    normalized === 'web_search_call' ||
    normalized === 'custom_tool_call'
  ) {
    return true
  }

  return normalized.endsWith('_call')
}

const trackChatCompletionToolDelta = (delta: Record<string, unknown>, state: StreamState) => {
  const functionCall = isRecord(delta.function_call) ? delta.function_call : null
  if (functionCall) {
    state.awaitingToolResult = true
    appendUnique(state.toolNames, functionCall.name)
  }

  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
  if (toolCalls.length === 0) {
    return
  }

  state.awaitingToolResult = true
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
      continue
    }

    appendUnique(state.toolNames, toolCall.function.name)
  }
}

const extractResponseText = (responseObject: Record<string, unknown>) => {
  const output = Array.isArray(responseObject.output) ? responseObject.output : []
  const textParts: string[] = []
  let itemId = ''

  for (const item of output) {
    if (!isRecord(item)) {
      continue
    }

    if (!itemId && item.type === 'message' && typeof item.id === 'string') {
      itemId = item.id
    }

    const content = Array.isArray(item.content) ? item.content : []
    for (const part of content) {
      if (!isRecord(part) || part.type !== 'output_text' || typeof part.text !== 'string') {
        continue
      }

      textParts.push(part.text)
    }
  }

  return {
    fullText: textParts.join(''),
    itemId,
  }
}

const isStreamingRequestBody = (body: Record<string, unknown>) => {
  if (body.stream === true) {
    return true
  }

  return isRecord(body.stream)
}

const readRequestBody = async (request: http.IncomingMessage, maxBytes: number) => {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) {
      throw new Error('Request body too large.')
    }

    chunks.push(buffer)
  }

  return Buffer.concat(chunks)
}

const createForwardHeaders = (headers: http.IncomingHttpHeaders) => {
  const forward = new Headers()

  for (const [key, value] of Object.entries(headers)) {
    if (!value) {
      continue
    }

    const lower = key.toLowerCase()
    if (lower === 'host' || lower === 'content-length' || lower === 'connection') {
      continue
    }

    if (Array.isArray(value)) {
      forward.set(key, value.join(', '))
      continue
    }

    forward.set(key, value)
  }

  return forward
}

const writeResponseHeaders = (response: http.ServerResponse, upstream: Response) => {
  response.statusCode = upstream.status
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection') {
      return
    }

    response.setHeader(key, value)
  })
  response.flushHeaders()
}

const pipeWebStreamToNode = async (stream: ReadableStream<Uint8Array>, response: http.ServerResponse) => {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      if (!value || response.destroyed || response.writableEnded) {
        break
      }

      if (!response.write(Buffer.from(value))) {
        await once(response, 'drain')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

const sendJson = async (
  response: http.ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', String(body.length))
  response.end(body)
}

type AttemptTarget = {
  rawPathname: string
  logicalPathname: string
  upstreamPathname: string
  search: string
}

const resolveAttemptTarget = (requestUrl: string | undefined, upstreamBaseUrl: string): AttemptTarget => {
  const incoming = new URL(requestUrl ?? '/', 'http://local.proxy')
  const rawPathname = incoming.pathname || '/'
  const needsV1Prefix =
    rawPathname === '/messages' ||
    rawPathname === '/responses' ||
    rawPathname === '/chat/completions'
  const logicalPathname =
    rawPathname.startsWith('/v1/') || rawPathname === '/v1'
      ? rawPathname
      : needsV1Prefix
        ? `/v1${rawPathname}`
        : rawPathname

  const upstreamUrl = new URL(upstreamBaseUrl)
  const upstreamPrefix = upstreamUrl.pathname.replace(/\/+$/g, '')

  let upstreamPathname = rawPathname
  if (upstreamPrefix) {
    upstreamPathname =
      rawPathname === upstreamPrefix || rawPathname.startsWith(`${upstreamPrefix}/`)
        ? rawPathname
        : `${upstreamPrefix}${rawPathname.startsWith('/') ? rawPathname : `/${rawPathname}`}`
  } else if (needsV1Prefix) {
    upstreamPathname = logicalPathname
  }

  return {
    rawPathname,
    logicalPathname,
    upstreamPathname,
    search: incoming.search,
  }
}

const buildUpstreamUrl = (origin: string, pathname: string, search: string) => `${origin}${pathname}${search}`

const readWithTimeout = async <T>(operation: Promise<T>, timeoutMs: number, reason: string) => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new StreamTimeoutError(reason)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

type RelayOptions = {
  firstByteTimeoutMs: number
  stallTimeoutMs: number
}

class SseClientWriter {
  private readonly response: http.ServerResponse

  private started = false
  private doneWritten = false

  constructor(response: http.ServerResponse) {
    this.response = response
  }

  start(statusCode: number, headers?: Headers) {
    if (this.started || this.response.destroyed || this.response.writableEnded) {
      return
    }

    this.started = true
    this.response.statusCode = statusCode

    headers?.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection') {
        return
      }

      this.response.setHeader(key, value)
    })

    if (!this.response.hasHeader('Content-Type')) {
      this.response.setHeader('Content-Type', 'text/event-stream')
    }

    if (!this.response.hasHeader('Cache-Control')) {
      this.response.setHeader('Cache-Control', 'no-cache')
    }

    if (!this.response.hasHeader('Connection')) {
      this.response.setHeader('Connection', 'keep-alive')
    }

    this.response.flushHeaders()
  }

  isStarted() {
    return this.started
  }

  isDisconnected() {
    return this.response.destroyed || this.response.writableEnded
  }

  async writeBlock(block: string) {
    const trimmed = block.trim()
    if (!trimmed || this.isDisconnected()) {
      return
    }

    await writeChunks(this.response, `${trimmed}\n\n`)
  }

  async writePayload(eventType: string | undefined, dataString: string) {
    const lines: string[] = []
    if (eventType) {
      lines.push(`event: ${eventType}`)
    }

    const dataLines = dataString.split('\n')
    for (const line of dataLines) {
      lines.push(`data: ${line}`)
    }

    await this.writeBlock(lines.join('\n'))
  }

  async writeDoneMarker() {
    if (this.doneWritten) {
      return
    }

    this.doneWritten = true
    await this.writePayload(undefined, '[DONE]')
  }

  async writeError(message: string) {
    await this.writePayload(
      'error',
      JSON.stringify({
        type: 'error',
        error: {
          type: 'proxy_error',
          message,
        },
      }),
    )
  }

  async close() {
    if (this.response.destroyed || this.response.writableEnded) {
      return
    }

    this.response.end()
  }
}

class ResilientProxyServer {
  private readonly provider: Provider

  private readonly upstreamBaseUrl: string

  private readonly upstreamOrigin: string

  private readonly firstByteTimeoutMs: number

  private readonly stallTimeoutMs: number

  private readonly responsesTailFetchTimeoutMs: number

  private readonly maxRecoveryRetries: number

  private readonly maxRequestBodyBytes: number

  private readonly safeResumeBodyBytes: number

  private readonly logger: Logger

  private server: http.Server | null = null

  private listenPort = 0

  constructor(options: StartResilientProxyServerOptions) {
    this.provider = options.provider
    this.upstreamBaseUrl = normalizeBaseUrl(options.upstreamBaseUrl)
    this.upstreamOrigin = new URL(this.upstreamBaseUrl).origin
    this.firstByteTimeoutMs = options.firstByteTimeoutMs ?? defaultFirstByteTimeoutMs
    this.stallTimeoutMs = options.stallTimeoutMs ?? defaultStallTimeoutMs
    this.responsesTailFetchTimeoutMs =
      options.responsesTailFetchTimeoutMs ?? defaultResponsesTailFetchTimeoutMs
    this.maxRecoveryRetries =
      options.maxRecoveryRetries === -1
        ? Number.POSITIVE_INFINITY
        : (options.maxRecoveryRetries ?? defaultMaxRecoveryRetries)
    this.maxRequestBodyBytes = options.maxRequestBodyBytes ?? defaultMaxRequestBodyBytes
    this.safeResumeBodyBytes = options.safeResumeBodyBytes ?? defaultSafeResumeBodyBytes
    this.logger = options.logger ?? console
  }

  async start(): Promise<RunningResilientProxyServer> {
    if (this.server) {
      return this.toRunningServer()
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    this.server.listen(0, localHost)
    await once(this.server, 'listening')
    const address = this.server.address()

    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine the resilient proxy listen port.')
    }

    this.listenPort = address.port
    this.logger.info(
      `[resilient-proxy] ${this.provider} proxy listening on http://${localHost}:${this.listenPort} -> ${this.upstreamBaseUrl}`,
    )

    return this.toRunningServer()
  }

  private toRunningServer(): RunningResilientProxyServer {
    const origin = `http://${localHost}:${this.listenPort}`
    return {
      provider: this.provider,
      origin,
      clientBaseUrl: this.provider === 'codex' ? `${origin}/v1` : origin,
      upstreamBaseUrl: this.upstreamBaseUrl,
      stop: async () => {
        if (!this.server) {
          return
        }

        const activeServer = this.server
        this.server = null
        activeServer.close()
        await once(activeServer, 'close').catch(() => undefined)
      },
    }
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      const bodyBuffer = await readRequestBody(request, this.maxRequestBodyBytes)
      const target = resolveAttemptTarget(request.url, this.upstreamBaseUrl)
      const body = this.tryParseJson(bodyBuffer, request.headers['content-type'])
      const endpoint = target.logicalPathname

      if (request.method === 'POST' && endpoint === '/v1/messages' && isRecord(body) && isStreamingRequestBody(body)) {
        await this.handleMessagesStream(target, request, response, body)
        return
      }

      if (request.method === 'POST' && endpoint === '/v1/responses' && isRecord(body) && isStreamingRequestBody(body)) {
        await this.handleResponsesStream(target, request, response, body)
        return
      }

      if (
        request.method === 'POST' &&
        endpoint === '/v1/chat/completions' &&
        isRecord(body) &&
        isStreamingRequestBody(body)
      ) {
        await this.handleChatCompletionsStream(target, request, response, body)
        return
      }

      await this.forwardDirect(target, request, response, bodyBuffer)
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined)
        return
      }

      const message = error instanceof Error ? error.message : 'Unexpected proxy error.'
      await sendJson(response, message === 'Request body too large.' ? 413 : 500, {
        error: {
          type: 'proxy_error',
          message,
        },
      })
    }
  }

  private tryParseJson(body: Buffer, contentType: string | string[] | undefined) {
    const normalizedType = Array.isArray(contentType) ? contentType.join(', ') : contentType ?? ''
    if (!normalizedType.toLowerCase().includes('json')) {
      return null
    }

    try {
      return JSON.parse(body.toString('utf8')) as unknown
    } catch {
      return null
    }
  }

  private async forwardDirect(
    target: AttemptTarget,
    request: http.IncomingMessage,
    response: http.ServerResponse,
    bodyBuffer: Buffer,
  ) {
    const headers = createForwardHeaders(request.headers)
    const upstreamResponse = await fetch(buildUpstreamUrl(this.upstreamOrigin, target.upstreamPathname, target.search), {
      method: request.method,
      headers,
      body: bodyBuffer.length > 0 ? new Uint8Array(bodyBuffer) : undefined,
    })

    writeResponseHeaders(response, upstreamResponse)
    if (upstreamResponse.body) {
      await pipeWebStreamToNode(upstreamResponse.body, response)
    }

    response.end()
  }

  private async handleMessagesStream(
    target: AttemptTarget,
    request: http.IncomingMessage,
    response: http.ServerResponse,
    body: Record<string, unknown>,
  ) {
    const endpoint = target.logicalPathname
    proxyStats.record(this.provider, 'request', endpoint)

    const originalBody = cloneJson(body)
    const originalMessages = Array.isArray(body.messages) ? cloneJson(body.messages) : []
    const headers = createForwardHeaders(request.headers)
    const writer = new SseClientWriter(response)
    const state = createStreamState()
    let attempt = 0
    let prefillDisabled = false

    while (attempt <= this.maxRecoveryRetries) {
      try {
        const attemptBody =
          attempt === 0
            ? cloneJson(originalBody)
            : this.prepareMessagesRetryBody(originalBody, originalMessages, state, prefillDisabled)

        if (attempt > 0) {
          state.isFirstAttempt = false
          await delay(retryDelayMs(attempt))
        }

        const upstreamResponse = await this.fetchStream(target, headers, attemptBody)
        if (!writer.isStarted()) {
          writer.start(upstreamResponse.status, upstreamResponse.headers)
        }

        await this.relaySseStream(
          upstreamResponse,
          writer,
          (block) => this.onMessagesEvent(block, state, writer),
          {
            firstByteTimeoutMs: this.firstByteTimeoutMs,
            stallTimeoutMs: this.stallTimeoutMs,
          },
        )

        if (!state.completed) {
          throw new RetryableProxyError('Stream closed before message_stop.')
        }

        if (attempt > 0) {
          proxyStats.record(this.provider, 'recovery_success', endpoint, { attempt })
        }
        await writer.close()
        return
      } catch (error) {
        if (error instanceof UpstreamClientError) {
          if (looksLikePrefillRejection(error.bodyText) && !prefillDisabled) {
            prefillDisabled = true
            continue
          }

          await this.finishClientError(response, writer, error)
          return
        }

        proxyStats.record(this.provider, 'disconnect', endpoint, {
          attempt,
          errorType: classifyProxyError(error),
        })

        if (attempt >= this.maxRecoveryRetries) {
          proxyStats.record(this.provider, 'recovery_fail', endpoint, { attempt })
          await this.finishStreamFailure(response, writer, error)
          return
        }

        attempt += 1
      }
    }
  }

  private async handleResponsesStream(
    target: AttemptTarget,
    request: http.IncomingMessage,
    response: http.ServerResponse,
    body: Record<string, unknown>,
  ) {
    const endpoint = target.logicalPathname
    proxyStats.record(this.provider, 'request', endpoint)

    const originalBody = cloneJson(body)
    const headers = createForwardHeaders(request.headers)
    const writer = new SseClientWriter(response)
    const state = createStreamState()
    let attempt = 0

    while (attempt <= this.maxRecoveryRetries) {
      try {
        const attemptBody = cloneJson(originalBody)
        if (attempt > 0) {
          state.isFirstAttempt = false
          state.skipPrefix = state.accumulatedText
          await delay(retryDelayMs(attempt))
        }

        const upstreamResponse = await this.fetchStream(target, headers, attemptBody)
        if (!writer.isStarted()) {
          writer.start(upstreamResponse.status, upstreamResponse.headers)
        }

        await this.relaySseStream(
          upstreamResponse,
          writer,
          (block) => this.onResponsesEvent(block, state, writer),
          {
            firstByteTimeoutMs: this.firstByteTimeoutMs,
            stallTimeoutMs: this.stallTimeoutMs,
          },
        )

        if (!state.completed) {
          throw new RetryableProxyError('Stream closed before response.completed.')
        }

        if (attempt > 0) {
          proxyStats.record(this.provider, 'recovery_success', endpoint, { attempt })
        }
        await writer.close()
        return
      } catch (error) {
        if (error instanceof UpstreamClientError) {
          await this.finishClientError(response, writer, error)
          return
        }

        proxyStats.record(this.provider, 'disconnect', endpoint, {
          attempt,
          errorType: classifyProxyError(error),
        })

        if (await this.recoverResponsesTail(target, headers, state, writer)) {
          proxyStats.record(this.provider, 'recovery_success', endpoint, { attempt })
          await writer.close()
          return
        }

        if (attempt >= this.maxRecoveryRetries) {
          proxyStats.record(this.provider, 'recovery_fail', endpoint, { attempt })
          await this.finishStreamFailure(response, writer, error)
          return
        }

        attempt += 1
      }
    }
  }

  private async handleChatCompletionsStream(
    target: AttemptTarget,
    request: http.IncomingMessage,
    response: http.ServerResponse,
    body: Record<string, unknown>,
  ) {
    const endpoint = target.logicalPathname
    proxyStats.record(this.provider, 'request', endpoint)

    const originalBody = cloneJson(body)
    const originalMessages = Array.isArray(body.messages) ? cloneJson(body.messages) : []
    const headers = createForwardHeaders(request.headers)
    const writer = new SseClientWriter(response)
    const state = createStreamState()
    let attempt = 0
    let prefillDisabled = false

    while (attempt <= this.maxRecoveryRetries) {
      try {
        const attemptBody =
          attempt === 0
            ? cloneJson(originalBody)
            : this.prepareChatCompletionsRetryBody(originalBody, originalMessages, state, prefillDisabled)

        if (attempt > 0) {
          state.isFirstAttempt = false
          await delay(retryDelayMs(attempt))
        }

        const upstreamResponse = await this.fetchStream(target, headers, attemptBody)
        if (!writer.isStarted()) {
          writer.start(upstreamResponse.status, upstreamResponse.headers)
        }

        await this.relaySseStream(
          upstreamResponse,
          writer,
          (block) => this.onChatCompletionsEvent(block, state, writer),
          {
            firstByteTimeoutMs: this.firstByteTimeoutMs,
            stallTimeoutMs: this.stallTimeoutMs,
          },
        )

        if (!state.completed) {
          throw new RetryableProxyError('Stream closed before chat completion finished.')
        }

        if (attempt > 0) {
          proxyStats.record(this.provider, 'recovery_success', endpoint, { attempt })
        }
        await writer.close()
        return
      } catch (error) {
        if (error instanceof UpstreamClientError) {
          if (looksLikePrefillRejection(error.bodyText) && !prefillDisabled) {
            prefillDisabled = true
            continue
          }

          await this.finishClientError(response, writer, error)
          return
        }

        proxyStats.record(this.provider, 'disconnect', endpoint, {
          attempt,
          errorType: classifyProxyError(error),
        })

        if (attempt >= this.maxRecoveryRetries) {
          proxyStats.record(this.provider, 'recovery_fail', endpoint, { attempt })
          await this.finishStreamFailure(response, writer, error)
          return
        }

        attempt += 1
      }
    }
  }

  private prepareMessagesRetryBody(
    originalBody: Record<string, unknown>,
    originalMessages: unknown[],
    state: StreamState,
    prefillDisabled: boolean,
  ) {
    state.skipPrefix = state.accumulatedText
    const attemptBody = {
      ...cloneJson(originalBody),
      messages: cloneJson(originalMessages),
    }

    if (prefillDisabled || !hasNonWhitespaceText(state.accumulatedText)) {
      return attemptBody
    }

    return (
      withMessagesAssistantPrefill(attemptBody, state.accumulatedText, this.safeResumeBodyBytes) ?? attemptBody
    )
  }

  private prepareChatCompletionsRetryBody(
    originalBody: Record<string, unknown>,
    originalMessages: unknown[],
    state: StreamState,
    prefillDisabled: boolean,
  ) {
    state.skipPrefix = state.accumulatedText
    const attemptBody = {
      ...cloneJson(originalBody),
      messages: cloneJson(originalMessages),
    }

    if (prefillDisabled || !hasNonWhitespaceText(state.accumulatedText)) {
      return attemptBody
    }

    return (
      withChatCompletionsAssistantPrefill(
        attemptBody,
        state.accumulatedText,
        this.safeResumeBodyBytes,
      ) ?? attemptBody
    )
  }

  private async fetchStream(
    target: AttemptTarget,
    headers: Headers,
    body: Record<string, unknown>,
  ) {
    const requestHeaders = new Headers(headers)
    if (!requestHeaders.has('Content-Type')) {
      requestHeaders.set('Content-Type', 'application/json')
    }

    const upstreamResponse = await fetch(
      buildUpstreamUrl(this.upstreamOrigin, target.upstreamPathname, target.search),
      {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
      },
    )

    if (upstreamResponse.status >= 500) {
      throw new UpstreamServerError(
        upstreamResponse.status,
        await upstreamResponse.text(),
        upstreamResponse.headers.get('content-type') ?? 'text/plain; charset=utf-8',
      )
    }

    if (upstreamResponse.status >= 400) {
      throw new UpstreamClientError(
        upstreamResponse.status,
        await upstreamResponse.text(),
        upstreamResponse.headers.get('content-type') ?? 'application/json; charset=utf-8',
      )
    }

    return upstreamResponse
  }

  private async relaySseStream(
    upstreamResponse: Response,
    writer: SseClientWriter,
    onBlock: (block: string) => Promise<void>,
    options: RelayOptions,
  ) {
    if (!upstreamResponse.body) {
      throw new RetryableProxyError('Upstream stream body was empty.')
    }

    const reader = upstreamResponse.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let receivedAny = false

    try {
      while (true) {
        const timeoutMs = receivedAny ? options.stallTimeoutMs : options.firstByteTimeoutMs
        const result = await readWithTimeout(reader.read(), timeoutMs, 'Upstream stream timed out.')
        if (result.done) {
          break
        }

        receivedAny = true
        buffer += decoder.decode(result.value, { stream: true })

        while (true) {
          const match = /\r?\n\r?\n/.exec(buffer)
          if (!match) {
            break
          }

          const block = buffer.slice(0, match.index)
          buffer = buffer.slice(match.index + match[0].length)
          if (block.trim()) {
            await onBlock(block)
          }
        }
      }

      buffer += decoder.decode()
      if (buffer.trim()) {
        await onBlock(buffer.trim())
      }
    } finally {
      reader.releaseLock()
    }

    if (writer.isDisconnected()) {
      throw new RetryableProxyError('Downstream client disconnected.')
    }
  }

  private async finishClientError(
    response: http.ServerResponse,
    writer: SseClientWriter,
    error: UpstreamClientError,
  ) {
    if (!writer.isStarted()) {
      response.statusCode = error.status
      response.setHeader('Content-Type', error.contentType)
      response.end(error.bodyText)
      return
    }

    await writer.writeError(error.bodyText || error.message)
    await writer.close()
  }

  private async finishStreamFailure(
    response: http.ServerResponse,
    writer: SseClientWriter,
    error: unknown,
  ) {
    const message = summarizeStreamFailure(error)

    if (!writer.isStarted()) {
      await sendJson(response, 503, {
        error: {
          type: 'proxy_error',
          message,
        },
      })
      return
    }

    await writer.writeError(message)
    await writer.close()
  }

  private async onMessagesEvent(block: string, state: StreamState, writer: SseClientWriter) {
    const parsed = parseSseBlock(block)
    if (!parsed.dataString) {
      return
    }

    let payload: Record<string, unknown> | null = null
    try {
      payload = JSON.parse(parsed.dataString) as Record<string, unknown>
    } catch {
      await writer.writeBlock(block)
      return
    }

    const eventType = parsed.rawEventType ?? String(payload.type ?? '')

    if (eventType === 'message_start') {
      const message = isRecord(payload.message) ? payload.message : null
      state.messageId = typeof message?.id === 'string' ? message.id : state.messageId
      state.model = typeof message?.model === 'string' ? message.model : state.model
      if (state.isFirstAttempt) {
        await writer.writeBlock(block)
      }
      return
    }

    if (eventType === 'content_block_start') {
      const contentBlock = isRecord(payload.content_block) ? payload.content_block : null
      if (contentBlock?.type === 'tool_use') {
        state.awaitingToolResult = true
        appendUnique(state.toolNames, contentBlock.name)
      }

      if (state.isFirstAttempt || Number(payload.index ?? 0) > 0) {
        await writer.writeBlock(block)
      }
      return
    }

    if (eventType === 'content_block_delta') {
      const delta = isRecord(payload.delta) ? payload.delta : null
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        const nextText = filterRetryDelta(state, delta.text)
        if (!nextText) {
          return
        }

        state.accumulatedText += nextText
        if (nextText !== delta.text) {
          const patched = cloneJson(payload)
          if (isRecord(patched.delta)) {
            patched.delta.text = nextText
          }

          await writer.writePayload(parsed.rawEventType, JSON.stringify(patched))
          return
        }
      }

      await writer.writeBlock(block)
      return
    }

    if (eventType === 'message_delta') {
      const delta = isRecord(payload.delta) ? payload.delta : null
      const stopReason =
        typeof delta?.stop_reason === 'string'
          ? delta.stop_reason
          : typeof payload.stop_reason === 'string'
            ? payload.stop_reason
            : ''
      if (stopReason === 'tool_use') {
        state.awaitingToolResult = true
      }
      if (stopReason) {
        state.completed = true
      }

      await writer.writeBlock(block)
      return
    }

    if (eventType === 'message_stop') {
      state.completed = true
      await writer.writeBlock(block)
      return
    }

    await writer.writeBlock(block)
  }

  private async onResponsesEvent(block: string, state: StreamState, writer: SseClientWriter) {
    const parsed = parseSseBlock(block)
    if (!parsed.dataString) {
      return
    }

    if (parsed.dataString === '[DONE]') {
      state.completed = true
      await writer.writeDoneMarker()
      return
    }

    let payload: Record<string, unknown> | null = null
    try {
      payload = JSON.parse(parsed.dataString) as Record<string, unknown>
    } catch {
      await writer.writeBlock(block)
      return
    }

    const eventType = parsed.rawEventType ?? String(payload.type ?? '')

    if (eventType === 'response.created') {
      const responsePayload = isRecord(payload.response) ? payload.response : null
      state.responseId =
        typeof responsePayload?.id === 'string' ? responsePayload.id : state.responseId
      state.model = typeof responsePayload?.model === 'string' ? responsePayload.model : state.model
      if (state.isFirstAttempt) {
        await writer.writeBlock(block)
      }
      return
    }

    if (eventType === 'response.output_item.added') {
      const item = isRecord(payload.item) ? payload.item : null
      if (item?.type === 'message' && typeof item.id === 'string') {
        state.responseItemId = item.id
      }

      if (isResponsesToolCallType(String(item?.type ?? ''))) {
        state.awaitingToolResult = true
        appendUnique(
          state.toolNames,
          typeof item?.name === 'string'
            ? item.name
            : typeof item?.tool_name === 'string'
              ? item.tool_name
              : typeof item?.call_name === 'string'
                ? item.call_name
                : typeof item?.type === 'string'
                  ? item.type
                  : '',
        )
      }

      if (state.isFirstAttempt) {
        await writer.writeBlock(block)
      }
      return
    }

    if (eventType === 'response.output_text.delta') {
      state.responseId = typeof payload.response_id === 'string' ? payload.response_id : state.responseId
      state.responseItemId = typeof payload.item_id === 'string' ? payload.item_id : state.responseItemId

      if (typeof payload.delta === 'string') {
        const nextDelta = filterRetryDelta(state, payload.delta)
        if (!nextDelta) {
          return
        }

        state.accumulatedText += nextDelta
        if (nextDelta !== payload.delta) {
          const patched = {
            ...cloneJson(payload),
            delta: nextDelta,
          }
          await writer.writePayload(parsed.rawEventType, JSON.stringify(patched))
          return
        }
      }

      await writer.writeBlock(block)
      return
    }

    if (eventType === 'response.output_text.done') {
      if (state.isFirstAttempt) {
        await writer.writeBlock(block)
      }
      return
    }

    if (isResponsesToolCallType(String(payload.type ?? ''))) {
      state.awaitingToolResult = true
      appendUnique(
        state.toolNames,
        typeof payload.name === 'string'
          ? payload.name
          : typeof payload.tool_name === 'string'
            ? payload.tool_name
            : typeof payload.call_name === 'string'
              ? payload.call_name
              : typeof payload.type === 'string'
                ? payload.type
                : '',
      )
    }

    if (eventType === 'response.completed') {
      const responsePayload = isRecord(payload.response) ? payload.response : null
      state.responseId =
        typeof responsePayload?.id === 'string' ? responsePayload.id : state.responseId
      state.completed = true
      await writer.writeBlock(block)
      return
    }

    if (eventType === 'response.failed' || eventType === 'response.incomplete') {
      const responsePayload = isRecord(payload.response) ? payload.response : null
      state.responseId =
        typeof responsePayload?.id === 'string' ? responsePayload.id : state.responseId
      await writer.writeBlock(block)
      return
    }

    if (state.isFirstAttempt) {
      await writer.writeBlock(block)
    }
  }

  private async onChatCompletionsEvent(block: string, state: StreamState, writer: SseClientWriter) {
    const parsed = parseSseBlock(block)
    if (!parsed.dataString) {
      return
    }

    if (parsed.dataString === '[DONE]') {
      state.completed = true
      await writer.writeDoneMarker()
      return
    }

    let payload: Record<string, unknown> | null = null
    try {
      payload = JSON.parse(parsed.dataString) as Record<string, unknown>
    } catch {
      await writer.writeBlock(block)
      return
    }

    state.model = typeof payload.model === 'string' ? payload.model : state.model
    state.responseId = typeof payload.id === 'string' ? payload.id : state.responseId

    const choices = Array.isArray(payload.choices) ? payload.choices : []
    if (choices.length === 0) {
      if (state.isFirstAttempt) {
        await writer.writeBlock(block)
      }
      return
    }

    if (choices.length !== 1 || !isRecord(choices[0])) {
      for (const choice of choices) {
        if (!isRecord(choice)) {
          continue
        }

        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          state.completed = true
        }

        if (isRecord(choice.delta)) {
          trackChatCompletionToolDelta(choice.delta, state)
        }
      }

      if (state.isFirstAttempt || state.completed || state.awaitingToolResult) {
        await writer.writeBlock(block)
      }
      return
    }

    const choice = choices[0]
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      state.completed = true
      await writer.writeBlock(block)
      return
    }

    const delta = isRecord(choice.delta) ? choice.delta : null
    if (!delta) {
      if (state.isFirstAttempt) {
        await writer.writeBlock(block)
      }
      return
    }

    trackChatCompletionToolDelta(delta, state)

    if (typeof delta.content === 'string') {
      const nextContent = filterRetryDelta(state, delta.content)
      if (!nextContent) {
        return
      }

      state.accumulatedText += nextContent
      if (nextContent !== delta.content) {
        const patched = cloneJson(payload)
        const patchedChoices = Array.isArray(patched.choices) ? patched.choices : []
        if (isRecord(patchedChoices[0]) && isRecord(patchedChoices[0].delta)) {
          patchedChoices[0].delta.content = nextContent
        }

        await writer.writePayload(parsed.rawEventType, JSON.stringify(patched))
        return
      }

      await writer.writeBlock(block)
      return
    }

    if (delta.role) {
      if (state.isFirstAttempt) {
        await writer.writeBlock(block)
      }
      return
    }

    if (state.isFirstAttempt || state.awaitingToolResult) {
      await writer.writeBlock(block)
    }
  }

  private async recoverResponsesTail(
    target: AttemptTarget,
    headers: Headers,
    state: StreamState,
    writer: SseClientWriter,
  ) {
    if (!state.responseId) {
      return false
    }

    const deadline = Date.now() + this.responsesTailFetchTimeoutMs
    const requestHeaders = new Headers(headers)
    requestHeaders.delete('Content-Type')
    requestHeaders.delete('Accept')
    const tailPath = `${target.upstreamPathname}/${state.responseId}`.replace(/\/{2,}/g, '/')

    while (Date.now() < deadline) {
      try {
        const upstreamResponse = await fetch(buildUpstreamUrl(this.upstreamOrigin, tailPath, ''), {
          method: 'GET',
          headers: requestHeaders,
        })

        if (upstreamResponse.status === 404) {
          return false
        }

        if (upstreamResponse.status >= 500) {
          await delay(1_000)
          continue
        }

        if (upstreamResponse.status >= 400) {
          return false
        }

        const payload = (await upstreamResponse.json()) as Record<string, unknown>
        const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : ''
        if (status === 'completed') {
          await this.forwardRecoveredResponse(payload, state, writer)
          return true
        }

        if (status === 'failed' || status === 'incomplete' || status === 'cancelled' || status === 'canceled') {
          return false
        }
      } catch {
        await delay(1_000)
        continue
      }

      await delay(1_000)
    }

    return false
  }

  private async forwardRecoveredResponse(
    responseObject: Record<string, unknown>,
    state: StreamState,
    writer: SseClientWriter,
  ) {
    const { fullText, itemId } = extractResponseText(responseObject)
    if (itemId) {
      state.responseItemId = itemId
    }

    if (typeof responseObject.id === 'string') {
      state.responseId = responseObject.id
    }

    const missingSuffix = computeMissingSuffix(state.accumulatedText, fullText)
    if (missingSuffix) {
      state.accumulatedText += missingSuffix
      await writer.writePayload(
        'response.output_text.delta',
        JSON.stringify({
          type: 'response.output_text.delta',
          response_id: state.responseId,
          item_id: state.responseItemId,
          output_index: 0,
          content_index: 0,
          delta: missingSuffix,
        }),
      )
    }

    await writer.writePayload(
      'response.completed',
      JSON.stringify({
        type: 'response.completed',
        response: responseObject,
      }),
    )
    state.completed = true
    await writer.writeDoneMarker()
  }
}

export const startResilientProxyServer = async (options: StartResilientProxyServerOptions) =>
  new ResilientProxyServer(options).start()

class ResilientProxyPool {
  private readonly logger: Logger

  private readonly servers = new Map<string, Promise<RunningResilientProxyServer> | RunningResilientProxyServer>()

  private runtimeConfig: ResilientProxyRuntimeConfig = {}

  constructor(logger: Logger = console) {
    this.logger = logger
  }

  async resolveBaseUrl(provider: Provider, upstreamBaseUrl: string, config?: ResilientProxyRuntimeConfig) {
    const normalizedUpstream = normalizeBaseUrl(upstreamBaseUrl)
    const effectiveConfig = config ?? this.runtimeConfig
    const key = `${provider}:${normalizedUpstream}:${effectiveConfig.firstByteTimeoutMs ?? 'default'}:${effectiveConfig.stallTimeoutMs ?? 'default'}:${effectiveConfig.maxRecoveryRetries ?? 'default'}`
    const existing = this.servers.get(key)

    if (existing) {
      const running = await existing
      return running.clientBaseUrl
    }

    const pending = startResilientProxyServer({
      provider,
      upstreamBaseUrl: normalizedUpstream,
      ...effectiveConfig,
      logger: this.logger,
    }).catch((error) => {
      this.servers.delete(key)
      throw error
    })

    this.servers.set(key, pending)
    const running = await pending
    this.servers.set(key, running)
    return running.clientBaseUrl
  }


  async configure(config: ResilientProxyRuntimeConfig) {
    const nextConfig = {
      firstByteTimeoutMs: config.firstByteTimeoutMs,
      stallTimeoutMs: config.stallTimeoutMs,
      maxRecoveryRetries: config.maxRecoveryRetries,
    }
    if (
      this.runtimeConfig.firstByteTimeoutMs === nextConfig.firstByteTimeoutMs &&
      this.runtimeConfig.stallTimeoutMs === nextConfig.stallTimeoutMs &&
      this.runtimeConfig.maxRecoveryRetries === nextConfig.maxRecoveryRetries
    ) {
      return
    }

    this.runtimeConfig = nextConfig
    await this.dispose()
  }

  async dispose() {
    const entries = [...this.servers.values()]
    this.servers.clear()
    await Promise.all(
      entries.map(async (entry) => {
        const running = await entry
        await running.stop().catch(() => undefined)
      }),
    )
  }

  getStats(since?: number): ProxyStatsSummary {
    return proxyStats.getStats(since)
  }

  resetStats() {
    proxyStats.reset()
  }
}

export const resilientProxyPool = new ResilientProxyPool()
