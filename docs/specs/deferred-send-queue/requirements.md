# Requirements — Deferred Send Queue

## Problem

When a chat card is already streaming, clicking **Send message** currently behaves like an interrupt/replacement flow for ordinary follow-up text. The user wants the default running-card behavior to match VS Code Codex: right-clicking the send button should mean **defer this message**, and queued messages should be sent automatically when the agent finishes the current answer.

## Goals

1. **Right-click sends later** — Right-clicking the composer send button while a card is streaming queues the current composer text/attachments instead of interrupting the active agent run.
2. **Running-card default** — Clicking Send while a card is streaming also queues the message by default so users can safely stack follow-ups without stopping the active answer.
3. **Automatic dispatch** — When the active agent run finishes, the queued messages are sent one at a time in FIFO order.
4. **Visible queue** — The composer shows the queued count and the oldest queued message preview while any queued message exists.
5. **Cancel** — Users can cancel queued messages before they are sent.
6. **Send now** — Users can immediately send the next queued message, which intentionally stops the current run if one is still streaming and starts that queued prompt now.
7. **Hover hint** — Hovering the send button explains that running-card sends are queued for later, including the right-click behavior.
8. **Existing special cases stay safe** — Ask-user answers still stop the waiting stream and send immediately; `/compact` follow-ups still wait for compaction completion.
9. **No persistence requirement** — The queue is runtime-only and may be cleared by reload/reset/closing the card.

## Non-goals

- Persisting queued messages across app restarts.
- Reordering individual queued messages in this slice.
- A global queue across cards/columns.
