import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SlashCommand } from '../shared/schema.ts'
import {
  areSlashCommandListsEqual,
  getSlashCommandsLoadKey,
  resolveSlashMenuDismissedAfterQueryChange,
  resolveRemoteSlashCommands,
  resolveSlashCommandsLoadKeyAfterCancel,
  shouldStartSlashCommandsLoad,
} from '../src/components/chat-card-slash-commands.ts'

const createRequest = (overrides: Partial<Parameters<typeof getSlashCommandsLoadKey>[0]> = {}) => ({
  provider: 'codex' as const,
  workspacePath: 'D:/workspace',
  language: 'en' as const,
  crossProviderSkillReuseEnabled: true,
  ...overrides,
})

test('slash command load key is stable for the same effective request', () => {
  assert.equal(
    getSlashCommandsLoadKey(createRequest({ workspacePath: '  D:/workspace  ' })),
    getSlashCommandsLoadKey(createRequest({ workspacePath: 'D:/workspace' })),
  )
})

test('slash command loader only starts again when the effective request changes', () => {
  const currentKey = getSlashCommandsLoadKey(createRequest())

  assert.equal(shouldStartSlashCommandsLoad(null, currentKey), true)
  assert.equal(shouldStartSlashCommandsLoad(currentKey, currentKey), false)
  assert.equal(
    shouldStartSlashCommandsLoad(
      currentKey,
      getSlashCommandsLoadKey(createRequest({ language: 'zh-CN' })),
    ),
    true,
  )
})

test('cancelling an in-flight slash command load allows the same request to restart', () => {
  const currentKey = getSlashCommandsLoadKey(createRequest())
  const newerKey = getSlashCommandsLoadKey(createRequest({ language: 'zh-CN' }))

  assert.equal(resolveSlashCommandsLoadKeyAfterCancel(currentKey, currentKey), null)
  assert.equal(resolveSlashCommandsLoadKeyAfterCancel(newerKey, currentKey), newerKey)
})

test('slash menu query reset is idempotent when the menu is already open', () => {
  assert.equal(resolveSlashMenuDismissedAfterQueryChange(false), false)
  assert.equal(resolveSlashMenuDismissedAfterQueryChange(true), false)
})

test('slash command list equality keeps identical results idempotent', () => {
  const previous: SlashCommand[] = [
    { name: 'help', description: 'Help', source: 'app' },
    { name: 'plan', description: 'Plan', source: 'skill' },
  ]
  const next: SlashCommand[] = [
    { name: 'help', description: 'Help', source: 'app' },
    { name: 'plan', description: 'Plan', source: 'skill' },
  ]

  assert.equal(areSlashCommandListsEqual(previous, next), true)
  assert.equal(
    areSlashCommandListsEqual(previous, [
      { name: 'help', description: 'Help', source: 'app' },
      { name: 'plan', description: 'Plan this', source: 'skill' },
    ]),
    false,
  )
})

test('empty native slash command results fall back to local app commands', () => {
  const localCommands: SlashCommand[] = [
    { name: 'help', description: 'Help', source: 'app' },
  ]

  assert.equal(resolveRemoteSlashCommands([], localCommands), localCommands)
  assert.deepEqual(resolveRemoteSlashCommands([
    { name: 'compact', description: 'Compact', source: 'native' },
  ], localCommands), [
    { name: 'compact', description: 'Compact', source: 'native' },
  ])
})
