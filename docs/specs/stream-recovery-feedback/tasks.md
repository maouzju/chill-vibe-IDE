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

## Slice 5 - Codex native placeholder handling

12. Treat stderr-only and JSON-RPC-error-only Codex native `Reconnecting... n/5` diagnostics as recovery control signals.
13. Keep those diagnostics out of final user-visible error text and record one local reconnect disconnect stat.
14. Add focused provider tests for stderr-only and JSON-RPC-error-only placeholder suppression and stats.

## Slice 6 - active resume and silent-stall recovery

15. Add focused provider tests showing an `active` Codex `thread/resume` still receives a follow-up blank `turn/start`.
16. Implement the active-resume continuation path so recovered cards cannot remain on `Thinking` with no terminal event.
17. Add focused provider tests for a local Codex stream that accepts `turn/start` but emits no visible output or terminal event before the first-byte timeout.
18. Implement the local stream stall watchdog and classify the timeout as recoverable `resume-session`, pausing it while command activity is in progress.

## Slice 7 - verification

19. Run `pnpm test` and confirm green.
20. Run `pnpm test:quality` (narrow scope).
21. Restart the active runtime (Electron via `pnpm dev:restart`).
22. Update handoff notes.
