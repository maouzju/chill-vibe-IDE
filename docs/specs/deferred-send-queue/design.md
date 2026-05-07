# Design — Deferred Send Queue

## Scope

Keep the queue in renderer runtime state. The persisted chat schema stays unchanged.

## State

`App.tsx` already has a per-card `queuedSendRequestsRef`. Promote it from an invisible implementation detail to a small runtime queue model:

- each item has `id`, `prompt`, and `attachments`
- React state mirrors lightweight queue summaries per card so the UI can render count/preview
- the full attachments stay in the ref and are not persisted

## Sending behavior

1. `ChatCard` uploads pending image attachments exactly like a normal send before handing the request to `App.tsx`.
2. `onSend` accepts an optional mode:
   - `auto`: idle cards send now; streaming cards interrupt and send now unless a special case must wait
   - `defer`: always enqueue for a streaming card; idle cards may send normally
   - `interrupt`: send immediately, stopping the running stream if needed
3. Ordinary click and Enter use `auto`, so a normal running-card send behaves like send-now/interruption.
4. Send-button right-click uses `defer` and prevents the browser context menu.
5. Ask-user follow-up sends keep their existing immediate-stop behavior.
6. `/compact` follow-ups continue to wait until compaction finishes.
7. When a stream reaches `done`, `error`, or `Stream not found`, `dispatchNextQueuedSend()` starts the next queued item.

## UI

`ChatCard` receives a queue summary and two actions:

- `queuedSendSummary?: { count: number; nextPreview: string }`
- `onCancelQueuedSends?: () => void`
- `onSendNextQueuedNow?: () => void`

The composer renders a quiet status row under the input:

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
- Run the focused spec via the repo Playwright wrapper.
- Run `pnpm test:quality` to prove TypeScript/ESLint.
