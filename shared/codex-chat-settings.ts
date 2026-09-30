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
  Partial<Pick<AppSettings, 'jevEnabled' | 'jevApiUrl'>>
type CodexChatRequestOverrides = Pick<
  ChatRequest,
  | 'personality'
  | 'serviceTier'
  | 'agentOutsideWorkspaceWriteEnabled'
  | 'codexDestructiveCommandProtectionEnabled'
  | 'codexIsolatedHomeEnabled'
  | 'attackPatternProtectionEnabled'
  | 'computerUseEnabled'
  | 'jevEnabled'
  | 'jevApiUrl'
>

export const defaultCodexChatSettings: CodexChatSettings = {
  codexPersonality: 'default',
  codexFastMode: false,
  agentOutsideWorkspaceWriteEnabled: true,
  codexDestructiveCommandProtectionEnabled: true,
  attackPatternProtectionEnabled: false,
  codexIsolatedHomeEnabled: true,
  computerUseEnabled: false,
  jevEnabled: false,
  jevApiUrl: '',
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
      ...(settings.computerUseEnabled ? { computerUseEnabled: true as const } : {}),
      ...(settings.jevEnabled ? { jevEnabled: true as const, ...(settings.jevApiUrl ? { jevApiUrl: settings.jevApiUrl } : {}) } : {}),
    }
  }

  return {
    agentOutsideWorkspaceWriteEnabled: settings.agentOutsideWorkspaceWriteEnabled,
    codexDestructiveCommandProtectionEnabled: settings.codexDestructiveCommandProtectionEnabled,
    attackPatternProtectionEnabled: settings.attackPatternProtectionEnabled,
    codexIsolatedHomeEnabled: settings.codexIsolatedHomeEnabled,
    // 只在打开时带字段：请求 schema 默认 false，省略即关闭，旧断言的默认形状不变。
    ...(settings.computerUseEnabled ? { computerUseEnabled: true as const } : {}),
    ...(settings.jevEnabled ? { jevEnabled: true as const, ...(settings.jevApiUrl ? { jevApiUrl: settings.jevApiUrl } : {}) } : {}),
    ...(settings.codexPersonality === 'default'
      ? {}
      : { personality: settings.codexPersonality }),
    ...(settings.codexFastMode ? { serviceTier: 'priority' as const } : {}),
  }
}

