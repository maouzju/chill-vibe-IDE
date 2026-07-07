import type { ChatRequest, StreamActivity, StreamErrorEvent, StreamErrorHint } from '../shared/schema.js'

// Whether a structured activity proves the turn actually produced output for the
// user. Reasoning/thinking is the model's internal monologue, so it does NOT
// count — otherwise enabling thinking (on by default) would mark every turn as
// "did work" and silently disable the typed-as-text tool-call recovery below
// (see shouldRecoverEmptyToolCallTurn). Every other activity (command, tool,
// edits, todo, compaction, ask-user, agents) is real, user-visible work.
export const structuredActivityCountsAsTurnOutput = (kind: StreamActivity['kind']): boolean =>
  kind !== 'reasoning'

const recoverableErrorPatterns = [
  'ended without emitting a terminal completion event',
  'closed before completion',
  'stream closed before',
  // The Anthropic SDK / Node fetch (undici) surfaces a dropped socket mid-stream
  // as "The socket connection was closed unexpectedly" — a transient network
  // disconnect in the same class as "closed before completion", so resume it.
  'socket connection was closed',
  'unexpected completion',
  'stalled without emitting stream output',
  'stalled after emitting stream output',
  'selected model is at capacity',
  'model is at capacity',
  // Anthropic intermittently returns stop_reason: tool_use with no tool_use
  // block, so the CLI's own retry fails and it surfaces "tool call could not be
  // parsed". Re-issuing a fresh turn usually succeeds, so treat it as resumable.
  'could not be parsed',
  // A proxy/gateway in front of Claude can intermittently return HTTP 200 with an
  // empty or malformed body; the CLI surfaces it as "API returned an empty or
  // malformed response". The turn produced no real output (only stray fragments
  // from the broken stream), so it is a transient upstream failure that should
  // auto-resume rather than dead-end the chat with an error bubble.
  'empty or malformed response',
] as const

const zeroExitPattern = /\b(?:codex|claude) exited with status code:\s*0\b/i

const recoverableSwitchConfigErrorPatterns = [
  'third-party apps now draw from your extra usage',
  'claim it at',
  'settings/usage',
  'keep going',
] as const

const isRecoverableSwitchConfigError = (normalizedMessage: string) =>
  recoverableSwitchConfigErrorPatterns.every((pattern) => normalizedMessage.includes(pattern))

export const classifyProviderStreamErrorRecovery = (
  request: Pick<ChatRequest, 'sessionId'>,
  message: string,
  hint?: StreamErrorHint,
): Pick<StreamErrorEvent, 'recoverable' | 'recoveryMode'> => {
  if (!request.sessionId?.trim()) {
    return {}
  }

  const normalizedMessage = message.trim().toLowerCase()
  if (!normalizedMessage) {
    return {}
  }

  const switchConfigRecoverable = isRecoverableSwitchConfigError(normalizedMessage)

  if (hint === 'env-setup' || (hint === 'switch-config' && !switchConfigRecoverable)) {
    return {}
  }

  if (
    switchConfigRecoverable ||
    recoverableErrorPatterns.some((pattern) => normalizedMessage.includes(pattern)) ||
    zeroExitPattern.test(normalizedMessage)
  ) {
    return {
      recoverable: true,
      recoveryMode: 'resume-session',
    }
  }

  return {}
}

// A Claude turn can "succeed" (non-error `result`) yet do no real work: the
// model may type a tool call as text instead of issuing a native tool_use block,
// the stripper removes that XML, and the UI is left with either an empty bubble
// or a misleading lead-in such as "先把任务设为进行中。". That prose alone is not
// proof that the requested action happened. If the turn contained a stripped
// tool-call block but produced no real structured activity, classify it as
// resumable so the bounded renderer retry machinery re-issues a fresh turn
// (Pitfall #141: re-issuing usually succeeds).
export const shouldRecoverEmptyToolCallTurn = (input: {
  consumedRealToolCallBlock: boolean
  sawStructuredActivity: boolean
  sawMeaningfulAssistantText: boolean
  hasSessionId: boolean
}): Pick<StreamErrorEvent, 'recoverable' | 'recoveryMode'> | null => {
  if (!input.hasSessionId) {
    return null
  }

  if (!input.consumedRealToolCallBlock) {
    return null
  }

  if (input.sawStructuredActivity) {
    return null
  }

  return {
    recoverable: true,
    recoveryMode: 'resume-session',
  }
}

// Decide how long the Claude stream may stay silent before the watchdog fires,
// or `null` to disarm. The claude CLI runs tools (e.g. Bash) internally and emits
// no stdout for the entire command duration, so while any command is in progress
// the watchdog must disarm and let the CLI own its own per-tool timeout —
// otherwise a legitimately long command would be false-killed. The same is true
// for a synchronously-awaited background tool (Workflow/subagent): `claude -p`
// waits for it (default cap 10 min via CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS) and
// streams nothing meanwhile, so the watchdog must stretch to that ceiling (or
// disarm when the wait is uncapped) instead of false-killing the CLI mid-run.
// With nothing in flight, a shorter first-byte window covers a launch that never
// produces output, and a longer between-events window covers a process that
// streamed something and then went silent without a terminal event (#42/#134).
// `absoluteHardCapMs` is a last-resort ceiling that bounds even the intentionally
// disarmed cases (an in-progress command, or an uncapped background-await). Those
// disarm the watchdog so a legitimately long command/workflow is never false-
// killed — but if the CLI process silently dies or wedges without ever emitting
// the command's `completed` event or a terminal result (child `close` never
// fires either), the disarm becomes permanent and the card spins in `streaming`
// forever (observed: 5 cards stuck, main.log silent 14 min). The hard cap sits
// far above any real command/workflow, so it only trips on genuine silent death.
export const resolveLocalStreamStallTimeoutMs = (input: {
  sawStreamOutput: boolean
  openCommandCount: number
  firstByteTimeoutMs: number
  stallTimeoutMs: number
  backgroundAwaitActive?: boolean
  backgroundAwaitTimeoutMs?: number | null
  absoluteHardCapMs?: number | null
}): number | null => {
  const hardCap =
    typeof input.absoluteHardCapMs === 'number' && input.absoluteHardCapMs > 0
      ? input.absoluteHardCapMs
      : null

  if (input.openCommandCount > 0) {
    return hardCap
  }

  if (input.backgroundAwaitActive) {
    // Honor the (shorter) background-await ceiling when present, else fall back
    // to the hard cap so an uncapped wait can never disarm the watchdog forever.
    return input.backgroundAwaitTimeoutMs ?? hardCap
  }

  return input.sawStreamOutput ? input.stallTimeoutMs : input.firstByteTimeoutMs
}
