import type { AppLanguage, Provider, SlashCommand, SlashCommandRequest } from '../../shared/schema'

type SlashCommandsLoadKeyInput = Pick<
  SlashCommandRequest,
  'provider' | 'workspacePath' | 'language' | 'crossProviderSkillReuseEnabled'
>

export const getSlashCommandsLoadKey = ({
  provider,
  workspacePath,
  language,
  crossProviderSkillReuseEnabled,
}: SlashCommandsLoadKeyInput) =>
  [
    provider,
    workspacePath.trim(),
    language,
    crossProviderSkillReuseEnabled ? 'reuse' : 'isolated',
  ].join('\u0000')

export const shouldStartSlashCommandsLoad = (
  currentLoadKey: string | null,
  nextLoadKey: string,
) => currentLoadKey !== nextLoadKey

export const resolveSlashCommandsLoadKeyAfterCancel = (
  currentLoadKey: string | null,
  cancelledLoadKey: string,
) => currentLoadKey === cancelledLoadKey ? null : currentLoadKey

export const resolveRemoteSlashCommands = (
  commands: SlashCommand[],
  localCommands: SlashCommand[],
) => commands.length > 0 ? commands : localCommands

export const areSlashCommandListsEqual = (
  previous: SlashCommand[],
  next: SlashCommand[],
) => {
  if (previous === next) {
    return true
  }

  if (previous.length !== next.length) {
    return false
  }

  return previous.every((command, index) => {
    const nextCommand = next[index]
    return (
      nextCommand !== undefined &&
      command.name === nextCommand.name &&
      command.description === nextCommand.description &&
      command.source === nextCommand.source
    )
  })
}

export type SlashCommandsLoadRequest = {
  provider: Provider
  workspacePath: string
  language: AppLanguage
  crossProviderSkillReuseEnabled: boolean
}
