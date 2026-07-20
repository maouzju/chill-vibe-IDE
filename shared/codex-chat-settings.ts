import type { AppSettings, ChatRequest, Provider } from './schema.js'

export type CodexChatSettings = Pick<
  AppSettings,
  | 'codexPersonality'
  | 'codexFastMode'
  | 'agentOutsideWorkspaceWriteEnabled'
  | 'codexDestructiveCommandProtectionEnabled'
  | 'codexIsolatedHomeEnabled'
>
type CodexChatRequestOverrides = Pick<
  ChatRequest,
  | 'personality'
  | 'serviceTier'
  | 'agentOutsideWorkspaceWriteEnabled'
  | 'codexDestructiveCommandProtectionEnabled'
  | 'codexIsolatedHomeEnabled'
>

export const defaultCodexChatSettings: CodexChatSettings = {
  codexPersonality: 'default',
  codexFastMode: false,
  agentOutsideWorkspaceWriteEnabled: true,
  codexDestructiveCommandProtectionEnabled: true,
  codexIsolatedHomeEnabled: true,
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
    }
  }

  return {
    agentOutsideWorkspaceWriteEnabled: settings.agentOutsideWorkspaceWriteEnabled,
    codexDestructiveCommandProtectionEnabled: settings.codexDestructiveCommandProtectionEnabled,
    codexIsolatedHomeEnabled: settings.codexIsolatedHomeEnabled,
    ...(settings.codexPersonality === 'default'
      ? {}
      : { personality: settings.codexPersonality }),
    ...(settings.codexFastMode ? { serviceTier: 'priority' as const } : {}),
  }
}
