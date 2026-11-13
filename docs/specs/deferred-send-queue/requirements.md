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
8A. **Only a user-requested compaction makes a follow-up wait** (added 2026-08-16) — The wait in #8 covers compaction the user asked for (`/compact` typed by hand). Auto-compaction that the app injects mid-stream must never make ordinary sends wait: the user never asked for it and usually cannot even see it, so their message would silently sit in the queue for the rest of a long run. Long sessions trigger auto-compaction most often, which is exactly why this surfaced as "the longer it streams, the more my messages turn into deferred ones".
8B. **A compaction the app runs before sending also makes follow-ups wait — but only while it is running** (added 2026-11-12) — When a chat is close to filling its context window, the app sends `/compact` as a turn of its own right before the user's message goes out (`docs/specs/context-usage-auto-compact`). That turn does nothing but compact and the user's message is already queued behind it, so an ordinary send submitted while it runs queues behind it too instead of interrupting: interrupting would throw the compaction away and send into the same nearly-full context. This is deliberately narrower than the exclusion in #8A: it applies only while that exact compaction turn is the card's active stream. Once the turn ends — finished, failed, or stopped — its boundary no longer makes anything wait. The explicit **Send now** action still interrupts it (#14).
9. **Restart persistence** — Queued prompts and uploaded image-attachment metadata are stored with their owning chat card and survive renderer reloads and full IDE restarts.
10. **Safe startup behavior** — Restored items stay visibly queued; reopening the IDE alone must not send them. If the interrupted run is resumed, the existing FIFO auto-dispatch continues after that run finishes. Otherwise the user can still choose **Send now** or **Cancel**.
11. **Intentional cleanup only** — Resetting the conversation, closing its card/workspace, cancelling the queue, or resetting app state removes the stored queue. Moving the card between columns does not.
12. **Fast interrupt safety** — When left-click send interrupts an in-flight answer, the interrupted provider session must not be resumed immediately. The queued follow-up starts from the settled visible transcript in a fresh native session, avoiding partially written Codex rollout files and equivalent interrupted-session races.
13. **Lost-terminal fallback** — If stopping a stale running card succeeds but its renderer subscription never receives `done`, left-click send must still settle that exact old stream and dispatch the queued follow-up after a short grace period. A newer stream must never be finalized by the fallback.
14. **Compaction escape hatch** — Ordinary follow-ups submitted while `/compact` is genuinely running still wait for compaction, but the queue's explicit **Send now** action must always interrupt the stale compaction stream and dispatch the selected prompt. A remembered `/compact` boundary must never make **Send now** requeue the same prompt forever.

## Non-goals

- Reordering individual queued messages in this slice.
- A global queue across cards/columns.
