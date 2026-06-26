import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyProviderStreamErrorRecovery,
  resolveLocalStreamStallTimeoutMs,
  shouldRecoverEmptyToolCallTurn,
  structuredActivityCountsAsTurnOutput,
} from '../server/provider-stream-recovery.ts'

test('provider unexpected completion with an existing session becomes resumable', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      'Claude ended without emitting a terminal completion event.',
    ),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})


test('provider zero status exit after a live session is resumable', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      'Codex exited with status code: 0',
    ),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})


test('capacity errors after a live session are resumable', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      'Selected model is at capacity. Please try a different model.',
    ),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})

test('third-party extra-usage 403 after a live session is resumable because credits can be claimed externally', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      'Failed to authenticate. API Error: 403 {"error":{"message":"Third-party apps now draw from your extra usage, not your plan limits. We\'ve added a $200 credit to get you started. Claim it at ***.ai/settings/usage and keep going.","type":"<nil>"},"type":"error"}',
      'switch-config',
    ),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})

test('Anthropic malformed tool-call turns after a live session are resumable', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      "The model's tool call could not be parsed (retry also failed).",
    ),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})

test('the malformed tool-call retry prompt itself is also treated as resumable', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      'Your tool call was malformed and could not be parsed. Please retry.',
    ),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})

test('a mid-stream socket disconnect after a live session is resumable', () => {
  // The Anthropic SDK / Node fetch (undici) surfaces a dropped socket mid-stream
  // as "The socket connection was closed unexpectedly". That is a transient
  // network disconnect (same class as "closed before completion"), so with an
  // existing session it should auto-resume instead of dead-ending the chat.
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      'API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
    ),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})

test('an empty or malformed HTTP 200 upstream response after a live session is resumable', () => {
  // A proxy/gateway in front of Claude can intermittently return HTTP 200 with an
  // empty or malformed body, and the CLI surfaces it verbatim as
  // "API returned an empty or malformed response (HTTP 200)". That is a transient
  // upstream failure in the same class as a dropped socket: the turn produced no
  // real assistant output, so with an existing session it must auto-resume
  // instead of dead-ending the chat with a stray error bubble and the half
  // fragments left over from the broken stream.
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      'API Error: API returned an empty or malformed response (HTTP 200) — check for a proxy or gateway intercepting the request',
    ),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})

test('setup and routing errors stay non-recoverable even with a session', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      'Codex exited with status code: 1',
      'switch-config',
    ),
    {},
  )
})

test('errors without a session id are not resumable', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: undefined,
      },
      'Claude ended without emitting a terminal completion event.',
    ),
    {},
  )
})

test('a turn whose only output was a tool call typed as text is auto-resumed', () => {
  // Claude typed a tool call as prose (so nothing executed), the stripper removed
  // it, and no real activity or text survived. The non-error `result` would
  // otherwise dead-end the chat ("老是停住"); classify it as resumable so the
  // bounded renderer retry machinery re-issues a fresh turn.
  assert.deepEqual(
    shouldRecoverEmptyToolCallTurn({
      consumedRealToolCallBlock: true,
      sawStructuredActivity: false,
      sawMeaningfulAssistantText: false,
      hasSessionId: true,
    }),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})

test('a turn that actually ran a tool is not treated as a dead-end', () => {
  assert.equal(
    shouldRecoverEmptyToolCallTurn({
      consumedRealToolCallBlock: true,
      sawStructuredActivity: true,
      sawMeaningfulAssistantText: false,
      hasSessionId: true,
    }),
    null,
  )
})

test('assistant prose alone does not prevent malformed typed-tool recovery', () => {
  assert.deepEqual(
    shouldRecoverEmptyToolCallTurn({
      consumedRealToolCallBlock: true,
      sawStructuredActivity: false,
      sawMeaningfulAssistantText: true,
      hasSessionId: true,
    }),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})

test('a Claude turn with only prose plus a stripped typed tool call is auto-resumed', () => {
  // Claude can emit a small lead-in such as "先把任务设为进行中。" and then type a
  // tool call as XML instead of issuing a native tool_use block. The prose alone
  // is not enough proof that the requested work happened; if no real structured
  // activity followed, the renderer should resume the session instead of ending
  // on a misleading chat bubble.
  assert.deepEqual(
    shouldRecoverEmptyToolCallTurn({
      consumedRealToolCallBlock: true,
      sawStructuredActivity: false,
      sawMeaningfulAssistantText: true,
      hasSessionId: true,
    }),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})

test('an ordinary empty turn with no stripped tool call is not auto-resumed', () => {
  assert.equal(
    shouldRecoverEmptyToolCallTurn({
      consumedRealToolCallBlock: false,
      sawStructuredActivity: false,
      sawMeaningfulAssistantText: false,
      hasSessionId: true,
    }),
    null,
  )
})

test('a dead-end tool-call turn without a session id cannot be resumed', () => {
  assert.equal(
    shouldRecoverEmptyToolCallTurn({
      consumedRealToolCallBlock: true,
      sawStructuredActivity: false,
      sawMeaningfulAssistantText: false,
      hasSessionId: false,
    }),
    null,
  )
})

test('stall watchdog disarms while a tool command is running (CLI owns its own timeout)', () => {
  // While the claude CLI executes a Bash command it emits no stdout for the whole
  // command duration. Arming the watchdog then would false-kill a legitimately
  // long command, so it must disarm (null) whenever a command is in progress.
  assert.equal(
    resolveLocalStreamStallTimeoutMs({
      sawStreamOutput: true,
      openCommandCount: 1,
      firstByteTimeoutMs: 90_000,
      stallTimeoutMs: 120_000,
    }),
    null,
  )
})

test('stall watchdog uses the between-events timeout once output has started', () => {
  assert.equal(
    resolveLocalStreamStallTimeoutMs({
      sawStreamOutput: true,
      openCommandCount: 0,
      firstByteTimeoutMs: 90_000,
      stallTimeoutMs: 120_000,
    }),
    120_000,
  )
})

test('stall watchdog uses the first-byte timeout before any output arrives', () => {
  assert.equal(
    resolveLocalStreamStallTimeoutMs({
      sawStreamOutput: false,
      openCommandCount: 0,
      firstByteTimeoutMs: 90_000,
      stallTimeoutMs: 120_000,
    }),
    90_000,
  )
})

test('reasoning activity does not count as turn output, while real work does', () => {
  // Reasoning/thinking is the model's internal monologue, not user-facing work.
  // It must NOT mark the turn as having produced output, or enabling thinking
  // (now on by default) would silently disable the typed-as-text tool-call
  // recovery whenever a turn also emits a thinking block.
  assert.equal(structuredActivityCountsAsTurnOutput('reasoning'), false)
  assert.equal(structuredActivityCountsAsTurnOutput('command'), true)
  assert.equal(structuredActivityCountsAsTurnOutput('tool'), true)
  assert.equal(structuredActivityCountsAsTurnOutput('edits'), true)
  assert.equal(structuredActivityCountsAsTurnOutput('todo'), true)
  assert.equal(structuredActivityCountsAsTurnOutput('compaction'), true)
  assert.equal(structuredActivityCountsAsTurnOutput('ask-user'), true)
  assert.equal(structuredActivityCountsAsTurnOutput('agents'), true)
})

test('a turn that only emitted thinking plus a phantom tool call still recovers', () => {
  // Mirror the providers.ts fold: only non-reasoning activities flip the flag,
  // so a thinking-only turn whose sole concrete output was a stripped
  // (typed-as-text) tool call must still auto-resume.
  const sawStructuredActivity = (['reasoning'] as const).some(structuredActivityCountsAsTurnOutput)

  assert.deepEqual(
    shouldRecoverEmptyToolCallTurn({
      consumedRealToolCallBlock: true,
      sawStructuredActivity,
      sawMeaningfulAssistantText: false,
      hasSessionId: true,
    }),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})
