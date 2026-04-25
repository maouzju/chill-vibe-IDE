# Stream Recovery Feedback — Requirements

## Context

When a streaming chat reply is interrupted and the recoverable-retry loop kicks in, the current UI shows nothing to the user. The assistant bubble goes quiet for several seconds (or fails silently after 6 retries). Users cannot tell whether the app is hung, reconnecting, or permanently failed.

Related pitfalls (AGENTS.md):
- **#22** — some Claude streams end without `message_stop`, triggering a recoverable retry.
- **#60** — placeholder deltas like `Reconnecting... n/5` must not reset the retry budget.
- **#91** — Codex can emit only reconnect placeholders before exit; treat as recoverable but not against retry budget.

## User-facing goal

When a chat card's stream enters recovery, the user sees a short status line **inside the streaming assistant bubble** — not a toast, not a global banner.

## Functional requirements

1. **Reconnecting state** — When `onError` receives a recoverable error and a retry is scheduled, the card's streaming indicator must show `正在重连… n/6` (or English equivalent) with the current retry attempt count.
2. **Resumed state** — When real assistant output resumes (i.e. the next `onData` event passes `shouldResetStreamRecoveryAttemptsForText` / `shouldResetStreamRecoveryAttemptsForActivity`), the status line briefly shows `已恢复` (~2s) then disappears so the normal streaming indicator resumes.
3. **Failed state** — When retry budget is exhausted (`retryCount >= 6`) or an unrecoverable final error arrives, the status line shows `重连失败` and stays until the card leaves streaming status. The existing error-message append in the transcript is still written.
4. **Dead resumed-session escape hatch** — If the same provider session repeatedly resumes into placeholder-only `Reconnecting... n/5` output, Chill Vibe must stop reusing that provider `sessionId`, start a fresh provider session, and replay the visible transcript so the user is not trapped in a dead archive.
5. **No extra persistence** — Recovery state is per-session in-memory only. It resets on app restart.
6. **No toast, no global alert** — Per user decision, feedback lives inside the assistant bubble area only.
7. **User retry budget honored** - The in-app chat recovery loop must use the same `resilientProxyMaxRetries` setting shown in Settings -> Routing -> Auto-retry. `-1` means unlimited recoverable retries instead of silently falling back to the hard-coded default.
8. **Runtime proxy settings are live** - Changes to stall timeout, first-byte timeout, and max retries must be synced to the Electron backend/proxy runtime immediately; otherwise long chats keep using stale retry behavior until a restart.
9. **Stats reflect local reconnects** - When Codex emits native `Reconnecting... n/5` placeholders before a recoverable local-stream retry, Settings -> Routing -> Auto-retry stats must count a disconnect immediately, and automated recovery attempts must not inflate the request count.

## Non-goals

- General recovery retry transport logic (already exists in `resilient-proxy.ts` and `App.tsx:onError`), except for the dead resumed-session escape hatch above.
- `InterruptedSessionEntry` restore menu (already exists on startup).
- Global notification / toast infrastructure.

## Theme / UI

Must render correctly in both light and dark themes. Reuse existing `streaming-indicator` layout and token colors.
