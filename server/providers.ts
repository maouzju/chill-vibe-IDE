import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import os from 'node:os'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path'
import readline from 'node:readline'
import type { Readable } from 'node:stream'

import {
  defaultAppLanguage,
  getProviderLabel,
  normalizeLanguage,
} from '../shared/i18n.js'
import { getActiveProviderProfile } from '../shared/default-state.js'
import { parseLocalModelToken } from '../shared/models.js'
import { isLoopbackHostname } from './automation-board-bridge.js'
import { resolveOllamaBaseUrl } from './ollama-manager.js'
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
  LocalModelEntry,
  Provider,
  ProviderStatus,
  ProviderTurnStopReason,
  ProviderTurnUsage,
  SlashCommand,
  SlashCommandRequest,
  StreamActivity,
  StreamErrorEvent,
  StreamErrorHint,
  StreamCompletion,
} from '../shared/schema.js'
import { resolveImageAttachmentPath } from './attachments.js'
import {
  createClaudeAskUserDeltaStripper,
  createClaudeStructuredOutputParser,
  isClaudeBackgroundAwaitTool,
} from './claude-structured-output.js'
import {
  mapClaudeTurnStopReason,
  readClaudeTurnUsage,
} from './provider-turn-telemetry.js'
import { buildCodexInboundRequestRejection } from './codex-inbound-request.js'
import {
  findUnsupportedClaudeFlags,
  getClaudeSupportedFlags,
} from './claude-capabilities.js'
import { createCodexCompactionActivityDeduper } from './codex-compaction-dedupe.js'
import { createCodexAgentStatusTracker } from './codex-agent-status.js'
import { createClaudeAgentStatusTracker } from './claude-agent-status.js'
import { writeServerLog } from './crash-logger.js'
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
import { getCodexNativeTurnCompletion } from './native-turn-completion.js'
import { resolveProviderCommandLaunch } from './provider-command-launch.js'
import {
  discoverProviderSkills,
  getReusableSkillProviders,
  prepareProviderSkillReuse,
} from './provider-skills.js'
import { createAsyncTtlCache } from './provider-slash-command-cache.js'
import { loadStateForRenderer } from './state-store.js'
import { proxyStats, type ProxyStatsEvent } from './proxy-stats-store.js'
import type { ResilientProxyRuntimeConfig } from './resilient-proxy.js'
import { resilientProxyPool } from './resilient-proxy.js'
import { createArchiveRecallRuntimeOverrides, getCodexArchiveRecallInstruction } from './archive-recall.js'
import { createWorkspaceAdminRuntime } from './automation-board-session.js'
import type { WorkspaceAdminClaudeMcpConfig } from './automation-board-runtime.js'
import {
  ensureCodexSafetyHookTrusted,
  prepareCodexSafetyRuntime,
  prepareDestructiveCommandGuardRuntime,
} from './codex-safety.js'
import {
  ClaudeSessionPool,
  type ClaudeSessionPoolEntryView,
  type ClaudeTurnAttachment,
} from './claude-session-pool.js'
import {
  buildClaudeCompletionBoundaryHookCommand,
  clearClaudeCompletionBoundarySnapshot,
  getClaudeCompletionBoundaryPath,
  readClaudeCompletionBoundary,
  type ClaudeCompletionBoundary,
  type ClaudeCompletionBoundaryHook,
} from './claude-completion-boundary.js'

// Claude 路的"能力协商"补丁：Codex 有 initialize + configRequirements/read 可以
// 逐级降级，Claude 侧我们从来没问过它认识什么参数，于是拼错或对面删掉的 flag 会被
// **静默忽略**——用户改了设置没有任何效果，界面上一个字都看不到（pitfall #289）。
//
// 刻意只诊断不改行为：解析 --help 是启发式的，误判会丢掉合法参数，代价大于收益。
// 全程 fire-and-forget：spawn 在这台机器上最坏单次阻塞 6.9s（pitfall #271），
// 探测结果与命令解析都做进程级缓存，绝不能让真实回合等它。
let claudeCapabilityCommand: Promise<string | null | undefined> | null = null

const reportUnsupportedClaudeFlags = (args: readonly string[], env: NodeJS.ProcessEnv) => {
  void (async () => {
    try {
      claudeCapabilityCommand ??= resolveCommand('claude')
      const command = await claudeCapabilityCommand
      if (!command) {
        return
      }

      const supported = await getClaudeSupportedFlags(command, env)
      const unsupported = findUnsupportedClaudeFlags(args, supported)
      if (unsupported.length === 0) {
        return
      }

      void writeServerLog('WARN', '[claude-capabilities] local CLI does not recognize these flags.', {
        unsupported,
        command,
      })
    } catch {
      // fail-open：探测本身出问题绝不能影响回合。
    }
  })()
}

type StreamSink = {
  onSession: (sessionId: string) => void
  onDelta: (content: string, itemId?: string) => void
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
  onDone: (payload?: {
    completion?: StreamCompletion
    turnStopReason?: ProviderTurnStopReason
    usage?: ProviderTurnUsage
  }) => void
  onError: (
    message: string,
    hint?: StreamErrorHint,
    recovery?: Pick<StreamErrorEvent, 'recoverable' | 'recoveryMode' | 'transientOnly'>,
  ) => void
}

export type ProviderRuntime = {
  args: string[]
  env: NodeJS.ProcessEnv
  // 症状：配好本地模型/自定义端点后 CLI 起得来、init 也发了，却从不向该端点发请求
  //   （本地模型 120s 超时；云端中转拿着 A 站 key 打 B 站 → 401 authentication_failed）。
  // 根因（2026-08-29 透明代理实测）：`~/.claude/settings.json` 的 `env` 优先级高于
  //   进程环境变量，spawn 时注入的 ANTHROPIC_* 被用户级配置整个盖掉；代理侧观测到
  //   注入 baseUrl 的那次收到 0 个请求。
  // 为什么单靠上面的 `env` 字段不够：它只作用于进程环境这一层，赢不了 settings.json。
  //   必须把同一份注入再送进 `--settings`（flagSettings 深合并层，优先级最高）才压得住。
  //   未注入时此字段保持 undefined —— 写空对象会在合并层把用户自己配的端点擦掉。
  claudeSettingsEnv?: Record<string, string>
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
const claudeSlashCommandCacheTtlMs = 5 * 60_000
const claudeSlashCommandCache = createAsyncTtlCache<SlashCommand[]>({
  ttlMs: claudeSlashCommandCacheTtlMs,
})
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
    ? 'In this Chill Vibe Codex exec environment, the native request_user_input tool is unavailable. When you must ask the user to choose before you can continue safely, do not call request_user_input and do not ask a plain-text multiple-choice question. Reply with only one complete XML block and no extra text. For one question, use this single-question shape: <ask-user-question>{"header":"Short title","question":"One concise question","multiSelect":false,"options":[{"label":"Option A","description":"Short tradeoff"},{"label":"Option B","description":"Short tradeoff"}]}</ask-user-question>. When multiple questions can be answered together, use this grouped shape: <ask-user-question>{"questions":[{"header":"First title","question":"First concise question","multiSelect":false,"options":[{"label":"Option A","description":"Short tradeoff"},{"label":"Option B","description":"Short tradeoff"}]},{"header":"Second title","question":"Second concise question","multiSelect":false,"options":[{"label":"Option A","description":"Short tradeoff"},{"label":"Option B","description":"Short tradeoff"}]}]}</ask-user-question>. The question group has no count limit. Use 2-3 options per question, keep labels short, omit any Other option, keep multiSelect false, and wait for the next user reply after emitting the block.'
    : '在这个 Chill Vibe 的 Codex exec 运行环境里，原生 request_user_input 工具不可用。当你必须在继续之前让用户做选择时，不要调用 request_user_input，也不要用普通文本写多选题。只输出一个完整的 XML 块，不要添加任何其他文本。只有一个问题时，使用这个单题格式：<ask-user-question>{"header":"简短标题","question":"一句简洁问题","multiSelect":false,"options":[{"label":"选项 A","description":"简短权衡"},{"label":"选项 B","description":"简短权衡"}]}</ask-user-question>。有多个问题可以一起回答时，使用这个题组格式：<ask-user-question>{"questions":[{"header":"第一题标题","question":"第一句简洁问题","multiSelect":false,"options":[{"label":"选项 A","description":"简短权衡"},{"label":"选项 B","description":"简短权衡"}]},{"header":"第二题标题","question":"第二句简洁问题","multiSelect":false,"options":[{"label":"选项 A","description":"简短权衡"},{"label":"选项 B","description":"简短权衡"}]}]}</ask-user-question>。题组数量不设上限；每题保持 2-3 个选项，label 要简短，不要自己添加 Other，multiSelect 保持 false，并在输出这个块后等待用户下一条回复。'

// 症状：agent 用 `Get-Content` 读仓库里任何含中文的 UTF-8 文件（AGENTS.md、
// SKILL.md、docs/），终端输出整片变成生僻汉字，agent 会误判文件损坏。
// 根因：2026-07-26 实测 Windows PowerShell 5.1（用户机 5.1.26100）的 Get-Content
// 对无 BOM 文件按 [Encoding]::Default 解码，中文系统上是 gb2312/GBK —— 与
// `chcp 65001` 无关（实测 chcp 已是 65001 仍乱码），改 [Console]::OutputEncoding
// 也无效，因为坏在读取端而不是输出端。
// 被否决的替代方案：(a) 在 spawn 时注入 env —— Get-Content 的默认编码不读任何
// 环境变量；(b) 改用 pwsh 7（默认 UTF-8）—— 用户机未安装，且 CLI 挑哪个 shell
// 不归 Chill Vibe 管；(c) 改用户的 PowerShell profile —— 污染用户全局环境。
// provider CLI 自己 spawn PowerShell，Chill Vibe 只能从系统提示这一侧修。
const getWindowsShellSafetyInstruction = () =>
  'Windows shell safety: shell commands run in PowerShell. If a command argument contains double quotes (for example ripgrep patterns that search JSON such as name": "value), wrap that argument in single quotes or use a here-string/script file. Do not put unescaped embedded double quotes inside a double-quoted PowerShell argument; it causes ParserError: TerminatorExpectedAtEndOfString. Prefer rg --fixed-strings for literal JSON/key searches. Windows file reading: this host runs Windows PowerShell 5.1, where Get-Content decodes BOM-less files with the system ANSI code page (GBK on a Chinese Windows), so shell-reading a UTF-8 file silently mojibakes every non-ASCII character. Prefer your native file-read tool over the shell. When you must use the shell, pass -Encoding UTF8 to Get-Content, or use [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false)). If shell output comes back as dense unfamiliar CJK characters where readable text was expected, that is this decoding bug: re-read the file as UTF-8 instead of reporting the file as corrupted or empty.'

const getClaudeAskUserQuestionInstruction = (language: AppLanguage) =>
  normalizeLanguage(language) === 'en'
    ? 'In this Chill Vibe Claude runtime, ask-user-question is only a renderer convention for asking the user to choose. Do not use it for normal replies unless you truly need a user decision before continuing. Every real action (running commands, reading files, editing files, searching, etc.) must go through native tool calls. Do not write tool calls as text, XML, JSON, markdown, or the word call.'
    : '在这个 Chill Vibe 的 Claude 运行环境里，ask-user-question 只是一种向用户提问并让用户选择的渲染约定。除非继续前确实需要用户做决定，否则不要在普通回复里使用它。所有实际操作（运行命令、读取文件、编辑文件、搜索等）都必须走原生工具调用。不要把工具调用写成文本、XML、JSON、Markdown，也不要输出单独的 call。'

// 手填的本机端点（用户不建本地模型条目，直接在「接口配置」里填 127.0.0.1）同样是本地推理。
// URL 解析失败时返回 false —— 认不出来就按远端处理，保留代理，不去猜。
const isLoopbackBaseUrl = (baseUrl: string) => {
  try {
    // URL.hostname keeps brackets around IPv6 literals (e.g. "[::1]").
    // Normalize them before the shared loopback check so local IPv6 endpoints
    // do not get routed through the resilient proxy.
    return isLoopbackHostname(new URL(baseUrl).hostname.replace(/^\[|\]$/g, ''))
  } catch {
    return false
  }
}

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

// 症状：2026-08-14 用户与两名同事都卡在「codex 用不了」，卡片里只有一行原样 JSON
//       `{"error":{"message":"unknown provider for model gpt-5.6-sol",...}}`，无引导、不可恢复。
// 根因：这类错误来自中转站/API 服务商（new-api 前端 + CLIProxyAPI 上游），意思是「这个模型名
//       在我这找不到能承接的渠道」。我们既没解析 JSON，classifyLaunchErrorHint 也匹配不到
//       （里面没有 api key / 401 / unauthorized 任一关键词），于是 hint=undefined，纯死胡同。
// 为什么不能只做 JSON 解析：解出来的 `unknown provider for model X` 对用户依然是天书，
//       真正缺的是「去哪改」——所以指引必须点名模型名和设置路径。
const upstreamModelUnavailablePatterns = [
  /unknown provider for model/i,
  /model[_\s]not[_\s]found/i,
  /no available channel/i,
  /无可用渠道/,
  /does not exist or you do not have access/i,
]

const parseUpstreamErrorBody = (raw: string): unknown => {
  const trimmed = raw.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) {
    return null
  }

  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

// 上游 JSON 错误体的形状不统一：OpenAI 兼容站是 { error: { message } }，有些直接 { message }，
// 少数把 error 本身写成字符串。三种都认，认不出就返回 null 让原文照旧透传。
const extractUpstreamErrorMessage = (raw: string): string | null => {
  const parsed = parseUpstreamErrorBody(raw)
  if (!isRecord(parsed)) {
    return null
  }

  const errorField = parsed.error
  if (typeof errorField === 'string' && errorField.trim()) {
    return errorField.trim()
  }

  if (isRecord(errorField)) {
    const nested = readString(errorField, 'message')
    if (nested?.trim()) {
      return nested.trim()
    }
  }

  const topLevel = readString(parsed, 'message')
  return topLevel?.trim() || null
}

// 只在能明确指认时才点名模型，猜错一个名字比不猜更误导。
const extractUnavailableModelName = (message: string): string | null => {
  const forModel = /(?:unknown provider for model|for model|模型)\s+["'`]?([\w.:\-/]+)["'`]?/i.exec(message)
  if (forModel?.[1]) {
    return forModel[1]
  }

  const quoted = /["'`]([\w.:\-/]{3,})["'`]/.exec(message)
  return quoted?.[1] ?? null
}

const formatUpstreamModelUnavailable = (
  language: AppLanguage,
  modelName: string | null,
  rawMessage: string,
) => {
  // 「换个模型名」只解决一半。2026-08-14 实测：同一个中转站、同一个模型名，一个 key 通、
  // 另一个 key 对 gpt-5.6/5.5/5.4 **全部**报 `No available channel ... under group X`——
  // 决定可用性的是 key 所在的分组，不是服务商也不是模型名。所以指引必须给出第二步，
  // 否则用户会把时间全花在换模型上。原始错误一定要原样附上：里面的 group 名和 request id
  // 是找站方时唯一能用的凭据。
  if (language === 'en') {
    const subject = modelName ? `the model "${modelName}"` : 'the requested model'
    return `Your API provider has no channel for ${subject}. This comes from the provider, not the local CLI. First, open Settings and set the Codex model to a name your provider actually serves. If every model name fails the same way, the problem is the API key's group rather than the model — ask your provider, quoting the request id below. Original error: ${rawMessage}`
  }

  const subject = modelName ? `「${modelName}」` : '当前请求的模型'
  return `服务商没有${subject}的可用渠道。这条错误来自 API 服务商，不是本机 CLI 的问题。先到 设置 → 模型 把 Codex 模型改成服务商实际提供的名称；如果换任何模型名都是同样报错，那说明问题在这个 API key 所属的分组上，不在模型名——把下面这条原始错误里的 request id 发给服务商处理。原始错误：${rawMessage}`
}

// 症状：模型名在上游没有渠道时，用户看到的错误是一句「Reconnecting... 1/5」，回合当场判死。
// 根因：codex app-server 对 5xx 会自动重连 5 次，每次发一条 `error` 通知，其中
//       `willRetry: true`、`message` 只是重连计数、**真正的原因只在 `additionalDetails`**；
//       重试耗尽后才发 `willRetry: false` 的终态（那条的 message 才是真因）。旧实现既没看
//       willRetry 就 finishWithError，也从没读过 additionalDetails——「判死得太早」和
//       「唯一有用的文本被丢掉」同时发生。2026-08-14 用 scripts/probe-codex-app-server.mjs
//       对着真实上游抓到全过程：5 次重连横跨 61 秒，之后才是真错误。
// 为什么不能把重试通知也当错误显示：它每十几秒来一条，且回合仍然活着，显示成错误既刷屏又骗人。
export const readCodexErrorNotification = (
  params: unknown,
): { message: string; willRetry: boolean } | null => {
  if (!isRecord(params)) {
    return null
  }

  const errorRecord = readRecord(params, 'error')
  const detail = errorRecord ? readString(errorRecord, 'additionalDetails')?.trim() : undefined
  const message =
    detail ||
    (errorRecord ? readString(errorRecord, 'message')?.trim() : undefined) ||
    readString(params, 'message')?.trim() ||
    'Codex run failed.'

  return { message, willRetry: params.willRetry === true }
}

// 症状：2026-08-16 排查「两个人同一个服务商、同一个 key、同一个模型，一个能用一个不能用」，
//   绕了三轮才想到去比对 base_url——因为报错里从来不说这次请求发往哪里。
// 根因：生效的 base_url 有两个互不可见的来源——应用内「接口配置」（cliRoutingEnabled 打开时
//   注入 OPENAI_BASE_URL，覆盖一切）与 `~/.codex/config.toml`。用户看不出自己走的是哪条，
//   两台机器对比时只能靠猜。
// 为什么不只打日志：这条信息只在失败那一刻有用，且必须和错误正文在一起——它是判断
//   「同样的配置为什么结果不同」的第一个分叉点。
const formatCodexRequestEndpoint = (language: AppLanguage, env: NodeJS.ProcessEnv) => {
  const overridden = env.OPENAI_BASE_URL?.trim()

  if (overridden) {
    return language === 'en'
      ? `Request endpoint: ${overridden} (from the app's API configuration).`
      : `本次请求发往：${overridden}（来自应用内「接口配置」）。`
  }

  return language === 'en'
    ? "Request endpoint: whatever ~/.codex/config.toml resolves to (the app's API configuration is off)."
    : '本次请求发往 ~/.codex/config.toml 里配置的地址（应用内「接口配置」未启用）。'
}

export const describeCodexUpstreamFailure = (
  raw: string,
  language: AppLanguage,
  env?: NodeJS.ProcessEnv,
): { message: string; hint: StreamErrorHint | undefined } => {
  const unwrapped = extractUpstreamErrorMessage(raw) ?? raw

  if (upstreamModelUnavailablePatterns.some((pattern) => pattern.test(unwrapped))) {
    const guidance = formatUpstreamModelUnavailable(
      language,
      extractUnavailableModelName(unwrapped),
      unwrapped,
    )

    return {
      message: env ? `${guidance}\n${formatCodexRequestEndpoint(language, env)}` : guidance,
      hint: 'switch-config',
    }
  }

  return { message: unwrapped, hint: classifyLaunchErrorHint(unwrapped) }
}

export const resolveProviderRuntime = async (
  provider: Provider,
  options: { localModelId?: string } = {},
): Promise<ProviderRuntime> => {
  const baseEnv =
    provider === 'claude' ? await resolveClaudeRuntimeEnvironment({ env: process.env }) : process.env

  try {
    // Provider launch can race the renderer's first runtime-settings sync. Use
    // the lightweight startup reader in that narrow fallback; the full loader
    // hydrates every session-history sidecar (974MB / 8,863 files observed on
    // 2026-08-06) and can turn a harmless status check into a main-process OOM.
    const settings = providerRuntimeSettingsOverride ?? (await loadStateForRenderer()).state.settings

    // 本地模型条目走自己的端点，绕开全局 active profile —— 这是「这张卡用本地、那张卡用
    // 云端」能成立的唯一原因（SPEC local-model-entries 需求 #4）。条目查不到时**不能**
    // 回落到 active profile：那等于拿用户的云端 key 去跑他以为在本地跑的东西。
    const localEntry = options.localModelId
      ? settings.localModelEntries.find((entry) => entry.id === options.localModelId)
      : undefined

    if (options.localModelId && !localEntry) {
      return {
        args: [],
        env: baseEnv,
      }
    }

    // 症状：加好本地模型后弹一条「CLI 路由当前是关闭的，本地模型同样不会生效」，用户被迫
    //   为了跑本机模型去开一个跟它无关的全局开关。
    // 根因：这个早退原本排在本地条目解析**之前**，顺手把本地模型一起短路了。但两者管的不是
    //   一回事——cliRoutingEnabled 决定"要不要拿应用内接口配置去覆盖 CLI 自带的全局配置"，
    //   而选中一个本地模型条目本身就是逐卡的显式指定，意图已经表达完了。
    // 为什么不能干脆把早退删掉：非本地模型必须保持"路由关了就完全不注入"，否则会拿应用内的
    //   云端 key 覆盖用户 ~/.codex/config.toml、~/.claude 里自己配的东西。所以是加 localEntry
    //   例外，不是移除判断。
    if (!localEntry && !settings.cliRoutingEnabled) {
      return {
        args: [],
        env: baseEnv,
      }
    }

    // 归一成同一形状，下游 name/apiKey/baseUrl 三个字段就不必再关心来源是条目还是 profile。
    // 本地条目只要求用户填「驱动方式」和「模型名」，地址与密钥留空时在这里补齐：
    // · 地址回落到本机 Ollama（resolveOllamaBaseUrl 认 CHILL_VIBE_OLLAMA_URL 覆盖），且
    //   codex 必须带 /v1 而 claude 填到主机根 —— 这个差异不该由用户去记，填错的表现是
    //   `404 page not found, url: .../responses`，光看报错根本看不出是少了 /v1。
    // · 密钥回落到占位串：本地服务不校验它，但下面 `if (!apiKey)` 会把整段注入短路掉，
    //   于是"留空"会变成"地址静默失效"，是本功能最容易踩的坑。
    const activeProfile = localEntry
      ? {
          name: localEntry.label || localEntry.model,
          apiKey: localEntry.apiKey.trim() || localModelFallbackApiKey,
          baseUrl: normalizeLocalModelBaseUrl(
            localEntry.harness,
            localEntry.baseUrl.trim() || resolveLocalModelDefaultBaseUrl(localEntry.harness),
          ),
        }
      : getActiveProviderProfile(settings, provider)
    const apiKey = activeProfile?.apiKey.trim()

    if (!apiKey) {
      return {
        args: [],
        env: baseEnv,
      }
    }

    const baseUrl = activeProfile?.baseUrl.trim() || defaultProviderBaseUrls[provider]

    // 症状：本地模型卡片发一条消息后机箱满载轰鸣几十分钟，界面早已关闭仍在烧 GPU。
    // 根因（2026-08-29 实测坐实）：断线续传代理默认开启（首字节 90s / 最多重试 6 次），
    //   而本机 27B 模型啃 4 万 token 的 prompt 远超 90 秒。首字节超时后代理换条连接重试，
    //   Ollama 收不到取消信号仍在算 —— 6 次重试堆出 6 个算不完的僵尸任务，实测 27 条并发
    //   连接、单请求恒定 5m5s 后 500、GPU 400W 空转两小时。堆积在推理侧，关界面停不掉。
    // 被否决的替代方案：把首字节超时调到上限 600s —— 治标，且重试对本地推理本就无意义：
    //   云端超时多半是网络抖动，重发有用；本地超时只是"还没算完"，重发只会让同一个模型
    //   从头再算一遍，越重试越慢。云端 profile 必须保留代理，那才是它存在的理由。
    // 为什么两个条件都要：localEntry 覆盖局域网上的本地推理（192.168 的 LM Studio 不是
    //   loopback 但同样是本地模型）；isLoopbackBaseUrl 覆盖用户不建条目、直接手填本机
    //   端点的那条路径。只判其一都会漏。
    const useResilientProxy =
      Boolean(settings.resilientProxyEnabled) && !localEntry && !isLoopbackBaseUrl(baseUrl)
    const runtimeBaseUrl = await maybeResolveProxyBaseUrl(
      provider,
      baseUrl,
      useResilientProxy,
      {
        firstByteTimeoutMs: settings.resilientProxyFirstByteTimeoutSec * 1000,
        stallTimeoutMs: settings.resilientProxyStallTimeoutSec * 1000,
        maxRecoveryRetries: settings.resilientProxyMaxRetries,
      },
    )

    if (provider === 'claude') {
      // 三个键必须整组覆盖：用户 settings.json 里常驻的通常是 ANTHROPIC_AUTH_TOKEN，
      // 只压 API_KEY 会让 CLI 拿着用户的云端 token 去打我们指定的端点。
      const claudeSettingsEnv = {
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_BASE_URL: runtimeBaseUrl,
      }

      return {
        args: [],
        env: {
          ...baseEnv,
          ...claudeSettingsEnv,
        },
        claudeSettingsEnv,
      }
    }

    // 不要在这里加 `wire_api = "chat"` 来迁就只支持 chat/completions 的本地推理服务。
    // 2026-08-23 实测（codex CLI 当日版本）：该值已被移除，启动直接死在配置解析上——
    // "`wire_api = \"chat\"` is no longer supported. How to fix: set `wire_api = \"responses\"`"。
    // 结论：Codex harness 只能连实现了 Responses API 的端点，Ollama 那类纯 chat/completions
    // 服务请改用 Claude harness（它们多半也提供 Anthropic 兼容的 /v1/messages）。
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

// 本地服务通常不校验密钥，但空 apiKey 会让 resolveProviderRuntime 整段短路（baseUrl 静默
// 失效），所以留空时补一个占位串而不是真的传空。
const localModelFallbackApiKey = 'local'

// Codex CLI 的默认 base_url 就带 /v1（https://api.openai.com/v1），它在此之后直接拼
// `/responses`；Claude CLI 则自己补 `/v1/messages`，只需要主机根。
export const resolveLocalModelDefaultBaseUrl = (harness: Provider) => {
  const base = resolveOllamaBaseUrl()
  return harness === 'codex' ? `${base}/v1` : base
}

// 症状：把条目的 harness 切到 codex 后，卡片一发消息就 `404 page not found, url: /responses`。
// 根因：上面那个补 /v1 的回落只在 baseUrl **留空**时才走到。用户手填 `http://127.0.0.1:11434`
//   （Ollama 官方文档里到处都是这个不带 /v1 的地址），或者先按 claude 填好主机根、之后再改
//   harness，都会掉进「填了、但缺 /v1」这道夹缝。端点形状是 CLI 协议的硬要求，不是用户该记的事。
// 被否决的替代方案：在 UI 切 harness 时顺手改写用户填的地址 —— 那是在用户眼皮底下动他的输入框，
//   而且绕不开手填这条路径。兜在拼 env 的地方才是唯一的收口。
// 必须幂等：已经带 /v1 的地址不能被补成 /v1/v1。claude 则相反 —— CLI 自己补 `/v1/messages`，
//   替它加 /v1 会打成 `/v1/v1/messages`，所以这个规则严格按 harness 分岔。
export const normalizeLocalModelBaseUrl = (harness: Provider, baseUrl: string) => {
  const trimmed = baseUrl.trim().replace(/\/+$/g, '')
  if (harness !== 'codex' || !trimmed) {
    return trimmed
  }
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`
}

// 令牌 → 条目。翻译只在 launchProviderRun 入口做一次，之后 request.model 就是真实模型名，
// buildClaudeArgs / buildCodexArgs / 流解析器全都不需要知道本地条目的存在。
export const resolveLocalModelEntry = async (
  model?: string | null,
): Promise<LocalModelEntry | null> => {
  const localModelId = parseLocalModelToken(model)
  if (!localModelId) {
    return null
  }

  try {
    const settings = providerRuntimeSettingsOverride ?? (await loadStateForRenderer()).state.settings
    return settings.localModelEntries.find((entry) => entry.id === localModelId) ?? null
  } catch {
    return null
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

const providerDiagnosticsMaxLineLength = 240

// 上游把整个错误体压成一行 JSON 是常态，而它经常超过 240 字符。旧实现对超长行一律整行丢弃，
// 于是「唯一说明了原因的那一行」被静默吞掉，用户只剩一句「Codex 退出，状态码：1」
// （2026-08-14 实测的 `unknown provider for model` 就是这么消失的）。
// 为什么不干脆放宽长度上限：长度过滤挡的是堆栈与超长路径这类真噪声，放宽等于全放进来。
// 折中是只对"看起来是错误体"的行截断保留。
const looksLikeUpstreamErrorBody = (line: string) => line.startsWith('{') || line.includes('"error"')

export const summarizeProviderDiagnostics = (stderr: string) => {
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
        !line.startsWith('at '),
    )
    .flatMap((line) => {
      if (line.length < providerDiagnosticsMaxLineLength) {
        return [line]
      }

      return looksLikeUpstreamErrorBody(line)
        ? [`${line.slice(0, providerDiagnosticsMaxLineLength)}…`]
        : []
    })

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

const isCodexAppServerAgentParamsUnsupported = (message: string) => {
  const normalized = message.toLowerCase()
  const mentionsAgentParam =
    normalized.includes('personality') ||
    normalized.includes('servicetier') ||
    normalized.includes('service tier')

  return (
    mentionsAgentParam &&
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
    (
      normalized.includes('failed to read session metadata') &&
      normalized.includes('rollout') &&
      normalized.includes('is empty')
    ) ||
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

const formatCodexAgentParamsCompatibilityNotice = (language: AppLanguage) =>
  language === 'en'
    ? 'Detected an older local Codex CLI that does not support Agent personality or Fast mode. Chill Vibe retried automatically without those optional fields for this run.'
    : '检测到本地 Codex CLI 版本较旧，不支持 Agent 人格或 Fast 模式。Chill Vibe 已自动移除这些可选参数并重试本次请求。'

const formatCodexSandboxRequirementsFallbackNotice = (
  language: AppLanguage,
  sandboxMode: CodexSandboxMode,
) =>
  language === 'en'
    ? `Codex requirements denied the requested sandbox. Chill Vibe narrowed this run to ${sandboxMode} without changing your Codex settings.`
    : `Codex 管理策略不允许原沙箱。本次运行已自动收窄为 ${sandboxMode}，未修改你的 Codex 设置。`

const formatCodexStaleSessionRecoveryNotice = (language: AppLanguage) =>
  language === 'en'
    ? 'The resumed Codex session could not be loaded from its rollout file. Chill Vibe started a new session automatically so your latest prompt and attachments are not lost.'
    : '恢复的 Codex 会话文件无法加载，Chill Vibe 已自动开启一个新会话，保留你本次发送的内容和附件。'

// 支持软中断的子进程句柄。只有 Claude keepalive 路径会挂上 `interruptTurn`：
// 它背后是 CLI 的 stream-json 控制通道，能只 abort 当前 turn 而保住进程与会话。
// 其余 provider（含 Claude 的非 keepalive 回退路径）没有这个能力，停止仍走 kill。
export type InterruptibleChild = ChildProcess & { interruptTurn?: () => boolean }

// 停止一个 turn 时的路径选择：能软中断就软中断，否则如实返回 false 让调用方硬 kill。
// 抽成纯函数是为了让"绝不静默失败"这条约束可被单测钉住——软中断一旦悄悄吞掉
// 而又没真的停下来，表现就是停止按钮失灵，比退化回 kill 严重得多。
export const tryInterruptProviderTurn = (child: InterruptibleChild | null | undefined) => {
  if (typeof child?.interruptTurn !== 'function') {
    return false
  }
  try {
    return child.interruptTurn() === true
  } catch {
    return false
  }
}

const createManagedChildHandle = () => {
  let activeChild: ChildProcess | null = null
  let interruptHandler: (() => boolean) | null = null
  const handle = new EventEmitter() as ChildProcess

  ;(handle as ChildProcess & { kill: ChildProcess['kill'] }).kill = ((signal?: NodeJS.Signals | number) =>
    activeChild?.kill(signal) ?? false) as ChildProcess['kill']

  ;(handle as InterruptibleChild).interruptTurn = () => interruptHandler?.() === true

  return {
    handle,
    setActiveChild: (child: ChildProcess | null) => {
      activeChild = child
    },
    setInterruptHandler: (fn: (() => boolean) | null) => {
      interruptHandler = fn
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

// CLI 眼里的良性中止：官方 CLI 对这两个 terminal_reason 既不按 error 级别记日志，也不
// 渲染错误 UI（`hat(e) = e==="aborted_streaming" || e==="aborted_tools"`，claude 2.1.206）。
// 其余 terminal_reason（api_error / model_error / prompt_too_long / blocking_limit /
// budget_exhausted / turn_setup_failed 等）才是真失败。
const CLAUDE_BENIGN_ABORT_TERMINAL_REASONS = new Set(['aborted_streaming', 'aborted_tools'])

const formatClaudeTurnAborted = (language: AppLanguage, terminalReason: string) =>
  language === 'en'
    ? `Claude's turn was aborted (${terminalReason}).`
    : `Claude 这一轮被中止了（${terminalReason}）。`

// 症状：2026-08-14 五个会话在四分钟内接连红出「Claude 运行失败。」，主进程日志和原生
//       转录里都查不到任何原因，事后无法归因。
// 根因：claude 2.1.206 的 result 事件分两套字段——只有 subtype==='success' 时错误文本在
//       `result`，error_during_execution / error_max_turns **根本不带 result 字段**，真实
//       原因只在 `errors` 数组里（官方 CLI 自己就是 `subtype==='success' ? result :
//       errors.join('; ')`）。此处旧实现只读 `result`，把唯一线索整个丢进兜底文案。
// 为什么不能只读 `errors`：subtype==='success' 且 is_error 的分支（余额不足等）没有
//       `errors`，文本仍在 `result`，两套字段必须都读。
export const describeClaudeResultFailure = (
  event: Record<string, unknown>,
  language: AppLanguage,
): { message: string; terminalReason: string | null; benignAbort: boolean } => {
  const subtype = typeof event.subtype === 'string' ? event.subtype : null
  const terminalReason = typeof event.terminal_reason === 'string' ? event.terminal_reason : null
  const benignAbort = terminalReason !== null && CLAUDE_BENIGN_ABORT_TERMINAL_REASONS.has(terminalReason)

  if (benignAbort) {
    return { message: formatClaudeTurnAborted(language, terminalReason), terminalReason, benignAbort }
  }

  const nativeErrors = Array.isArray(event.errors)
    ? event.errors
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
    : []
  if (nativeErrors.length > 0) {
    return { message: nativeErrors.join('; '), terminalReason, benignAbort }
  }

  const resultText = typeof event.result === 'string' ? event.result.trim() : ''
  if (resultText) {
    return { message: resultText, terminalReason, benignAbort }
  }

  // 连 CLI 都没给出原因时，至少把 subtype/terminal_reason 带上，别再退回一句无信息量的话。
  const label = [subtype, terminalReason].filter(Boolean).join(' / ')
  const fallback = formatClaudeRunFailed(language)
  return {
    message: label ? `${fallback.replace(/[。.]$/u, '')}（${label}）。` : fallback,
    terminalReason,
    benignAbort,
  }
}

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
  text.replace(/(?:[ \t]*(?:\r?\n|^)[ \t]*(?:call:?|court|course|count|card|课){1,3}[ \t]*)+$/iu, '')

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

// Absolute last-resort ceiling that bounds even the intentionally-disarmed
// watchdog cases (in-progress command, uncapped background-await). It must sit
// far above any legitimate command/workflow so it only trips when the CLI has
// genuinely gone silent-dead without ever emitting a terminal event or closing
// its process — the state that otherwise spins a card in `streaming` forever.
const getLocalProviderAbsoluteHardCapMs = () =>
  getLocalProviderTimeoutMs('CHILL_VIBE_LOCAL_PROVIDER_ABSOLUTE_HARD_CAP_MS', 1_800_000)

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

const getCachedClaudeSlashCommands = (
  workspacePath: string,
  language: AppLanguage,
) => {
  const normalizedWorkspacePath = resolvePath(workspacePath.trim())
  const workspaceKey = process.platform === 'win32'
    ? normalizedWorkspacePath.toLowerCase()
    : normalizedWorkspacePath
  const cacheKey = `${workspaceKey}\u0000${language}`

  return claudeSlashCommandCache.get(
    cacheKey,
    () => discoverClaudeSlashCommands(workspacePath, language),
  )
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
    const native = buildNativeSlashCommands(
      'codex',
      ['agent', 'subagents', 'compact', 'init', 'plan'],
      normalizedLanguage,
    )
    return dedupeSlashCommands([...local, ...skills, ...native])
  }

  if (provider === 'claude') {
    const native = await getCachedClaudeSlashCommands(workspacePath, normalizedLanguage)
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
    getWindowsShellSafetyInstruction(),
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

const codexSandboxModesByAccess: CodexSandboxMode[] = [
  'danger-full-access',
  'workspace-write',
  'read-only',
]

const getCodexSandboxMode = (request: ChatRequest): CodexSandboxMode =>
  request.sandboxMode ?? (
    request.agentOutsideWorkspaceWriteEnabled === false
      ? 'workspace-write'
      : 'danger-full-access'
  )

type CodexApprovalPolicy = NonNullable<ChatRequest['approvalPolicy']>

export type CodexManagementPolicy = {
  supported: boolean
  allowedSandboxModes: CodexSandboxMode[]
  allowedApprovalPolicies: CodexApprovalPolicy[]
  effectiveSandboxMode: CodexSandboxMode
  message?: string
}

const getCodexApprovalPolicy = (request: ChatRequest): CodexApprovalPolicy =>
  request.approvalPolicy === 'on-request' ? 'on-request' : 'never'

const isCodexSandboxRequirementsConflict = (
  message: string,
  sandboxMode: CodexSandboxMode,
) => {
  const normalized = message.toLowerCase()
  return normalized.includes('requirements') &&
    normalized.includes(sandboxMode) &&
    (
      normalized.includes('do not allow') ||
      normalized.includes('does not allow') ||
      normalized.includes('not allowed') ||
      normalized.includes('not permitted') ||
      normalized.includes('denied')
    )
}

const readCodexAllowedSandboxModes = (
  result: unknown,
  approvalPolicy: CodexApprovalPolicy,
): CodexSandboxMode[] | null => {
  if (!isRecord(result) || !isRecord(result.requirements)) {
    return null
  }

  const requirements = result.requirements
  let constrained = false
  let allowed = new Set<CodexSandboxMode>(codexSandboxModesByAccess)

  if (Array.isArray(requirements.allowedApprovalPolicies)) {
    constrained = true
    const approvalAllowed = requirements.allowedApprovalPolicies.some(
      (candidate) => candidate === approvalPolicy,
    )
    if (!approvalAllowed) {
      return []
    }
  }

  if (Array.isArray(requirements.allowedSandboxModes)) {
    constrained = true
    const allowedLegacyModes = new Set(
      requirements.allowedSandboxModes.filter(
        (candidate): candidate is CodexSandboxMode =>
          typeof candidate === 'string' &&
          codexSandboxModesByAccess.includes(candidate as CodexSandboxMode),
      ),
    )
    allowed = new Set([...allowed].filter((candidate) => allowedLegacyModes.has(candidate)))
  }

  if (isRecord(requirements.allowedPermissionProfiles)) {
    constrained = true
    const profileModes = new Set<CodexSandboxMode>()
    if (requirements.allowedPermissionProfiles[':danger-full-access'] === true) {
      profileModes.add('danger-full-access')
    }
    if (requirements.allowedPermissionProfiles[':workspace'] === true) {
      profileModes.add('workspace-write')
    }
    if (requirements.allowedPermissionProfiles[':read-only'] === true) {
      profileModes.add('read-only')
    }
    allowed = new Set([...allowed].filter((candidate) => profileModes.has(candidate)))
  }

  return constrained
    ? codexSandboxModesByAccess.filter((candidate) => allowed.has(candidate))
    : null
}

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
        networkAccess: request.networkAccessEnabled === true,
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
    includeAgentParams?: boolean
  },
) => ({
  threadId,
  input: buildCodexAppServerInput(request, attachmentPaths),
  cwd: request.workspacePath,
  approvalPolicy: getCodexApprovalPolicy(request),
  sandboxPolicy: buildCodexSandboxPolicy(request),
  model: request.model || undefined,
  ...(options?.includeAgentParams === false
    ? {}
    : {
        ...(request.personality ? { personality: request.personality } : {}),
        ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
      }),
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

  let safetyRuntime
  try {
    safetyRuntime = await prepareCodexSafetyRuntime(request, runtime.args, runtime.env)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to prepare Codex safety protection.'
    sink.onError(message, 'env-setup')
    return null
  }

  const child = await spawnProvider(
    'codex',
    buildCodexAppServerArgs(safetyRuntime.args),
    request.workspacePath,
    sink,
    language,
    safetyRuntime.env,
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
  const agentStatusTracker = createCodexAgentStatusTracker({
    rootThreadId: emittedSessionId,
  })
  let currentRequest = request
  let transientPlaceholderStallTimer: ReturnType<typeof setTimeout> | undefined
  let transientPlaceholderDisconnectStatsReported = false
  let localStreamStallTimer: ReturnType<typeof setTimeout> | undefined
  let sawVisibleStreamOutput = false
  const openProviderWorkItemIds = new Set<string>()
  let hasOpenAgentWork = false

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
    if (finished) {
      return
    }

    clearLocalStreamStallTimer()
    // 症状：Codex 原生 task 已完成，但丢失终态/残留 open-work 后卡片可 streaming 数小时。
    // 根因：旧 Codex watchdog 在 command/agent 活跃时完全停表，且 command 路径没有统一硬上限。
    // 与 Claude 共用同一超时决策，让所有“有意放宽”最多只持续 absolute hard cap（Pitfall #224）。
    const timeoutMs = resolveLocalStreamStallTimeoutMs({
      sawStreamOutput: sawVisibleStreamOutput,
      openCommandCount: openProviderWorkItemIds.size,
      firstByteTimeoutMs: getLocalProviderFirstByteTimeoutMs(),
      stallTimeoutMs: getLocalProviderStallTimeoutMs(),
      backgroundAwaitActive: hasOpenAgentWork,
      backgroundAwaitTimeoutMs: null,
      absoluteHardCapMs: getLocalProviderAbsoluteHardCapMs(),
    })
    if (timeoutMs === null) {
      return
    }
    localStreamStallTimer = setTimeout(() => {
      localStreamStallTimer = undefined
      if (finished) {
        return
      }

      const message = sawVisibleStreamOutput
        ? 'Codex stalled after emitting stream output.'
        : 'Codex stalled without emitting stream output.'
      const sessionId = emittedSessionId?.trim()
      if (!sessionId) {
        finishWithError(message)
        return
      }

      void getCodexNativeTurnCompletion(sessionId).then((completion) => {
        if (finished) {
          return
        }
        if (completion === 'completed') {
          finishWithDone()
          return
        }
        finishWithError(message)
      })
    }, timeoutMs)
  }

  const markVisibleStreamProgress = () => {
    sawVisibleStreamOutput = true
    scheduleLocalStreamStallTimer()
  }

  const markProviderWorkStarted = (itemId: string) => {
    openProviderWorkItemIds.add(itemId)
    sawVisibleStreamOutput = true
    scheduleLocalStreamStallTimer()
  }

  const markProviderWorkSettled = (itemId: string) => {
    openProviderWorkItemIds.delete(itemId)
    sawVisibleStreamOutput = true
    scheduleLocalStreamStallTimer()
  }

  const syncAgentWorkState = () => {
    hasOpenAgentWork = agentStatusTracker.hasRunningAgents()
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

  const sendRequest = async (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => {
    const id = nextRequestId()

    return await new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            pendingRequests.delete(id)
            reject(new Error(`${method} timed out.`))
          }, timeoutMs)
        : null
      pendingRequests.set(id, {
        method,
        resolve: (value) => {
          if (timer) clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          if (timer) clearTimeout(timer)
          reject(error)
        },
      })

      void writeCodexJsonRpcMessage(child.stdin!, {
        id,
        method,
        ...(params ? { params } : {}),
      }).catch((error) => {
        pendingRequests.delete(id)
        if (timer) clearTimeout(timer)
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

  const narrowCodexSandboxForRequirementsConflict = async (message: string) => {
    const currentSandboxMode = getCodexSandboxMode(currentRequest)
    if (!isCodexSandboxRequirementsConflict(message, currentSandboxMode)) {
      return false
    }

    const currentIndex = codexSandboxModesByAccess.indexOf(currentSandboxMode)
    const narrowerModes = codexSandboxModesByAccess.slice(currentIndex + 1)
    if (narrowerModes.length === 0) {
      return false
    }

    let allowedModes: CodexSandboxMode[] | null = null
    try {
      const requirements = await sendRequest('configRequirements/read')
      allowedModes = readCodexAllowedSandboxModes(
        requirements,
        getCodexApprovalPolicy(currentRequest),
      )
    } catch {
      // Older app-server builds do not expose configRequirements/read. In that
      // case, retry progressively narrower built-in modes and let Codex enforce
      // the effective local or managed policy.
    }

    const nextSandboxMode = narrowerModes.find(
      (candidate) => allowedModes === null || allowedModes.includes(candidate),
    )
    if (!nextSandboxMode) {
      return false
    }

    currentRequest = {
      ...currentRequest,
      sandboxMode: nextSandboxMode,
    }
    sink.onLog(formatCodexSandboxRequirementsFallbackNotice(language, nextSandboxMode))
    return true
  }

  const applyCodexManagedSandboxRequirements = async () => {
    try {
      const requirements = await sendRequest('configRequirements/read', undefined, 1_000)
      const allowedModes = readCodexAllowedSandboxModes(
        requirements,
        getCodexApprovalPolicy(currentRequest),
      )
      if (allowedModes === null) {
        return
      }

      const currentSandboxMode = getCodexSandboxMode(currentRequest)
      const currentIndex = codexSandboxModesByAccess.indexOf(currentSandboxMode)
      const effectiveMode = codexSandboxModesByAccess
        .slice(currentIndex)
        .find((candidate) => allowedModes.includes(candidate))

      if (effectiveMode && effectiveMode !== currentSandboxMode) {
        currentRequest = {
          ...currentRequest,
          sandboxMode: effectiveMode,
        }
      }
    } catch {
      // Older app-server builds may not expose configRequirements/read. Keep
      // the existing conflict-driven compatibility fallback for those builds.
    }
  }

  const startTurnWithCompatibilityFallback = async (threadId: string) => {
    let includeEffort = true
    let includeAgentParams = true

    while (true) {
      scheduleLocalStreamStallTimer()
      try {
        await sendRequest(
          'turn/start',
          buildCodexTurnStartParams(currentRequest, threadId, attachmentPaths, {
            includeEffort,
            includeAgentParams,
          }),
        )
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (includeEffort && isCodexAppServerEffortUnsupported(message)) {
          includeEffort = false
          sink.onLog(formatCodexEffortCompatibilityNotice(language))
          continue
        }

        if (includeAgentParams && isCodexAppServerAgentParamsUnsupported(message)) {
          includeAgentParams = false
          sink.onLog(formatCodexAgentParamsCompatibilityNotice(language))
          continue
        }

        if (await narrowCodexSandboxForRequirementsConflict(message)) {
          continue
        }

        throw error
      }
    }
  }

  const startThreadOnce = async () => {
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

  const startThread = async () => {
    while (true) {
      try {
        return await startThreadOnce()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (await narrowCodexSandboxForRequirementsConflict(message)) {
          continue
        }
        throw error
      }
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
        markProviderWorkStarted(activity.itemId)
      } else if (activity.kind === 'command') {
        markProviderWorkSettled(activity.itemId)
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

        const described = describeCodexUpstreamFailure(errorMessage, language, safetyRuntime.env)
        finishWithError(described.message, described.hint)
        return
      }

      const method = readString(message, 'method')
      if (!method) {
        return
      }

      if ('id' in message) {
        // 症状 — 旧实现在这里 finishWithError，于是 Codex 任何一次反向请求（审批、
        //   elicitation、将来新增的调用）都会把**整条流判死**，回合当场失败；
        //   `approvalPolicy: 'on-request'` 因此从来不可用。
        // 根因 — 把"我们没实现这个方法"误当成"这个回合完了"。JSON-RPC 对未识别
        //   方法的约定是回 -32601，由调用方决定降级还是放弃，与回合存活无关。
        // 为什么不按方法名实现语义 — 手上没有任何真实入站请求的实证，照猜实现
        //   等于重犯 pitfall #289/#291。先按规范拒绝 + 把方法名落进日志，等日志
        //   里真的出现它，再拿实证补对应分支。
        void writeCodexJsonRpcMessage(
          child.stdin!,
          buildCodexInboundRequestRejection(message.id, method),
        ).catch(() => undefined)
        sink.onLog(formatCodexAppServerUnexpectedRequest(language, method))
        return
      }

      const params = readRecord(message, 'params') ?? {}

      const agentUpdate = agentStatusTracker.handleNotification(message)
      if (agentUpdate.activity) {
        markDurableProviderProgress()
        sink.onActivity(agentUpdate.activity)
        syncAgentWorkState()
      }
      if (agentUpdate.releaseDeferredRootCompletion) {
        finishWithDone()
        return
      }
      if (agentUpdate.handled) {
        return
      }

      if (method === 'thread/started') {
        const thread = readRecord(params, 'thread')
        const sessionId = thread ? readString(thread, 'id') : undefined
        const parentThreadId = thread ? readString(thread, 'parentThreadId') : undefined
        if (parentThreadId) {
          return
        }
        if (sessionId && sessionId !== emittedSessionId) {
          emittedSessionId = sessionId
          agentStatusTracker.setRootThreadId(sessionId)
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

          sink.onDelta(deltaForSink, itemId)
        }

        return
      }

      if (method === 'turn/completed' && !manualCompactRequest) {
        if (agentStatusTracker.markRootTurnCompleted() === 'finish') {
          finishWithDone()
        } else {
          syncAgentWorkState()
        }
        return
      }

      if (method === 'error') {
        const notification = readCodexErrorNotification(params) ?? {
          message: 'Codex run failed.',
          willRetry: false,
        }

        // 还在自动重连的回合没有死，别替它宣判——真正的终态会带 willRetry:false 再来一次。
        if (notification.willRetry) {
          scheduleLocalStreamStallTimer()
          sink.onLog(notification.message)
          return
        }

        const described = describeCodexUpstreamFailure(notification.message, language, safetyRuntime.env)
        finishWithError(described.message, described.hint)
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
      const diagnostics = summarizeProviderDiagnostics(stderr)
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

    const diagnostics = summarizeProviderDiagnostics(stderr)
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
      await applyCodexManagedSandboxRequirements()

      if (safetyRuntime.hookCommand) {
        try {
          await ensureCodexSafetyHookTrusted({
            sendRequest,
            workspacePath: request.workspacePath,
            hookCommand: safetyRuntime.hookCommand,
            language,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Codex safety initialization failed.'
          finishWithError(message, 'env-setup')
          return
        }
      }

      const threadResponse = await startThread()

      const threadRecord = isRecord(threadResponse) ? readRecord(threadResponse, 'thread') : null
      const threadId = (threadRecord ? readString(threadRecord, 'id') : undefined) ?? request.sessionId

      if (!threadId) {
        throw new Error('Codex app-server did not return a thread id.')
      }

      if (threadId !== emittedSessionId) {
        emittedSessionId = threadId
        agentStatusTracker.setRootThreadId(threadId)
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
    const skillReuse = await prepareProviderSkillReuse({
      ...request,
      prompt: expandCodexNativeSlashPrompt(request),
    })

    if (skillReuse.prompt !== currentRequest.prompt) {
      currentRequest = {
        ...currentRequest,
        prompt: skillReuse.prompt,
      }
    }

    if (skillReuse.systemInstructions) {
      currentRequest = {
        ...currentRequest,
        systemPrompt: [currentRequest.systemPrompt, skillReuse.systemInstructions]
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
  // 本地模型条目：在这里把令牌翻成真实模型名，并让端点跟着条目走而不是全局 active
  // profile。翻译只做这一次 —— 下游 argv 构造与流解析器看到的就是一个普通模型名。
  // 条目查不到（被删了）时把 model 清空，让 CLI 回落到它自己的默认模型，而不是把
  // `__local__:xxx` 当模型名发出去。
  const localModelEntry = await resolveLocalModelEntry(currentRequest.model)
  const requestedLocalModelId = parseLocalModelToken(currentRequest.model)
  if (requestedLocalModelId) {
    currentRequest = {
      ...currentRequest,
      model: localModelEntry?.model ?? '',
    }
  }
  const runtime = await resolveProviderRuntime(currentRequest.provider, {
    localModelId: requestedLocalModelId ?? undefined,
  })

  // 超管回合：把工作区 MCP 接进本次 provider 启动。只有 `card.adminAccess`
  // 开着的回合才走这里（请求上表现为 `request.adminAccess`）—— 普通聊天卡永远
  // 拿不到工作区工具，这是权限边界而不是优化。桥接不可用时降级为"没有工具的
  // 普通回合"，绝不因此让整个回合失败。
  let adminRuntime: Awaited<ReturnType<typeof createWorkspaceAdminRuntime>> = null

  try {
    adminRuntime = await createWorkspaceAdminRuntime(currentRequest)
  } catch (error) {
    console.warn(
      `[workspace-admin] Unable to prepare workspace admin MCP runtime: ${error instanceof Error ? error.message : String(error)}`,
    )
    adminRuntime = null
  }

  if (currentRequest.provider === 'codex') {
    let archiveRecallRuntime: Awaited<ReturnType<typeof createArchiveRecallRuntimeOverrides>> | null = null

    try {
      archiveRecallRuntime = await createArchiveRecallRuntimeOverrides(currentRequest)
    } catch (error) {
      console.warn(`[archive-recall] Unable to prepare archive recall runtime: ${error instanceof Error ? error.message : String(error)}`)
      archiveRecallRuntime = null
    }

    const extraCodexArgs = [
      ...(archiveRecallRuntime?.runtimeArgs ?? []),
      ...(adminRuntime?.codexRuntimeArgs ?? []),
    ]
    const extraSystemPrompt = [
      ...(archiveRecallRuntime ? [getCodexArchiveRecallInstruction(language)] : []),
      ...(adminRuntime ? [adminRuntime.instruction] : []),
    ]
    const codexRuntime = extraCodexArgs.length > 0
      ? {
          ...runtime,
          args: [...runtime.args, ...extraCodexArgs],
        }
      : runtime
    const codexRequest = extraSystemPrompt.length > 0
      ? {
          ...currentRequest,
          systemPrompt: [currentRequest.systemPrompt, ...extraSystemPrompt]
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

  const claudeRequest = adminRuntime
    ? {
        ...currentRequest,
        systemPrompt: [currentRequest.systemPrompt, adminRuntime.instruction]
          .filter((part) => part.trim().length > 0)
          .join('\n\n'),
      }
    : currentRequest

  return launchClaudeRun(
    claudeRequest,
    sink,
    language,
    runtime,
    attachmentPaths,
    options?.claudeSessionPool ?? null,
    adminRuntime?.claudeMcpConfig,
  )
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
  readCompletionBoundary?: () => ClaudeCompletionBoundary
  onCompletionBoundary?: (boundary: ClaudeCompletionBoundary) => void
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
  // Per-turn sub-agent progress. See the system/task_* branch in handleLine.
  const claudeAgentTracker = createClaudeAgentStatusTracker({ language })
  // 15s：CLI 在子代理执行长命令期间静默上百秒（2026-08-09 实测 39.6s→195.1s 无事件），
  // 面板只能靠周期重发让本地推算的已运行时长走动，证明子代理还活着。
  const claudeAgentTickMs = 15_000
  let claudeAgentTicker: ReturnType<typeof setInterval> | undefined
  // Identity of the text content block currently streaming. The renderer keys a
  // streamed assistant bubble by this id; without one it can only chain deltas
  // through "the message I was last appending to", which an activity arriving
  // mid-sentence resets — splitting one sentence across two bubbles. Deltas from
  // one block share an id, and each new assistant message starts a new one.
  let claudeStreamMessageId: string | null = null
  let claudeTextBlockItemId: string | null = null
  let claudeTextBlockSeq = 0
  const nextClaudeTextItemId = (blockIndex: number | null) => {
    claudeTextBlockSeq += 1
    const messagePart = claudeStreamMessageId ?? `seq${claudeTextBlockSeq}`
    return `${messagePart}:text:${blockIndex ?? claudeTextBlockSeq}`
  }
  let stderr = ''
  let emittedSessionId: string | null = request.sessionId?.trim() || null
  // Stall watchdog: the Claude path otherwise has no timeout, so a CLI that
  // goes silent without a terminal `result` event spins the card forever
  // ("使用工具也经常卡住不动"). The watchdog disarms while a tool command is in
  // progress (the CLI emits no stdout for the command duration and owns its own
  // per-tool timeout), so it never false-kills a legitimately long command.
  let openClaudeCommandCount = 0
  // Latched once the turn dispatches a synchronously-awaited background tool
  // (Workflow/subagent). The CLI keeps emitting system:task_* progress but no
  // assistant deltas while it waits (up to its own 10-min cap), so the watchdog
  // must stay patient for the rest of the turn instead of false-killing the CLI.
  // Resets per turn (the parser is created fresh each turn).
  let sawBackgroundAwaitTool = false
  let claudeStallTimer: ReturnType<typeof setTimeout> | undefined
  let finished = false

  const clearClaudeStallTimer = () => {
    if (claudeStallTimer) {
      clearTimeout(claudeStallTimer)
      claudeStallTimer = undefined
    }
  }

  const clearClaudeAgentTicker = () => {
    if (claudeAgentTicker) {
      clearInterval(claudeAgentTicker)
      claudeAgentTicker = undefined
    }
  }

  // Arm only while a sub-agent is actually running, and disarm the moment the
  // last one settles — an interval that outlives the turn keeps a settled card
  // repainting forever.
  const syncClaudeAgentTicker = () => {
    if (finished || !claudeAgentTracker.hasRunningAgents()) {
      clearClaudeAgentTicker()
      return
    }
    if (claudeAgentTicker) {
      return
    }
    claudeAgentTicker = setInterval(() => {
      if (finished || !claudeAgentTracker.hasRunningAgents()) {
        clearClaudeAgentTicker()
        return
      }
      sink.onActivity(claudeAgentTracker.snapshot())
    }, claudeAgentTickMs)
    claudeAgentTicker.unref?.()
  }

  const markFinished = () => {
    finished = true
    clearClaudeStallTimer()
    clearClaudeAgentTicker()
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
      absoluteHardCapMs: getLocalProviderAbsoluteHardCapMs(),
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

      // 症状：派发子代理后卡片只剩通用计时器，用户无法判断跑了几个/跑到哪步/是否卡住。
      // 根因：2026-08-09 实测 claude 2.1.206 的 stdout 顶层就带 system:task_started /
      //       task_progress / task_updated / task_notification（含 subagent_type、当前动作、
      //       last_tool_name、usage），但此处的 system 分支此前只认 init，其余全部丢弃。
      // 必须在通用结构化解析之前 return：这些事件不属于主代理的活动流，落进去会污染主卡片。
      const claudeAgentUpdate = claudeAgentTracker.handleEvent(event)
      if (claudeAgentUpdate.handled) {
        if (claudeAgentUpdate.activity) {
          sink.onActivity(claudeAgentUpdate.activity)
        }
        syncClaudeAgentTicker()
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
            // Non-partial fallback path: one whole assistant message at a time,
            // so its own id is the bubble identity.
            const wholeMessageId = readString(event.message, 'id')
            sink.onDelta(
              visibleTextContent,
              wholeMessageId ? `${wholeMessageId}:text` : undefined,
            )
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
          // A Workflow/subagent was dispatched. 2026-08-09 实测：CLI 并非静默——它持续
          // 播报 system:task_* 进度（已由 claudeAgentTracker 渲染成子代理面板），但主消息
          // 流没有 assistant 增量，看门狗仍需在本轮剩余时间保持耐心。
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

      if (event.type === 'stream_event' && event.event?.type === 'message_start') {
        const startedMessageId = readString(event.event.message, 'id')
        claudeStreamMessageId = startedMessageId ?? null
        // A new assistant message is a genuine bubble boundary: drop the old
        // block identity so its first text delta opens a fresh bubble.
        claudeTextBlockItemId = null
      }

      if (event.type === 'stream_event' && event.event?.type === 'content_block_start') {
        const blockType = readString(event.event.content_block, 'type')
        claudeTextBlockItemId =
          blockType === 'text'
            ? nextClaudeTextItemId(
                typeof event.event.index === 'number' ? event.event.index : null,
              )
            : null
      }

      if (
        event.type === 'stream_event' &&
        event.event?.type === 'content_block_delta' &&
        event.event.delta?.type === 'text_delta' &&
        typeof event.event.delta.text === 'string'
      ) {
        sawClaudeDelta = true
        // Older CLI builds can stream text deltas without an opening
        // content_block_start; keep a stable id for that block anyway.
        if (!claudeTextBlockItemId) {
          claudeTextBlockItemId = nextClaudeTextItemId(
            typeof event.event.index === 'number' ? event.event.index : null,
          )
        }
        const safeText = askUserDeltaStripper.push(event.event.delta.text)
        const visibleText = typedToolChatterFilter.push(safeText)
        if (visibleText) {
          if (visibleText.trim()) {
            sawMeaningfulAssistantText = true
          }
          sink.onDelta(visibleText, claudeTextBlockItemId)
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
          // Residual text belongs to the last streamed block, not a new bubble.
          sink.onDelta(visibleResidualDelta, claudeTextBlockItemId ?? undefined)
        }

        if (event.is_error) {
          const failure = describeClaudeResultFailure(event, language)
          const { message } = failure
          // 事后归因全靠这一行：转录里只留一句渲染文案，日志此前对 result 失败完全沉默
          // （2026-08-14 五连挂，main.log 里一个字都没有）。
          // 为什么不能只 console.warn —— 后端整树跑在 utilityProcess 里，主进程用
          // `stdio: 'inherit'` fork 它，而打包版是无控制台的 GUI 进程：所有 console
          // 输出直接进虚空（同日实测 server/ 那 21 处诊断一条都没落过盘）。必须显式写
          // 文件。落 logs/server.log 而不是改 fork 的 stdio 为 pipe：后者要主进程持续
          // 消费管道，漏消费就是后端背压卡死，代价远大于收益。
          const diagnostics = {
            subtype: typeof event.subtype === 'string' ? event.subtype : null,
            terminalReason: failure.terminalReason,
            benignAbort: failure.benignAbort,
            apiErrorStatus: event.api_error_status ?? null,
            stopReason: event.stop_reason ?? null,
            numTurns: event.num_turns ?? null,
            sessionId: emittedSessionId ?? request.sessionId ?? null,
            message: truncate(message),
          }
          console.warn(`[claude-result] turn failed. ${JSON.stringify(diagnostics)}`)
          void writeServerLog('ERROR', '[claude-result] turn failed.', diagnostics)
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

        const completionBoundary = hooks.readCompletionBoundary?.() ?? 'unknown'
        hooks.onCompletionBoundary?.(completionBoundary)
        // 症状 — 「输出被截断」「模型拒答」「上下文快满了」三件事在 UI 和转录里
        //   都查不到，只能事后翻 server.log 猜（2026-08-16 对照 ACP 时定位）。
        // 根因 — stop_reason 只被读进 is_error 分支的诊断对象；usage / contextWindow
        //   则全项目零采集，而 CLI 每个 result 都在报。
        // 为什么不塞进 completion — 那是既有的二值契约（terminal /
        //   background-pending），复用它会把两个正交维度挤成一个枚举。
        // 为什么条件展开而不是直接赋 undefined — 无遥测时 payload 的**形状**必须与
        //   改动前逐字节一致：写死 `turnStopReason: undefined` 会真的建出这个键，
        //   deepEqual 断言和结构化克隆都看得见（2026-08-16 实测，
        //   tests/claude-completion-boundary 当场变红）。可选字段只是类型上可省，
        //   运行时得真的不存在才算纯增量。
        const turnStopReason = mapClaudeTurnStopReason(event)
        const turnUsage = readClaudeTurnUsage(event)
        sink.onDone({
          completion: completionBoundary === 'background-pending'
            ? 'background-pending'
            : 'terminal',
          ...(turnStopReason ? { turnStopReason } : {}),
          ...(turnUsage ? { usage: turnUsage } : {}),
        })
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
    const diagnostics = summarizeProviderDiagnostics(stderr)
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
    // 重启 attempt 时同样要停子代理心跳，否则被丢弃的 parser 会留着 interval 继续
    // 往已经换掉的 sink 上重画面板。
    cancel: () => {
      clearClaudeStallTimer()
      clearClaudeAgentTicker()
    },
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
  workspaceAdminMcpConfig?: WorkspaceAdminClaudeMcpConfig,
) => {
  const cardId = request.cardId?.trim()

  let safetyRuntime
  try {
    safetyRuntime = await prepareDestructiveCommandGuardRuntime(request, runtime.env)
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : 'Unable to prepare Claude Agent safety protection.'
    sink.onError(message, 'env-setup')
    return null
  }

  const preparedRuntime = {
    ...runtime,
    env: safetyRuntime.env,
  }

  if (pool && cardId && isClaudeKeepaliveEnabled()) {
    return launchClaudeKeepaliveRun(
      request,
      sink,
      language,
      preparedRuntime,
      attachmentPaths,
      pool,
      cardId,
      safetyRuntime.hookCommand,
      workspaceAdminMcpConfig,
    )
  }

  return launchClaudeSingleShotRun(
    request,
    sink,
    language,
    preparedRuntime,
    attachmentPaths,
    safetyRuntime.hookCommand,
    workspaceAdminMcpConfig,
  )
}

const launchClaudeSingleShotRun = async (
  request: ChatRequest,
  sink: StreamSink,
  language: AppLanguage,
  runtime: ProviderRuntime,
  attachmentPaths: string[],
  safetyHookCommand?: string,
  workspaceAdminMcpConfig?: WorkspaceAdminClaudeMcpConfig,
) => {
  const managedChild = createManagedChildHandle()
  let currentRequest = request
  let fallbackAttempted = false
  let staleSessionFallbackAttempted = false

  const startClaudeAttempt = async (includeEffort: boolean) => {
    const args = [
      ...runtime.args,
      ...buildClaudeArgs(currentRequest, attachmentPaths, {
        includeEffort,
        safetyHookCommand,
        workspaceAdminMcpConfig,
        settingsEnvOverride: runtime.claudeSettingsEnv,
      }),
    ]

    reportUnsupportedClaudeFlags(args, runtime.env)

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
      const diagnostics = summarizeProviderDiagnostics(stderrText)
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

export const isClaudeTurnStartLine = (line: string) => {
  if (!line.trim()) {
    return false
  }

  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    // Non-JSON noise on stdout never starts a turn.
    return false
  }

  if (!event || typeof event !== 'object') {
    return false
  }

  const record = event as { type?: unknown; subtype?: unknown; parent_tool_use_id?: unknown }
  // 症状：2026-07-27 父回合已显示完成，Explore 子代理的后续命令却把主卡片重新拉成运行中。
  // 根因：sidechain stream-json 同样含 message_start，但非空 parent_tool_use_id 表明它仍属于 Agent 工具内部。
  // 不能禁用全部 idle 输出；真实 task-notification 顶层回流仍需按 claude-session-keepalive SPEC 展示。
  if (
    typeof record.parent_tool_use_id === 'string' &&
    record.parent_tool_use_id.trim().length > 0
  ) {
    return false
  }

  // 症状：system/init 与后台 bookkeeping 会把空闲主卡提前拉成 streaming，随后只能等 watchdog。
  // 根因：2026-08-01 实测真实 task-notification 会在前导行后发顶层 stream_event/message_start。
  // 被否决：未知 JSON fail-open 会继续误附着 sidechain；只认原生顶层开流信号，见对应 SPEC。
  const streamEvent = event as { type?: unknown; event?: { type?: unknown } }
  return streamEvent.type === 'stream_event' && streamEvent.event?.type === 'message_start'
}

export const isClaudeSidechainLine = (line: string) => {
  if (!line.trim()) {
    return false
  }

  try {
    const event = JSON.parse(line) as { parent_tool_use_id?: unknown }
    return (
      typeof event?.parent_tool_use_id === 'string' &&
      event.parent_tool_use_id.trim().length > 0
    )
  } catch {
    return false
  }
}

export const buildClaudeKeepaliveSignature = (
  request: ChatRequest,
  includeEffort: boolean,
  runtime: ProviderRuntime,
  attachmentPaths: string[] = [],
  safetyHookCommand?: string,
  completionBoundaryHook?: ClaudeCompletionBoundaryHook,
) =>
  JSON.stringify({
    workspace: request.workspacePath,
    model: request.model ?? '',
    // 签的是真正上命令行的那个 `--effort`（null = 省略，即 auto 档），外加一个
    // ultracode 布尔 —— 两者缺一不可：
    // · 只签 flag 会让 ultracode 和普通 xhigh 共用进程（两者 flag 都是 xhigh，
    //   只差 `"ultracode": true` 这个 --settings 键），那是真正的串档。
    // · 反过来签原始档位则会过度分区：关思考+low 与开思考+low 生成不同签名，
    //   spawn 出的 argv 却逐字节相同，于是 acquireForTurn 判定签名不符，把一个
    //   还热着、可能正跑着后台任务的池化子进程 kill 掉，只为用同样的参数重启。
    effort: includeEffort
      ? toClaudeEffortFlagValue(
          request.model,
          request.reasoningEffort,
          request.thinkingEnabled === false,
        ) ?? 'omitted'
      : 'omitted',
    ultracode: request.thinkingEnabled !== false && isUltracodeEffort(request.reasoningEffort),
    plan: Boolean(request.planMode),
    language: normalizeLanguage(request.language),
    systemPrompt: request.systemPrompt,
    modelPromptRules: request.modelPromptRules,
    skills: request.crossProviderSkillReuseEnabled !== false,
    runtimeArgs: runtime.args,
    runtimeEnv: Object.fromEntries(Object.entries(runtime.env).sort(([left], [right]) => left.localeCompare(right))),
    attachmentDirectories: dedupeResolvedPaths(
      attachmentPaths
        .filter((attachmentPath) => attachmentPath.trim().length > 0)
        .map((attachmentPath) => resolvePath(dirname(attachmentPath))),
    ),
    outsideWorkspaceWrite: request.agentOutsideWorkspaceWriteEnabled !== false,
    destructiveCommandProtection: request.codexDestructiveCommandProtectionEnabled === true,
    safetyHookCommand: safetyHookCommand ?? '',
    completionBoundaryHook: completionBoundaryHook ?? null,
  })

const launchClaudeKeepaliveRun = async (
  request: ChatRequest,
  sink: StreamSink,
  language: AppLanguage,
  runtime: ProviderRuntime,
  attachmentPaths: string[],
  pool: ClaudeSessionPool,
  cardId: string,
  safetyHookCommand?: string,
  workspaceAdminMcpConfig?: WorkspaceAdminClaudeMcpConfig,
) => {
  const managedChild = createManagedChildHandle()
  let currentRequest = request
  let fallbackAttempted = false
  let staleSessionFallbackAttempted = false
  const completionBoundaryPath = getClaudeCompletionBoundaryPath(cardId)
  const completionBoundaryHook = buildClaudeCompletionBoundaryHookCommand(completionBoundaryPath)

  const startAttempt = async (includeEffort: boolean): Promise<boolean> => {
    // A user-authored turn supersedes the renderer's prior idle-wait marker.
    // Clear pool metadata before acquire can recycle an incompatible old child;
    // this prevents that intentional replacement from masquerading as a crash.
    pool.updateMeta(cardId, { backgroundWorkPending: false })
    const signature = buildClaudeKeepaliveSignature(
      currentRequest,
      includeEffort,
      runtime,
      attachmentPaths,
      safetyHookCommand,
      completionBoundaryHook,
    )

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
            safetyHookCommand,
            completionBoundaryHook,
            workspaceAdminMcpConfig,
            settingsEnvOverride: runtime.claudeSettingsEnv,
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
        completionBoundaryPath,
      },
    })

    if (!acquired) {
      return false
    }

    const child = acquired.child as ChildProcess
    managedChild.setActiveChild(child)
    // 软中断只在这条 keepalive 路径成立：stdin 常驻可写才有控制通道。
    // 绑定时带上 cardId + child，中断永远只作用于这一轮自己的进程，
    // 不会误伤同一张卡上后开的新 turn。
    managedChild.setInterruptHandler(() => pool.interruptTurn(cardId, child))
    pool.updateMeta(cardId, { backgroundWorkPending: false }, child)
    clearClaudeCompletionBoundarySnapshot(completionBoundaryPath)

    let turnCompletionBoundary: ClaudeCompletionBoundary | undefined
    const parser = createClaudeTurnParser({
      request: currentRequest,
      sink,
      language,
      killChild: () => pool.releaseEntry(cardId, child),
      onSettled: () => {
        if (turnCompletionBoundary !== 'background-pending') {
          pool.updateMeta(cardId, { backgroundWorkPending: false }, child)
        }
        managedChild.setActiveChild(null)
        // 这一轮已收口，中断入口必须随之失效：留着它，后续对同一个 handle 的
        // stop 会把中断发到进程的下一轮活儿上。
        managedChild.setInterruptHandler(null)
        pool.endTurn(cardId, child)
      },
      onSessionId: (sessionId) => pool.updateSessionId(cardId, sessionId, child),
      readCompletionBoundary: () => readClaudeCompletionBoundary(completionBoundaryPath),
      onCompletionBoundary: (boundary) => {
        turnCompletionBoundary = boundary
        pool.updateMeta(
          cardId,
          { backgroundWorkPending: boundary === 'background-pending' },
          child,
        )
      },
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
        const diagnostics = summarizeProviderDiagnostics(stderrText)
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
    }, child)

    const prompt = getClaudePrompt(currentRequest, attachmentPaths)
    const written = pool.writeUserMessage(
      cardId,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      }),
      child,
    )

    if (!written) {
      parser.cancel()
      pool.releaseEntry(cardId, child)
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
  onCompletionBoundary?: (boundary: ClaudeCompletionBoundary) => void
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
  const completionBoundaryPath =
    typeof options.entry.meta.completionBoundaryPath === 'string'
      ? options.entry.meta.completionBoundaryPath
      : undefined
  if (completionBoundaryPath) {
    clearClaudeCompletionBoundarySnapshot(completionBoundaryPath)
  }

  const parser = createClaudeTurnParser({
    request: pseudoRequest,
    sink: options.sink,
    language,
    killChild: options.killChild,
    onSettled: options.onSettled,
    onCompletionBoundary: options.onCompletionBoundary,
    readCompletionBoundary: completionBoundaryPath
      ? () => readClaudeCompletionBoundary(completionBoundaryPath)
      : undefined,
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
    getWindowsShellSafetyInstruction(),
  ].join(' ')

  if (request.model) {
    args.push('--model', request.model)
  }

  for (const attachmentPath of attachmentPaths) {
    args.push('--image', attachmentPath)
  }

  // 症状：codex-cli 0.144.1 收到 `--ask-for-approval` 直接退出，stderr 只有一行
  //       `error: unexpected argument '--ask-for-approval' found`（2026-08-14 实测）。
  // 根因：exec 是非交互模式，这个开关自诞生起就是空操作，0.144 把它从 exec 的 argv 里删了。
  // 为什么不能干脆不传：approval_policy 仍是真配置项，用户 config.toml 可能写着别的值，
  //       必须继续显式钉死 never；`-c` 覆盖在新旧 CLI 上都受支持，是唯一向后兼容的写法。
  args.push('-c', 'approval_policy="never"')
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

export const readCodexManagementPolicy = async (): Promise<CodexManagementPolicy> => {
  const settings = providerRuntimeSettingsOverride ?? (await loadStateForRenderer()).state.settings
  const requestedMode: CodexSandboxMode = settings.agentOutsideWorkspaceWriteEnabled
    ? 'danger-full-access'
    : 'workspace-write'
  const fallback = (message?: string): CodexManagementPolicy => ({
    supported: false,
    allowedSandboxModes: [],
    allowedApprovalPolicies: [],
    effectiveSandboxMode: requestedMode,
    ...(message ? { message } : {}),
  })
  const command = await resolveCommand('codex')
  if (!command) {
    return fallback('Codex CLI was not found.')
  }

  const runtime = await resolveProviderRuntime('codex')
  const launch = await resolveProviderCommandLaunch({
    command,
    args: buildCodexAppServerArgs(runtime.args),
  })

  return await new Promise<CodexManagementPolicy>((resolve) => {
    let settled = false
    let child: ChildProcess
    const finish = (result: CodexManagementPolicy) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child?.kill()
      resolve(result)
    }
    const timer = setTimeout(() => finish(fallback('Codex management policy detection timed out.')), 6_000)

    try {
      child = spawn(launch.command, launch.args, {
        cwd: process.cwd(),
        env: runtime.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch (error) {
      finish(fallback(error instanceof Error ? error.message : String(error)))
      return
    }

    if (!child.stdin || !child.stdout) {
      finish(fallback('Codex app-server did not expose stdio.'))
      return
    }

    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let payload: unknown
      try {
        payload = JSON.parse(line)
      } catch {
        return
      }
      if (!isRecord(payload) || typeof payload.id !== 'string') return
      if (payload.id === 'policy-initialize') {
        void writeCodexJsonRpcMessage(child.stdin!, { method: 'initialized' })
        void writeCodexJsonRpcMessage(child.stdin!, { id: 'policy-read', method: 'configRequirements/read' })
        return
      }
      if (payload.id !== 'policy-read') return
      const result = readRecord(payload, 'result')
      const requirements = result ? readRecord(result, 'requirements') : null
      const allowedSandboxModes = readCodexAllowedSandboxModes(result, 'never')
      if (!requirements || allowedSandboxModes === null) {
        finish(fallback('This Codex CLI does not expose managed requirements.'))
        return
      }
      const allowedApprovalPolicies = Array.isArray(requirements.allowedApprovalPolicies)
        ? requirements.allowedApprovalPolicies.filter(
            (value): value is CodexApprovalPolicy => value === 'never' || value === 'on-request',
          )
        : (['never', 'on-request'] satisfies CodexApprovalPolicy[])
      const requestedIndex = codexSandboxModesByAccess.indexOf(requestedMode)
      const effectiveSandboxMode = codexSandboxModesByAccess
        .slice(requestedIndex)
        .find((mode) => allowedSandboxModes.includes(mode)) ?? requestedMode
      finish({
        supported: true,
        allowedSandboxModes,
        allowedApprovalPolicies,
        effectiveSandboxMode,
      })
    })
    child.on('error', (error) => finish(fallback(error.message)))
    child.on('exit', () => finish(fallback('Codex app-server closed before returning policy.')))
    void writeCodexJsonRpcMessage(child.stdin, {
      id: 'policy-initialize',
      method: 'initialize',
      params: { clientInfo: { name: 'chill-vibe', title: 'Chill Vibe', version: '0.1.0' }, capabilities: null },
    })
  })
}

const isResolvedPathInside = (candidatePath: string, rootPath: string) => {
  const relativePath = relative(resolvePath(rootPath), resolvePath(candidatePath))
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
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
    safetyHookCommand?: string
    completionBoundaryHook?: ClaudeCompletionBoundaryHook
    platform?: NodeJS.Platform
    // 看板监工回合专属。--strict-mcp-config 让本次启动只认这里给的 MCP，
    // 不继承用户 ~/.claude 里配置的其它 server。
    workspaceAdminMcpConfig?: WorkspaceAdminClaudeMcpConfig
    // resolveProviderRuntime 注入的 ANTHROPIC_* 原样透传到 `--settings`，用来压住
    // 用户 `~/.claude/settings.json` 里的同名 env（后者优先级高于进程环境变量）。
    // 见 ProviderRuntime.claudeSettingsEnv 上的根因说明。
    settingsEnvOverride?: Record<string, string>
  },
) => {
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages']
  if (options?.streamingInput) {
    args.push('--input-format', 'stream-json')
  }
  const thinkingDisabled = request.thinkingEnabled === false
  // `--effort` only accepts low/medium/high/xhigh/max — there is no `none`, and
  // the CLI has no thinking-off switch at all. The model-aware exit point
  // returns null when the flag must be omitted (the auto tier), maps
  // thinking-off to low, keeps Fable 5 on its high default, ultracode to xhigh.
  const effortFlagValue = toClaudeEffortFlagValue(
    request.model,
    request.reasoningEffort,
    thinkingDisabled,
  )
  const ultracodeActive = !thinkingDisabled && isUltracodeEffort(request.reasoningEffort)
  const permissionMode = request.planMode ? 'plan' : 'bypassPermissions'
  const outsideWorkspaceWriteRestricted = request.agentOutsideWorkspaceWriteEnabled === false
  const safetyHookCommand = (
    request.codexDestructiveCommandProtectionEnabled === true ||
    outsideWorkspaceWriteRestricted
  )
    ? options?.safetyHookCommand
    : undefined
  const platform = options?.platform ?? process.platform
  const completionBoundaryHook = options?.completionBoundaryHook
  const additionalDirectories = resolveClaudeAdditionalDirectories({
    ...options,
    attachmentPaths,
    crossProviderSkillReuseEnabled: request.crossProviderSkillReuseEnabled,
  })
  const outsideWorkspaceReadDirectories = outsideWorkspaceWriteRestricted
    ? additionalDirectories.filter((directory) =>
        !isResolvedPathInside(directory, request.workspacePath))
    : []
  const sandboxSettings = outsideWorkspaceWriteRestricted && platform !== 'win32'
    ? {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        network: {
          allowedDomains: ['*'],
        },
        ...(outsideWorkspaceReadDirectories.length > 0
          ? {
              filesystem: {
                denyWrite: outsideWorkspaceReadDirectories,
              },
            }
          : {}),
      }
    : undefined
  const systemPrompt = [
    buildProviderSystemPrompt(request.language, getRequestBaseSystemPrompt(request)),
    getClaudeAskUserQuestionInstruction(request.language),
    getWindowsShellSafetyInstruction(),
  ].join(' ')

  args.push('--permission-mode', permissionMode)
  if (options?.workspaceAdminMcpConfig) {
    args.push(
      '--mcp-config',
      JSON.stringify(options.workspaceAdminMcpConfig),
      '--strict-mcp-config',
    )
  }
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
      // 只在真的注入了端点时写这个键。省略 ≠ 中立地继承用户配置吗？对 env 恰恰相反：
      // 这里省略才是继承，写了才是覆盖 —— 而未注入的场景（路由关闭 / 无 profile）
      // 正需要继承，所以不能无条件展开成空对象。
      ...(options?.settingsEnvOverride ? { env: options.settingsEnvOverride } : {}),
      // Official ultracode channel (Claude Code v2.1.157+): a session-level
      // settings key that sends xhigh plus dynamic-workflow orchestration.
      // Older CLIs treat unknown settings keys as a warning, degrading to
      // plain xhigh.
      //
      // 症状：用户 `~/.claude/settings.json` 里常驻 `"ultracode": true` 时，在
      // Chill Vibe 里选「超高（xhigh）」实际跑出 ultracode——模型收到「每个实质
      // 任务都去编排 workflow」的常驻 system-reminder，两个档位行为合流。
      // 根因（2026-08-13 扒 CLI 2.1.206 二进制实测）：`--settings` 是 lodash
      // `mergeWith` 深合并的 flagSettings 层，只覆盖**显式写出**的键，省略的键
      // 一律从 userSettings 继承；CLI 的 `Eie()` 判定 ultracode 是否生效要求
      // `settings.ultracode===true && workflows 开着 && effort 解析结果==="xhigh"`
      // 三条同时成立，xhigh 档位恰好凑齐第三条（低档位凑不齐才侥幸无恙）。
      // 为什么不能写回条件展开：省略这个键不是「保持中立」而是放弃覆盖，只有显式
      // 送 false 才能在合并层压掉用户级的 true。
      ultracode: ultracodeActive,
      ...(sandboxSettings ? { sandbox: sandboxSettings } : {}),
      ...(safetyHookCommand || completionBoundaryHook
        ? {
            hooks: {
              ...(safetyHookCommand
                ? {
                    PreToolUse: [
                      {
                        matcher: 'Bash|Edit|Write|NotebookEdit',
                        hooks: [
                          {
                            type: 'command',
                            command: platform === 'win32' ? 'powershell.exe' : '/bin/sh',
                            args: platform === 'win32'
                              ? [
                                  '-NoProfile',
                                  '-NonInteractive',
                                  '-ExecutionPolicy',
                                  'Bypass',
                                  '-Command',
                                  safetyHookCommand,
                                ]
                              : ['-c', safetyHookCommand],
                            timeout: 5,
                            statusMessage: 'Chill Vibe safety check',
                          },
                        ],
                      },
                    ],
                  }
                : {}),
              ...(completionBoundaryHook
                ? {
                    Stop: [
                      {
                        hooks: [
                          {
                            type: 'command',
                            command: completionBoundaryHook.command,
                            args: completionBoundaryHook.args,
                            timeout: 5,
                            statusMessage: 'Tracking Claude background work',
                          },
                        ],
                      },
                    ],
                  }
                : {}),
            },
          }
        : {}),
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

  // effortFlagValue === null 是「自动」档：省略 flag 让 CLI 用自己的默认，
  // 而不是把 null 拼成字符串送上命令行。
  if (options?.includeEffort !== false && effortFlagValue !== null) {
    args.push('--effort', effortFlagValue)
  }
  args.push('--append-system-prompt', systemPrompt)

  const prompt = getClaudePrompt(request, attachmentPaths)
  if (!options?.streamingInput && prompt.length > 0) {
    args.push(prompt)
  }
  return args
}
