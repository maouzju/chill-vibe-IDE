# Agent Run Duration Summary — Requirements

## Problem

Agent replies can take seconds or minutes, but once a run finishes the chat gives no compact indication of how long it took. Users have to estimate from the clock or logs.

## User-visible behavior

1. After an agent run reaches a terminal state, append one quiet, single-line summary at the end of that run.
2. Chinese copy uses the form `已运行 3分钟24秒`; English uses `Ran for 3m 24s`.
3. Durations below one minute show seconds only. Durations of one hour or more include hours, minutes, and seconds while omitting zero-value middle units when they are not needed.
4. The summary is visually smaller and quieter than assistant content. It must not look like a chat bubble, alert, badge, or actionable control.
5. The summary appears after normal completion, manual interruption, and terminal stream failure. Recoverable reconnect attempts remain part of the same run and must not reset the timer.
6. The summary is persisted with the conversation so reopening the card keeps it visible.
7. Duration summaries are UI bookkeeping and must never be replayed to Codex or Claude as conversation context.

## Compatibility and safety

- Existing saved conversations without duration summaries continue to load unchanged.
- No new card-level persisted field is required.
- The summary must render correctly in both light and dark themes and at narrow widths.
- A completed run produces at most one duration summary.
