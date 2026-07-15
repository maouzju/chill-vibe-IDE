# Design — Deferred Send Queue

## Scope

Persist the queue on its owning `ChatCard` so the existing app-state save/restore path carries it across renderer reloads and full IDE restarts. Keep the current renderer ref as the low-churn dispatch cache, but make every queue mutation update both the cache and the persisted card field through the reducer.

## State

Add a shared `queuedSendRequestSchema` and a `queuedSends` array on `chatCardSchema`:

- each item has `id`, `prompt`, and `attachments`
- `createCard()` defaults the field to an empty array
- persisted-state normalization restores valid items, drops malformed/empty entries, and defaults legacy cards to an empty queue
- uploaded attachment metadata is persisted with the prompt; image bytes remain in the existing attachment store

`App.tsx` keeps the existing per-card `queuedSendRequestsRef` and lightweight React summaries for dispatch/UI performance. `commitLoadedState()` repopulates both from `queuedSends`, and enqueue/dequeue/cancel mutations synchronously update the ref, summary, and reducer state before requesting an immediate save.

## Sending behavior

1. `ChatCard` uploads pending image attachments exactly like a normal send before handing the request to `App.tsx`.
2. `onSend` accepts an optional mode:
   - `auto`: idle cards send now; streaming cards interrupt and send now unless a special case must wait
   - `defer`: always enqueue for a streaming card; idle cards may send normally
   - `interrupt`: send immediately, stopping the running stream if needed
3. Ordinary click and Enter use `auto`, so a normal running-card send behaves like send-now/interruption.
4. Send-button right-click uses `defer` and prevents the browser context menu.
5. Ask-user follow-up sends keep their existing immediate-stop behavior, including restored ask-user cards whose old stream may not emit a final `done` event after `stop`, or whose stale stream id is already missing from the backend.
6. `/compact` follow-ups continue to wait until compaction finishes.
7. When a stream reaches `done`, `error`, or `Stream not found`, `dispatchNextQueuedSend()` starts the next queued item.
8. Startup hydration restores the queue but does not dispatch merely because the restored card is idle. A resumed interrupted stream still reaches the normal completion path and dispatches FIFO; otherwise the restored controls remain available for an explicit user choice.
9. Conversation reset and card/workspace removal clear the owning queue. Moving a card preserves it because the data travels with the card.

## UI

`ChatCard` receives a queue summary and two actions:

- `queuedSendSummary?: { count: number; nextPreview: string }`
- `onCancelQueuedSends?: () => void`
- `onSendNextQueuedNow?: () => void`

The composer renders a quiet status row above the input:

- count + preview
- **Send now** text button
- **Cancel** text button
- a hover tooltip on the send button that explains left-click sends now and right-click sends later while the card is running

Use existing theme tokens and subdued composer-note styling so the queue does not become louder than message content.

## Validation

- Add focused Playwright coverage for:
  1. left-click while streaming stops the current answer and sends immediately
  2. right-click while streaming queues
  3. queued message can be cancelled
  4. queued message can be sent now
  5. queued FIFO sends after stream completion
- Add focused unit coverage proving:
  1. a queued prompt and its attachment metadata survive save/load normalization
  2. legacy and malformed persisted queues normalize safely
  3. loaded queues rebuild the runtime cache/summary without auto-dispatch
- Run the focused spec via the repo Playwright wrapper.
- Run `pnpm test:quality` to prove TypeScript/ESLint.
