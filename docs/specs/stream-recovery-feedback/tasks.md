# Stream Recovery Feedback — Tasks

## Slice 1 — pure transition helpers (red → green)

1. Create `tests/stream-recovery-feedback.test.ts` with failing cases for:
   - `computeRecoveryStatusAfterRetryScheduled` produces `{ kind: 'reconnecting', attempt: retryCount + 1, max }`.
   - `computeRecoveryStatusAfterSuccess` returns `{ kind: 'resumed' }` only when previous was `reconnecting`; returns previous otherwise.
   - `computeRecoveryStatusAfterFinalFailure` returns `{ kind: 'failed' }`.
   - `shouldClearRecoveryStatusOnStreamIdle` returns false for `failed`, true for others / undefined.
2. Register the new test in `tests/index.test.ts`.
3. Run — confirm red.
4. Create `src/stream-recovery-feedback.ts` with the helpers.
5. Run — confirm green.

## Slice 2 — i18n

6. Add `streamRecoveryReconnecting`, `streamRecoveryResumed`, `streamRecoveryFailed` to the `LocaleText` type and both zh-CN and en-US dictionaries in `shared/i18n.ts`.

## Slice 3 — UI wiring

7. Update `StreamingIndicator` in `src/components/MessageBubble.tsx` to accept `recoveryStatus` prop and render the localized label when present.
8. Thread `recoveryStatus` from `ChatCardView` → `ChatTranscript` → `StreamingIndicator`.

## Slice 4 — App.tsx state management

9. Add `recoveryStatuses` state in `App.tsx`.
10. Dispatch on:
    - `onError` recoverable branch → `reconnecting`.
    - `onError` final failure (including retry budget exhaustion) → `failed`.
    - `onData` when a reset predicate returns true for the card → `resumed` + schedule 2s timer to clear.
    - Card transitions from `streaming` → non-streaming: clear via `shouldClearRecoveryStatusOnStreamIdle`.
11. Pass `recoveryStatus={recoveryStatuses.get(card.id)}` to each `ChatCardView`.

## Slice 5 — verification

12. Run `pnpm test` and confirm green.
13. Run `pnpm test:quality` (narrow scope).
14. Restart the active runtime (Electron via `pnpm dev:restart`).
15. Update handoff notes.
