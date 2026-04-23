# Stream Recovery Feedback — Design

## Approach

Keep the change tightly scoped. Do **not** modify `chatCardSchema` or persistence. Track recovery state in a React `useState<Map<cardId, RecoveryStatus>>` inside `App.tsx`, expose it to `ChatCard` / `StreamingIndicator` via props, and clear it when the card leaves streaming status.

## New types (internal, not in schema)

```ts
type CardRecoveryStatus =
  | { kind: 'reconnecting'; attempt: number; max: number }
  | { kind: 'resumed' }     // shown briefly, auto-clears after ~2s
  | { kind: 'failed' }      // shown until card exits streaming
```

## Pure state-transition function

All state writes go through one helper — trivial to unit test red-first:

```ts
// src/stream-recovery-feedback.ts
export const computeRecoveryStatusAfterRetryScheduled = (
  currentAttempt: number,
  max: number,
): CardRecoveryStatus => ({ kind: 'reconnecting', attempt: currentAttempt + 1, max })

export const computeRecoveryStatusAfterSuccess = (
  previous: CardRecoveryStatus | undefined,
): CardRecoveryStatus | undefined =>
  previous?.kind === 'reconnecting' ? { kind: 'resumed' } : previous

export const computeRecoveryStatusAfterFinalFailure = (): CardRecoveryStatus =>
  ({ kind: 'failed' })

export const shouldClearRecoveryStatusOnStreamIdle = (
  previous: CardRecoveryStatus | undefined,
): boolean => previous?.kind !== 'failed' // keep failed until stream restarts
```

## Integration points

1. **`App.tsx`**:
   - Add `const [recoveryStatuses, setRecoveryStatuses] = useState<Map<string, CardRecoveryStatus>>(new Map())`.
   - In `onError` recoverable branch (before the `setTimeout`): call `computeRecoveryStatusAfterRetryScheduled`.
   - In `onError` final-failure branch: `computeRecoveryStatusAfterFinalFailure`.
   - In `onData` / the text/activity reset branch (wherever `shouldResetStreamRecoveryAttempts*` returns `true`): call `computeRecoveryStatusAfterSuccess` + schedule a 2s clear.
   - When a card transitions to `idle` after `streaming`: clear unless `failed` (use `shouldClearRecoveryStatusOnStreamIdle`).
   - Track consecutive `resume-session` retries whose provider output was only transient reconnect placeholder text. After a small threshold, clear the card's stale `sessionId`, start a fresh provider session, and seed the request with the visible transcript via `buildSeededChatPrompt`; filter placeholder reconnect messages out of that seeded transcript.

2. **Prop drilling**:
   - `App.tsx` → `ChatCard` (new optional prop `recoveryStatus?: CardRecoveryStatus`).
   - `ChatCard` → `StreamingIndicator` via the existing render site at ChatCard.tsx:876.

3. **`StreamingIndicator`** (`src/components/MessageBubble.tsx`):
   - Accept optional `recoveryStatus?: CardRecoveryStatus`.
   - If present, render a `<span className="streaming-recovery">` line below the dots with the localized label, replacing the default label while in `reconnecting`/`failed`. For `resumed` show the localized `已恢复` briefly.

4. **i18n**: add three keys in `shared/i18n.ts`:
   - `streamRecoveryReconnecting(attempt, max)` → `正在重连… ${n}/${max}` / `Reconnecting… ${n}/${max}`
   - `streamRecoveryResumed` → `已恢复` / `Resumed`
   - `streamRecoveryFailed` → `重连失败` / `Reconnect failed`

## Testing

### Tier 1 (logic) — red-first

Unit test `src/stream-recovery-feedback.ts`:
- Transition to `reconnecting` increments attempt count.
- `resumed` only emits when previous was `reconnecting` (no false positives on fresh streams).
- `failed` overrides `reconnecting`.
- `shouldClearRecoveryStatusOnStreamIdle` preserves `failed` but clears others.
- `shouldFallbackToFreshSessionAfterTransientResumeLoop` only triggers for recoverable `resume-session` placeholder-only loops at the configured threshold.
- `buildSeededChatPrompt` skips placeholder reconnect messages when replaying a fresh-session recovery prompt.

Register the new file in `tests/index.test.ts`.

### Tier 2 (UI) — theme check

Add/extend a `tests/theme-check.spec.ts` snapshot for `StreamingIndicator` with recovery status (optional — the indicator reuses existing `streaming-*` tokens, so if time presses the existing coverage is sufficient).

## Risk

- Low. No schema or persistence change. No new dependencies. Feature is additive and renders only while streaming.
- Pitfall #60 alignment: we deliberately tie the `resumed` transition to the *same* predicate (`shouldResetStreamRecoveryAttemptsForText` / `shouldResetStreamRecoveryAttemptsForActivity`) that governs retry-budget reset, so placeholder reconnect deltas cannot flip the bubble to `resumed`.
