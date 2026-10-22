import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  filterSlashCommands,
  formatLocalSlashHelp,
  getSlashCommandDescription,
  getLocalSlashCommands,
  getSlashCompletionQuery,
  isLocalSlashCommandInput,
  parseSlashCommandInput,
} from '../shared/slash-commands.ts'

describe('slash command helpers', () => {
  it('filters by name prefix first, then name substring, then description (so Chinese queries find skills)', () => {
    const commands = [
      { name: 'plan', description: 'inspect plan', source: 'native' as const },
      { name: 'predict-needs', description: '预判需求：蒸馏用户画像', source: 'skill' as const },
      { name: 'release-pipeline', description: 'Audit and publish', source: 'skill' as const },
      { name: 'pipeline-x', description: undefined, source: 'skill' as const },
    ]
    assert.deepEqual(filterSlashCommands(commands, 'pre').map((c) => c.name), ['predict-needs'])
    assert.deepEqual(filterSlashCommands(commands, 'pipe').map((c) => c.name), ['pipeline-x', 'release-pipeline'])
    assert.deepEqual(filterSlashCommands(commands, '预判').map((c) => c.name), ['predict-needs'])
    assert.deepEqual(filterSlashCommands(commands, '预判需求').map((c) => c.name), ['predict-needs'])
    assert.deepEqual(filterSlashCommands(commands, '').map((c) => c.name), commands.map((c) => c.name))
    assert.deepEqual(filterSlashCommands(commands, 'zzz'), [])
  })

  it('parses slash command names and arguments', () => {
    assert.deepEqual(parseSlashCommandInput('/MODEL sonnet'), {
      name: 'model',
      args: 'sonnet',
    })
    assert.deepEqual(parseSlashCommandInput(' /status '), {
      name: 'status',
      args: '',
    })
    assert.equal(parseSlashCommandInput('plain text'), null)
  })

  it('extracts completion queries and recognizes local commands', () => {
    assert.equal(getSlashCompletionQuery('  /Sta'), 'sta')
    assert.equal(getSlashCompletionQuery('/model opus 4.7'), null)
    assert.equal(isLocalSlashCommandInput('/help'), true)
    assert.equal(isLocalSlashCommandInput('/plan'), false)
  })

  it('formats help text and slash command descriptions', () => {
    assert.match(formatLocalSlashHelp('claude', 'en'), /Claude native slash commands/i)
    assert.equal(
      getSlashCommandDescription('claude', 'cost', 'native', 'en'),
      'show cost and usage summary',
    )
    assert.equal(
      getSlashCommandDescription('codex', 'compact', 'native', 'en'),
      'compact the current session context',
    )
    assert.equal(
      getSlashCommandDescription('codex', 'agent', 'native', 'en'),
      'show and inspect sub-agent status',
    )
    assert.equal(
      getSlashCommandDescription('codex', 'help', 'app', 'en'),
      'show this help',
    )
  })

  it('keeps /compact out of app-local slash interception', () => {
    assert.equal(isLocalSlashCommandInput('/compact'), false)
    assert.ok(getLocalSlashCommands('en').every((command) => command.name !== 'compact'))
  })
})
