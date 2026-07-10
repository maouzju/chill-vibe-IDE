import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildCodexChatRequestOverrides } from '../shared/codex-chat-settings.ts'

describe('Codex chat request settings', () => {
  it('omits optional overrides when settings follow Codex defaults', () => {
    assert.deepEqual(
      buildCodexChatRequestOverrides('codex', {
        codexPersonality: 'default',
        codexFastMode: false,
      }),
      {},
    )
  })

  it('maps personality and Fast mode to current app-server turn fields', () => {
    assert.deepEqual(
      buildCodexChatRequestOverrides('codex', {
        codexPersonality: 'pragmatic',
        codexFastMode: true,
      }),
      {
        personality: 'pragmatic',
        serviceTier: 'priority',
      },
    )
  })

  it('never sends Codex-only overrides to Claude', () => {
    assert.deepEqual(
      buildCodexChatRequestOverrides('claude', {
        codexPersonality: 'friendly',
        codexFastMode: true,
      }),
      {},
    )
  })
})
