import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  getBrainstormCardStatus,
  normalizeBrainstormAnswerCount,
  resolveBrainstormRequestTarget,
} from '../src/components/brainstorm-card-utils.ts'

describe('brainstorm card utils', () => {
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
        model: 'gpt-5.4',
      }),
      { provider: 'codex', model: 'gpt-5.4' },
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
        model: 'gpt-5.4',
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
        model: 'gpt-5.4',
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
