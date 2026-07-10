import type { AppSettings, ChatRequest, Provider } from './schema.js'

export type CodexChatSettings = Pick<AppSettings, 'codexPersonality' | 'codexFastMode'>
type CodexChatRequestOverrides = Pick<ChatRequest, 'personality' | 'serviceTier'>

export const defaultCodexChatSettings: CodexChatSettings = {
  codexPersonality: 'default',
  codexFastMode: false,
}

export const buildCodexChatRequestOverrides = (
  provider: Provider,
  settings: CodexChatSettings,
): Partial<CodexChatRequestOverrides> => {
  if (provider !== 'codex') {
    return {}
  }

  return {
    ...(settings.codexPersonality === 'default'
      ? {}
      : { personality: settings.codexPersonality }),
    ...(settings.codexFastMode ? { serviceTier: 'priority' as const } : {}),
  }
}
