import { getSlashCompletionQuery } from '../../shared/slash-commands'
import type { SlashCommand } from '../../shared/schema'

export const filterAutomationBoardSlashCommands = (
  draft: string,
  commands: SlashCommand[],
) => {
  const query = getSlashCompletionQuery(draft)
  if (query === null) return []
  return query ? commands.filter((command) => command.name.startsWith(query)) : commands
}

export const applyAutomationBoardSlashCompletion = (command: SlashCommand) =>
  `/${command.name} `
