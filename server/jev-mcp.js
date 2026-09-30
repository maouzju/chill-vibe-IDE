import { realpath, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// JEV 快速判断 MCP（docs/specs/jev-mcp-toggle）。只在设置里打开「JEV 快速判断」的回合被注入。
// 一个工具 `jev_ask`：对一批文件/文本并发问同一组「是否 / 选择 / 打分」问题，返回精简 JSON。
// 为什么只做这一个：09-29 调研社区用法（JevMCP / jev-mcp / jev-kit），MCP 形态唯一被反复
// 证明有用的是「批量筛文件」；单次判断在原生 Windows 上中位约 1s，并不比 Haiku 快多少，
// 价值在于大批量并发、便宜、结果不占 agent 上下文。
// 精简格式照 JevMCP（MIT）：noul → 0.93 / [0.55,"?"]；choice/score → [值, 置信度]，不确定附 top-2。

export const jevKeyFileEnvKey = 'CHILL_VIBE_JEV_KEY_FILE'
export const jevRootEnvKey = 'CHILL_VIBE_JEV_ROOT'

const protocolVersion = '2025-03-26'
const defaultThreshold = 0.6
const maxItems = 300
const maxStateChars = 60_000
const maxFileBytes = 1_000_000
const concurrency = 8
const requestTimeoutMs = 30_000
const retryStatuses = new Set([408, 429, 500, 502, 503, 504, 529])
const deadKeyStatuses = new Set([401, 402, 403])
const skippedDirNames = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', 'coverage', '.venv', 'venv', '__pycache__', 'target',
])
const binaryExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.7z', '.exe', '.dll', '.so',
  '.dylib', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.wav', '.mov', '.lock', '.asar', '.node', '.wasm',
])

export const jevMcpToolDefinitions = [
  {
    name: 'jev_ask',
    description:
      'Fast yes/no, choice and score judgments over many files or texts at once (JEV, ~0.1-1s each, cheap). ' +
      'Use it to triage or classify dozens of files before reading them; it cannot write, count or do math. ' +
      'Returns compact JSON: noul=P(yes), choice/score=[value,confidence]; "unsure" lists low-confidence answers to double-check.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'object',
          description:
            'Map of id -> {type:"noul"|"choice"|"score", instructions, criteria?}. choice criteria: {option: description}; score criteria: array low->high (2-10 levels).',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files or directories relative to the workspace (directories are walked; node_modules/.git/dist skipped).',
        },
        extensions: { type: 'array', items: { type: 'string' }, description: 'Only files with these extensions, e.g. [".ts"].' },
        texts: { type: 'array', items: { type: 'string' }, description: 'Inline texts to judge.' },
        threshold: { type: 'number', description: 'Confidence below this is reported as unsure (default 0.6).' },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  },
]

const round2 = (value) => Math.round(Number(value) * 100) / 100

export const resolveJevEndpoint = (apiKey) =>
  apiKey.startsWith('sk-or-')
    ? { provider: 'openrouter', url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' }
    : { provider: 'typesafe', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' }

const answerConfidence = (answer) =>
  answer?.type === 'noul' ? Math.abs(2 * Number(answer.noul) - 1) : Number(answer?.confidence ?? 0)

export const compactJevAnswer = (answer, threshold = defaultThreshold) => {
  if (answer?.type === 'noul') {
    const probability = round2(answer.noul)
    return Math.abs(2 * probability - 1) >= threshold ? probability : [probability, '?']
  }
  const value = answer?.type === 'choice' ? answer.choice : round2(answer?.score)
  const confidence = round2(answer?.confidence ?? 0)
  if (confidence >= threshold) {
    return [value, confidence]
  }
  const top = Object.entries(answer?.probabilities ?? {})
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 2)
  return [value, confidence, Object.fromEntries(top.map(([key, probability]) => [key, round2(probability)]))]
}

const toPosix = (value) => value.split(path.sep).join('/')

/** 把 paths/texts 展开成待判断条目；相对路径按工作区解析，目录递归，跳过依赖/构建目录与二进制。 */
export const collectJevItems = async (root, { paths = [], texts = [], extensions } = {}) => {
  const items = []
  const skipped = []
  const allowed = Array.isArray(extensions) && extensions.length > 0
    ? new Set(extensions.map((entry) => (String(entry).startsWith('.') ? String(entry) : `.${entry}`).toLowerCase()))
    : null
  const seen = new Set()
  // 症状：JEV 的相对路径或链接可把工作区外文件上传给第三方。
  // 根因：2026-09-30 发布审计及红测证实，path.resolve 本身不限制读取边界。
  // 不只做字符串前缀检查：realpath 后再校验，才能挡住符号链接与目录联接。
  const rootReal = await realpath(root)
  const ensureInsideRoot = async (candidate) => {
    const resolved = await realpath(candidate)
    const relative = path.relative(rootReal, resolved)
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('path is outside the workspace')
    }
    return resolved
  }

  const addFile = async (absolutePath, explicit) => {
    try {
      absolutePath = await ensureInsideRoot(absolutePath)
    } catch (error) {
      skipped.push(String(absolutePath) + ': ' + (error instanceof Error ? error.message : String(error)))
      return
    }
    if (items.length >= maxItems || seen.has(absolutePath)) return
    const extension = path.extname(absolutePath).toLowerCase()
    if (binaryExtensions.has(extension)) return
    if (!explicit && allowed && !allowed.has(extension)) return
    seen.add(absolutePath)
    const label = toPosix(path.relative(root, absolutePath)) || path.basename(absolutePath)
    try {
      const info = await stat(absolutePath)
      if (info.size > maxFileBytes) {
        skipped.push(`${label}: larger than 1MB`)
        return
      }
      const content = await readFile(absolutePath, 'utf8')
      if (content.includes('\u0000')) return
      items.push({ label, state: content })
    } catch (error) {
      skipped.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const walk = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      skipped.push(`${toPosix(path.relative(root, directory)) || '.'}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (items.length >= maxItems) return
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!skippedDirNames.has(entry.name)) await walk(absolutePath)
      } else if (entry.isFile()) {
        await addFile(absolutePath, false)
      }
    }
  }

  for (const rawPath of paths) {
    if (items.length >= maxItems) break
    let absolutePath
    try {
      absolutePath = await ensureInsideRoot(path.resolve(root, String(rawPath)))
    } catch (error) {
      skipped.push(String(rawPath) + ': ' + (error instanceof Error ? error.message : String(error)))
      continue
    }
    // 显式点名的 node_modules 也不展开：一个依赖目录就能把 300 项额度吃光。
    if (skippedDirNames.has(path.basename(absolutePath))) continue
    try {
      const info = await stat(absolutePath)
      if (info.isDirectory()) await walk(absolutePath)
      else await addFile(absolutePath, true)
    } catch {
      skipped.push(`${rawPath}: not found`)
    }
  }

  texts.forEach((text, index) => {
    if (items.length < maxItems) items.push({ label: `text[${index}]`, state: String(text) })
  })

  return { items, skipped }
}

const redact = (text, secret) => (secret ? String(text).split(secret).join('[redacted]') : String(text))

class JevKeyRejectedError extends Error {}

const postJev = async (endpoint, apiKey, state, questions, fetchImpl) => {
  let lastError = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      const response = await fetchImpl(endpoint.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: endpoint.model, state, questions }),
        signal: controller.signal,
      })
      const body = await response.text()
      if (response.ok) {
        const parsed = JSON.parse(body)
        return parsed?.answers ?? {}
      }
      if (deadKeyStatuses.has(response.status)) {
        throw new JevKeyRejectedError(
          `JEV rejected the API key (HTTP ${response.status}); check the key in Chill Vibe settings.`,
        )
      }
      lastError = `HTTP ${response.status}: ${redact(body.slice(0, 200), apiKey)}`
      if (!retryStatuses.has(response.status)) break
    } catch (error) {
      if (error instanceof JevKeyRejectedError) throw error
      lastError = redact(error instanceof Error ? error.message : String(error), apiKey)
    } finally {
      clearTimeout(timer)
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt))
  }
  throw new Error(lastError || 'JEV request failed')
}

export const runJevAsk = async (args, { apiKey, root, fetchImpl = fetch }) => {
  const questions = args?.questions
  if (!questions || typeof questions !== 'object' || Object.keys(questions).length === 0) {
    throw new Error('questions is required: {id: {type, instructions, criteria?}}')
  }
  const threshold = typeof args?.threshold === 'number' ? args.threshold : defaultThreshold
  const { items, skipped } = await collectJevItems(root, {
    paths: Array.isArray(args?.paths) ? args.paths : [],
    texts: Array.isArray(args?.texts) ? args.texts : [],
    extensions: args?.extensions,
  })
  if (items.length === 0) {
    throw new Error('Nothing to judge: pass paths (files/directories) or texts.')
  }

  const endpoint = resolveJevEndpoint(apiKey)
  const results = {}
  const unsure = []
  const errors = [...skipped]
  let keyError = null
  let cursor = 0

  const worker = async () => {
    while (cursor < items.length && !keyError) {
      const item = items[cursor]
      cursor += 1
      const state = item.state.length > maxStateChars
        ? `${item.state.slice(0, maxStateChars)}\n[truncated]`
        : item.state
      try {
        const answers = await postJev(endpoint, apiKey, state, questions, fetchImpl)
        const compact = {}
        for (const [id, answer] of Object.entries(answers)) {
          compact[id] = compactJevAnswer(answer, threshold)
          if (answerConfidence(answer) < threshold) unsure.push(`${item.label}:${id}`)
        }
        results[item.label] = compact
      } catch (error) {
        if (error instanceof JevKeyRejectedError) {
          keyError = error
          return
        }
        errors.push(`${item.label}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  if (keyError) throw keyError

  const ordered = Object.fromEntries(items.filter((item) => item.label in results).map((item) => [item.label, results[item.label]]))
  return {
    results: ordered,
    unsure,
    ...(errors.length > 0 ? { errors } : {}),
    ...(items.length >= maxItems ? { note: `stopped at ${maxItems} items; narrow paths or extensions` } : {}),
  }
}

const readApiKey = async () => {
  const keyFile = process.env[jevKeyFileEnvKey]
  if (!keyFile) return ''
  try {
    return (await readFile(keyFile, 'utf8')).trim()
  } catch {
    return ''
  }
}

const callJevTool = async (name, args) => {
  if (name !== 'jev_ask') {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
  const apiKey = await readApiKey()
  if (!apiKey) {
    return {
      content: [{ type: 'text', text: 'JEV API key is missing; the user must fill it in Chill Vibe settings.' }],
      isError: true,
    }
  }
  try {
    const result = await runJevAsk(args, { apiKey, root: process.env[jevRootEnvKey] || process.cwd() })
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false }
  } catch (error) {
    return {
      content: [{ type: 'text', text: redact(error instanceof Error ? error.message : String(error), apiKey) }],
      isError: true,
    }
  }
}

// MCP stdio 是换行分帧的 JSON-RPC（不是 LSP 的 Content-Length，见 automation-board-mcp.js 的 ADR）。
const sendMessage = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const handleRequest = async (request) => {
  if (request.method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request?.params?.protocolVersion || protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'chill-vibe-jev', version: '0.1.0' },
      },
    })
    return
  }

  if (request.method === 'notifications/initialized') {
    return
  }

  if (request.method === 'tools/list') {
    sendMessage({ jsonrpc: '2.0', id: request.id, result: { tools: jevMcpToolDefinitions } })
    return
  }

  if (request.method === 'tools/call') {
    const result = await callJevTool(request?.params?.name, request?.params?.arguments)
    sendMessage({ jsonrpc: '2.0', id: request.id, result })
    return
  }

  if (request.id !== undefined) {
    sendMessage({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } })
  }
}

const startStdioServer = () => {
  let pending = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const payload = line.trim()
      if (!payload) continue
      let request
      try {
        request = JSON.parse(payload)
      } catch {
        continue
      }
      void handleRequest(request)
    }
  })
}

// 直接入口守卫（pitfall 211）：被 import 时绝不能自己跑起来。
const currentFilePath = fileURLToPath(import.meta.url)
const entryFilePath = process.argv[1] ? path.resolve(process.argv[1]) : ''

if (entryFilePath && currentFilePath === entryFilePath) {
  startStdioServer()
}
