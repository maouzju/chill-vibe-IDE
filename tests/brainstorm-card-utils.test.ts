import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  getBrainstormCardStatus,
  normalizeBrainstormAnswerCount,
  resolveBrainstormRequestTarget,
} from '../src/components/brainstorm-card-utils.ts'

describe('brainstorm card utils', () => {
  // 2026-10-15：头脑风暴下拉里能选 Gemini，但目标解析把非 claude 一律压回 codex，选了等于没选。
  it('keeps a Gemini request target instead of collapsing it to Codex', () => {
    assert.deepEqual(resolveBrainstormRequestTarget({ provider: 'gemini', model: 'gemini-4-argon' }), {
      provider: 'gemini',
      model: 'gemini-4-argon',
    })
    assert.deepEqual(resolveBrainstormRequestTarget({ provider: 'gemini', model: '' }), {
      provider: 'gemini',
      model: 'gemini-3.8-flash',
    })
  })

  it('normalizes the adjustable answer count into a safe range', () => {
    assert.equal(normalizeBrainstormAnswerCount(undefined), 6)
    assert.equal(normalizeBrainstormAnswerCount(0), 1)
    assert.equal(normalizeBrainstormAnswerCount(6.8), 6)
    assert.equal(normalizeBrainstormAnswerCount(24), 12)
  })

  it('resolves the per-card request target without changing the brainstorm tool model', () => {
    assert.deepEqual(
      resolveBrainstormRequestTarget({
        provider: 'codex',
        model: 'gpt-5.5',
      }),
      { provider: 'codex', model: 'gpt-5.5' },
    )

    assert.deepEqual(
      resolveBrainstormRequestTarget({
        provider: 'claude',
        model: 'claude-sonnet-4-6',
      }),
      { provider: 'claude', model: 'claude-sonnet-4-6' },
    )

    assert.deepEqual(
      resolveBrainstormRequestTarget(
        {
          provider: 'codex',
          model: '',
        },
        'gpt-5.5',
      ),
      { provider: 'codex', model: 'gpt-5.5' },
    )
  })

  it('keeps answer-level failures from marking the whole brainstorm card as error', () => {
    assert.equal(
      getBrainstormCardStatus({
        prompt: 'topic',
        provider: 'codex',
        model: 'gpt-5.5',
        answerCount: 2,
        failedAnswers: [],
        answers: [
          { id: 'a', content: 'Idea A', status: 'done', error: '' },
          { id: 'b', content: '', status: 'error', error: 'failed' },
        ],
      }),
      'idle',
    )

    assert.equal(
      getBrainstormCardStatus({
        prompt: 'topic',
        provider: 'codex',
        model: 'gpt-5.5',
        answerCount: 2,
        failedAnswers: [],
        answers: [
          { id: 'a', content: '', status: 'streaming', streamId: 'stream-a', error: '' },
        ],
      }),
      'streaming',
    )
  })
})
