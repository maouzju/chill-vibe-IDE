import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultSystemPrompt } from '../shared/system-prompt.ts'
import type { ChatRequest } from '../shared/schema.ts'
import { expandCodexNativeSlashPrompt } from '../server/providers.ts'

const createRequest = (prompt: string): ChatRequest => ({
  provider: 'codex',
  workspacePath: 'D:/Git/chill-vibe',
  model: 'gpt-5.4',
  reasoningEffort: 'medium',
  thinkingEnabled: true,
  planMode: false,
  language: 'en',
  systemPrompt: defaultSystemPrompt,
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
  prompt,
  attachments: [],
})

test('expandCodexNativeSlashPrompt rewrites /init into a project-instructions prompt', () => {
  const prompt = expandCodexNativeSlashPrompt(
    createRequest('/init Refresh the project guidance for contributors.'),
  )

  assert.match(prompt, /refresh the project instructions/i)
  assert.match(prompt, /AGENTS\.md/)
  assert.match(prompt, /README|docs/i)
  assert.match(prompt, /Refresh the project guidance for contributors\./)
  assert.doesNotMatch(prompt, /^\/init\b/)
})

test('expandCodexNativeSlashPrompt rewrites /plan into a planning prompt', () => {
  const prompt = expandCodexNativeSlashPrompt(
    createRequest('/plan Map the implementation steps for this bug fix.'),
  )

  assert.match(prompt, /produce a concrete implementation plan/i)
  assert.match(prompt, /do not make code changes yet/i)
  assert.match(prompt, /Map the implementation steps for this bug fix\./)
  assert.doesNotMatch(prompt, /^\/plan\b/)
})

test('expandCodexNativeSlashPrompt leaves unrelated prompts unchanged', () => {
  const prompt = expandCodexNativeSlashPrompt(createRequest('Investigate this bug normally.'))

  assert.equal(prompt, 'Investigate this bug normally.')
})
