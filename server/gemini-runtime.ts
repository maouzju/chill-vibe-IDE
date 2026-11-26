import {
  CLAUDE_EMPTY_CONTINUE_PROMPT,
  CLAUDE_EMPTY_CONTINUE_PROMPT_ZH,
} from '../shared/claude-prompt-markers.js'
import type { ChatRequest, ProviderTurnUsage, StreamCommandActivity } from '../shared/schema.js'

// Gemini CLI headless 运行（docs/specs/gemini-cli-provider）。
// 纯函数部分独立成模块：providers.ts 只负责起进程，参数与 stream-json 事件映射在这里可单测。

// 只读回合用 default：无头模式下 gemini-cli 会把需要审批的 shell / 编辑 / 写文件工具整个排除。
// 粘贴图片：Gemini CLI 在提示词里认 `@路径` 来读文件（含图片，模型是多模态的）；
// 但 @ 只允许读工作区内的目录，附件在应用数据目录里，所以要 --include-directories 放行。
// 路径统一正斜杠，空格用反斜杠转义（CLI 的 @ 语法以空白分词）。
const toGeminiPath = (path: string) => path.replace(/\\/g, '/')

const geminiAttachmentDirectories = (attachmentPaths: string[]) => [
  ...new Set(
    attachmentPaths
      .map((path) => toGeminiPath(path.trim()))
      .filter(Boolean)
      .map((path) => path.slice(0, Math.max(path.lastIndexOf('/'), 0)))
      .filter(Boolean),
  ),
]

export const buildGeminiArgs = (
  request: Pick<ChatRequest, 'model' | 'sessionId' | 'readOnly'>,
  attachmentPaths: string[] = [],
) => {
  const args = [
    '--output-format',
    'stream-json',
    '--approval-mode',
    request.readOnly === true ? 'default' : 'yolo',
  ]
  const attachmentDirectories = geminiAttachmentDirectories(attachmentPaths)
  if (attachmentDirectories.length > 0) {
    args.push('--include-directories', attachmentDirectories.join(','))
  }
  const model = request.model?.trim()
  if (model) {
    args.push('--model', model)
  }
  const sessionId = request.sessionId?.trim()
  if (sessionId) {
    args.push('--resume', sessionId)
  }
  return args
}

// Gemini CLI 没有 append-system-prompt 参数；GEMINI_SYSTEM_MD 会整段替换内置提示词（连工具说明一起丢），
// 所以系统提示词作为前导块拼进 stdin。续聊（--resume）时 CLI 已带着历史，不重复注入。
//
// 症状：Gemini 卡报「No input provided via stdin. Input can be provided by piping data into gemini…」。
// 根因：2026-11-26 实证——已有会话的卡上空发送（续聊不注入系统提示词）时 stdin 是空串，
//   gemini-cli 0.24.5 在 `if (!input)` 处以退出码 42 直接退出，连会话文件都不写。
// 被否决：只在有 sessionId 时兜底（像 getClaudePrompt）——新会话空发送只剩系统提示词块，
//   模型拿不到任何用户输入；这里的不变量是「stdin 里一定有一句用户的话」。
export const buildGeminiPrompt = (
  request: Pick<ChatRequest, 'prompt' | 'systemPrompt' | 'sessionId'> &
    Partial<Pick<ChatRequest, 'language'>>,
  attachmentPaths: string[] = [],
) => {
  const refs = attachmentPaths
    .map((path) => toGeminiPath(path.trim()).replace(/ /g, '\\ '))
    .filter(Boolean)
    .map((path) => `@${path}`)
  const userPrompt =
    request.prompt.trim() || refs.length > 0
      ? request.prompt
      : request.language === 'en'
        ? CLAUDE_EMPTY_CONTINUE_PROMPT
        : CLAUDE_EMPTY_CONTINUE_PROMPT_ZH
  const prompt = refs.length > 0 ? `${userPrompt}\n\n${refs.join('\n')}` : userPrompt
  const systemPrompt = request.systemPrompt.trim()
  if (!systemPrompt || request.sessionId?.trim()) {
    return prompt
  }
  return `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${prompt}`
}

type GeminiSink = {
  onSession: (sessionId: string) => void
  onDelta: (content: string, itemId?: string) => void
  onLog: (message: string) => void
  onActivity: (activity: StreamCommandActivity) => void
  onDone: (payload?: { usage?: ProviderTurnUsage }) => void
  onError: (message: string) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readString = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === 'string' ? (record[key] as string) : ''

const readNumber = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === 'number' && Number.isFinite(record[key]) ? (record[key] as number) : undefined

const describeToolCall = (toolName: string, parameters: unknown) => {
  if (isRecord(parameters) && typeof parameters.command === 'string') {
    return parameters.command
  }
  const serialized = parameters === undefined ? '' : JSON.stringify(parameters)
  const detail = serialized && serialized !== '{}' ? ` ${serialized.length > 240 ? `${serialized.slice(0, 240)}...` : serialized}` : ''
  return `${toolName || 'tool'}${detail}`
}

// CLI 启动时往 stderr 打的提示行不是错误，别让它们挤进失败摘要。
// 「Invalid hook event name: enabled/disabled/notifications」是 CLI 0.24.5 自己的告警：它把 hooks 下的
// 开关键也当事件名遍历（hookRegistry.processHooksConfiguration），钩子照常注册，与报错无关。
const isGeminiStderrNoise = (line: string) =>
  /^YOLO mode is enabled/i.test(line) ||
  /^Shell cwd was reset/i.test(line) ||
  /^Loaded cached credentials/i.test(line) ||
  /^Invalid hook event name:/i.test(line) ||
  /^Hook registry initialized/i.test(line)

// CLI 没登录/没配 key 时的固定文案；给它补一句人话怎么登录。
const isGeminiAuthMissing = (text: string) => /please set an auth method/i.test(text)

// CLI 把上游报错包成「[API Error: {"error":{"message":"<再一层 JSON>"}}]」，最内层 message 才是人话。
const parseJsonLoose = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const unwrapGeminiApiError = (raw: string, depth = 0): string => {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (depth > 4 || start < 0 || end <= start) {
    return raw.trim()
  }
  const parsed = parseJsonLoose(raw.slice(start, end + 1))
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined
  const message = error ? readString(error, 'message') : ''
  if (!error || !message) {
    return raw.trim()
  }
  const nested = unwrapGeminiApiError(message, depth + 1)
  if (nested !== message.trim()) {
    return nested
  }
  const code = readNumber(error, 'code')
  const status = readString(error, 'status')
  const suffix = [code, status].filter((part) => part !== undefined && part !== '').join(' ')
  return suffix && depth > 0 ? `${message} (${suffix})` : message
}

const isStackTraceLine = (line: string) => /^at\s/.test(line)

export const createGeminiStreamParser = (
  sink: GeminiSink,
  options: {
    formatExit?: (code: number | null) => string
    describeAuthMissing?: (raw: string) => string
  } = {},
) => {
  let settled = false
  const stderrLines: string[] = []
  const tools = new Map<string, string>()

  const settle = (finish: () => void) => {
    if (settled) {
      return
    }
    settled = true
    finish()
  }

  const handleEvent = (event: Record<string, unknown>) => {
    switch (event.type) {
      case 'init': {
        const sessionId = readString(event, 'session_id').trim()
        if (sessionId) {
          sink.onSession(sessionId)
        }
        return
      }
      case 'message': {
        const content = readString(event, 'content')
        if (event.role === 'assistant' && content) {
          sink.onDelta(content)
        }
        return
      }
      case 'tool_use': {
        const itemId = readString(event, 'tool_id') || `gemini-tool-${tools.size + 1}`
        const command = describeToolCall(readString(event, 'tool_name'), event.parameters)
        tools.set(itemId, command)
        sink.onActivity({ itemId, kind: 'command', status: 'in_progress', command, output: '', exitCode: null })
        return
      }
      case 'tool_result': {
        const itemId = readString(event, 'tool_id')
        if (!itemId) {
          return
        }
        const failed = event.status !== 'success'
        const errorMessage = isRecord(event.error) ? readString(event.error, 'message') : ''
        sink.onActivity({
          itemId,
          kind: 'command',
          status: failed ? 'failed' : 'completed',
          command: tools.get(itemId) ?? itemId,
          output: readString(event, 'output') || errorMessage,
          exitCode: failed ? 1 : 0,
        })
        return
      }
      case 'error': {
        const message = readString(event, 'message')
        if (message) {
          sink.onLog(message)
        }
        return
      }
      case 'result': {
        if (event.status === 'success') {
          const stats = isRecord(event.stats) ? event.stats : {}
          const inputTokens = readNumber(stats, 'input_tokens')
          const outputTokens = readNumber(stats, 'output_tokens')
          const cached = readNumber(stats, 'cached')
          const usage: ProviderTurnUsage | undefined =
            inputTokens === undefined && outputTokens === undefined
              ? undefined
              : {
                  used: inputTokens ?? 0,
                  ...(inputTokens !== undefined ? { inputTokens } : {}),
                  ...(outputTokens !== undefined ? { outputTokens } : {}),
                  ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
                }
          settle(() => sink.onDone(usage ? { usage } : undefined))
          return
        }
        const error = isRecord(event.error) ? event.error : {}
        const rawMessage = readString(error, 'message') || readString(event, 'message')
        const message = rawMessage ? unwrapGeminiApiError(rawMessage) : 'Gemini CLI reported an error.'
        settle(() => sink.onError(message))
        return
      }
      default:
    }
  }

  return {
    handleLine: (line: string) => {
      const trimmed = line.trim()
      if (!trimmed || settled) {
        return
      }
      let event: unknown
      try {
        event = JSON.parse(trimmed)
      } catch {
        return
      }
      if (isRecord(event)) {
        handleEvent(event)
      }
    },
    handleStderrLine: (line: string) => {
      const trimmed = line.trim()
      if (trimmed && !isGeminiStderrNoise(trimmed)) {
        stderrLines.push(trimmed)
      }
    },
    handleProcessClosed: (code: number | null) => {
      if (code === 0) {
        settle(() => sink.onDone())
        return
      }
      const apiLine = [...stderrLines].reverse().find((line) => /ApiError:|\[API Error:/.test(line))
      const diagnostics = apiLine
        ? unwrapGeminiApiError(apiLine.slice(apiLine.search(/ApiError:|\[API Error:/)))
        : stderrLines.filter((line) => !isStackTraceLine(line)).slice(-6).join('\n')
      if (diagnostics && options.describeAuthMissing && isGeminiAuthMissing(diagnostics)) {
        const described = options.describeAuthMissing(diagnostics)
        settle(() => sink.onError(described))
        return
      }
      settle(() =>
        sink.onError(diagnostics || options.formatExit?.(code) || `Gemini CLI exited with code ${code ?? 'unknown'}.`),
      )
    },
    handleSpawnError: (error: Error) => {
      settle(() => sink.onError(error.message))
    },
    settled: () => settled,
  }
}
