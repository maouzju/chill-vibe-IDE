import { cliCompatNeedsAction, type CliCompatStatus } from '../../../shared/cli-compat'
import type { AppLanguage, AppSettings, OnboardingStatus, Provider, ProviderStatus } from '../../../shared/schema'

// 设置面板的「目录」：每一项归哪个分类、算基础还是高级、叫什么、用人话怎么解释。
// App.tsx 只负责生产控件 JSX，排版/分层/搜索全部看这里——所以这里是纯数据，能用 Node 测试钉住。
// 见 docs/specs/settings-beginner-redesign/design.md。

export const settingsCategoryIds = [
  'get-started',
  'models',
  'appearance',
  'automation',
  'network',
  'system',
] as const

export type SettingsCategoryId = (typeof settingsCategoryIds)[number]
export type SettingsTier = 'basic' | 'advanced'
export type LocalizedText = Record<AppLanguage, string>

export type SettingsItemMeta = {
  id: string
  category: SettingsCategoryId
  tier: SettingsTier
  label: LocalizedText
  /** 一句人话：做什么；拿不准就保持默认。 */
  hint?: LocalizedText
  /** 额外搜索词，中英混放。 */
  keywords?: string[]
  experimental?: boolean
  danger?: boolean
}

const keepDefault: LocalizedText = {
  'zh-CN': '拿不准就保持默认。',
  en: 'If unsure, keep the default.',
}

const hint = (zh: string, en: string): LocalizedText => ({
  'zh-CN': `${zh}${keepDefault['zh-CN']}`,
  en: `${en} ${keepDefault.en}`,
})

export const settingsItemCatalog: readonly SettingsItemMeta[] = [
  // ---- 开始使用 ----
  {
    id: 'account',
    category: 'get-started',
    tier: 'basic',
    label: { 'zh-CN': '连接账号', en: 'Connect account' },
    hint: hint(
      '填 API key、中转站地址、cc-switch 导入和断线重连代理都在「接口」选项卡；这里只显示当前用的是哪个；',
      'API keys, relay URLs, cc-switch import and the resilient proxy live in the Routing tab; this only shows what is in use.',
    ),
    // 接口选项卡里的东西不在设置重复摆（09-23 用户反馈），但搜这些词要能落到这张跳转卡上。
    keywords: [
      'api key', 'apikey', '密钥', 'base url', '中转', 'provider', 'profile', '账号', 'account', 'login', '登录',
      'routing', '路由', 'cli routing', 'inject', '注入', 'cc-switch', 'import', '导入',
      'proxy', '代理', 'reconnect', '重连', '断线', 'retry', '重试', 'stall', 'timeout', '超时', 'network', '网络',
      'stats', '统计', 'disconnect', 'recovery',
    ],
  },
  {
    id: 'environment',
    category: 'get-started',
    tier: 'advanced',
    label: { 'zh-CN': '环境设置', en: 'Environment' },
    hint: hint(
      '检查并一键安装 Git、Node、Claude CLI、Codex CLI，也能把 CLI 更新到指定版本；',
      'Checks and one-click installs Git, Node, Claude CLI and Codex CLI, and can update a CLI to a chosen version.',
    ),
    keywords: ['install', '安装', 'cli', 'git', 'node', 'update cli', '更新 cli', 'setup', '环境'],
  },
  {
    id: 'cli-compat',
    category: 'get-started',
    tier: 'advanced',
    label: { 'zh-CN': 'CLI 兼容版本', en: 'CLI compatibility' },
    hint: hint(
      '这个 IDE 版本验证过的 CLI 版本；一键下载装在应用目录，不动你系统里的 CLI；',
      'The CLI versions this IDE build was verified against; one click installs them privately without touching your system CLI.',
    ),
    keywords: ['compat', '兼容', 'version', '版本', 'cli'],
  },

  // ---- 模型与对话 ----
  {
    id: 'models',
    category: 'models',
    tier: 'basic',
    label: { 'zh-CN': '默认模型', en: 'Default model' },
    hint: hint(
      '新开的会话默认用哪个模型、想多深（思考深度越高越慢越贵）；',
      'Which model new chats start with and how deeply it reasons (higher effort is slower and pricier).',
    ),
    keywords: ['model', '模型', 'reasoning', 'effort', '思考', '推理', 'thinking', 'claude', 'codex', 'default'],
  },
  {
    id: 'model-behavior',
    category: 'models',
    tier: 'advanced',
    label: { 'zh-CN': '对话行为', en: 'Chat behavior' },
    hint: hint(
      'Agent 的性格、系统提示词、按模型追加的提示词、Git 分析用的模型；',
      'Agent personality, system prompt, per-model prompt rules and the model used for Git analysis.',
    ),
    keywords: ['prompt', '提示词', 'personality', '人格', 'fast', 'skill', 'git agent', 'system prompt', 'rules', '规则'],
  },
  {
    id: 'local-models',
    category: 'models',
    tier: 'advanced',
    label: { 'zh-CN': '本地模型', en: 'Local models' },
    hint: hint(
      '把 Ollama / LM Studio 这类跑在自己电脑上的模型接进来，不走云端；',
      'Plug in models running on this machine (Ollama, LM Studio, …) instead of a cloud endpoint.',
    ),
    keywords: ['ollama', 'local', '本地', 'lm studio', 'vllm', 'llama'],
  },

  // ---- 外观与编辑 ----
  {
    id: 'language-theme',
    category: 'appearance',
    tier: 'basic',
    label: { 'zh-CN': '语言与主题', en: 'Language & theme' },
    keywords: ['language', '语言', 'theme', '主题', 'dark', 'light', '深色', '浅色', 'custom', 'accent'],
  },
  {
    id: 'typography',
    category: 'appearance',
    tier: 'advanced',
    label: { 'zh-CN': '字体与缩放', en: 'Font & scale' },
    keywords: ['font', '字体', 'scale', '缩放', 'line height', '行高', 'ui scale', 'zoom'],
  },
  {
    id: 'editor',
    category: 'appearance',
    tier: 'advanced',
    label: { 'zh-CN': '编辑器', en: 'Editor' },
    keywords: ['editor', '编辑器', 'word wrap', '换行', 'minimap', 'tab size', 'font size'],
  },

  // ---- 自动化与工具 ----
  {
    id: 'wake-timer',
    category: 'automation',
    tier: 'advanced',
    label: { 'zh-CN': '计划唤醒', en: 'Wake timer' },
    hint: hint(
      '让会话在别的会话干完、或过一段时间后自动醒来继续；',
      'Lets a chat wake up on its own after other chats finish or after a delay.',
    ),
    keywords: ['wake', '唤醒', 'timer', '定时', 'schedule'],
  },
  {
    id: 'auto-urge',
    category: 'automation',
    tier: 'advanced',
    label: { 'zh-CN': '自动鞭策', en: 'Auto urge' },
    hint: hint(
      'Agent 停下来但没干完时自动催它继续，直到看到成功关键字；',
      'Automatically nudges the agent to keep going until it reports the success keyword.',
    ),
    keywords: ['urge', '鞭策', '催', 'continue', 'auto'],
  },
  {
    id: 'repeat-loop',
    category: 'automation',
    tier: 'advanced',
    label: { 'zh-CN': '循环执行', en: 'Repeat loop' },
    hint: hint('把同一条需求按次数或时间反复跑；', 'Reruns the same request a number of times or on a schedule.'),
    keywords: ['repeat', '循环', 'loop'],
  },
  {
    id: 'tool-cards',
    category: 'automation',
    tier: 'advanced',
    label: { 'zh-CN': '卡片类型', en: 'Card Type' },
    hint: hint(
      '决定工作区里能开哪些工具卡：Git、文件树、便签、自动化看板……；',
      'Which tool cards can be opened in a workspace: Git, files, sticky notes, the automation board…',
    ),
    keywords: ['git', 'files', '文件', 'sticky', '便签', 'board', '看板', 'card', '卡片', 'automation', 'tool'],
  },

  // ---- 网络与安全 ----
  {
    id: 'codex-safety',
    category: 'network',
    tier: 'advanced',
    label: { 'zh-CN': 'Agent 安全防护', en: 'Agent Safety' },
    hint: hint(
      '限制 Agent 能改哪些目录、能不能跑删库式命令、能不能操作浏览器；',
      'Limits which folders the agent may write, whether it can run destructive commands, and whether it may drive a browser.',
    ),
    keywords: [
      'safety', '安全', 'sandbox', '沙箱', 'policy', '策略', 'admin', '超管', 'destructive', 'computer use', '浏览器', 'browser', 'isolated', '隔离', 'workspace', 'permission', '权限',
    ],
  },

  // ---- 系统 ----
  {
    id: 'update',
    category: 'system',
    tier: 'basic',
    label: { 'zh-CN': '应用更新', en: 'App Update' },
    keywords: ['update', '更新', 'version', '版本', 'upgrade'],
  },
  {
    id: 'general',
    category: 'system',
    tier: 'advanced',
    label: { 'zh-CN': '通用行为', en: 'General' },
    keywords: ['close', '关闭', 'sound', '提示音', '声音', 'accessibility', '无障碍', '读屏', 'tray', '托盘'],
  },
  {
    id: 'experimental',
    category: 'system',
    tier: 'advanced',
    label: { 'zh-CN': '实验功能', en: 'Experimental' },
    hint: hint('还在打磨的附加卡片：统计、天气、音乐、白噪音；', 'Extras still being polished: stats, weather, music, white noise.'),
    keywords: ['experimental', '实验', 'weather', '天气', 'music', '音乐', 'white noise', '白噪音', 'stats', '统计'],
    experimental: true,
  },
  {
    id: 'data',
    category: 'system',
    tier: 'advanced',
    label: { 'zh-CN': '本地数据', en: 'Local Data' },
    keywords: ['clear', '清空', 'reset', '重置', 'data', '数据', 'backup', '备份', 'danger'],
    danger: true,
  },
]

const orderRank = (item: SettingsItemMeta) => (item.danger ? 2 : item.experimental ? 1 : 0)

/** 分类内顺序：普通项 → 实验项 → 危险项；同档保持目录声明顺序。 */
export const orderSettingsItems = <T extends SettingsItemMeta>(items: readonly T[]): T[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => orderRank(a.item) - orderRank(b.item) || a.index - b.index)
    .map(({ item }) => item)

export const getSettingsCategoryItems = (category: SettingsCategoryId): SettingsItemMeta[] =>
  orderSettingsItems(settingsItemCatalog.filter((item) => item.category === category))

/** 「基础」视图：四个新手必看项，按新手的操作顺序排。 */
const basicViewOrder = ['language-theme', 'account', 'models', 'update'] as const

export const getBasicSettingsItems = (): SettingsItemMeta[] =>
  basicViewOrder
    .map((id) => settingsItemCatalog.find((item) => item.id === id && item.tier === 'basic'))
    .filter((item): item is SettingsItemMeta => Boolean(item))

export const getSettingsItemMeta = (id: string): SettingsItemMeta | undefined =>
  settingsItemCatalog.find((item) => item.id === id)

const normalizeQuery = (value: string) => value.trim().toLowerCase()

/** 搜索匹配 label / hint / keywords 的两种语言：用户在中文界面里搜 "proxy" 也要命中。 */
export const filterSettingsItems = <T extends SettingsItemMeta>(items: readonly T[], query: string): T[] => {
  const needle = normalizeQuery(query)
  if (!needle) {
    return [...items]
  }

  return items.filter((item) => {
    const haystack = [
      item.id,
      item.label['zh-CN'],
      item.label.en,
      item.hint?.['zh-CN'] ?? '',
      item.hint?.en ?? '',
      ...(item.keywords ?? []),
    ]
      .join('\n')
      .toLowerCase()
    return haystack.includes(needle)
  })
}

// ---- 环境健康灯 ----

export type HealthState = 'ok' | 'warn' | 'error' | 'unknown'

export type HealthFix =
  | { kind: 'install-cli' }
  | { kind: 'connect-account' }
  | { kind: 'install-compat'; provider: Provider }
  | { kind: 'activate-compat'; provider: Provider }

export type HealthLight = {
  state: HealthState
  fix: HealthFix | null
  /** 供 UI 组句的细节：可用的 provider 列表 / 出问题的 provider。 */
  providers: Provider[]
  /** 账号灯：绿是因为关了路由、走 CLI 自己的登录。 */
  viaCliLogin?: boolean
}

export type EnvironmentHealth = {
  cli: HealthLight
  account: HealthLight
  version: HealthLight
}

/** 三盏灯全绿：健康卡折叠成一行结论，不再占满设置页顶部。 */
export const isEnvironmentHealthAllOk = (health: EnvironmentHealth) =>
  health.cli.state === 'ok' && health.account.state === 'ok' && health.version.state === 'ok'

export type EnvironmentHealthInput = {
  onboardingStatus: OnboardingStatus | null
  providers: readonly ProviderStatus[]
  cliCompatStatus: CliCompatStatus | null
  settings: Pick<AppSettings, 'providerProfiles' | 'cliRoutingEnabled'>
}

const allProviders: readonly Provider[] = ['claude', 'codex']

const resolveAvailableProviders = (input: EnvironmentHealthInput): Provider[] | null => {
  const checks = input.onboardingStatus?.environment.checks ?? []
  const statuses = input.providers
  if (checks.length === 0 && statuses.length === 0) {
    return null
  }

  return allProviders.filter((provider) => {
    const check = checks.find((entry) => entry.id === provider)
    const status = statuses.find((entry) => entry.provider === provider)
    return Boolean(check?.available) || Boolean(status?.available)
  })
}

const hasKeyedActiveProfile = (settings: EnvironmentHealthInput['settings'], provider: Provider) => {
  const collection = settings.providerProfiles[provider]
  const active = collection.profiles.find((profile) => profile.id === collection.activeProfileId)
  return Boolean(active && active.apiKey.trim())
}

export const deriveEnvironmentHealth = (input: EnvironmentHealthInput): EnvironmentHealth => {
  const available = resolveAvailableProviders(input)

  const cli: HealthLight =
    available === null
      ? { state: 'unknown', fix: null, providers: [] }
      : available.length === allProviders.length
        ? { state: 'ok', fix: null, providers: available }
        : {
            state: available.length === 0 ? 'error' : 'warn',
            fix: { kind: 'install-cli' },
            providers: available,
          }

  const account: HealthLight = (() => {
    if (available === null) {
      return { state: 'unknown', fix: null, providers: [] }
    }
    if (!input.settings.cliRoutingEnabled) {
      return { state: 'ok', fix: null, providers: available, viaCliLogin: true }
    }
    const keyed = allProviders.filter((provider) => hasKeyedActiveProfile(input.settings, provider))
    if (keyed.length > 0) {
      return { state: 'ok', fix: null, providers: keyed }
    }
    return { state: 'warn', fix: { kind: 'connect-account' }, providers: [] }
  })()

  const version: HealthLight = (() => {
    const entries = input.cliCompatStatus?.entries
    if (!entries || available === null) {
      return { state: 'unknown', fix: null, providers: [] }
    }
    for (const entry of entries) {
      // 没装的 provider 不算版本问题：那是 CLI 灯的事。
      if (!available.includes(entry.provider) && !entry.systemVersion && !entry.active) {
        continue
      }
      if (!cliCompatNeedsAction(entry)) {
        continue
      }
      return {
        state: 'warn',
        fix: entry.installed
          ? { kind: 'activate-compat', provider: entry.provider }
          : { kind: 'install-compat', provider: entry.provider },
        providers: [entry.provider],
      }
    }
    return { state: 'ok', fix: null, providers: available }
  })()

  return { cli, account, version }
}

// ---- 首启向导步进 ----

export type OnboardingWizardStage = 'loading' | 'setup' | 'account' | 'model' | 'complete'

export type OnboardingWizardInput = {
  statusLoaded: boolean
  environmentReady: boolean
  setupSkipped: boolean
  importState: 'idle' | 'imported' | 'skipped'
  accountState: 'idle' | 'connected' | 'skipped'
  hasUsableAccount: boolean
  modelState: 'idle' | 'confirmed'
}

export const resolveOnboardingWizardStage = (input: OnboardingWizardInput): OnboardingWizardStage => {
  if (!input.statusLoaded) {
    return 'loading'
  }
  if (!input.environmentReady && !input.setupSkipped) {
    return 'setup'
  }
  const accountDone =
    input.importState !== 'idle' || input.accountState !== 'idle' || input.hasUsableAccount
  if (!accountDone) {
    return 'account'
  }
  if (input.modelState !== 'confirmed') {
    return 'model'
  }
  return 'complete'
}
