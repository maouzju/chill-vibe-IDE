import type { AppSettings, ChatRequest, Provider } from './schema.js'

export type CodexChatSettings = Pick<
  AppSettings,
  | 'codexPersonality'
  | 'codexFastMode'
  | 'agentOutsideWorkspaceWriteEnabled'
  | 'codexDestructiveCommandProtectionEnabled'
  | 'codexIsolatedHomeEnabled'
  | 'attackPatternProtectionEnabled'
  | 'computerUseEnabled'
> &
  Partial<
    Pick<
      AppSettings,
      | 'memoryBudgetEnabled'
      | 'memoryBudgetMinFreeGb'
      | 'memoryBudgetMinCommitGb'
      | 'memoryBudgetMaxHeavyProcesses'
    >
  > &
  Partial<Pick<AppSettings, 'desktopControlEnabled' | 'jevEnabled' | 'jevApiUrl'>>
type CodexChatRequestOverrides = Pick<
  ChatRequest,
  | 'personality'
  | 'serviceTier'
  | 'agentOutsideWorkspaceWriteEnabled'
  | 'codexDestructiveCommandProtectionEnabled'
  | 'codexIsolatedHomeEnabled'
  | 'attackPatternProtectionEnabled'
  | 'computerUseEnabled'
  | 'desktopControlEnabled'
  | 'jevEnabled'
  | 'jevApiUrl'
  | 'memoryBudget'
>

export const defaultCodexChatSettings: CodexChatSettings = {
  codexPersonality: 'default',
  codexFastMode: false,
  agentOutsideWorkspaceWriteEnabled: true,
  codexDestructiveCommandProtectionEnabled: true,
  attackPatternProtectionEnabled: false,
  codexIsolatedHomeEnabled: true,
  computerUseEnabled: false,
  desktopControlEnabled: false,
  jevEnabled: false,
  jevApiUrl: '',
  memoryBudgetEnabled: true,
  memoryBudgetMinFreeGb: 8,
  memoryBudgetMinCommitGb: 8,
  memoryBudgetMaxHeavyProcesses: 8,
}

// AI 内存预算对三个 provider 都生效（docs/specs/agent-memory-budget）；只在开启时带字段，省略 = 关闭。
// 设置里默认开（normalizeAppSettings 补齐 true），这里只认显式 true，调用方不带字段就不下发。
const buildMemoryBudgetOverride = (settings: CodexChatSettings) =>
  settings.memoryBudgetEnabled !== true
    ? {}
    : {
        memoryBudget: {
          minFreeGb: settings.memoryBudgetMinFreeGb ?? 8,
          minCommitGb: settings.memoryBudgetMinCommitGb ?? 8,
          maxHeavyProcesses: settings.memoryBudgetMaxHeavyProcesses ?? 8,
        },
      }

export const buildCodexChatRequestOverrides = (
  provider: Provider,
  settings: CodexChatSettings,
): Partial<CodexChatRequestOverrides> => {
  if (provider === 'claude') {
    return {
      agentOutsideWorkspaceWriteEnabled: settings.agentOutsideWorkspaceWriteEnabled,
      codexDestructiveCommandProtectionEnabled:
        settings.codexDestructiveCommandProtectionEnabled,
      attackPatternProtectionEnabled: settings.attackPatternProtectionEnabled,
      ...buildMemoryBudgetOverride(settings),
      ...(settings.computerUseEnabled ? { computerUseEnabled: true as const } : {}),
      ...(settings.desktopControlEnabled ? { desktopControlEnabled: true as const } : {}),
      ...(settings.jevEnabled ? { jevEnabled: true as const, ...(settings.jevApiUrl ? { jevApiUrl: settings.jevApiUrl } : {}) } : {}),
    }
  }

  return {
    agentOutsideWorkspaceWriteEnabled: settings.agentOutsideWorkspaceWriteEnabled,
    codexDestructiveCommandProtectionEnabled: settings.codexDestructiveCommandProtectionEnabled,
    attackPatternProtectionEnabled: settings.attackPatternProtectionEnabled,
    codexIsolatedHomeEnabled: settings.codexIsolatedHomeEnabled,
    ...buildMemoryBudgetOverride(settings),
    // 只在打开时带字段：请求 schema 默认 false，省略即关闭，旧断言的默认形状不变。
    ...(settings.computerUseEnabled ? { computerUseEnabled: true as const } : {}),
    ...(settings.desktopControlEnabled ? { desktopControlEnabled: true as const } : {}),
    ...(settings.jevEnabled ? { jevEnabled: true as const, ...(settings.jevApiUrl ? { jevApiUrl: settings.jevApiUrl } : {}) } : {}),
    ...(settings.codexPersonality === 'default'
      ? {}
      : { personality: settings.codexPersonality }),
    ...(settings.codexFastMode ? { serviceTier: 'priority' as const } : {}),
  }
}

