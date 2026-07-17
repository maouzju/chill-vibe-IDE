import type { AppSettings, ChatRequest, Provider } from './schema.js'

export type CodexChatSettings = Pick<
  AppSettings,
  | 'codexPersonality'
  | 'codexFastMode'
  | 'codexDestructiveCommandProtectionEnabled'
  | 'codexIsolatedHomeEnabled'
>
type CodexChatRequestOverrides = Pick<
  ChatRequest,
  | 'personality'
  | 'serviceTier'
  | 'codexDestructiveCommandProtectionEnabled'
  | 'codexIsolatedHomeEnabled'
>

export const defaultCodexChatSettings: CodexChatSettings = {
  codexPersonality: 'default',
  codexFastMode: false,
  codexDestructiveCommandProtectionEnabled: true,
  codexIsolatedHomeEnabled: true,
}

export const buildCodexChatRequestOverrides = (
  provider: Provider,
  settings: CodexChatSettings,
): Partial<CodexChatRequestOverrides> => {
  if (provider !== 'codex') {
    return {}
  }

  return {
    codexDestructiveCommandProtectionEnabled: settings.codexDestructiveCommandProtectionEnabled,
    codexIsolatedHomeEnabled: settings.codexIsolatedHomeEnabled,
    ...(settings.codexPersonality === 'default'
      ? {}
      : { personality: settings.codexPersonality }),
    ...(settings.codexFastMode ? { serviceTier: 'priority' as const } : {}),
  }
}
