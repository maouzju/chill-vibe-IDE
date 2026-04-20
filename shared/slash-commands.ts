import { defaultAppLanguage, getLocaleText, normalizeLanguage } from './i18n.js'
import type { AppLanguage, Provider, SlashCommand, SlashCommandSource } from './schema.js'

const LOCAL_SLASH_COMMAND_NAMES = new Set(['help', 'model', 'new', 'clear', 'status'])

const CLAUDE_NATIVE_SLASH_COMMAND_DESCRIPTIONS: Record<AppLanguage, Record<string, string>> = {
  'zh-CN': {
    'agent-reach': '搜索网页和受支持的平台',
    compact: '压缩当前会话上下文',
    context: '查看上下文和 token 使用情况',
    cost: '查看成本和使用摘要',
    init: '初始化或刷新项目说明',
    plan: '查看或管理当前计划',
    'pr-comments': '起草拉取请求评论',
    pua: '进入更强的坚持推进模式',
    'release-notes': '根据当前改动生成发布说明',
    review: '审查当前改动',
    'security-review': '执行安全专项审查',
    todos: '查看当前待办列表',
  },
  en: {
    'agent-reach': 'search the web and supported platforms',
    compact: 'compact the current session context',
    context: 'show context and token usage',
    cost: 'show cost and usage summary',
    init: 'bootstrap or refresh project instructions',
    plan: 'inspect or manage the current plan',
    'pr-comments': 'draft pull request comments',
    pua: 'escalate persistence and try-harder mode',
    'release-notes': 'draft release notes from current changes',
    review: 'review current changes',
    'security-review': 'run a security-focused review',
    todos: 'inspect the current todo list',
  },
}

const CODEX_NATIVE_SLASH_COMMAND_DESCRIPTIONS: Record<AppLanguage, Record<string, string>> = {
  'zh-CN': {
    compact: '压缩当前会话上下文',
    init: '初始化或刷新项目说明',
    plan: '查看或管理当前计划',
  },
  en: {
    compact: 'compact the current session context',
    init: 'bootstrap or refresh project instructions',
    plan: 'inspect or manage the current plan',
  },
}

export type ParsedSlashCommand = {
  name: string
  args: string
}

export const getLocalSlashCommands = (
  language: AppLanguage = defaultAppLanguage,
): SlashCommand[] => {
  const text = getLocaleText(normalizeLanguage(language))

  return [
    {
      name: 'help',
      description: text.appSlashHelp.slice('/help - '.length),
      source: 'app',
    },
    {
      name: 'model',
      description: text.appSlashModel.slice('/model <name> - '.length),
      source: 'app',
    },
    {
      name: 'new',
      description: text.appSlashNew.slice('/new - '.length),
      source: 'app',
    },
    {
      name: 'clear',
      description: text.appSlashClear.slice('/clear - '.length),
      source: 'app',
    },
    {
      name: 'status',
      description: text.appSlashStatus.slice('/status - '.length),
      source: 'app',
    },
  ]
}

export const parseSlashCommandInput = (input: string): ParsedSlashCommand | null => {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) {
    return null
  }

  const body = trimmed.slice(1).trim()
  if (!body) {
    return { name: '', args: '' }
  }

  const [name, ...rest] = body.split(/\s+/)
  return {
    name: name.toLowerCase(),
    args: rest.join(' ').trim(),
  }
}

export const getSlashCompletionQuery = (input: string) => {
  const trimmed = input.trimStart()
  const match = /^\/([^\s]*)$/.exec(trimmed)
  return match ? match[1].toLowerCase() : null
}

export const isLocalSlashCommandInput = (input: string) => {
  const parsed = parseSlashCommandInput(input)
  return Boolean(parsed && LOCAL_SLASH_COMMAND_NAMES.has(parsed.name))
}

export const getSlashCommandDescription = (
  provider: Provider,
  name: string,
  source: SlashCommandSource,
  language: AppLanguage = defaultAppLanguage,
) => {
  const normalizedLanguage = normalizeLanguage(language)

  if (source === 'app') {
    return getLocalSlashCommands(normalizedLanguage).find((command) => command.name === name)?.description ?? `/${name}`
  }

  if (source === 'skill') {
    return `Skill /${name}`
  }

  if (provider === 'claude') {
    return (
      CLAUDE_NATIVE_SLASH_COMMAND_DESCRIPTIONS[normalizedLanguage][name] ??
      `${getLocaleText(normalizedLanguage).claudeNativeCommandPrefix} /${name}`
    )
  }

  const codexDescription = CODEX_NATIVE_SLASH_COMMAND_DESCRIPTIONS[normalizedLanguage][name]
  if (codexDescription) {
    return codexDescription
  }

  return `${getLocaleText(normalizedLanguage).codexNativeCommandPrefix} /${name}`
}

export const formatLocalSlashHelp = (
  provider: Provider,
  language: AppLanguage = defaultAppLanguage,
) => {
  const text = getLocaleText(normalizeLanguage(language))
  const lines = [
    text.appSlashCommandsTitle,
    text.appSlashHelp,
    text.appSlashModel,
    text.appSlashNew,
    text.appSlashClear,
    text.appSlashStatus,
  ]

  if (provider === 'claude') {
    lines.push('', text.claudeSlashCommandsFooter)
  } else {
    lines.push('', text.codexSlashCommandsFooterOne, text.codexSlashCommandsFooterTwo)
  }

  return lines.join('\n')
}
