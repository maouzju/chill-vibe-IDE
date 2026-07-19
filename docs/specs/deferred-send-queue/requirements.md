# Requirements — Deferred Send Queue

## Problem

When a chat card is already streaming, clicking **Send message** currently behaves like an interrupt/replacement flow for ordinary follow-up text. The user wants the default running-card behavior to match VS Code Codex: right-clicking the send button should mean **defer this message**, and queued messages should be sent automatically when the agent finishes the current answer.

## Goals

1. **Right-click sends later** — Right-clicking the composer send button while a card is streaming queues the current composer text/attachments instead of interrupting the active agent run.
2. **Left-click sends now** - Left-clicking the composer send button while a card is streaming intentionally stops the current answer and sends the composer message immediately.
3. **Automatic dispatch** — When the active agent run finishes, the queued messages are sent one at a time in FIFO order.
4. **Visible queue** — The composer shows the queued count and the oldest queued message preview while any queued message exists.
5. **Cancel** — Users can cancel queued messages before they are sent.
6. **Send now** — Users can immediately send the next queued message, which intentionally stops the current run if one is still streaming and starts that queued prompt now.
7. **Hover hint** - Hovering the send button explains that left-click sends now and right-click sends later while the card is running.
8. **Existing special cases stay safe** — Ask-user answers still stop the waiting stream and send immediately; `/compact` follow-ups still wait for compaction completion.
9. **Restart persistence** — Queued prompts and uploaded image-attachment metadata are stored with their owning chat card and survive renderer reloads and full IDE restarts.
10. **Safe startup behavior** — Restored items stay visibly queued; reopening the IDE alone must not send them. If the interrupted run is resumed, the existing FIFO auto-dispatch continues after that run finishes. Otherwise the user can still choose **Send now** or **Cancel**.
11. **Intentional cleanup only** — Resetting the conversation, closing its card/workspace, cancelling the queue, or resetting app state removes the stored queue. Moving the card between columns does not.
12. **Fast interrupt safety** — When left-click send interrupts an in-flight answer, the interrupted provider session must not be resumed immediately. The queued follow-up starts from the settled visible transcript in a fresh native session, avoiding partially written Codex rollout files and equivalent interrupted-session races.

## Non-goals

- Reordering individual queued messages in this slice.
- A global queue across cards/columns.
