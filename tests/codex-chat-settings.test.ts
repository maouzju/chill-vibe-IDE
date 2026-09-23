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

    assert.equal(request.agentOutsideWorkspaceWriteEnabled, true)
    assert.equal(request.codexDestructiveCommandProtectionEnabled, true)
    assert.equal(request.codexIsolatedHomeEnabled, true)
  })

  it('defaults computer use off on parsed requests from older callers', () => {
    const request = chatRequestSchema.parse({
      provider: 'claude',
      workspacePath: 'D:/repo',
      prompt: 'Open the site.',
    })
    assert.notEqual(request.computerUseEnabled, true, '省略 = 关闭')
  })

  it('forwards computerUseEnabled to both Claude and Codex requests', () => {
    const settings = {
      codexPersonality: 'default' as const,
      codexFastMode: false,
      agentOutsideWorkspaceWriteEnabled: true,
      codexDestructiveCommandProtectionEnabled: true,
      attackPatternProtectionEnabled: false,
      codexIsolatedHomeEnabled: true,
      computerUseEnabled: true,
    }
    assert.equal(buildCodexChatRequestOverrides('claude', settings).computerUseEnabled, true)
    assert.equal(buildCodexChatRequestOverrides('codex', settings).computerUseEnabled, true)
    assert.equal(
      'computerUseEnabled' in buildCodexChatRequestOverrides('codex', { ...settings, computerUseEnabled: false }),
      false,
      '关闭时省略字段，请求 schema 默认 false',
    )
  })

  it('omits optional overrides when settings follow Codex defaults', () => {
    assert.deepEqual(
      buildCodexChatRequestOverrides('codex', {
        codexPersonality: 'default',
        codexFastMode: false,
        agentOutsideWorkspaceWriteEnabled: true,
        codexDestructiveCommandProtectionEnabled: true,
        attackPatternProtectionEnabled: false,
        codexIsolatedHomeEnabled: true,
        computerUseEnabled: false,
      }),
      {
        agentOutsideWorkspaceWriteEnabled: true,
        codexDestructiveCommandProtectionEnabled: true,
        attackPatternProtectionEnabled: false,
        codexIsolatedHomeEnabled: true,
      },
    )
  })

  it('maps personality and Fast mode to current app-server turn fields', () => {
    assert.deepEqual(
      buildCodexChatRequestOverrides('codex', {
        codexPersonality: 'pragmatic',
        codexFastMode: true,
        agentOutsideWorkspaceWriteEnabled: false,
        codexDestructiveCommandProtectionEnabled: false,
        attackPatternProtectionEnabled: true,
        codexIsolatedHomeEnabled: false,
        computerUseEnabled: false,
      }),
      {
        personality: 'pragmatic',
        serviceTier: 'priority',
        agentOutsideWorkspaceWriteEnabled: false,
        codexDestructiveCommandProtectionEnabled: false,
        attackPatternProtectionEnabled: true,
        codexIsolatedHomeEnabled: false,
      },
    )
  })

  it('sends the shared destructive-command protection setting to Claude without Codex-only overrides', () => {
    assert.deepEqual(
      buildCodexChatRequestOverrides('claude', {
        codexPersonality: 'friendly',
        codexFastMode: true,
        agentOutsideWorkspaceWriteEnabled: false,
        codexDestructiveCommandProtectionEnabled: true,
        attackPatternProtectionEnabled: false,
        codexIsolatedHomeEnabled: true,
        computerUseEnabled: false,
      }),
      {
        agentOutsideWorkspaceWriteEnabled: false,
        codexDestructiveCommandProtectionEnabled: true,
        attackPatternProtectionEnabled: false,
      },
    )

    assert.deepEqual(
      buildCodexChatRequestOverrides('claude', {
        codexPersonality: 'default',
        codexFastMode: false,
        agentOutsideWorkspaceWriteEnabled: true,
        codexDestructiveCommandProtectionEnabled: false,
        attackPatternProtectionEnabled: false,
        codexIsolatedHomeEnabled: true,
        computerUseEnabled: false,
      }),
      {
        agentOutsideWorkspaceWriteEnabled: true,
        codexDestructiveCommandProtectionEnabled: false,
        attackPatternProtectionEnabled: false,
      },
    )
  })
})
