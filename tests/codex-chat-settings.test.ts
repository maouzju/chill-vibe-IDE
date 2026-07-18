import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildCodexChatRequestOverrides } from '../shared/codex-chat-settings.ts'
import { chatRequestSchema } from '../shared/schema.ts'

describe('Agent chat request settings', () => {
  it('defaults parsed Codex safety request fields on for older callers', () => {
    const request = chatRequestSchema.parse({
      provider: 'codex',
      workspacePath: 'D:/repo',
      prompt: 'Inspect this workspace.',
    })

    assert.equal(request.codexDestructiveCommandProtectionEnabled, true)
    assert.equal(request.codexIsolatedHomeEnabled, true)
  })

  it('omits optional overrides when settings follow Codex defaults', () => {
    assert.deepEqual(
      buildCodexChatRequestOverrides('codex', {
        codexPersonality: 'default',
        codexFastMode: false,
        codexDestructiveCommandProtectionEnabled: true,
        codexIsolatedHomeEnabled: true,
      }),
      {
        codexDestructiveCommandProtectionEnabled: true,
        codexIsolatedHomeEnabled: true,
      },
    )
  })

  it('maps personality and Fast mode to current app-server turn fields', () => {
    assert.deepEqual(
      buildCodexChatRequestOverrides('codex', {
        codexPersonality: 'pragmatic',
        codexFastMode: true,
        codexDestructiveCommandProtectionEnabled: false,
        codexIsolatedHomeEnabled: false,
      }),
      {
        personality: 'pragmatic',
        serviceTier: 'priority',
        codexDestructiveCommandProtectionEnabled: false,
        codexIsolatedHomeEnabled: false,
      },
    )
  })

  it('sends the shared destructive-command protection setting to Claude without Codex-only overrides', () => {
    assert.deepEqual(
      buildCodexChatRequestOverrides('claude', {
        codexPersonality: 'friendly',
        codexFastMode: true,
        codexDestructiveCommandProtectionEnabled: true,
        codexIsolatedHomeEnabled: true,
      }),
      {
        codexDestructiveCommandProtectionEnabled: true,
      },
    )

    assert.deepEqual(
      buildCodexChatRequestOverrides('claude', {
        codexPersonality: 'default',
        codexFastMode: false,
        codexDestructiveCommandProtectionEnabled: false,
        codexIsolatedHomeEnabled: true,
      }),
      {
        codexDestructiveCommandProtectionEnabled: false,
      },
    )
  })
})
