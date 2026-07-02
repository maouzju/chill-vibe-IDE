import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import os from 'node:os'
import { basename, delimiter, dirname, resolve as resolvePath } from 'node:path'
import readline from 'node:readline'
import type { Readable } from 'node:stream'

import {
  defaultAppLanguage,
  getProviderLabel,
  normalizeLanguage,
} from '../shared/i18n.js'
import { getActiveProviderProfile } from '../shared/default-state.js'
import { buildSystemPromptForModel, normalizeSystemPrompt } from '../shared/system-prompt.js'
import {
  getSlashCommandDescription,
  getLocalSlashCommands,
  parseSlashCommandInput,
} from '../shared/slash-commands.js'
import { isUltracodeEffort, normalizeReasoningEffort, toClaudeEffortFlagValue } from '../shared/reasoning.js'
import { providerSupportsImageAttachments } from '../shared/chat-attachments.js'
import type {
  AppLanguage,
  AppSettings,
  ChatRequest,
  ImageAttachment,
  Provider,
  ProviderStatus,
  SlashCommand,
  SlashCommandRequest,
  StreamActivity,
  StreamErrorEvent,
  StreamErrorHint,
} from '../shared/schema.js'
import { resolveImageAttachmentPath } from './attachments.js'
import {
  createClaudeAskUserDeltaStripper,
  createClaudeStructuredOutputParser,
  isClaudeBackgroundAwaitTool,
} from './claude-structured-output.js'
import { createCodexCompactionActivityDeduper } from './codex-compaction-dedupe.js'
import { resolveClaudeRuntimeEnvironment } from './claude-runtime-environment.js'
import {
  looksLikeCodexStructuredAgentMessage,
  parseCodexResponseEvent,
} from './codex-structured-output.js'
import {
  classifyProviderStreamErrorRecovery,
  resolveLocalStreamStallTimeoutMs,
  shouldRecoverEmptyToolCallTurn,
  structuredActivityCountsAsTurnOutput,
} from './provider-stream-recovery.js'
import { readStringPreserveWhitespace } from './provider-stream-text.js'
import { resolveProviderCommandLaunch } from './provider-command-launch.js'
import {
  buildCrossProviderSkillInstructions,
  discoverProviderSkills,
  expandSkillSlashPrompt,
  getReusableSkillProviders,
} from './provider-skills.js'
import { loadState } from './state-store.js'
import { proxyStats, type ProxyStatsEvent } from './proxy-stats-store.js'
import type { ResilientProxyRuntimeConfig } from './resilient-proxy.js'
import { resilientProxyPool } from './resilient-proxy.js'
import { createArchiveRecallRuntimeOverrides, getCodexArchiveRecallInstruction } from './archive-recall.js'
import {
  ClaudeSessionPool,
  type ClaudeSessionPoolEntryView,
  type ClaudeTurnAttachment,
} from './claude-session-pool.js'

type StreamSink = {
  onSession: (sessionId: string) => void
  onDelta: (content: string) => void
  onLog: (message: string) => void
  onAssistantMessage: (message: { itemId: string; content: string }) => void
  onActivity: (activity: StreamActivity) => void
  onStats?: (event: {
    event: ProxyStatsEvent
    endpoint: string
    attempt?: number
    errorType?: string
    alreadyRecorded?: boolean
  }) => void
  onDone: () => void
  onError: (
    message: string,
    hint?: StreamErrorHint,
    recovery?: Pick<StreamErrorEvent, 'recoverable' | 'recoveryMode' | 'transientOnly'>,
  ) => void
}

export type ProviderRuntime = {
  args: string[]
  env: NodeJS.ProcessEnv
}

let providerRuntimeSettingsOverride: AppSettings | null = null

export const setProviderRuntimeSettingsOverride = (settings: AppSettings | null) => {
  providerRuntimeSettingsOverride = settings
}

type ProviderProxyStatsRecordRequest = {
  provider: Provider
  event: ProxyStatsEvent
  endpoint: string
  attempt?: number
  errorType?: string
}

const providerProxyStatsEventValues: ProxyStatsEvent[] = [
  'request',
  'disconnect',
  'recovery_success',
  'recovery_fail',
]

const parseProviderProxyStatsRecordRequest = (value: unknown): ProviderProxyStatsRecordRequest => {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid proxy stats event.')
  }

  const record = value as Record<string, unknown>
  const provider = record.provider
  const event = record.event
  const endpoint = typeof record.endpoint === 'string' ? record.endpoint.trim() : ''
  const attempt = record.attempt
  const errorType = record.errorType

  if ((provider !== 'codex' && provider !== 'claude') || typeof event !== 'string' || !providerProxyStatsEventValues.includes(event as ProxyStatsEvent) || endpoint.length === 0) {
    throw new Error('Invalid proxy stats event.')
  }

  if (attempt !== undefined && (typeof attempt !== 'number' || !Number.isFinite(attempt))) {
    throw new Error('Invalid proxy stats event.')
  }

  if (errorType !== undefined && typeof errorType !== 'string') {
    throw new Error('Invalid proxy stats event.')
  }

  return {
    provider,
    event: event as ProxyStatsEvent,
    endpoint,
    attempt,
    errorType,
  }
}

export const recordProviderProxyStatsEvent = (request: unknown) => {
  const parsed = parseProviderProxyStatsRecordRequest(request)

  proxyStats.record(parsed.provider, parsed.event, parsed.endpoint, {
    attempt: parsed.attempt,
    errorType: parsed.errorType,
  })
}

const providerCommandPreferences: Record<Provider, string[]> =
  process.platform === 'win32'
    ? {
        codex: ['codex.exe', 'codex.cmd', 'codex'],
        claude: ['claude.exe', 'claude.cmd', 'claude'],
      }
    : {
        codex: ['codex'],
        claude: ['claude'],
      }

const commandLookupTool = process.platform === 'win32' ? 'where.exe' : 'which'
const slashCommandDiscoveryTimeoutMs = 6_000
const defaultProviderBaseUrls: Record<Provider, string> = {
  codex: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com',
}
const codexSwitchProviderName = 'chill_vibe_switch'

const formatTomlString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const normalizeLookupPath = (entry: string) => resolvePath(entry).replace(/[\\/]+$/, '').toLowerCase()

const zhProviderLanguageInstruction = '请始终使用简体中文进行思考和回复。所有推理过程和输出内容都必须使用简体中文。'

export const buildProviderSystemPrompt = (
  language: AppLanguage,
  systemPrompt?: string | null,
) => {
  const normalizedLanguage = normalizeLanguage(language)
  const instructions = [normalizeSystemPrompt(systemPrompt)]

  if (normalizedLanguage === 'zh-CN') {
    instructions.unshift(zhProviderLanguageInstruction)
  }

  return instructions.join(' ')
}

const getRequestBaseSystemPrompt = (request: ChatRequest) =>
  buildSystemPromptForModel(request.systemPrompt, request.model, request.modelPromptRules)

const getCodexAskUserQuestionInstruction = (language: AppLanguage) =>
  normalizeLanguage(language) === 'en'
    ? 'In this Chill Vibe Codex exec environment, the native request_user_input tool is unavailable. When you must ask the user to choose before you can continue safely, do not call request_user_input and do not ask a plain-text multiple-choice question. Instead, reply with only one XML block in this exact shape and no extra text: <ask-user-question>{"header":"Short title","question":"One concise question","multiSelect":false,"options":[{"label":"Option A","description":"Short tradeoff"},{"label":"Option B","description":"Short tradeoff"}]}</ask-user-question>. Use 2-3 options, keep labels short, omit any Other option, and wait for the next user reply after emitting the block.'
    : '在这个 Chill Vibe 的 Codex exec 运行环境里，原生 request_user_input 工具不可用。当你必须在继续之前让用户做选择时，不要调用 request_user_input，也不要用普通文本写多选题。而是只输出一个完整的 XML 块，并且不要加任何其他文本：<ask-user-question>{"header":"简短标题","question":"一句简洁问题","multiSelect":false,"options":[{"label":"选项 A","description":"简短权衡"},{"label":"选项 B","description":"简短权衡"}]}</ask-user-question>。选项保持 2-3 个，label 要简短，不要自己加 Other，并在输出这个块后等待用户下一条回复。'

const getCodexWindowsShellSafetyInstruction = () =>
  'Windows shell safety: shell commands run in PowerShell. If a command argument contains double quotes (for example ripgrep patterns that search JSON such as name": "value), wrap that argument in single quotes or use a here-string/script file. Do not put unescaped embedded double quotes inside a double-quoted PowerShell argument; it causes ParserError: TerminatorExpectedAtEndOfString. Prefer rg --fixed-strings for literal JSON/key searches.'

const getClaudeAskUserQuestionInstruction = (language: AppLanguage) =>
  normalizeLanguage(language) === 'en'
    ? 'In this Chill Vibe Claude runtime, ask-user-question is only a renderer convention for asking the user to choose. Do not use it for normal replies unless you truly need a user decision before continuing. Every real action (running commands, reading files, editing files, searching, etc.) must go through native tool calls. Do not write tool calls as text, XML, JSON, markdown, or the word call.'
    : '在这个 Chill Vibe 的 Claude 运行环境里，ask-user-question 只是一种向用户提问并让用户选择的渲染约定。除非继续前确实需要用户做决定，否则不要在普通回复里使用它。所有实际操作（运行命令、读取文件、编辑文件、搜索等）都必须走原生工具调用。不要把工具调用写成文本、XML、JSON、Markdown，也不要输出单独的 call。'

const maybeResolveProxyBaseUrl = async (
  provider: Provider,
  baseUrl: string,
  enabled: boolean,
  config?: ResilientProxyRuntimeConfig,
) => {
  if (!enabled) {
    return baseUrl
  }

  try {
    return await resilientProxyPool.resolveBaseUrl(provider, baseUrl, config)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[resilient-proxy] Falling back to direct ${provider} upstream: ${message}`)
    return baseUrl
  }
}

const classifyLaunchErrorHint = (message: string): StreamErrorHint | undefined => {
  const normalized = message.toLowerCase()

  if (
    normalized.includes('cli was not found') ||
    normalized.includes('command was not found') ||
    normalized.includes('not in path') ||
    normalized.includes('命令未安装') ||
    normalized.includes('没有找到本地')
  ) {
    return 'env-setup'
  }

  if (
    normalized.includes('api key') ||
    normalized.includes('openai_api_key') ||
    normalized.includes('anthropic_api_key') ||
    normalized.includes('anthropic_auth_token') ||
    normalized.includes('unauthorized') ||
    normalized.includes('authentication') ||
    normalized.includes('sign in') ||
    normalized.includes('codex login') ||
    normalized.includes('401') ||
    normalized.includes('403') ||
    normalized.includes('invalid api key') ||
    normalized.includes('auth token') ||
    normalized.includes('access token')
  ) {
    return 'switch-config'
  }

  return undefined
}

export const resolveProviderRuntime = async (provider: Provider): Promise<ProviderRuntime> => {
  const baseEnv =
    provider === 'claude' ? await resolveClaudeRuntimeEnvironment({ env: process.env }) : process.env

  try {
    const settings = providerRuntimeSettingsOverride ?? (await loadState()).settings
    if (!settings.cliRoutingEnabled) {
      return {
        args: [],
        env: baseEnv,
      }
    }

    const activeProfile = getActiveProviderProfile(settings, provider)
    const apiKey = activeProfile?.apiKey.trim()

    if (!apiKey) {
      return {
        args: [],
        env: baseEnv,
      }
    }

    const baseUrl = activeProfile?.baseUrl.trim() || defaultProviderBaseUrls[provider]
    const runtimeBaseUrl = await maybeResolveProxyBaseUrl(
      provider,
      baseUrl,
      Boolean(settings.resilientProxyEnabled),
      {
        firstByteTimeoutMs: settings.resilientProxyFirstByteTimeoutSec * 1000,
        stallTimeoutMs: settings.resilientProxyStallTimeoutSec * 1000,
        maxRecoveryRetries: settings.resilientProxyMaxRetries,
      },
    )

    if (provider === 'claude') {
      return {
        args: [],
        env: {
          ...baseEnv,
          ANTHROPIC_API_KEY: apiKey,
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_BASE_URL: runtimeBaseUrl,
        },
      }
    }

    return {
      args: [
        '-c',
        `model_providers.${codexSwitchProviderName}={ name = ${formatTomlString(
          activeProfile?.name.trim() || 'Chill Vibe Switch',
        )}, base_url = ${formatTomlString(runtimeBaseUrl)}, env_key = "OPENAI_API_KEY" }`,
        '-c',
        `model_provider=${formatTomlString(codexSwitchProviderName)}`,
      ],
      env: {
        ...baseEnv,
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: runtimeBaseUrl,
      },
    }
  } catch {
    return {
      args: [],
      env: baseEnv,
    }
  }
}

export const resolveCommand = async (provider: Provider) => {
  const lookup = await new Promise<string[]>((resolve) => {
    const child = spawn(commandLookupTool, providerCommandPreferences[provider], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })

    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })

    child.on('close', () => {
      const matches = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

      resolve(matches)
    })

    child.on('error', () => resolve([]))
  })

  const preferred = providerCommandPreferences[provider]

  if (process.platform !== 'win32') {
    return preferred
      .map((candidate) => lookup.find((entry) => entry.toLowerCase().endsWith(candidate.toLowerCase())))
      .find(Boolean)
  }

  const pathDirectoryOrder = (process.env.PATH ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeLookupPath)

  return lookup
    .map((entry) => {
      const candidateName = basename(entry).toLowerCase()
      const preferredIndex = preferred.findIndex((candidate) => candidateName === candidate.toLowerCase())
      if (preferredIndex < 0) {
        return null
      }

      const directoryIndex = pathDirectoryOrder.indexOf(normalizeLookupPath(dirname(entry)))

      return {
        entry,
        directoryIndex: directoryIndex >= 0 ? directoryIndex : Number.MAX_SAFE_INTEGER,
        preferredIndex,
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) =>
      left.directoryIndex - right.directoryIndex || left.preferredIndex - right.preferredIndex,
    )[0]?.entry
}

const readLines = (stream: Readable, onLine: (line: string) => void) => {
  const reader = readline.createInterface({ input: stream })
  reader.on('line', onLine)
  return reader
}

const summarizeDiagnostics = (stderr: string) => {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !line.includes('plugins::startup_sync') &&
        !line.includes('plugins::manager') &&
        !line.includes('shell_snapshot') &&
        !line.startsWith('<') &&
        !line.startsWith('at ') &&
        line.length < 240,
    )

  return lines.slice(0, 8).join('\n')
}

const isClaudeEffortUnsupported = (message: string) => {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('--effort') &&
    (
      normalized.includes('unknown option') ||
      normalized.includes('unexpected argument') ||
      normalized.includes('unrecognized option') ||
      normalized.includes('unknown argument')
    )
  )
}

const isClaudeStaleResumedSession = (message: string) => {
  const normalized = message.toLowerCase()
  return normalized.includes('no deferred tool marker found in the resumed session')
}

const isCodexAppServerEffortUnsupported = (message: string) => {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('effort') &&
    (
      normalized.includes('requires newer codex cli') ||
      normalized.includes('unknown field') ||
      normalized.includes('unexpected field') ||
      normalized.includes('unsupported field') ||
      normalized.includes('invalid field')
    )
  )
}

const isCodexStaleResumedSession = (message: string) => {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('failed to load rollout') ||
    normalized.includes('no rollout found for thread id') ||
    normalized.includes('no session path found for thread id') ||
    normalized.includes('empty session file') ||
    (normalized.includes('rollout') && normalized.includes('session file'))
  )
}

const formatClaudeEffortCompatibilityNotice = (language: AppLanguage) =>
  language === 'en'
    ? 'Detected an older local Claude CLI that does not support --effort. Chill Vibe retried automatically without that flag. Please upgrade Claude CLI with: npm update -g @anthropic-ai/claude-code'
    : '检测到本地 Claude CLI 版本较旧，不支持 --effort。Chill Vibe 已自动改为不传该参数后重试。建议执行：npm update -g @anthropic-ai/claude-code'

const formatClaudeStaleSessionRecoveryNotice = (language: AppLanguage) =>
  language === 'en'
    ? 'The resumed Claude session is stale (no deferred tool marker). Chill Vibe started a new session automatically so your prompt and attachments are not lost.'
    : '检测到 Claude 会话已失效（无法恢复），Chill Vibe 已自动开启一个新会话，并保留了你这次发送的内容和图片。'

const formatCodexEffortCompatibilityNotice = (language: AppLanguage) =>
  language === 'en'
    ? 'Detected an older local Codex CLI that does not support app-server reasoning effort. Chill Vibe retried automatically without that field for this run.'
    : '检测到本地 Codex CLI 版本较旧，不支持 app-server 的 reasoning effort 字段。Chill Vibe 已自动改为不传该字段后重试本次请求。'

const formatCodexStaleSessionRecoveryNotice = (language: AppLanguage) =>
  language === 'en'
    ? 'The resumed Codex session could not be loaded from its rollout file. Chill Vibe started a new session automatically so your latest prompt and attachments are not lost.'
    : '恢复的 Codex 会话文件无法加载，Chill Vibe 已自动开启一个新会话，保留你本次发送的内容和附件。'

const createManagedChildHandle = () => {
  let activeChild: ChildProcess | null = null
  const handle = new EventEmitter() as ChildProcess

  ;(handle as ChildProcess & { kill: ChildProcess['kill'] }).kill = ((signal?: NodeJS.Signals | number) =>
    activeChild?.kill(signal) ?? false) as ChildProcess['kill']

  return {
    handle,
    setActiveChild: (child: ChildProcess | null) => {
      activeChild = child
    },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readString = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === 'string' ? record[key].trim() : undefined

const readRecord = (record: Record<string, unknown>, key: string) =>
  isRecord(record[key]) ? (record[key] as Record<string, unknown>) : null

const truncate = (value: string, max = 320) =>
  value.length > max ? `${value.slice(0, max)}...` : value

const formatProviderCommandMissing = (language: AppLanguage, provider: Provider) => {
  const label = getProviderLabel(language, provider)
  return language === 'en' ? `The local ${label} CLI was not found.` : `没有找到本地 ${label} 命令。`
}

const formatWorkspaceMissing = (language: AppLanguage, workspacePath: string) =>
  language === 'en'
    ? `Workspace path does not exist: ${workspacePath}`
    : `工作区路径不存在：${workspacePath}`

const formatWorkspaceNotDirectory = (language: AppLanguage, workspacePath: string) =>
  language === 'en'
    ? `Workspace path is not a folder: ${workspacePath}`
    : `工作区路径不是文件夹：${workspacePath}`

const formatProviderUnavailableNote = (provider: Provider) =>
  `${provider === 'codex' ? 'Codex' : 'Claude'} 命令未安装，或不在 PATH 中。`

const formatWorkspaceValidationReason = (
  language: AppLanguage,
  reason: 'missing' | 'not-directory',
) => {
  if (language === 'en') {
    return reason === 'missing' ? 'Path does not exist.' : 'Path exists, but it is not a folder.'
  }

  return reason === 'missing' ? '路径不存在。' : '路径存在，但不是文件夹。'
}

export const normalizeProviderExitCode = (code: number | null) => {
  if (code === null || !Number.isInteger(code)) {
    return code
  }

  return code > 0x7fffffff ? code - 0x1_0000_0000 : code
}

const formatProviderExit = (language: AppLanguage, provider: Provider, code: number | null) => {
  const label = getProviderLabel(language, provider)
  const normalizedCode = normalizeProviderExitCode(code)
  return language === 'en'
    ? `${label} exited with status code: ${normalizedCode ?? 'unknown'}`
    : `${label} 退出，状态码：${normalizedCode ?? '未知'}`
}

const formatClaudeRunFailed = (language: AppLanguage) =>
  language === 'en' ? 'Claude run failed.' : 'Claude 运行失败。'

// Shown when a turn produced only a tool call typed as text (which never
// executed) and nothing else, so it would otherwise dead-end silently. The
// renderer treats the recoverable classification as the real signal and
// auto-resumes; this message is only a fallback label.
const formatClaudeTypedToolCallStalled = (language: AppLanguage) =>
  language === 'en'
    ? 'Claude ended a turn without running its tool call. Resuming.'
    : 'Claude 这一轮没有真正执行工具调用就结束了，正在自动继续。'


// Exported for tests. Both call sites guard on real tool activity in the same
// turn (hasToolUse / sawStructuredActivity), so besides the known marker words
// this may also treat 1-2 bare short words as protocol residue: leaked markers
// keep mutating (call → court → course → count → card → …) and an assistant
// text that is nothing but a lone word beside a real tool call is never
// meaningful prose.
export const isBareClaudeToolCallMarkerText = (text: string) => {
  const lines = text.split(/\r?\n/)
  const isKnownMarkerLine = (line: string) => {
    const normalized = line.trim().toLowerCase()
    return (
      !normalized ||
      normalized === 'call' ||
      normalized === 'call:' ||
      normalized === 'court' ||
      normalized === 'course' ||
      normalized === 'count' ||
      normalized === 'card' ||
      normalized === '课'
    )
  }
  if (lines.every(isKnownMarkerLine)) {
    return true
  }

  const isBareResidueWordLine = (line: string) => {
    const normalized = line.trim()
    return !normalized || /^[a-zA-Z]{2,12}$/.test(normalized) || /^[一-鿿]$/.test(normalized)
  }
  const nonEmptyLineCount = lines.filter((line) => line.trim()).length
  return nonEmptyLineCount > 0 && nonEmptyLineCount <= 2 && lines.every(isBareResidueWordLine)
}

// Exported for tests. Only called on text a typed tool-call XML block was just
// stripped from (consumedToolCallBlockCount > 0 at both call sites).
export const stripTrailingClaudeTypedToolMarkerLines = (text: string) =>
  text.replace(/(?:[ \t]*(?:\r?\n|^)[ \t]*(?:call:?|court|course|count|card|课)[ \t]*)+$/iu, '')

const isPotentialClaudeTypedToolChatterPrefix = (text: string) => {
  const normalized = text
    .trimStart()
    .replace(/^[`"'“”‘’（([{\s]+/, '')
    .toLowerCase()

  if (!normalized) {
    return true
  }

  if (normalized === 'call' || normalized === 'call:') {
    return true
  }

  if (
    normalized === 'court' ||
    normalized === 'course' ||
    normalized === 'count' ||
    normalized === 'card' ||
    normalized === '课'
  ) {
    return true
  }

  if ('工具调用'.startsWith(normalized)) {
    return true
  }

  return 'tool call'.startsWith(normalized.replace(/\s+/g, ' '))
}

const isClaudeTypedToolRetryChatter = (text: string) => {
  const normalized = text.replace(/\s+/g, ' ').trim()

  if (!normalized) {
    return false
  }

  return (
    /工具调用.{0,160}(?:格式|坏|重新|重试|再发|解析|失败|改用|触发|避免)/i.test(normalized) ||
    /(?:重新|重试|再发|改用).{0,120}工具调用/i.test(normalized) ||
    /tool\s+call.{0,180}(?:malformed|format|parse|retry|again|failed|broken|resend|re-send)/i.test(
      normalized,
    ) ||
    /(?:retry|resend|re-send).{0,120}tool\s+call/i.test(normalized)
  )
}

const createClaudeTypedToolChatterFilter = () => {
  let pending = ''
  const maxPrefixBufferLength = 240

  return {
    push(text: string) {
      if (!text) {
        return ''
      }

      pending += text

      if (isClaudeTypedToolRetryChatter(pending)) {
        return ''
      }

      if (
        pending.length <= maxPrefixBufferLength &&
        isPotentialClaudeTypedToolChatterPrefix(pending)
      ) {
        return ''
      }

      const released = pending
      pending = ''
      return released
    },
    dropIfChatter() {
      if (!pending) {
        return
      }

      if (
        isClaudeTypedToolRetryChatter(pending) ||
        (pending.length <= maxPrefixBufferLength &&
          isPotentialClaudeTypedToolChatterPrefix(pending))
      ) {
        pending = ''
      }
    },
    flush() {
      const released = pending
      pending = ''
      return released
    },
  }
}

const formatImageAttachmentsUnsupported = (language: AppLanguage, provider: Provider) =>
  language === 'en'
    ? `${getProviderLabel(language, provider)} does not currently support pasted image attachments in this app. Switch the card to Codex to send images.`
    : `${getProviderLabel(language, provider)} 当前还不支持在这个应用里发送粘贴的图片。请将卡片切换到 Codex 后再发送。`

const formatProviderUnexpectedCompletion = (language: AppLanguage, provider: Provider) => {
  const label = getProviderLabel(language, provider)
  return language === 'en'
    ? `${label} ended without emitting a terminal completion event.`
    : `${label} 在没有发出终止完成事件的情况下就结束了。`
}

const reconnectingPlaceholderProgressPattern = String.raw`(?:\s+\d+\s*\/\s*\d+)?`
const reconnectingPlaceholderSuffixPattern = String.raw`(?:\s*(?:\.{1,3}|\u2026))?${reconnectingPlaceholderProgressPattern}`
const transientRecoveryPlaceholderPattern = new RegExp(
  String.raw`^reconnecting${reconnectingPlaceholderSuffixPattern}$`,
  'i',
)

const isTransientRecoveryPlaceholder = (content: string) => transientRecoveryPlaceholderPattern.test(content.trim())

const transientRecoveryPlaceholderPrefixPattern = new RegExp(
  String.raw`^reconnecting(?:\s*(?:\.{0,3}|\u2026))?(?:\s*\d*\s*(?:\/\s*\d*)?)?$`,
  'i',
)
const transientRecoveryPlaceholderSequencePattern = new RegExp(
  String.raw`^(?:reconnecting${reconnectingPlaceholderSuffixPattern}\s*)+$`,
  'i',
)

const ansiEscape = String.fromCharCode(27)
const ansiControlSequencePattern = new RegExp(`${ansiEscape}\\[[0-?]*[ -/]*[@-~]`, 'g')

const stripAnsiControlSequences = (content: string) =>
  content.replace(ansiControlSequencePattern, '')

const normalizeTransientRecoveryPlaceholderText = (content: string) =>
  stripAnsiControlSequences(content).replace(/\r/g, '\n')

const getTransientRecoveryPlaceholderDiagnostics = (content: string) =>
  normalizeTransientRecoveryPlaceholderText(content)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

const hasOnlyTransientRecoveryPlaceholderDiagnostics = (content: string) => {
  const diagnostics = getTransientRecoveryPlaceholderDiagnostics(content)

  return diagnostics.length > 0 && diagnostics.every((line) =>
    transientRecoveryPlaceholderPattern.test(line) ||
    transientRecoveryPlaceholderSequencePattern.test(line),
  )
}

const hasTransientRecoveryPlaceholderDiagnostics = (content: string) =>
  getTransientRecoveryPlaceholderDiagnostics(content).some((line) =>
    transientRecoveryPlaceholderPattern.test(line) ||
    transientRecoveryPlaceholderSequencePattern.test(line),
  )

export const isCodexNativeReconnectPlaceholderForTesting = (content: string) =>
  isTransientRecoveryPlaceholder(content) || hasOnlyTransientRecoveryPlaceholderDiagnostics(content)

const isTransientRecoveryPlaceholderPrefix = (content: string) => {
  const normalized = content.trim()
  if (!normalized) {
    return false
  }

  const lower = normalized.toLowerCase()
  return (
    'reconnecting'.startsWith(lower) ||
    transientRecoveryPlaceholderPrefixPattern.test(normalized) ||
    transientRecoveryPlaceholderSequencePattern.test(normalized)
  )
}

const shouldStartTransientPlaceholderStallTimer = (content: string) => {
  const normalized = content.trim().toLowerCase()

  return normalized.length >= 'reconnecting'.length && normalized.startsWith('reconnecting')
}

const getTransientPlaceholderStallTimeoutMs = () => {
  const parsed = Number.parseInt(process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS ?? '', 10)
  if (Number.isFinite(parsed) && parsed >= 50) {
    return parsed
  }

  return 3000
}

const getLocalProviderTimeoutMs = (envName: string, fallbackMs: number) => {
  const parsed = Number.parseInt(process.env[envName] ?? '', 10)
  if (Number.isFinite(parsed) && parsed >= 50) {
    return parsed
  }

  return fallbackMs
}

const getLocalProviderFirstByteTimeoutMs = () =>
  getLocalProviderTimeoutMs('CHILL_VIBE_LOCAL_PROVIDER_FIRST_BYTE_TIMEOUT_MS', 90_000)

const getLocalProviderStallTimeoutMs = () =>
  getLocalProviderTimeoutMs('CHILL_VIBE_LOCAL_PROVIDER_STALL_TIMEOUT_MS', 120_000)

// How long the stall watchdog may wait while the CLI synchronously runs a
// background tool (Workflow/subagent). `claude -p` caps that wait at 10 min by
// default and exits when it lapses; we mirror the CLI's own knob
// (CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS) and add a buffer so the CLI surfaces its
// own terminal result/error first. `0` means "wait without a limit" per the CLI
// docs, so the watchdog disarms entirely (null) and relies on process-close.
const getBackgroundAwaitWatchdogMs = (): number | null => {
  const parsed = Number.parseInt(process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ?? '', 10)
  if (Number.isFinite(parsed) && parsed === 0) {
    return null
  }
  const ceilingMs = Number.isFinite(parsed) && parsed >= 50 ? parsed : 600_000
  return ceilingMs + 60_000
}

const classifyLiveProviderStreamRecovery = (
  request: Pick<ChatRequest, 'sessionId'>,
  message: string,
  hint?: StreamErrorHint,
  emittedSessionId?: string | null,
  options?: { transientOnly?: boolean; interruptedByTransientPlaceholder?: boolean },
): Pick<StreamErrorEvent, 'recoverable' | 'recoveryMode' | 'transientOnly'> => {
  const sessionId =
    typeof emittedSessionId === 'string' && emittedSessionId.trim().length > 0
      ? emittedSessionId
      : request.sessionId
  const baseRecovery = classifyProviderStreamErrorRecovery(
    {
      sessionId,
    },
    message,
    hint,
  )

  if (options?.transientOnly) {
    if (baseRecovery.recoverable) {
      return {
        ...baseRecovery,
        transientOnly: true,
      }
    }

    if (
      sessionId?.trim() &&
      hint !== 'switch-config' &&
      hint !== 'env-setup'
    ) {
      return {
        recoverable: true,
        recoveryMode: 'resume-session',
        transientOnly: true,
      }
    }

    return baseRecovery
  }

  if (options?.interruptedByTransientPlaceholder && sessionId?.trim() && baseRecovery.recoverable !== true) {
    return {
      recoverable: true,
      recoveryMode: 'resume-session',
    }
  }

  return baseRecovery
}

const resolveAttachmentPaths = async (attachments: ImageAttachment[]) =>
  Promise.all(attachments.map((attachment) => resolveImageAttachmentPath(attachment.id)))

const cloneSlashCommands = (commands: readonly SlashCommand[]) =>
  commands.map((command) => ({ ...command }))

const dedupeSlashCommands = (commands: SlashCommand[]) => {
  const seen = new Set<string>()
  return commands.filter((command) => {
    if (seen.has(command.name)) {
      return false
    }

    seen.add(command.name)
    return true
  })
}

const buildNativeSlashCommands = (
  provider: Provider,
  names: string[],
  language: AppLanguage,
) =>
  names
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .map(
      (name): SlashCommand => ({
        name,
        source: 'native',
        description: getSlashCommandDescription(provider, name, 'native', language),
      }),
    )

const buildLocalSlashCommands = (language: AppLanguage) =>
  cloneSlashCommands(getLocalSlashCommands(language))

const resolveDiscoveryCwd = async (workspacePath: string) => {
  try {
    const workspaceStats = await stat(workspacePath)
    return workspaceStats.isDirectory() ? workspacePath : process.cwd()
  } catch {
    return process.cwd()
  }
}

export const summarizeClaudeToolUse = (language: AppLanguage, item: Record<string, unknown>) => {
  const name = readString(item, 'name')
  const input = isRecord(item.input) ? item.input : {}

  if (!name) {
    return null
  }

  switch (name) {
    case 'Read': {
      const filePath = readString(input, 'file_path')
      return language === 'en'
        ? filePath
          ? `Read ${basename(filePath)}`
          : 'Read file'
        : filePath
          ? `读取 ${basename(filePath)}`
          : '读取文件'
    }
    case 'Glob':
      return language === 'en' ? 'Search files' : '搜索文件'
    case 'Grep':
      return language === 'en' ? 'Search text' : '搜索文本'
    case 'Bash':
    case 'BashOutput':
    case 'KillShell': {
      const command = readString(input, 'command')
      return language === 'en'
        ? command
          ? `Run command: ${truncate(command, 80)}`
          : 'Run command'
        : command
          ? `执行命令：${truncate(command, 80)}`
          : '执行命令'
    }
    case 'WebFetch': {
      const url = readString(input, 'url')
      return language === 'en'
        ? url
          ? `Read web page: ${truncate(url, 80)}`
          : 'Read web page'
        : url
          ? `读取网页：${truncate(url, 80)}`
          : '读取网页'
    }
    case 'WebSearch': {
      const query = readString(input, 'query')
      return language === 'en'
        ? query
          ? `Web search: ${truncate(query, 80)}`
          : 'Web search'
        : query
          ? `网络搜索：${truncate(query, 80)}`
          : '网络搜索'
    }
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const filePath = readString(input, 'file_path')
      return language === 'en'
        ? filePath
          ? `Edit ${basename(filePath)}`
          : 'Edit file'
        : filePath
          ? `修改 ${basename(filePath)}`
          : '修改文件'
    }
    case 'TodoWrite':
      return language === 'en' ? 'Update todo list' : '更新任务清单'
    default:
      return language === 'en' ? `Use tool: ${name}` : `调用工具：${name}`
  }
}

const extractClaudeLocalCommandOutput = (content: string) => {
  const matches = [...content.matchAll(/<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g)]
  const output = matches
    .map((match) => match[2].trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()

  return output || null
}

const discoverClaudeSlashCommands = async (
  workspacePath: string,
  language: AppLanguage,
): Promise<SlashCommand[]> => {
  const command = await resolveCommand('claude')
  if (!command) {
    return []
  }

  const cwd = await resolveDiscoveryCwd(workspacePath)
  const runtime = await resolveProviderRuntime('claude')
  const launch = await resolveProviderCommandLaunch({
    command,
    args: ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '/cost'],
  })

  return await new Promise<SlashCommand[]>((resolve) => {
    let child: ChildProcess

    try {
      child = spawn(launch.command, launch.args, {
        cwd,
        env: runtime.env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch {
      resolve([])
      return
    }

    if (!child.stdout) {
      resolve([])
      return
    }

    let resolved = false
    let slashCommands: SlashCommand[] = []

    const reader = readline.createInterface({ input: child.stdout })
    const timer = setTimeout(() => {
      child.kill()
      finish()
    }, slashCommandDiscoveryTimeoutMs)

    const finish = () => {
      if (resolved) {
        return
      }

      resolved = true
      clearTimeout(timer)
      reader.close()
      resolve(slashCommands)
    }

    reader.on('line', (line) => {
      if (slashCommands.length > 0 || !line.trim()) {
        return
      }

      try {
        const event = JSON.parse(line)
        if (event.type !== 'system' || event.subtype !== 'init' || !Array.isArray(event.slash_commands)) {
          return
        }

        slashCommands = buildNativeSlashCommands(
          'claude',
          event.slash_commands.filter((name: unknown): name is string => typeof name === 'string'),
          language,
        )
      } catch {
        // Ignore malformed output and fall back to local slash commands.
      }
    })

    child.on('close', finish)
    child.on('error', finish)
  })
}

const spawnProvider = async (
  provider: Provider,
  args: string[],
  workspacePath: string,
  sink: StreamSink,
  language: AppLanguage,
  env: NodeJS.ProcessEnv,
  options?: {
    stdin?: 'ignore' | 'pipe'
  },
) => {
  const command = await resolveCommand(provider)

  if (!command) {
    sink.onError(formatProviderCommandMissing(language, provider), 'env-setup')
    return null
  }

  let workspaceStats
  try {
    workspaceStats = await stat(workspacePath)
  } catch {
    sink.onError(formatWorkspaceMissing(language, workspacePath))
    return null
  }

  if (!workspaceStats.isDirectory()) {
    sink.onError(formatWorkspaceNotDirectory(language, workspacePath))
    return null
  }

  try {
    const launch = await resolveProviderCommandLaunch({ command, args })
    const child = spawn(launch.command, launch.args, {
      cwd: workspacePath,
      env,
      stdio: [options?.stdin ?? 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    return child
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to launch the local provider CLI.'
    sink.onError(message, classifyLaunchErrorHint(message))
    return null
  }
}

export const getProviderStatuses = async (): Promise<ProviderStatus[]> =>
  Promise.all(
    (['codex', 'claude'] as const).map(async (provider) => {
      const command = await resolveCommand(provider)
      return {
        provider,
        available: Boolean(command),
        command: command ?? undefined,
        note: command ? undefined : formatProviderUnavailableNote(provider),
      }
    }),
  )

export const getProviderSlashCommands = async ({
  provider,
  workspacePath,
  language = defaultAppLanguage,
  crossProviderSkillReuseEnabled = true,
}: SlashCommandRequest): Promise<SlashCommand[]> => {
  const normalizedLanguage = normalizeLanguage(language)
  const local = buildLocalSlashCommands(normalizedLanguage)
  const skills = await discoverProviderSkills(
    workspacePath,
    getReusableSkillProviders(provider, crossProviderSkillReuseEnabled),
  )

  // Native CLI command lists (especially Claude's init-event `slash_commands`) can include
  // user skills by name; skills must dedupe first so their metadata wins, matching the
  // send-path priority in expandSkillSlashPrompt.
  if (provider === 'codex') {
    const native = buildNativeSlashCommands('codex', ['compact', 'init', 'plan'], normalizedLanguage)
    return dedupeSlashCommands([...local, ...skills, ...native])
  }

  if (provider === 'claude') {
    const native = await discoverClaudeSlashCommands(workspacePath, normalizedLanguage)
    return dedupeSlashCommands([...local, ...skills, ...native])
  }

  return dedupeSlashCommands([...local, ...skills])
}

export const validateWorkspacePath = async (
  workspacePath: string,
  language: AppLanguage = defaultAppLanguage,
) => {
  const normalizedLanguage = normalizeLanguage(language)

  try {
    const info = await stat(workspacePath)
    return info.isDirectory()
      ? { valid: true as const }
      : {
          valid: false as const,
          reason: formatWorkspaceValidationReason(normalizedLanguage, 'not-directory'),
        }
  } catch {
    return {
      valid: false as const,
      reason: formatWorkspaceValidationReason(normalizedLanguage, 'missing'),
    }
  }
}

const formatCodexCompactRequiresSession = (language: AppLanguage) =>
  language === 'en'
    ? 'Codex /compact requires an existing session.'
    : '\u9700\u8981\u5148\u542f\u52a8\u4e00\u4e2a Codex \u4f1a\u8bdd\u540e\u624d\u80fd\u4f7f\u7528 /compact\u3002'

const formatCodexAppServerMissingStdio = (language: AppLanguage) =>
  language === 'en'
    ? 'Codex app-server did not expose the expected stdio pipes.'
    : 'Codex app-server \u6ca1\u6709\u63d0\u4f9b\u9884\u671f\u7684 stdio \u7ba1\u9053\u3002'

const formatCodexAppServerUnexpectedRequest = (language: AppLanguage, method: string) =>
  language === 'en'
    ? `Codex app-server requested unsupported interaction: ${method}`
    : `Codex app-server \u53d1\u51fa\u4e86\u5f53\u524d\u672a\u652f\u6301\u7684\u4ea4\u4e92\u8bf7\u6c42\uff1a${method}`

const isManualCodexCompactRequest = (request: ChatRequest) => {
  if (request.provider !== 'codex' || request.attachments.length > 0) {
    return false
  }

  const parsed = parseSlashCommandInput(request.prompt)
  return Boolean(parsed && parsed.name === 'compact' && parsed.args.length === 0)
}

const buildCodexInitSlashPrompt = (language: AppLanguage, args: string) => {
  const userPrompt = args.trim()
  const instruction =
    language === 'en'
      ? [
          'Refresh the project instructions for this workspace.',
          'Inspect the existing AGENTS.md, README, and the most relevant docs before you change anything.',
          'If the repo-specific guidance is missing or stale, draft or update the project instructions with concise, durable collaborator guidance grounded in the files you inspected.',
          'Call out any uncertainty or missing repo context before inventing project rules.',
        ].join('\n')
      : [
          '请为当前工作区刷新项目说明。',
          '在修改任何内容前，先检查现有的 AGENTS.md、README 和最相关的 docs。',
          '如果仓库级协作说明缺失或已过时，请基于你实际检查到的文件，起草或更新简洁、长期有效的项目说明。',
          '如果仓库上下文不足或存在不确定点，先明确指出，不要凭空编造项目规则。',
        ].join('\n')

  if (!userPrompt) {
    return instruction
  }

  return language === 'en'
    ? `${instruction}\n\nUser request:\n${userPrompt}`
    : `${instruction}\n\n用户请求：\n${userPrompt}`
}

const buildCodexPlanSlashPrompt = (language: AppLanguage, args: string) => {
  const userPrompt = args.trim()
  const instruction =
    language === 'en'
      ? [
          'Produce a concrete implementation plan for this request before making code changes.',
          'Inspect the relevant files first, then summarize the requirements, constraints, and the smallest safe sequence of steps.',
          'Do not make code changes yet unless the user explicitly asks you to skip planning and implement immediately.',
        ].join('\n')
      : [
          '先为这次请求产出一份具体的实现计划，再进入代码修改。',
          '先检查相关文件，再总结需求、约束，以及最小且安全的执行步骤。',
          '在用户没有明确要求跳过规划直接实现之前，不要先改代码。',
        ].join('\n')

  if (!userPrompt) {
    return instruction
  }

  return language === 'en'
    ? `${instruction}\n\nUser request:\n${userPrompt}`
    : `${instruction}\n\n用户请求：\n${userPrompt}`
}

export const expandCodexNativeSlashPrompt = (request: ChatRequest) => {
  if (request.provider !== 'codex') {
    return request.prompt
  }

  const parsed = parseSlashCommandInput(request.prompt)
  if (!parsed) {
    return request.prompt
  }

  switch (parsed.name) {
    case 'init':
      return buildCodexInitSlashPrompt(request.language, parsed.args)
    case 'plan':
      return buildCodexPlanSlashPrompt(request.language, parsed.args)
    default:
      return request.prompt
  }
}

const buildCodexAppServerBaseInstructions = (request: ChatRequest) =>
  [
    buildProviderSystemPrompt(request.language, request.systemPrompt),
    getCodexAskUserQuestionInstruction(request.language),
    getCodexWindowsShellSafetyInstruction(),
  ].join(' ')

export const buildCodexAppServerInput = (request: ChatRequest, attachmentPaths: string[]) => {
  const prompt = request.prompt.trim()
  const items: Array<Record<string, unknown>> = []

  if (prompt || attachmentPaths.length > 0 || request.sessionId) {
    items.push({
      type: 'text',
      // An empty prompt on a resumed session means "continue". Send a neutral
      // nudge instead of an empty text item, mirroring getClaudePrompt, so the
      // model actually continues rather than receiving a blank turn.
      text:
        prompt ||
        (attachmentPaths.length > 0 ? getCodexPrompt(request, attachmentPaths) : '') ||
        (request.sessionId ? 'Please continue.' : ''),
      text_elements: [],
    })
  }

  for (const attachmentPath of attachmentPaths) {
    items.push({
      type: 'localImage',
      path: attachmentPath,
    })
  }

  return items
}

type CodexSandboxMode = NonNullable<ChatRequest['sandboxMode']>

const getCodexSandboxMode = (request: ChatRequest): CodexSandboxMode =>
  request.sandboxMode ?? 'danger-full-access'

type CodexApprovalPolicy = NonNullable<ChatRequest['approvalPolicy']>

const getCodexApprovalPolicy = (request: ChatRequest): CodexApprovalPolicy =>
  request.approvalPolicy === 'on-request' ? 'on-request' : 'never'

const buildCodexSandboxPolicy = (request: ChatRequest) => {
  const sandboxMode = getCodexSandboxMode(request)

  switch (sandboxMode) {
    case 'read-only':
      return {
        type: 'readOnly',
        networkAccess: false,
      } as const
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        networkAccess: request.networkAccessEnabled ? 'enabled' : 'restricted',
        writableRoots: [request.workspacePath],
      } as const
    case 'danger-full-access':
      return {
        type: 'dangerFullAccess',
      } as const
  }
}

const createCodexJsonRpcIdFactory = () => {
  let requestCount = 0
  return () => `chill-vibe-${Date.now()}-${requestCount += 1}`
}

const writeCodexJsonRpcMessage = (
  stream: NodeJS.WritableStream,
  message: Record<string, unknown>,
) =>
  new Promise<void>((resolve, reject) => {
    stream.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })

const buildCodexThreadStartParams = (request: ChatRequest, workspacePath: string) => ({
  model: request.model || undefined,
  cwd: workspacePath,
  approvalPolicy: getCodexApprovalPolicy(request),
  sandbox: getCodexSandboxMode(request),
  baseInstructions: buildCodexAppServerBaseInstructions(request),
})

const buildCodexThreadResumeParams = (
  request: ChatRequest,
  workspacePath: string,
  threadId: string,
) => ({
  threadId,
  model: request.model || undefined,
  cwd: workspacePath,
  approvalPolicy: getCodexApprovalPolicy(request),
  sandbox: getCodexSandboxMode(request),
  baseInstructions: buildCodexAppServerBaseInstructions(request),
})

const buildCodexTurnStartParams = (
  request: ChatRequest,
  threadId: string,
  attachmentPaths: string[],
  options?: {
    includeEffort?: boolean
  },
) => ({
  threadId,
  input: buildCodexAppServerInput(request, attachmentPaths),
  cwd: request.workspacePath,
  approvalPolicy: getCodexApprovalPolicy(request),
  sandboxPolicy: buildCodexSandboxPolicy(request),
  model: request.model || undefined,
  ...(options?.includeEffort === false
    ? {}
    : {
        effort: request.thinkingEnabled === false
          ? 'none'
          : normalizeReasoningEffort('codex', request.reasoningEffort),
      }),
})

const launchCodexAppServerRun = async (
  request: ChatRequest,
  sink: StreamSink,
  language: AppLanguage,
  runtime: ProviderRuntime,
  attachmentPaths: string[],
  archiveRecallCleanup?: (() => Promise<void>) | null,
) => {
  if (isManualCodexCompactRequest(request) && !request.sessionId) {
    sink.onError(formatCodexCompactRequiresSession(language))
    return null
  }

  const child = await spawnProvider(
    'codex',
    buildCodexAppServerArgs(runtime.args),
    request.workspacePath,
    sink,
    language,
    runtime.env,
    { stdin: 'pipe' },
  )

  if (!child) {
    return null
  }

  if (!child.stdout || !child.stderr || !child.stdin) {
    sink.onError(formatCodexAppServerMissingStdio(language))
    child.kill()
    return null
  }

  let archiveRecallCleanedUp = false
  const cleanupArchiveRecall = async () => {
    if (archiveRecallCleanedUp || !archiveRecallCleanup) {
      return
    }

    archiveRecallCleanedUp = true
    try {
      await archiveRecallCleanup()
    } catch {
      // Ignore archive recall cleanup errors so the provider run can settle normally.
    }
  }

  const nextRequestId = createCodexJsonRpcIdFactory()
  const manualCompactRequest = isManualCodexCompactRequest(request)
  const compactionActivityDeduper = createCodexCompactionActivityDeduper()
  const bufferedStructuredAgentMessageDeltas = new Map<string, string>()
  const transientPlaceholderCandidateContentByItemId = new Map<string, string>()
  const emittedAssistantContent = {
    durable: false,
    interruptedByTransientPlaceholder: false,
    transientOnly: false,
  }
  const transientOnlyCompletionMessage =
    'Codex produced only transient reconnect placeholders before completion.'
  const pendingRequests = new Map<
    string,
    {
      method: string
      resolve: (value: unknown) => void
      reject: (error: Error) => void
    }
  >()
  let finished = false
  let stderr = ''
  let emittedSessionId: string | null = request.sessionId?.trim() || null
  let currentRequest = request
  let transientPlaceholderStallTimer: ReturnType<typeof setTimeout> | undefined
  let transientPlaceholderDisconnectStatsReported = false
  let localStreamStallTimer: ReturnType<typeof setTimeout> | undefined
  let sawVisibleStreamOutput = false
  let hasOpenProviderWork = false

  const clearTransientPlaceholderStallTimer = () => {
    if (transientPlaceholderStallTimer) {
      clearTimeout(transientPlaceholderStallTimer)
      transientPlaceholderStallTimer = undefined
    }
  }

  const clearLocalStreamStallTimer = () => {
    if (localStreamStallTimer) {
      clearTimeout(localStreamStallTimer)
      localStreamStallTimer = undefined
    }
  }

  const scheduleLocalStreamStallTimer = () => {
    if (finished || hasOpenProviderWork) {
      return
    }

    clearLocalStreamStallTimer()
    const timeoutMs = sawVisibleStreamOutput
      ? getLocalProviderStallTimeoutMs()
      : getLocalProviderFirstByteTimeoutMs()
    localStreamStallTimer = setTimeout(() => {
      localStreamStallTimer = undefined
      if (finished || hasOpenProviderWork) {
        return
      }

      finishWithError(
        sawVisibleStreamOutput
          ? 'Codex stalled after emitting stream output.'
          : 'Codex stalled without emitting stream output.',
      )
    }, timeoutMs)
  }

  const markVisibleStreamProgress = () => {
    sawVisibleStreamOutput = true
    scheduleLocalStreamStallTimer()
  }

  const markProviderWorkStarted = () => {
    hasOpenProviderWork = true
    sawVisibleStreamOutput = true
    clearLocalStreamStallTimer()
  }

  const markProviderWorkSettled = () => {
    if (!hasOpenProviderWork) {
      return
    }

    hasOpenProviderWork = false
    sawVisibleStreamOutput = true
    scheduleLocalStreamStallTimer()
  }

  const reportTransientPlaceholderDisconnectStats = () => {
    if (transientPlaceholderDisconnectStatsReported) {
      return
    }

    transientPlaceholderDisconnectStatsReported = true
    const event = {
      event: 'disconnect' as const,
      endpoint: '/cli/local-stream',
      errorType: 'native-reconnect-placeholder',
      alreadyRecorded: true,
    }
    proxyStats.record(request.provider, event.event, event.endpoint, {
      errorType: event.errorType,
    })
    sink.onStats?.(event)
  }

  const recordTransientPlaceholderControlSignal = (
    content?: string,
    options: { itemId?: string; startStallTimer?: boolean } = {},
  ) => {
    emittedAssistantContent.interruptedByTransientPlaceholder = true
    emittedAssistantContent.transientOnly = !emittedAssistantContent.durable
    if (options.itemId && content) {
      transientPlaceholderCandidateContentByItemId.set(options.itemId, content)
    }
    reportTransientPlaceholderDisconnectStats()
    if (options.startStallTimer) {
      scheduleTransientPlaceholderStallTimer()
    }
  }

  const markDurableAssistantContentProgress = () => {
    emittedAssistantContent.durable = true
    emittedAssistantContent.transientOnly = false
    transientPlaceholderCandidateContentByItemId.clear()
    clearTransientPlaceholderStallTimer()
  }

  const markDurableProviderProgress = () => {
    emittedAssistantContent.transientOnly = false
    transientPlaceholderCandidateContentByItemId.clear()
    clearTransientPlaceholderStallTimer()
  }

  const hasTransientPlaceholderWithoutDurableAssistantContent = () =>
    !emittedAssistantContent.durable &&
    (emittedAssistantContent.transientOnly || transientPlaceholderCandidateContentByItemId.size > 0)

  const recordAssistantContentProgress = (content: string, itemId?: string) => {
    if (!content.trim()) {
      return
    }

    if (isTransientRecoveryPlaceholder(content)) {
      recordTransientPlaceholderControlSignal(content, {
        itemId,
        startStallTimer: true,
      })
      return
    }

    if (isTransientRecoveryPlaceholderPrefix(content)) {
      recordTransientPlaceholderControlSignal(content, {
        itemId,
        startStallTimer: shouldStartTransientPlaceholderStallTimer(content),
      })
      return
    }

    if (itemId) {
      transientPlaceholderCandidateContentByItemId.delete(itemId)
    }
    markDurableAssistantContentProgress()
  }

  const scheduleTransientPlaceholderStallTimer = () => {
    if (finished) {
      return
    }

    clearTransientPlaceholderStallTimer()
    transientPlaceholderStallTimer = setTimeout(() => {
      transientPlaceholderStallTimer = undefined
      if (finished) {
        return
      }

      const stalledAfterDurableContentMessage =
        'Codex stalled after native reconnect placeholders interrupted the stream.'
      finishWithError(
        emittedAssistantContent.durable
          ? stalledAfterDurableContentMessage
          : 'Codex stalled after producing only transient reconnect placeholders.',
      )
    }, getTransientPlaceholderStallTimeoutMs())
  }

  const rejectPendingRequests = (message: string) => {
    for (const { reject } of pendingRequests.values()) {
      reject(new Error(message))
    }
    pendingRequests.clear()
  }

  const finishWithDone = () => {
    if (finished) {
      return
    }

    if (hasTransientPlaceholderWithoutDurableAssistantContent()) {
      finishWithError(transientOnlyCompletionMessage)
      return
    }

    clearTransientPlaceholderStallTimer()
    clearLocalStreamStallTimer()
    finished = true
    rejectPendingRequests('Codex run completed.')
    void cleanupArchiveRecall()
    sink.onDone()
    child.kill()
  }

  const finishWithError = (message: string, hint?: StreamErrorHint) => {
    if (finished) {
      return
    }

    let visibleMessage = message
    if (hasOnlyTransientRecoveryPlaceholderDiagnostics(message)) {
      recordTransientPlaceholderControlSignal(message)
      visibleMessage = emittedAssistantContent.durable
        ? 'Codex stalled after native reconnect placeholders interrupted the stream.'
        : transientOnlyCompletionMessage
    }

    clearTransientPlaceholderStallTimer()
    clearLocalStreamStallTimer()
    finished = true
    rejectPendingRequests(visibleMessage)
    void cleanupArchiveRecall()
    sink.onError(
      visibleMessage,
      hint,
      classifyLiveProviderStreamRecovery(request, visibleMessage, hint, emittedSessionId, {
        transientOnly: hasTransientPlaceholderWithoutDurableAssistantContent(),
        interruptedByTransientPlaceholder: emittedAssistantContent.interruptedByTransientPlaceholder,
      }),
    )
    child.kill()
  }

  const sendRequest = async (method: string, params?: Record<string, unknown>) => {
    const id = nextRequestId()

    return await new Promise<unknown>((resolve, reject) => {
      pendingRequests.set(id, { method, resolve, reject })

      void writeCodexJsonRpcMessage(child.stdin!, {
        id,
        method,
        ...(params ? { params } : {}),
      }).catch((error) => {
        pendingRequests.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  const sendNotification = async (method: string, params?: Record<string, unknown>) => {
    await writeCodexJsonRpcMessage(child.stdin!, {
      method,
      ...(params ? { params } : {}),
    })
  }

  const startTurnWithCompatibilityFallback = async (threadId: string) => {
    try {
      scheduleLocalStreamStallTimer()
      await sendRequest('turn/start', buildCodexTurnStartParams(currentRequest, threadId, attachmentPaths))
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      if (!isCodexAppServerEffortUnsupported(message)) {
        throw error
      }

      sink.onLog(formatCodexEffortCompatibilityNotice(language))
      scheduleLocalStreamStallTimer()
      await sendRequest(
        'turn/start',
        buildCodexTurnStartParams(currentRequest, threadId, attachmentPaths, { includeEffort: false }),
      )
    }
  }

  const startThread = async () => {
    if (!currentRequest.sessionId) {
      return await sendRequest('thread/start', buildCodexThreadStartParams(currentRequest, currentRequest.workspacePath))
    }

    try {
      return await sendRequest(
        'thread/resume',
        buildCodexThreadResumeParams(currentRequest, currentRequest.workspacePath, currentRequest.sessionId),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isCodexStaleResumedSession(message)) {
        throw error
      }

      sink.onLog(formatCodexStaleSessionRecoveryNotice(language))
      currentRequest = { ...currentRequest, sessionId: undefined }
      emittedSessionId = null
      return await sendRequest('thread/start', buildCodexThreadStartParams(currentRequest, currentRequest.workspacePath))
    }
  }

  const handleCodexEvent = (event: unknown) => {
    for (const parsed of parseCodexResponseEvent(event)) {
      bufferedStructuredAgentMessageDeltas.delete(parsed.itemId)
      transientPlaceholderCandidateContentByItemId.delete(parsed.itemId)

      if (parsed.type === 'assistant_message') {
        compactionActivityDeduper.reset()
        const shouldSuppressTransientPlaceholder = isTransientRecoveryPlaceholderPrefix(parsed.content)
        recordAssistantContentProgress(parsed.content, parsed.itemId)
        if (shouldSuppressTransientPlaceholder) {
          continue
        }
        markVisibleStreamProgress()
        sink.onAssistantMessage({
          itemId: parsed.itemId,
          content: parsed.content,
        })
        continue
      }

      const activity = { ...parsed }
      delete (activity as { type?: 'activity' }).type

      if (activity.kind === 'command' && activity.status === 'in_progress') {
        markProviderWorkStarted()
      } else if (activity.kind === 'command') {
        markProviderWorkSettled()
      } else {
        markVisibleStreamProgress()
      }

      if (activity.kind === 'compaction') {
        if (compactionActivityDeduper.shouldEmit(event, activity)) {
          markDurableProviderProgress()
          sink.onActivity({
            ...activity,
            trigger: manualCompactRequest ? 'manual' : activity.trigger,
          })
        }

        if (manualCompactRequest && activity.status === 'completed') {
          finishWithDone()
        }

        continue
      }

      compactionActivityDeduper.reset()
      markDurableProviderProgress()
      sink.onActivity(activity)
    }
  }

  const stdoutLines = readLines(child.stdout, (line) => {
    if (!line.trim()) {
      return
    }

    try {
      const message = JSON.parse(line) as unknown

      if (!isRecord(message)) {
        return
      }

      if ('id' in message && 'result' in message) {
        const id = typeof message.id === 'string' ? message.id : String(message.id)
        const pending = pendingRequests.get(id)
        if (!pending) {
          return
        }

        pendingRequests.delete(id)
        pending.resolve(message.result)
        return
      }

      if ('id' in message && isRecord(message.error)) {
        const id = typeof message.id === 'string' ? message.id : String(message.id)
        const pending = pendingRequests.get(id)
        const errorMessage = readString(message.error, 'message') ?? 'Codex app-server request failed.'

        if (pending) {
          pendingRequests.delete(id)
          pending.reject(new Error(errorMessage))
          return
        }

        finishWithError(errorMessage, classifyLaunchErrorHint(errorMessage))
        return
      }

      const method = readString(message, 'method')
      if (!method) {
        return
      }

      if ('id' in message) {
        finishWithError(
          formatCodexAppServerUnexpectedRequest(language, method),
          classifyLaunchErrorHint(method),
        )
        return
      }

      const params = readRecord(message, 'params') ?? {}

      if (method === 'thread/started') {
        const thread = readRecord(params, 'thread')
        const sessionId = thread ? readString(thread, 'id') : undefined
        if (sessionId && sessionId !== emittedSessionId) {
          emittedSessionId = sessionId
          sink.onSession(sessionId)
        }
        return
      }

      if (method === 'item/agentMessage/delta') {
        compactionActivityDeduper.reset()
        const delta = readStringPreserveWhitespace(params, 'delta')
        const itemId = readString(params, 'itemId') ?? readString(params, 'item_id')

        if (delta) {
          const pendingTransientCandidate = itemId
            ? transientPlaceholderCandidateContentByItemId.get(itemId)
            : undefined
          const contentForProgress = pendingTransientCandidate
            ? `${pendingTransientCandidate}${delta}`
            : delta
          const shouldSuppressTransientPlaceholder = Boolean(
            itemId && isTransientRecoveryPlaceholderPrefix(contentForProgress),
          )
          recordAssistantContentProgress(contentForProgress, itemId)

          if (shouldSuppressTransientPlaceholder) {
            return
          }

          const deltaForSink = pendingTransientCandidate ? contentForProgress : delta
          markVisibleStreamProgress()

          if (itemId) {
            const bufferedDelta = bufferedStructuredAgentMessageDeltas.get(itemId)

            if (bufferedDelta !== undefined || looksLikeCodexStructuredAgentMessage(deltaForSink)) {
              bufferedStructuredAgentMessageDeltas.set(itemId, `${bufferedDelta ?? ''}${deltaForSink}`)
              return
            }
          }

          sink.onDelta(deltaForSink)
        }

        return
      }

      if (method === 'turn/completed' && !manualCompactRequest) {
        finishWithDone()
        return
      }

      if (method === 'error') {
        const errorRecord = readRecord(params, 'error')
        const messageText =
          (errorRecord ? readString(errorRecord, 'message') : undefined) ??
          readString(params, 'message') ??
          'Codex run failed.'
        finishWithError(messageText, classifyLaunchErrorHint(messageText))
        return
      }

      handleCodexEvent(message)
    } catch {
      // Ignore malformed stdout noise unless the run eventually fails.
    }
  })

  const stderrLines = readLines(child.stderr, (line) => {
    if (!line.trim()) {
      return
    }

    if (hasTransientRecoveryPlaceholderDiagnostics(line)) {
      recordTransientPlaceholderControlSignal(line, { startStallTimer: true })
    }

    stderr += `${line}\n`
  })

  child.on('close', (code) => {
    stdoutLines.close()
    stderrLines.close()
    void cleanupArchiveRecall()

    if (finished) {
      return
    }

    clearTransientPlaceholderStallTimer()
    clearLocalStreamStallTimer()
    finished = true
    rejectPendingRequests(code === 0 ? 'Codex app-server closed before completion.' : formatProviderExit(language, 'codex', code))

    if (code === 0) {
      const diagnostics = summarizeDiagnostics(stderr)
      const message = hasOnlyTransientRecoveryPlaceholderDiagnostics(diagnostics || stderr)
        ? transientOnlyCompletionMessage
        : diagnostics || formatProviderUnexpectedCompletion(language, 'codex')
      const hint = classifyLaunchErrorHint(`${message}\n${stderr}`)
      sink.onError(
        message,
        hint,
        classifyLiveProviderStreamRecovery(request, message, hint, emittedSessionId, {
          transientOnly: hasTransientPlaceholderWithoutDurableAssistantContent(),
          interruptedByTransientPlaceholder: emittedAssistantContent.interruptedByTransientPlaceholder,
        }),
      )
      return
    }

    const diagnostics = summarizeDiagnostics(stderr)
    const message = hasOnlyTransientRecoveryPlaceholderDiagnostics(diagnostics || stderr)
      ? transientOnlyCompletionMessage
      : diagnostics || formatProviderExit(language, 'codex', code)
    const hint = classifyLaunchErrorHint(`${message}\n${stderr}`)
    sink.onError(
      message,
      hint,
      classifyLiveProviderStreamRecovery(request, message, hint, emittedSessionId, {
        transientOnly: hasTransientPlaceholderWithoutDurableAssistantContent(),
        interruptedByTransientPlaceholder: emittedAssistantContent.interruptedByTransientPlaceholder,
      }),
    )
  })

  child.on('error', (error) => {
    if (finished) {
      return
    }

    void cleanupArchiveRecall()
    finished = true
    clearTransientPlaceholderStallTimer()
    clearLocalStreamStallTimer()
    stdoutLines.close()
    stderrLines.close()
    rejectPendingRequests(error.message)
    const hint = classifyLaunchErrorHint(error.message)
    sink.onError(
      error.message,
      hint,
      classifyLiveProviderStreamRecovery(request, error.message, hint, emittedSessionId, {
        transientOnly: hasTransientPlaceholderWithoutDurableAssistantContent(),
        interruptedByTransientPlaceholder: emittedAssistantContent.interruptedByTransientPlaceholder,
      }),
    )
  })

  void (async () => {
    try {
      await sendRequest('initialize', {
        clientInfo: {
          name: 'chill-vibe',
          title: 'Chill Vibe',
          version: '0.1.0',
        },
        capabilities: null,
      })
      await sendNotification('initialized')

      const threadResponse = await startThread()

      const threadRecord = isRecord(threadResponse) ? readRecord(threadResponse, 'thread') : null
      const threadId = (threadRecord ? readString(threadRecord, 'id') : undefined) ?? request.sessionId

      if (!threadId) {
        throw new Error('Codex app-server did not return a thread id.')
      }

      if (threadId !== emittedSessionId) {
        emittedSessionId = threadId
        sink.onSession(threadId)
      }

      if (manualCompactRequest) {
        await sendRequest('thread/compact/start', { threadId })
        return
      }

      if (
        request.prompt.trim().length > 0 ||
        attachmentPaths.length > 0 ||
        currentRequest.sessionId
      ) {
        await startTurnWithCompatibilityFallback(threadId)
        return
      }

      if (currentRequest.sessionId) {
        return
      }

      finishWithError(formatProviderUnexpectedCompletion(language, 'codex'))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Codex run failed.'
      finishWithError(message, classifyLaunchErrorHint(message))
    }
  })()

  return child
}

export const launchProviderRun = async (
  request: ChatRequest,
  sink: StreamSink,
  options?: {
    // Long-lived Claude process pool (Electron host only). When present and
    // the request carries a cardId, Claude turns reuse a pooled CLI process.
    claudeSessionPool?: ClaudeSessionPool | null
  },
) => {
  const language = normalizeLanguage(request.language)
  let currentRequest = request

  try {
    const expandedPrompt = await expandSkillSlashPrompt({
      ...request,
      prompt: expandCodexNativeSlashPrompt(request),
    })
    const crossProviderSkillInstructions = await buildCrossProviderSkillInstructions(request)

    if (expandedPrompt !== currentRequest.prompt) {
      currentRequest = {
        ...currentRequest,
        prompt: expandedPrompt,
      }
    }

    if (crossProviderSkillInstructions) {
      currentRequest = {
        ...currentRequest,
        systemPrompt: [currentRequest.systemPrompt, crossProviderSkillInstructions]
          .filter((part) => part.trim().length > 0)
          .join('\n\n'),
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sink.onLog(
      language === 'en'
        ? `Unable to load cross-provider skills; continuing without them. ${message}`
        : `无法加载跨 Provider skills，已继续本次运行但不注入它们。${message}`,
    )
    currentRequest = request
  }

  if (
    currentRequest.attachments.length > 0 &&
    !providerSupportsImageAttachments(currentRequest.provider)
  ) {
    sink.onError(formatImageAttachmentsUnsupported(language, currentRequest.provider))
    return null
  }

  let attachmentPaths: string[] = []

  if (currentRequest.attachments.length > 0) {
    try {
      attachmentPaths = await resolveAttachmentPaths(currentRequest.attachments)
    } catch (error) {
      sink.onError(error instanceof Error ? error.message : 'Unable to read the pasted image.')
      return null
    }
  }
  const runtime = await resolveProviderRuntime(currentRequest.provider)

  if (currentRequest.provider === 'codex') {
    let archiveRecallRuntime: Awaited<ReturnType<typeof createArchiveRecallRuntimeOverrides>> | null = null

    try {
      archiveRecallRuntime = await createArchiveRecallRuntimeOverrides(currentRequest)
    } catch (error) {
      console.warn(`[archive-recall] Unable to prepare archive recall runtime: ${error instanceof Error ? error.message : String(error)}`)
      archiveRecallRuntime = null
    }

    const codexRuntime = archiveRecallRuntime
      ? {
          ...runtime,
          args: [...runtime.args, ...archiveRecallRuntime.runtimeArgs],
        }
      : runtime
    const codexRequest = archiveRecallRuntime
      ? {
          ...currentRequest,
          systemPrompt: [currentRequest.systemPrompt, getCodexArchiveRecallInstruction(language)]
            .filter((part) => part.trim().length > 0)
            .join('\n\n'),
        }
      : currentRequest

    return launchCodexAppServerRun(
      codexRequest,
      sink,
      language,
      codexRuntime,
      attachmentPaths,
      archiveRecallRuntime?.cleanup,
    )
  }

  return launchClaudeRun(currentRequest, sink, language, runtime, attachmentPaths, options?.claudeSessionPool ?? null)
}

// ---------------------------------------------------------------------------
// Claude turn parser
//
// One instance per turn. Folds the CLI's stream-json stdout lines into sink
// calls, owns the stall watchdog and the result/error terminal handling. The
// single-shot path and the keepalive (pooled, `--input-format stream-json`)
// path share this state machine so the stripper/watchdog/recovery behavior can
// never drift between them.
// ---------------------------------------------------------------------------

type ClaudeTurnParser = {
  handleLine: (line: string) => void
  handleStderrLine: (line: string) => void
  // Fallback-free terminal handling for an unexpected process exit. The caller
  // is responsible for the effort/stale-session restart checks first.
  handleProcessClosed: (code: number | null) => void
  handleSpawnError: (error: Error) => void
  armWatchdog: () => void
  // Drop the parser without settling (the caller is restarting the attempt).
  cancel: () => void
  settled: () => boolean
  sawStreamOutput: () => boolean
  stderrText: () => string
}

// Exported for the keepalive integration test, which drives a real fake-CLI
// child process through the pool + parser composition.
export const createClaudeTurnParser = (hooks: {
  request: ChatRequest
  sink: StreamSink
  language: AppLanguage
  killChild: () => void
  // Fired exactly once after the turn's final sink call (done or error), so a
  // pooled process can be returned to idle only after the stream settled.
  onSettled?: () => void
  onSessionId?: (sessionId: string) => void
}): ClaudeTurnParser => {
  const { request, sink, language } = hooks
  const parseClaudeStructuredOutput = createClaudeStructuredOutputParser(language, {
    planMode: request.planMode,
  })
  let sawClaudeDelta = false
  let sawClaudeStreamOutput = false
  // Track whether the turn produced anything real, so a turn whose only output
  // was a tool call typed as text (stripped, never executed) can be auto-resumed
  // instead of silently dead-ending.
  let sawStructuredActivity = false
  let sawMeaningfulAssistantText = false
  const askUserDeltaStripper = createClaudeAskUserDeltaStripper()
  const typedToolChatterFilter = createClaudeTypedToolChatterFilter()
  let stderr = ''
  let emittedSessionId: string | null = request.sessionId?.trim() || null
  // Stall watchdog: the Claude path otherwise has no timeout, so a CLI that
  // goes silent without a terminal `result` event spins the card forever
  // ("使用工具也经常卡住不动"). The watchdog disarms while a tool command is in
  // progress (the CLI emits no stdout for the command duration and owns its own
  // per-tool timeout), so it never false-kills a legitimately long command.
  let openClaudeCommandCount = 0
  // Latched once the turn dispatches a synchronously-awaited background tool
  // (Workflow/subagent). The CLI then runs it silently and waits (up to its own
  // 10-min cap); the watchdog must stay patient for the rest of the turn instead
  // of false-killing the CLI during that silent wait. Resets per turn (the parser
  // is created fresh each turn).
  let sawBackgroundAwaitTool = false
  let claudeStallTimer: ReturnType<typeof setTimeout> | undefined
  let finished = false

  const clearClaudeStallTimer = () => {
    if (claudeStallTimer) {
      clearTimeout(claudeStallTimer)
      claudeStallTimer = undefined
    }
  }

  const markFinished = () => {
    finished = true
    clearClaudeStallTimer()
  }

  const scheduleClaudeStallTimer = () => {
    clearClaudeStallTimer()

    if (finished) {
      return
    }

    const timeoutMs = resolveLocalStreamStallTimeoutMs({
      sawStreamOutput: sawClaudeStreamOutput,
      openCommandCount: openClaudeCommandCount,
      firstByteTimeoutMs: getLocalProviderFirstByteTimeoutMs(),
      stallTimeoutMs: getLocalProviderStallTimeoutMs(),
      backgroundAwaitActive: sawBackgroundAwaitTool,
      backgroundAwaitTimeoutMs: getBackgroundAwaitWatchdogMs(),
    })

    if (timeoutMs === null) {
      return
    }

    claudeStallTimer = setTimeout(() => {
      claudeStallTimer = undefined

      if (finished) {
        return
      }

      markFinished()
      const message = sawClaudeStreamOutput
        ? 'Claude stalled after emitting stream output.'
        : 'Claude stalled without emitting stream output.'
      sink.onError(
        message,
        undefined,
        classifyLiveProviderStreamRecovery(request, message, undefined, emittedSessionId),
      )
      hooks.killChild()
      hooks.onSettled?.()
    }, timeoutMs)
  }

  const handleLine = (line: string) => {
    if (!line.trim() || finished) {
      return
    }

    try {
      const event = JSON.parse(line)
      sawClaudeStreamOutput = true
      // Any line is progress: reset the watchdog. The command-count update in
      // the activity loop below re-evaluates (and disarms) it for tool runs.
      scheduleClaudeStallTimer()

      if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
        emittedSessionId = event.session_id
        hooks.onSessionId?.(event.session_id)
        sink.onSession(event.session_id)
        return
      }

      const claudeStructuredEvents = parseClaudeStructuredOutput(event)

      if (event.type === 'assistant' && !sawClaudeDelta) {
        if (Array.isArray(event.message?.content)) {
          const hasToolUse = event.message.content.some(
            (item: { type?: string }) => item.type === 'tool_use',
          )
          const textContent = event.message.content
            .filter((item: { type?: string; text?: string }) => item.type === 'text')
            .map((item: { text?: string }) => item.text ?? '')
            .join('')
          const safeTextContent =
            askUserDeltaStripper.push(textContent) + askUserDeltaStripper.flush()
          // A native tool_use in the same assistant event is as strong a signal
          // as a stripped typed tool-call block: a trailing marker word on the
          // preceding prose belongs to the tool-call payload, not the prose.
          const visibleTextContent = typedToolChatterFilter.push(
            askUserDeltaStripper.consumedToolCallBlockCount() > 0 || hasToolUse
              ? stripTrailingClaudeTypedToolMarkerLines(safeTextContent)
              : safeTextContent,
          )

          if (
            visibleTextContent.trim() &&
            !(hasToolUse && isBareClaudeToolCallMarkerText(visibleTextContent))
          ) {
            sawMeaningfulAssistantText = true
            sink.onDelta(visibleTextContent)
          }
        }
      }

      for (const parsed of claudeStructuredEvents) {
        if (structuredActivityCountsAsTurnOutput(parsed.kind)) {
          sawStructuredActivity = true
        }
        if (parsed.kind === 'command') {
          if (parsed.status === 'in_progress') {
            openClaudeCommandCount += 1
          } else if (parsed.status === 'completed') {
            openClaudeCommandCount = Math.max(0, openClaudeCommandCount - 1)
          }
        }
        if (
          parsed.kind === 'tool' &&
          typeof parsed.toolName === 'string' &&
          isClaudeBackgroundAwaitTool(parsed.toolName)
        ) {
          // A Workflow/subagent was dispatched: the CLI now runs it silently and
          // waits for it. Keep the watchdog patient for the rest of this turn.
          sawBackgroundAwaitTool = true
        }
        const activity = { ...parsed }
        delete (activity as { type?: 'activity' }).type
        sink.onActivity(activity)
      }

      if (claudeStructuredEvents.length > 0) {
        // Re-evaluate the watchdog now that the in-progress command count may
        // have changed: disarm while a command runs, re-arm once it completes.
        scheduleClaudeStallTimer()
      }

      if (
        event.type === 'user' &&
        typeof event.message?.content === 'string' &&
        claudeStructuredEvents.length === 0
      ) {
        const localCommandOutput = extractClaudeLocalCommandOutput(event.message.content)
        if (localCommandOutput) {
          sink.onLog(localCommandOutput)
          return
        }
      }

      if (
        event.type === 'stream_event' &&
        event.event?.type === 'content_block_delta' &&
        event.event.delta?.type === 'text_delta' &&
        typeof event.event.delta.text === 'string'
      ) {
        sawClaudeDelta = true
        const safeText = askUserDeltaStripper.push(event.event.delta.text)
        const visibleText = typedToolChatterFilter.push(safeText)
        if (visibleText) {
          if (visibleText.trim()) {
            sawMeaningfulAssistantText = true
          }
          sink.onDelta(visibleText)
        }
        return
      }

      if (event.type === 'assistant') {
        return
      }

      if (event.type === 'result') {
        markFinished()

        const residualDelta = askUserDeltaStripper.flush()
        if (askUserDeltaStripper.consumedToolCallBlockCount() > 0) {
          typedToolChatterFilter.dropIfChatter()
        }
        const visibleResidualDelta =
          typedToolChatterFilter.push(
            askUserDeltaStripper.consumedToolCallBlockCount() > 0
              ? stripTrailingClaudeTypedToolMarkerLines(residualDelta)
              : residualDelta,
          ) + typedToolChatterFilter.flush()
        if (
          visibleResidualDelta &&
          !(sawStructuredActivity && isBareClaudeToolCallMarkerText(visibleResidualDelta))
        ) {
          if (visibleResidualDelta.trim()) {
            sawMeaningfulAssistantText = true
          }
          sink.onDelta(visibleResidualDelta)
        }

        if (event.is_error) {
          const message =
            typeof event.result === 'string' ? event.result : formatClaudeRunFailed(language)
          const hint = classifyLaunchErrorHint(message)
          sink.onError(message, hint, classifyLiveProviderStreamRecovery(request, message, hint, emittedSessionId))
          hooks.onSettled?.()
          return
        }

        // A clean `result` can still be a dead-end: the model typed a tool call
        // as text (now stripped) and produced no real activity or prose, so the
        // turn did nothing. Auto-resume it via the bounded renderer retry path
        // instead of calling onDone() and stalling the chat ("老是停住").
        const emptyToolCallRecovery = shouldRecoverEmptyToolCallTurn({
          consumedRealToolCallBlock: askUserDeltaStripper.consumedToolCallBlockCount() > 0,
          sawStructuredActivity,
          sawMeaningfulAssistantText,
          hasSessionId: Boolean((emittedSessionId ?? request.sessionId)?.trim()),
        })

        if (emptyToolCallRecovery) {
          sink.onError(formatClaudeTypedToolCallStalled(language), undefined, emptyToolCallRecovery)
          hooks.onSettled?.()
          return
        }

        sink.onDone()
        hooks.onSettled?.()
        return
      }
    } catch {
      // Ignore non-JSON stdout noise unless the run eventually fails.
    }
  }

  const handleStderrLine = (line: string) => {
    if (!line.trim()) {
      return
    }

    stderr += `${line}\n`
  }

  const handleProcessClosed = (code: number | null) => {
    if (finished) {
      return
    }

    markFinished()
    const diagnostics = summarizeDiagnostics(stderr)
    const message =
      code === 0
        ? diagnostics || formatProviderUnexpectedCompletion(language, request.provider)
        : diagnostics || formatProviderExit(language, request.provider, code)
    const detail = `${message}\n${stderr}`
    const hint = classifyLaunchErrorHint(detail)
    sink.onError(message, hint, classifyLiveProviderStreamRecovery(request, message, hint, emittedSessionId))
    hooks.onSettled?.()
  }

  const handleSpawnError = (error: Error) => {
    if (finished) {
      return
    }

    markFinished()
    const hint = classifyLaunchErrorHint(error.message)
    sink.onError(error.message, hint, classifyLiveProviderStreamRecovery(request, error.message, hint, emittedSessionId))
    hooks.onSettled?.()
  }

  return {
    handleLine,
    handleStderrLine,
    handleProcessClosed,
    handleSpawnError,
    // Arm the first-byte watchdog: if the CLI never produces output (or a
    // terminal event) it would otherwise hang the card indefinitely.
    armWatchdog: scheduleClaudeStallTimer,
    cancel: clearClaudeStallTimer,
    settled: () => finished,
    sawStreamOutput: () => sawClaudeStreamOutput,
    stderrText: () => stderr,
  }
}

const isClaudeKeepaliveEnabled = () => process.env.CHILL_VIBE_CLAUDE_KEEPALIVE !== '0'

const launchClaudeRun = async (
  request: ChatRequest,
  sink: StreamSink,
  language: AppLanguage,
  runtime: ProviderRuntime,
  attachmentPaths: string[],
  pool: ClaudeSessionPool | null,
) => {
  const cardId = request.cardId?.trim()

  if (pool && cardId && isClaudeKeepaliveEnabled()) {
    return launchClaudeKeepaliveRun(request, sink, language, runtime, attachmentPaths, pool, cardId)
  }

  return launchClaudeSingleShotRun(request, sink, language, runtime, attachmentPaths)
}

const launchClaudeSingleShotRun = async (
  request: ChatRequest,
  sink: StreamSink,
  language: AppLanguage,
  runtime: ProviderRuntime,
  attachmentPaths: string[],
) => {
  const managedChild = createManagedChildHandle()
  let currentRequest = request
  let fallbackAttempted = false
  let staleSessionFallbackAttempted = false

  const startClaudeAttempt = async (includeEffort: boolean) => {
    const args = [
      ...runtime.args,
      ...buildClaudeArgs(currentRequest, attachmentPaths, { includeEffort }),
    ]

    const child = await spawnProvider(
      currentRequest.provider,
      args,
      currentRequest.workspacePath,
      sink,
      language,
      runtime.env,
    )

    if (!child) {
      managedChild.setActiveChild(null)
      return false
    }

    managedChild.setActiveChild(child)

    if (!child.stdout || !child.stderr) {
      const message = formatProviderUnexpectedCompletion(language, currentRequest.provider)
      managedChild.setActiveChild(null)
      sink.onError(message, undefined, classifyProviderStreamErrorRecovery(currentRequest, message))
      child.kill()
      return false
    }

    const parser = createClaudeTurnParser({
      request: currentRequest,
      sink,
      language,
      killChild: () => {
        try {
          child.kill()
        } catch {
          // The process may already be gone.
        }
      },
      onSettled: () => managedChild.setActiveChild(null),
    })

    const stdoutLines = readLines(child.stdout, parser.handleLine)
    const stderrLines = readLines(child.stderr, parser.handleStderrLine)

    parser.armWatchdog()

    child.on('close', (code) => {
      stdoutLines.close()
      stderrLines.close()

      if (parser.settled()) {
        managedChild.setActiveChild(null)
        return
      }

      const stderrText = parser.stderrText()
      const diagnostics = summarizeDiagnostics(stderrText)
      const message =
        code === 0
          ? diagnostics || formatProviderUnexpectedCompletion(language, currentRequest.provider)
          : diagnostics || formatProviderExit(language, currentRequest.provider, code)
      const detail = `${message}\n${stderrText}`

      if (
        includeEffort &&
        !fallbackAttempted &&
        code !== 0 &&
        !parser.sawStreamOutput() &&
        isClaudeEffortUnsupported(detail)
      ) {
        fallbackAttempted = true
        parser.cancel()
        managedChild.setActiveChild(null)
        sink.onLog(formatClaudeEffortCompatibilityNotice(language))
        void startClaudeAttempt(false)
        return
      }

      if (
        !staleSessionFallbackAttempted &&
        code !== 0 &&
        !parser.sawStreamOutput() &&
        currentRequest.sessionId?.trim() &&
        isClaudeStaleResumedSession(detail)
      ) {
        staleSessionFallbackAttempted = true
        parser.cancel()
        managedChild.setActiveChild(null)
        sink.onLog(formatClaudeStaleSessionRecoveryNotice(language))
        currentRequest = { ...currentRequest, sessionId: undefined }
        void startClaudeAttempt(includeEffort)
        return
      }

      parser.handleProcessClosed(code)
    })

    child.on('error', (error) => {
      if (parser.settled()) {
        managedChild.setActiveChild(null)
        return
      }

      stdoutLines.close()
      stderrLines.close()
      parser.handleSpawnError(error)
    })

    return true
  }

  const started = await startClaudeAttempt(true)
  return started ? managedChild.handle : null
}

// ---------------------------------------------------------------------------
// Claude keepalive run
//
// The CLI process is pooled per card and stays alive between turns
// (`--input-format stream-json`), so background tasks started by the agent
// survive the turn and their completion wakes the agent for an unsolicited
// follow-up turn. User messages are written to stdin as stream-json lines.
// ---------------------------------------------------------------------------

const buildClaudeKeepaliveSignature = (
  request: ChatRequest,
  includeEffort: boolean,
  runtime: ProviderRuntime,
) =>
  JSON.stringify({
    workspace: request.workspacePath,
    model: request.model ?? '',
    // Use the normalized tier (not the --effort flag value) so ultracode keeps a
    // distinct keepalive process from xhigh/max: ultracode launches with an
    // extra `"ultracode": true` --settings key, so it must not share a pooled CLI.
    effort: includeEffort
      ? `${request.thinkingEnabled === false ? 'none' : normalizeReasoningEffort('claude', request.reasoningEffort)}`
      : 'omitted',
    plan: Boolean(request.planMode),
    language: normalizeLanguage(request.language),
    systemPrompt: request.systemPrompt,
    modelPromptRules: request.modelPromptRules,
    skills: request.crossProviderSkillReuseEnabled !== false,
    runtimeArgs: runtime.args,
  })

const launchClaudeKeepaliveRun = async (
  request: ChatRequest,
  sink: StreamSink,
  language: AppLanguage,
  runtime: ProviderRuntime,
  attachmentPaths: string[],
  pool: ClaudeSessionPool,
  cardId: string,
) => {
  const managedChild = createManagedChildHandle()
  let currentRequest = request
  let fallbackAttempted = false
  let staleSessionFallbackAttempted = false

  const startAttempt = async (includeEffort: boolean): Promise<boolean> => {
    const signature = buildClaudeKeepaliveSignature(currentRequest, includeEffort, runtime)

    const acquired = await pool.acquireForTurn({
      key: cardId,
      signature,
      sessionId: currentRequest.sessionId,
      spawn: async () => {
        const args = [
          ...runtime.args,
          ...buildClaudeArgs(currentRequest, attachmentPaths, {
            includeEffort,
            streamingInput: true,
          }),
        ]

        const spawned = await spawnProvider(
          currentRequest.provider,
          args,
          currentRequest.workspacePath,
          sink,
          language,
          runtime.env,
          { stdin: 'pipe' },
        )

        if (spawned && (!spawned.stdout || !spawned.stderr || !spawned.stdin)) {
          const message = formatProviderUnexpectedCompletion(language, currentRequest.provider)
          sink.onError(message, undefined, classifyProviderStreamErrorRecovery(currentRequest, message))
          spawned.kill()
          return null
        }

        return spawned
      },
      meta: {
        language,
        workspacePath: currentRequest.workspacePath,
        model: currentRequest.model ?? '',
      },
    })

    if (!acquired) {
      return false
    }

    const child = acquired.child as ChildProcess
    managedChild.setActiveChild(child)

    const parser = createClaudeTurnParser({
      request: currentRequest,
      sink,
      language,
      killChild: () => pool.releaseEntry(cardId),
      onSettled: () => {
        managedChild.setActiveChild(null)
        pool.endTurn(cardId)
      },
      onSessionId: (sessionId) => pool.updateSessionId(cardId, sessionId),
    })

    pool.beginTurn(cardId, {
      onLine: parser.handleLine,
      onStderrLine: parser.handleStderrLine,
      onProcessClosed: (code) => {
        if (parser.settled()) {
          managedChild.setActiveChild(null)
          return
        }

        const stderrText = parser.stderrText()
        const diagnostics = summarizeDiagnostics(stderrText)
        const message =
          code === 0
            ? diagnostics || formatProviderUnexpectedCompletion(language, currentRequest.provider)
            : diagnostics || formatProviderExit(language, currentRequest.provider, code)
        const detail = `${message}\n${stderrText}`

        if (
          includeEffort &&
          !fallbackAttempted &&
          code !== 0 &&
          !parser.sawStreamOutput() &&
          isClaudeEffortUnsupported(detail)
        ) {
          fallbackAttempted = true
          parser.cancel()
          managedChild.setActiveChild(null)
          sink.onLog(formatClaudeEffortCompatibilityNotice(language))
          void startAttempt(false)
          return
        }

        if (
          !staleSessionFallbackAttempted &&
          code !== 0 &&
          !parser.sawStreamOutput() &&
          currentRequest.sessionId?.trim() &&
          isClaudeStaleResumedSession(detail)
        ) {
          staleSessionFallbackAttempted = true
          parser.cancel()
          managedChild.setActiveChild(null)
          sink.onLog(formatClaudeStaleSessionRecoveryNotice(language))
          currentRequest = { ...currentRequest, sessionId: undefined }
          void startAttempt(includeEffort)
          return
        }

        parser.handleProcessClosed(code)
      },
    })

    const prompt = getClaudePrompt(currentRequest, attachmentPaths)
    const written = pool.writeUserMessage(
      cardId,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      }),
    )

    if (!written) {
      parser.cancel()
      pool.releaseEntry(cardId)
      managedChild.setActiveChild(null)
      const message = formatProviderUnexpectedCompletion(language, currentRequest.provider)
      sink.onError(message, undefined, classifyProviderStreamErrorRecovery(currentRequest, message))
      return false
    }

    parser.armWatchdog()
    return true
  }

  const started = await startAttempt(true)
  return started ? managedChild.handle : null
}

// Builds the per-turn attachment for an unsolicited keepalive turn: the CLI
// woke itself between turns (background task finished → agent re-invoked), so
// there is no originating ChatRequest. Recovery classification only needs the
// session id and provider, which the pool entry carries.
export const createClaudeUnsolicitedTurnAttachment = (options: {
  entry: ClaudeSessionPoolEntryView
  sink: StreamSink
  killChild: () => void
  onSettled: () => void
}): ClaudeTurnAttachment => {
  const language = normalizeLanguage(
    typeof options.entry.meta.language === 'string'
      ? (options.entry.meta.language as AppLanguage)
      : undefined,
  )

  const pseudoRequest: ChatRequest = {
    provider: 'claude',
    workspacePath:
      typeof options.entry.meta.workspacePath === 'string' && options.entry.meta.workspacePath
        ? options.entry.meta.workspacePath
        : '.',
    model: typeof options.entry.meta.model === 'string' ? options.entry.meta.model : '',
    reasoningEffort: 'max',
    thinkingEnabled: true,
    planMode: false,
    sessionId: options.entry.sessionId ?? undefined,
    language,
    systemPrompt: '',
    modelPromptRules: [],
    crossProviderSkillReuseEnabled: true,
    prompt: '',
    attachments: [],
  }

  const parser = createClaudeTurnParser({
    request: pseudoRequest,
    sink: options.sink,
    language,
    killChild: options.killChild,
    onSettled: options.onSettled,
  })

  parser.armWatchdog()

  return {
    onLine: parser.handleLine,
    onStderrLine: parser.handleStderrLine,
    onProcessClosed: (code) => {
      if (!parser.settled()) {
        parser.handleProcessClosed(code)
      }
    },
  }
}

export type RunningCliProcess = ChildProcess

export const buildCodexAppServerArgs = (runtimeArgs: string[] = []) => [
  ...runtimeArgs,
  // `stdio://` is already the Codex app-server default transport. Avoid passing
  // `--listen stdio://` so older local CLI builds that do not recognize the flag
  // can still launch successfully.
  'app-server',
]

const getCodexPrompt = (request: ChatRequest, attachmentPaths: string[]) => {
  const prompt = request.prompt.trim()

  if (prompt) {
    return prompt
  }

  return attachmentPaths.length > 1
    ? 'Please inspect the attached images.'
    : 'Please inspect the attached image.'
}

export const buildCodexArgs = (request: ChatRequest, attachmentPaths: string[]) => {
  const args = request.sessionId
    ? ['exec', 'resume', '--json', '--skip-git-repo-check']
    : ['exec', '--json', '--skip-git-repo-check']
  const reasoningEffort = normalizeReasoningEffort('codex', request.reasoningEffort)
  const systemPrompt = [
    buildProviderSystemPrompt(request.language, getRequestBaseSystemPrompt(request)),
    getCodexAskUserQuestionInstruction(request.language),
    getCodexWindowsShellSafetyInstruction(),
  ].join(' ')

  if (request.model) {
    args.push('--model', request.model)
  }

  for (const attachmentPath of attachmentPaths) {
    args.push('--image', attachmentPath)
  }

  args.push('--ask-for-approval', 'never')
  args.push('--sandbox', getCodexSandboxMode(request))
  args.push('-c', `model_reasoning_effort="${request.thinkingEnabled === false ? 'none' : reasoningEffort}"`)
  args.push('-c', `instructions=${formatTomlString(systemPrompt)}`)

  if (request.sessionId) {
    args.push(request.sessionId)
  }

  const prompt = getCodexPrompt(request, attachmentPaths)
  if (!request.sessionId || prompt.trim().length > 0 || attachmentPaths.length > 0) {
    args.push(prompt)
  }
  return args
}

const getClaudePrompt = (request: ChatRequest, attachmentPaths: string[]) => {
  const prompt = request.prompt.trim()

  if (attachmentPaths.length === 0) {
    if (prompt) {
      return prompt
    }
    // When resuming a session with no new input, Claude's CLI errors out with
    // "No deferred tool marker found in the resumed session" unless we give it
    // something to continue with. Emit a neutral fallback so auto-resume feels
    // seamless instead of surfacing that error to the user.
    return request.sessionId ? 'Please continue.' : ''
  }

  const imagePrefix =
    attachmentPaths.length > 1 ? 'Analyze these images:' : 'Analyze this image:'
  const imageRefs = attachmentPaths.join('\n')

  return prompt
    ? `${imagePrefix}\n${imageRefs}\n\n${prompt}`
    : `${imagePrefix}\n${imageRefs}`
}

const resolveConfiguredPath = (value: string | undefined) => {
  const normalized = value?.trim()
  return normalized ? resolvePath(normalized) : null
}

const dedupeResolvedPaths = (paths: string[]) => {
  const seen = new Set<string>()

  return paths.filter((candidate) => {
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

const resolveClaudeAdditionalDirectories = (options?: {
  env?: NodeJS.ProcessEnv
  homeDir?: string | null
  attachmentPaths?: string[]
  crossProviderSkillReuseEnabled?: boolean
}) => {
  const attachmentDirectories = dedupeResolvedPaths(
    (options?.attachmentPaths ?? [])
      .filter((attachmentPath) => attachmentPath.trim().length > 0)
      .map((attachmentPath) => resolvePath(dirname(attachmentPath))),
  )

  if (typeof options?.homeDir === 'string' && options.homeDir.trim().length > 0) {
    return dedupeResolvedPaths([
      resolvePath(options.homeDir, '.claude'),
      ...(options.crossProviderSkillReuseEnabled === false
        ? []
        : [resolvePath(options.homeDir, '.codex')]),
      ...attachmentDirectories,
    ])
  }

  const env = options?.env ?? process.env
  const homeCandidates = [
    resolveConfiguredPath(env.HOME),
    resolveConfiguredPath(env.USERPROFILE),
    resolveConfiguredPath(
      env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined,
    ),
    resolveConfiguredPath(os.homedir()),
  ].filter((candidate): candidate is string => Boolean(candidate))
  const codexConfigHome = resolveConfiguredPath(env.CODEX_HOME)

  return dedupeResolvedPaths([
    ...homeCandidates.map((homeDir) => resolvePath(homeDir, '.claude')),
    ...(options?.crossProviderSkillReuseEnabled === false
      ? []
      : [
          ...homeCandidates.map((homeDir) => resolvePath(homeDir, '.codex')),
          ...(codexConfigHome ? [codexConfigHome] : []),
        ]),
    ...attachmentDirectories,
  ])
}

export const buildClaudeArgs = (
  request: ChatRequest,
  attachmentPaths: string[] = [],
  options?: {
    includeEffort?: boolean
    env?: NodeJS.ProcessEnv
    homeDir?: string | null
    // Keepalive mode: keep the CLI alive between turns and feed user messages
    // over stdin (`--input-format stream-json`) instead of a one-shot argv
    // prompt, so background tasks survive the turn and can wake the agent.
    streamingInput?: boolean
  },
) => {
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages']
  if (options?.streamingInput) {
    args.push('--input-format', 'stream-json')
  }
  const thinkingDisabled = request.thinkingEnabled === false
  // `--effort` only accepts low/medium/high/xhigh/max (plus none to disable
  // thinking). The model-aware exit point keeps Fable 5 clear of `none` —
  // thinking cannot be turned off there — and maps ultracode to xhigh.
  const effortFlagValue = toClaudeEffortFlagValue(
    request.model,
    request.reasoningEffort,
    thinkingDisabled,
  )
  const ultracodeActive = !thinkingDisabled && isUltracodeEffort(request.reasoningEffort)
  const permissionMode = request.planMode ? 'plan' : 'bypassPermissions'
  const additionalDirectories = resolveClaudeAdditionalDirectories({
    ...options,
    attachmentPaths,
    crossProviderSkillReuseEnabled: request.crossProviderSkillReuseEnabled,
  })
  const systemPrompt = [
    buildProviderSystemPrompt(request.language, getRequestBaseSystemPrompt(request)),
    getClaudeAskUserQuestionInstruction(request.language),
  ].join(' ')

  args.push('--permission-mode', permissionMode)
  if (additionalDirectories.length > 0) {
    args.push('--add-dir', ...additionalDirectories)
  }
  args.push(
    '--settings',
    JSON.stringify({
      ...(permissionMode === 'bypassPermissions'
        ? {
            skipDangerousModePermissionPrompt: true,
          }
        : {}),
      // Official ultracode channel (Claude Code v2.1.157+): a session-level
      // settings key that sends xhigh plus dynamic-workflow orchestration.
      // Older CLIs treat unknown settings keys as a warning, degrading to
      // plain xhigh.
      ...(ultracodeActive ? { ultracode: true } : {}),
      permissions: {
        defaultMode: permissionMode,
        ...(additionalDirectories.length > 0
          ? {
              additionalDirectories,
            }
          : {}),
      },
    }),
  )

  if (request.sessionId) {
    args.unshift(request.sessionId)
    args.unshift('-r')
  }

  if (request.model) {
    args.push('--model', request.model)
  }

  if (options?.includeEffort !== false) {
    args.push('--effort', effortFlagValue)
  }
  args.push('--append-system-prompt', systemPrompt)

  const prompt = getClaudePrompt(request, attachmentPaths)
  if (!options?.streamingInput && prompt.length > 0) {
    args.push(prompt)
  }
  return args
}
