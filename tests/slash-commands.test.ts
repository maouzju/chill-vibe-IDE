import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  formatLocalSlashHelp,
  getSlashCommandDescription,
  getLocalSlashCommands,
  getSlashCompletionQuery,
  isLocalSlashCommandInput,
  parseSlashCommandInput,
} from '../shared/slash-commands.ts'

describe('slash command helpers', () => {
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
      getSlashCommandDescription('codex', 'help', 'app', 'en'),
      'show this help',
    )
  })

  it('keeps /compact out of app-local slash interception', () => {
    assert.equal(isLocalSlashCommandInput('/compact'), false)
    assert.ok(getLocalSlashCommands('en').every((command) => command.name !== 'compact'))
  })
})
