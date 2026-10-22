import { filterSlashCommands, getSlashCompletionQuery } from '../../shared/slash-commands'
import type { SlashCommand } from '../../shared/schema'

export const filterAutomationBoardSlashCommands = (
  draft: string,
  commands: SlashCommand[],
) => {
  const query = getSlashCompletionQuery(draft)
  if (query === null) return []
  return filterSlashCommands(commands, query)
}

export const applyAutomationBoardSlashCompletion = (command: SlashCommand) =>
  `/${command.name} `
