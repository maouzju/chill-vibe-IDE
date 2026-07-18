import assert from 'node:assert/strict'
import test from 'node:test'

import { buildClaudeKeepaliveSignature } from '../server/providers.ts'
import type { ChatRequest } from '../shared/schema.ts'

const request = {
  provider: 'claude',
  prompt: 'test',
  workspacePath: process.cwd(),
  attachments: [],
  model: '',
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: '',
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
} satisfies ChatRequest

test('Claude keepalive signature changes with runtime environment and attachment authorization directories', () => {
  const runtime = { args: [], env: { API_KEY: 'first' } }
  const first = buildClaudeKeepaliveSignature(request, true, runtime, ['C:\\images-a\\one.png'])
  const changedEnv = buildClaudeKeepaliveSignature(
    request,
    true,
    { ...runtime, env: { API_KEY: 'second' } },
    ['C:\\images-a\\one.png'],
  )
  const changedAttachmentDirectory = buildClaudeKeepaliveSignature(
    request,
    true,
    runtime,
    ['C:\\images-b\\two.png'],
  )

  assert.notEqual(first, changedEnv)
  assert.notEqual(first, changedAttachmentDirectory)
  assert.equal(
    buildClaudeKeepaliveSignature(
      request,
      true,
      { args: [], env: { SECOND: '2', FIRST: '1' } },
    ),
    buildClaudeKeepaliveSignature(
      request,
      true,
      { args: [], env: { FIRST: '1', SECOND: '2' } },
    ),
  )
})
