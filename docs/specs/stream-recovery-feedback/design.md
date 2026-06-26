# Stream Recovery Feedback — Design

## Approach

Keep the change tightly scoped. Do **not** modify `chatCardSchema` or persistence. Track recovery state in a React `useState<Map<cardId, RecoveryStatus>>` inside `App.tsx`, expose it to `ChatCard` / `StreamingIndicator` via props, and clear it when the card leaves streaming status.

## New types (internal, not in schema)

```ts
type CardRecoveryStatus =
  | { kind: 'reconnecting'; attempt: number; max: number | 'unlimited' }
  | { kind: 'resumed' }     // shown briefly, auto-clears after ~2s
  | { kind: 'failed' }      // shown until card exits streaming
```

## Pure state-transition function

All state writes go through one helper — trivial to unit test red-first:

```ts
// src/stream-recovery-feedback.ts
export const computeRecoveryStatusAfterRetryScheduled = (
  currentAttempt: number,
  max: number | 'unlimited',
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
   - Fresh-session seeded prompts must preserve long user-authored transcript turns in full. The size budget may still omit older non-protected turns and compact structured/tool output, but it must not silently drop the middle of a pasted multi-hundred-line user prompt.
   - Treat Codex app-server stale-session resume errors (`failed to load rollout`, `no rollout found`, `no session path found`, `empty session file`) as recoverable by dropping the stale `sessionId`, logging the automatic fresh-session notice, and starting a new thread for the same prompt/attachments.
   - When `thread/resume` returns a thread in `active` or `idle` state for a recovered Codex session, always send a follow-up blank `turn/start` so the stream has a real terminal path.
   - Resolve the UI retry ceiling from `settings.resilientProxyMaxRetries` via `getRecoverableStreamRetryLimit()`. The value `-1` maps to `Infinity`, so long conversations do not stop after the old hard-coded six attempts when the user intentionally selected unlimited retries.
   - Keep the visible reconnect attempt separate from the retry-budget counter for placeholder-only/transient retries. Those retries still must not consume the budget, but the label should advance from `1/无限` to `2/无限`, `3/无限`, etc. so the user can tell recovery is still actively looping.

2. **Runtime proxy settings sync**:
   - `shouldSyncRuntimeSettings()` treats `resilientProxyStallTimeoutSec`, `resilientProxyFirstByteTimeoutSec`, and `resilientProxyMaxRetries` like routing settings.
   - `syncRuntimeSettings()` updates `setProviderRuntimeSettingsOverride()` and reconfigures the singleton `resilientProxyPool`, disposing existing proxy listeners when timeout/retry settings change.
   - `resolveProviderRuntime()` passes the current timeout/retry values into `resilientProxyPool.resolveBaseUrl()` so newly created provider proxies use the live settings.

3. **Prop drilling**:
   - `App.tsx` → `ChatCard` (new optional prop `recoveryStatus?: CardRecoveryStatus`).
   - `ChatCard` → `StreamingIndicator` via the existing render site at ChatCard.tsx:876.

4. **`StreamingIndicator`** (`src/components/MessageBubble.tsx`):
   - Accept optional `recoveryStatus?: CardRecoveryStatus`.
   - If present, render a `<span className="streaming-recovery">` line below the dots with the localized label, replacing the default label while in `reconnecting`/`failed`. For `resumed` show the localized `已恢复` briefly.

5. **Local recovery stats bridge**:
   - Provider runs may emit an in-band `stats` stream event for local-only recovery signals that happen before the terminal `error` event. The first native reconnect placeholder maps to one `disconnect` stat with `errorType: 'native-reconnect-placeholder'`, including when the placeholder is seen only in a Codex JSON-RPC error response or stderr diagnostics.
   - Codex app-server records native reconnect placeholder disconnects into the backend proxy-stats store immediately and marks the emitted stream stats payload as `alreadyRecorded`; `App.tsx` still updates its in-memory local recovery state but skips a second `recordProxyStatsEvent()` write for that payload.
   - Later recoverable `onError` handling still runs through `noteLocalRecoveryDisconnect()` so local recovery state is consistent and duplicate disconnect stats are not emitted.
   - Auto recovery retries call `beginOrContinueLocalRecoveryStatsRun()` instead of always starting a new run, so request counts describe user-visible chat requests rather than every internal retry.

6. **Provider capacity recovery**:
   - `classifyProviderStreamErrorRecovery()` treats model-capacity messages as recoverable only when a session id is available.
   - Codex app-server JSON-RPC failures after `thread/start` and Claude `result.is_error` failures both pass the emitted session id into that classifier, so transient capacity pressure resumes the existing conversation instead of ending the card.
   - `ChatManager` also attaches the latest backend-known session id to recoverable `resume-session` error events. The renderer patches that id into the card before choosing the recovery mode, covering the race where `session` and `error` arrive close together and persistence has not yet caught up.

7. **Native reconnect placeholder suppression**:
   - `item/agentMessage/delta` chunks, `item/completed` assistant messages, JSON-RPC error responses, and stderr diagnostic lines that are only Codex native `Reconnecting... n/5` placeholders are treated as recovery control signals.
   - These placeholders update recovery/stats state, but they are not forwarded as visible `delta`, `assistant_message`, or final error text and are not replayed into fresh-session seeded prompts.

8. **Silent local-provider stall watchdog**:
   - After a Codex `turn/start` request is accepted, start a local first-byte watchdog. Reset it whenever a visible delta, assistant message, or completed non-command activity arrives.
   - Pause the watchdog while a command activity is `in_progress`, because long local commands can legitimately run without producing additional stream output.
   - If the watchdog fires before visible output or a terminal event, emit `Codex stalled without emitting stream output.` and classify it as recoverable `resume-session`.
   - If visible output happened and the stream later goes quiet outside an in-progress command, emit `Codex stalled after emitting stream output.` through the same recoverable path.

9. **Renderer/window lifetime cleanup**:
   - Electron main owns stream subscription cleanup by `BrowserWindow` / `WebContents` lifetime.
   - Cleanup runs on `close`, `closed`, `webContents.destroyed`, and `render-process-gone`, so provider stream events stop before they can keep sending into a destroyed renderer.
   - `sendChatStreamEventSafely()` checks both `isDestroyed()` and `isCrashed()` before forwarding events.

10. **Interrupted-session resume pacing**:
   - Startup recovery resumes interrupted sessions in small batches instead of starting every provider run at once.
   - This reduces simultaneous stream events, React updates, and queued persistence writes after a crash/reopen.

11. **i18n**: add three keys in `shared/i18n.ts`:
   - `streamRecoveryReconnecting(attempt, max)` → finite retries: `正在重连… ${n}/${max}` / `Reconnecting… ${n}/${max}`; unlimited retries: `正在重连… ${n}/无限` / `Reconnecting… ${n}/unlimited`.
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
- `buildSeededChatPrompt` keeps long user-authored historical prompts intact while still bounding noisy replay content such as structured tool output.
- Codex app-server JSON-RPC-error-only and stderr-only placeholder diagnostics produce recoverable failure text, stay out of user-visible errors, and record one disconnect stat.
- Codex app-server silent stalls produce a recoverable resume-session error instead of timing out forever.
- Codex active resumed threads start a blank follow-up turn, matching the idle resumed-thread path.

Register the new file in `tests/index.test.ts`.

### Tier 2 (UI) — theme check

Add/extend a `tests/theme-check.spec.ts` snapshot for `StreamingIndicator` with recovery status (optional — the indicator reuses existing `streaming-*` tokens, so if time presses the existing coverage is sufficient).

## Risk

- Low. No schema or persistence change. No new dependencies. Feature is additive and renders only while streaming.
- Pitfall #60 alignment: we deliberately tie the `resumed` transition to the *same* predicate (`shouldResetStreamRecoveryAttemptsForText` / `shouldResetStreamRecoveryAttemptsForActivity`) that governs retry-budget reset, so placeholder reconnect deltas cannot flip the bubble to `resumed`.
