import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SlashCommand } from '../shared/schema.ts'
import {
  applyAutomationBoardSlashCompletion,
  filterAutomationBoardSlashCommands,
} from '../src/components/automation-board-slash-commands.ts'

const commands: SlashCommand[] = [
  { name: 'help', description: 'Help', source: 'app' },
  { name: 'plan', description: 'Plan', source: 'native' },
  { name: 'project-review', description: 'Review', source: 'skill' },
]

test('automation board requirement slash completion filters a leading command query', () => {
  assert.deepEqual(filterAutomationBoardSlashCommands('/pl', commands), [commands[1]])
  assert.deepEqual(filterAutomationBoardSlashCommands('/', commands), commands)
  assert.deepEqual(filterAutomationBoardSlashCommands('write /pl', commands), [])
})

test('automation board slash completion inserts a trailing space without submitting', () => {
  assert.equal(applyAutomationBoardSlashCompletion(commands[2]), '/project-review ')
})
