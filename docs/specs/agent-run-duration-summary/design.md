# Agent Run Duration Summary — Design

## Data representation

Persist the result as a lightweight system message:

```ts
{
  role: 'system',
  content: '',
  meta: {
    kind: 'run-duration',
    durationMs: '204000'
  }
}
```

`chatMessageSchema.meta` already accepts string records, so this is backward-compatible and needs no schema migration. Seeded transcript replay already excludes system messages, which keeps this bookkeeping out of provider prompts.

## Timing lifecycle

- Record `Date.now()` in a renderer ref when a card starts a new send.
- Keep the same start value through recoverable stream retries.
- Consume the start value once when the run completes, is stopped, or reaches a terminal error.
- If a renderer attaches to an already-running restored stream and has no start value, fall back to the most recent user-message timestamp; if that is invalid, use the attachment time.
- Clamp the stored duration to a finite non-negative integer and display at least one second for a completed visible run.

## Rendering

- `MessageBubble` detects `meta.kind === 'run-duration'` and renders a dedicated `.message-run-duration` line instead of the normal role header and message body.
- Formatting is handled by a pure helper so Chinese/English output and boundary cases are unit-testable.
- Styling uses existing ink tokens, no border/background/shadow, a small font, and modest transcript-aligned padding.

## Completion integration

- Normal/stopped `onDone`: append the duration marker after any stop notice or changes summary.
- Stop fallback without server acknowledgement: append the same marker after settling the stream.
- Terminal stream errors and request-start failures: append the marker after the error notice.
- Recoverable failures do not consume the timer.

## Verification

- Red-first unit tests for duration formatting and marker creation/consumption.
- Server-rendered component test proving the marker uses the compact dedicated line and does not render normal message chrome.
- Theme regression coverage for light/dark.
- `pnpm test:quality` and the narrow relevant test files.
