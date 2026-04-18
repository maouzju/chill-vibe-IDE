import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import { basename, delimiter, dirname, resolve as resolvePath } from 'node:path'
import readline from 'node:readline'
import type { Readable } from 'node:stream'

import {
  defaultAppLanguage,
  getProviderLabel,
  normalizeLanguage,
} from '../shared/i18n.js'
import { getActiveProviderProfile } from '../shared/default-state.js'
import { normalizeSystemPrompt } from '../shared/system-prompt.js'
import {
  getSlashCommandDescription,
  getLocalSlashCommands,
  parseSlashCommandInput,
} from '../shared/slash-commands.js'
import { normalizeReasoningEffort } from '../shared/reasoning.js'
import { providerSupportsImageAttachments } from '../shared/chat-attachments.js'
import type {
  AppLanguage,
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
import { createClaudeStructuredOutputParser, stripClaudeAskUserXmlBlocks } from './claude-structured-output.js'
import { createCodexCompactionActivityDeduper } from './codex-compaction-dedupe.js'
import { resolveClaudeRuntimeEnvironment } from './claude-runtime-environment.js'
import {
  looksLikeCodexStructuredAgentMessage,
  parseCodexResponseEvent,
} from './codex-structured-output.js'
import { classifyProviderStreamErrorRecovery } from './provider-stream-recovery.js'
import { readStringPreserveWhitespace } from './provider-stream-text.js'
import { resolveProviderCommandLaunch } from './provider-command-launch.js'
import {
  buildCrossProviderSkillInstructions,
  discoverProviderSkills,
  getReusableSkillProviders,
} from './provider-skills.js'
import { loadState } from './state-store.js'
import { resilientProxyPool } from './resilient-proxy.js'
import { createArchiveRecallRuntimeOverrides, getCodexArchiveRecallInstruction } from './archive-recall.js'

type StreamSink = {
  onSession: (sessionId: string) => void
  onDelta: (content: string) => void
  onLog: (message: string) => void
  onAssistantMessage: (message: { itemId: string; content: string }) => void
  onActivity: (activity: StreamActivity) => void
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

const getCodexAskUserQuestionInstruction = (language: AppLanguage) =>
  normalizeLanguage(language) === 'en'
    ? 'In this Chill Vibe Codex exec environment, the native request_user_input tool is unavailable. When you must ask the user to choose before you can continue safely, do not call request_user_input and do not ask a plain-text multiple-choice question. Instead, reply with only one XML block in this exact shape and no extra text: <ask-user-question>{"header":"Short title","question":"One concise question","multiSelect":false,"options":[{"label":"Option A","description":"Short tradeoff"},{"label":"Option B","description":"Short tradeoff"}]}</ask-user-question>. Use 2-3 options, keep labels short, omit any Other option, and wait for the next user reply after emitting the block.'
    : '在这个 Chill Vibe 的 Codex exec 运行环境里，原生 request_user_input 工具不可用。当你必须在继续之前让用户做选择时，不要调用 request_user_input，也不要用普通文本写多选题。而是只输出一个完整的 XML 块，并且不要加任何其他文本：<ask-user-question>{"header":"简短标题","question":"一句简洁问题","multiSelect":false,"options":[{"label":"选项 A","description":"简短权衡"},{"label":"选项 B","description":"简短权衡"}]}</ask-user-question>。选项保持 2-3 个，label 要简短，不要自己加 Other，并在输出这个块后等待用户下一条回复。'

const getClaudeAskUserQuestionInstruction = (language: AppLanguage) =>
  normalizeLanguage(language) === 'en'
    ? 'In this Chill Vibe Claude runtime, the native AskUserQuestion tool cannot surface an interactive prompt to the user — calling it makes the CLI auto-return a placeholder "Answer questions?" result, which the user sees as a cancellation. Do not call AskUserQuestion. When you must ask the user to choose before you can continue safely, reply with only one XML block in this exact shape and no extra text: <ask-user-question>{"header":"Short title","question":"One concise question","multiSelect":false,"options":[{"label":"Option A","description":"Short tradeoff"},{"label":"Option B","description":"Short tradeoff"}]}</ask-user-question>. Use 2-3 options, keep labels short, omit any Other option, and wait for the next user reply after emitting the block.'
    : '在这个 Chill Vibe 的 Claude 运行环境里，原生 AskUserQuestion 工具无法向用户弹出可交互面板 —— 一旦调用，CLI 会自动返回占位结果 "Answer questions?"，用户那边看到的就是"已取消"。不要调用 AskUserQuestion。当你必须在继续之前让用户做选择时，只输出一个完整的 XML 块，并且不要加任何其他文本：<ask-user-question>{"header":"简短标题","question":"一句简洁问题","multiSelect":false,"options":[{"label":"选项 A","description":"简短权衡"},{"label":"选项 B","description":"简短权衡"}]}</ask-user-question>。选项保持 2-3 个，label 要简短，不要自己加 Other，并在输出这个块后等待用户下一条回复。'

const maybeResolveProxyBaseUrl = async (provider: Provider, baseUrl: string, enabled: boolean) => {
  if (!enabled) {
    return baseUrl
  }

  try {
    return await resilientProxyPool.resolveBaseUrl(provider, baseUrl)
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
    const state = await loadState()
    if (!state.settings.cliRoutingEnabled) {
      return {
        args: [],
        env: baseEnv,
      }
    }

    const activeProfile = getActiveProviderProfile(state.settings, provider)
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
      Boolean(state.settings.resilientProxyEnabled),
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

const formatImageAttachmentsUnsupported = (language: AppLanguage, provider: Provider) =>
  language === 'en'
    ? `${getProviderLabel(language, provider)} does not currently support pasted image attachments in this app. Switch the card to Codex to send images.`
    : `${getProviderLabel(language, provider)} 当前还不支持在这个应用里发送粘贴的图片。请将卡片切换到 Codex 后再发送。`

const formatProviderUnexpectedCompletion = (language: AppLanguage, provider: Provider) => {
  const label = getProviderLabel(language, provider)
  return language === 'en'
    ? `${label} ended without emitting a terminal completion event.`
    : `${label} 鍦ㄦ病鏈夊彂鍑虹粓姝㈠畬鎴愪簨浠剁殑鎯呭喌涓嬪氨缁撴潫浜嗐€?`
}

const transientRecoveryPlaceholderPattern = /^reconnecting(?:\s*(?:\.{3}|…))?(?:\s+\d+\s*\/\s*\d+)?$/i

const isTransientRecoveryPlaceholder = (content: string) => transientRecoveryPlaceholderPattern.test(content.trim())

const classifyLiveProviderStreamRecovery = (
  request: Pick<ChatRequest, 'sessionId'>,
  message: string,
  hint?: StreamErrorHint,
  emittedSessionId?: string | null,
) =>
  classifyProviderStreamErrorRecovery(
    {
      sessionId:
        typeof emittedSessionId === 'string' && emittedSessionId.trim().length > 0
          ? emittedSessionId
          : request.sessionId,
    },
    message,
    hint,
  )

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

  if (provider === 'codex') {
    const native = buildNativeSlashCommands('codex', ['compact'], normalizedLanguage)
    return dedupeSlashCommands([...local, ...native, ...skills])
  }

  if (provider === 'claude') {
    const native = await discoverClaudeSlashCommands(workspacePath, normalizedLanguage)
    return dedupeSlashCommands([...local, ...native, ...skills])
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

const buildCodexAppServerBaseInstructions = (request: ChatRequest) =>
  [
    buildProviderSystemPrompt(request.language, request.systemPrompt),
    getCodexAskUserQuestionInstruction(request.language),
  ].join(' ')

const buildCodexAppServerInput = (request: ChatRequest, attachmentPaths: string[]) => {
  const prompt = request.prompt.trim()
  const items: Array<Record<string, unknown>> = []

  if (prompt || attachmentPaths.length > 0 || request.sessionId) {
    items.push({
      type: 'text',
      text: prompt || (attachmentPaths.length > 0 ? getCodexPrompt(request, attachmentPaths) : ''),
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
        networkAccess: false,
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
  approvalPolicy: 'never',
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
  approvalPolicy: 'never',
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
  approvalPolicy: 'never',
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
  const emittedAssistantContent = {
    durable: false,
    transientOnly: false,
  }
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

    finished = true
    rejectPendingRequests(message)
    void cleanupArchiveRecall()
    sink.onError(message, hint, classifyLiveProviderStreamRecovery(request, message, hint, emittedSessionId))
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
      await sendRequest('turn/start', buildCodexTurnStartParams(currentRequest, threadId, attachmentPaths))
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      if (!isCodexAppServerEffortUnsupported(message)) {
        throw error
      }

      sink.onLog(formatCodexEffortCompatibilityNotice(language))
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

      if (parsed.type === 'assistant_message') {
        compactionActivityDeduper.reset()
        sink.onAssistantMessage({
          itemId: parsed.itemId,
          content: parsed.content,
        })
        continue
      }

      const activity = { ...parsed }
      delete (activity as { type?: 'activity' }).type

      if (activity.kind === 'compaction') {
        if (compactionActivityDeduper.shouldEmit(event, activity)) {
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
          if (isTransientRecoveryPlaceholder(delta)) {
            emittedAssistantContent.transientOnly = !emittedAssistantContent.durable
          } else {
            emittedAssistantContent.durable = true
            emittedAssistantContent.transientOnly = false
          }

          if (itemId) {
            const bufferedDelta = bufferedStructuredAgentMessageDeltas.get(itemId)

            if (bufferedDelta !== undefined || looksLikeCodexStructuredAgentMessage(delta)) {
              bufferedStructuredAgentMessageDeltas.set(itemId, `${bufferedDelta ?? ''}${delta}`)
              return
            }
          }

          sink.onDelta(delta)
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

    stderr += `${line}\n`
  })

  child.on('close', (code) => {
    stdoutLines.close()
    stderrLines.close()
    void cleanupArchiveRecall()

    if (finished) {
      return
    }

    finished = true
    rejectPendingRequests(code === 0 ? 'Codex app-server closed before completion.' : formatProviderExit(language, 'codex', code))

    if (code === 0) {
      const diagnostics = summarizeDiagnostics(stderr)
      const message = diagnostics || formatProviderUnexpectedCompletion(language, 'codex')
      const hint = classifyLaunchErrorHint(`${message}\n${stderr}`)
      sink.onError(message, hint, {
        ...classifyLiveProviderStreamRecovery(request, message, hint, emittedSessionId),
        transientOnly: emittedAssistantContent.transientOnly && !emittedAssistantContent.durable,
      })
      return
    }

    const diagnostics = summarizeDiagnostics(stderr)
    const message = diagnostics || formatProviderExit(language, 'codex', code)
    const hint = classifyLaunchErrorHint(`${message}\n${stderr}`)
    sink.onError(message, hint, classifyLiveProviderStreamRecovery(request, message, hint, emittedSessionId))
  })

  child.on('error', (error) => {
    if (finished) {
      return
    }

    void cleanupArchiveRecall()
    finished = true
    stdoutLines.close()
    stderrLines.close()
    rejectPendingRequests(error.message)
    const hint = classifyLaunchErrorHint(error.message)
    sink.onError(error.message, hint, classifyLiveProviderStreamRecovery(request, error.message, hint, emittedSessionId))
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

      const threadStatus = threadRecord ? readRecord(threadRecord, 'status') : null
      const threadStatusType = readString(threadStatus ?? {}, 'type')

      if (
        request.prompt.trim().length > 0 ||
        attachmentPaths.length > 0 ||
        (currentRequest.sessionId && threadStatusType !== 'active')
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

export const launchProviderRun = async (request: ChatRequest, sink: StreamSink) => {
  const language = normalizeLanguage(request.language)
  let currentRequest = request

  try {
    const crossProviderSkillInstructions = await buildCrossProviderSkillInstructions(request)

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

  const parseClaudeStructuredOutput = createClaudeStructuredOutputParser(language)
  const managedChild = createManagedChildHandle()
  let finished = false
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
      finished = true
      managedChild.setActiveChild(null)
      return false
    }

    managedChild.setActiveChild(child)

    if (!child.stdout || !child.stderr) {
      const message = formatProviderUnexpectedCompletion(language, currentRequest.provider)
      finished = true
      managedChild.setActiveChild(null)
      sink.onError(message, undefined, classifyProviderStreamErrorRecovery(currentRequest, message))
      child.kill()
      return false
    }

    let sawClaudeDelta = false
    let sawClaudeStreamOutput = false
    let stderr = ''
    let emittedSessionId: string | null = currentRequest.sessionId?.trim() || null

    const stdoutLines = readLines(child.stdout, (line) => {
      if (!line.trim()) {
        return
      }

      try {
        const event = JSON.parse(line)
        sawClaudeStreamOutput = true

        const claudeStructuredEvents = parseClaudeStructuredOutput(event)

        for (const parsed of claudeStructuredEvents) {
          const activity = { ...parsed }
          delete (activity as { type?: 'activity' }).type
          sink.onActivity(activity)
        }

        if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
          emittedSessionId = event.session_id
          sink.onSession(event.session_id)
          return
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
          sink.onDelta(event.event.delta.text)
          return
        }

        if (event.type === 'assistant' && !sawClaudeDelta) {
          if (Array.isArray(event.message?.content)) {
            const textContent = event.message.content
              .filter((item: { type?: string; text?: string }) => item.type === 'text')
              .map((item: { text?: string }) => stripClaudeAskUserXmlBlocks(item.text ?? ''))
              .join('')

            if (textContent.trim()) {
              sink.onDelta(textContent)
            }
          }
          return
        }

        if (event.type === 'result') {
          finished = true
          managedChild.setActiveChild(null)

          if (event.is_error) {
            const message =
              typeof event.result === 'string' ? event.result : formatClaudeRunFailed(language)
            sink.onError(message, classifyLaunchErrorHint(message))
            return
          }

          sink.onDone()
          return
        }
      } catch {
        // Ignore non-JSON stdout noise unless the run eventually fails.
      }
    })

    const stderrLines = readLines(child.stderr, (line) => {
      if (!line.trim()) {
        return
      }

      stderr += `${line}\n`
    })

    child.on('close', (code) => {
      stdoutLines.close()
      stderrLines.close()

      if (finished) {
        managedChild.setActiveChild(null)
        return
      }

      const diagnostics = summarizeDiagnostics(stderr)
      const message =
        code === 0
          ? diagnostics || formatProviderUnexpectedCompletion(language, currentRequest.provider)
          : diagnostics || formatProviderExit(language, currentRequest.provider, code)
      const detail = `${message}\n${stderr}`

      if (
        includeEffort &&
        !fallbackAttempted &&
        code !== 0 &&
        !sawClaudeStreamOutput &&
        isClaudeEffortUnsupported(detail)
      ) {
        fallbackAttempted = true
        managedChild.setActiveChild(null)
        sink.onLog(formatClaudeEffortCompatibilityNotice(language))
        void startClaudeAttempt(false)
        return
      }

      if (
        !staleSessionFallbackAttempted &&
        code !== 0 &&
        !sawClaudeStreamOutput &&
        currentRequest.sessionId?.trim() &&
        isClaudeStaleResumedSession(detail)
      ) {
        staleSessionFallbackAttempted = true
        managedChild.setActiveChild(null)
        sink.onLog(formatClaudeStaleSessionRecoveryNotice(language))
        currentRequest = { ...currentRequest, sessionId: undefined }
        void startClaudeAttempt(includeEffort)
        return
      }

      finished = true
      managedChild.setActiveChild(null)
      const hint = classifyLaunchErrorHint(detail)
      sink.onError(message, hint, classifyLiveProviderStreamRecovery(currentRequest, message, hint, emittedSessionId))
    })

    child.on('error', (error) => {
      if (finished) {
        managedChild.setActiveChild(null)
        return
      }

      finished = true
      managedChild.setActiveChild(null)
      stdoutLines.close()
      stderrLines.close()
      const hint = classifyLaunchErrorHint(error.message)
      sink.onError(error.message, hint, classifyLiveProviderStreamRecovery(currentRequest, error.message, hint, emittedSessionId))
    })

    return true
  }

  const started = await startClaudeAttempt(true)
  return started ? managedChild.handle : null
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
    buildProviderSystemPrompt(request.language, request.systemPrompt),
    getCodexAskUserQuestionInstruction(request.language),
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

export const buildClaudeArgs = (
  request: ChatRequest,
  attachmentPaths: string[] = [],
  options?: {
    includeEffort?: boolean
  },
) => {
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages']
  const reasoningEffort = normalizeReasoningEffort('claude', request.reasoningEffort)
  const permissionMode = request.planMode ? 'plan' : 'bypassPermissions'
  const systemPrompt = [
    buildProviderSystemPrompt(request.language, request.systemPrompt),
    getClaudeAskUserQuestionInstruction(request.language),
  ].join(' ')

  args.push('--permission-mode', permissionMode)
  args.push(
    '--settings',
    JSON.stringify({
      permissions: {
        defaultMode: permissionMode,
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
    args.push('--effort', request.thinkingEnabled === false ? 'none' : reasoningEffort)
  }
  args.push('--append-system-prompt', systemPrompt)

  const prompt = getClaudePrompt(request, attachmentPaths)
  if (prompt.length > 0) {
    args.push(prompt)
  }
  return args
}
