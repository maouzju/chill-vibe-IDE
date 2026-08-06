# Design: Codex Multi-Agent UI Parity

## Reference behavior

The implementation follows Codex CLI `0.144.1` rather than the older screenshot-oriented first slice.

Codex keeps a per-thread event store, recognizes v2 `subAgentActivity` items, separates root and child notifications by `threadId`, and derives a bounded `/agent` status view from recent child activity. Chill Vibe will reproduce those behavioral contracts in its existing app-server stream architecture.

## Data model

Extend the existing `agents` structured activity without changing the persisted card schema.

```ts
type StreamAgentEntry = {
  threadId: string
  nickname?: string
  role?: string
  path?: string
  status: StreamAgentStatus
  message?: string | null
  activity?: string[]
}

type StreamAgentsActivity = {
  itemId: string
  kind: 'agents'
  status: 'completed'
  view?: 'toolCall' | 'status'
  tool?: StreamAgentTool
  callStatus?: StreamAgentToolCallStatus
  prompt?: string | null
  model?: string | null
  reasoningEffort?: string | null
  agents: StreamAgentEntry[]
}
```

`view` is optional so saved first-slice payloads remain valid and default to `toolCall`. A live panel uses `view: 'status'`, a stable `itemId`, and agents filtered to the currently running set.

## Server-side tracker

Add a small pure tracker module owned by the Codex app-server adapter.

### State

- root thread id;
- child metadata keyed by thread id;
- stable first-seen order;
- canonical path, nickname, role, and lifecycle status;
- latest six previewable items per child, deduplicated by item id;
- whether the root turn has completed while children remain active.

### Routing rules

1. A root `thread/started` notification may establish the root id.
2. A `thread/started` notification with `parentThreadId` registers a child only when its parent is the root or an already tracked child.
3. Any `subAgentActivity` item registers or updates its target child and canonical path. This also covers nested descendants.
   The live panel includes a running child as soon as `thread/started` provides its nickname/role/thread id; canonical path is enrichment, not a visibility prerequisite.
4. Once the root id is known, notifications carrying a different tracked `threadId` are consumed by the child tracker and are not passed to the normal parent parser.
5. Child deltas are not forwarded as parent assistant deltas. Completed child items provide the bounded preview instead.
6. Root `turn/completed` completes the normal run only when no child is active. Otherwise it records deferred completion and the process stays attached.
7. When the final active child settles, deferred root completion is released exactly once.
8. Deferring completion must not disable every recovery ceiling. An independent absolute-hard-cap timer starts when child work becomes active and is cleared only after the child set settles or the run finishes.

### Status mapping

- child thread/turn active or `subAgentActivity.started` -> `running`;
- turn completed or thread idle -> `completed`;
- turn interrupted or `subAgentActivity.interrupted` -> `interrupted`;
- failed turn or system error -> `errored`;
- thread closed/not loaded -> `shutdown`;
- metadata-only child before a turn begins -> `pendingInit`.

Only `pendingInit` and `running` entries appear in the live running panel. The tracker retains settled metadata during the process lifetime so a later interaction can reactivate the same entry without changing its original order.

## Preview summarization

Implement a pure summary function mirroring `codex-rs/tui/src/app/agent_status_feed.rs`:

- normalize whitespace;
- truncate to 240 Unicode grapheme clusters;
- never include command output or raw reasoning;
- retain no more than six unique item summaries;
- update, rather than duplicate, an item when both started and completed events arrive;
- send the renderer the ordered summaries, oldest to newest.

The renderer joins the summaries as separate quiet lines and visually clamps the block to the latest three lines, matching the CLI's bounded status view.

## Rendering

`StructuredAgentsCard` supports two variants:

### Tool-call history (`view: 'toolCall'` or missing)

- Keep legacy spawn/send/resume/wait/close information.
- Use Codex naming syntax `Nickname [role]`.
- Keep prompt, model/effort, call status, result message, and error states.
- Remove the unsupported disabled `Open` control and mention hint.

### Live status (`view: 'status'`)

- Header: `Sub-agents running` / `正在运行的子智能体`.
- Empty state: `No sub-agents running.` / `没有正在运行的子智能体。`.
- Row title: canonical path in a code-like accent treatment, falling back to nickname/role/thread id.
- Body: latest bounded activity; if empty, `No recent activity yet.`.
- Running status remains explicit and accessible.

Use the existing structured-card tokens and minimal seams. The panel updates in place through the existing message-id upsert path.

## Local slash commands

Add Codex-native local aliases `agent` and `subagents` to the provider slash-command list. Handling is local:

- never send the slash command to the model;
- append a snapshot of the latest live-status payload;
- when no payload exists, append the localized empty status panel;
- allow invocation while the parent stream is active without stopping or steering it.

## Testing strategy

### Red-first unit tests

1. Child `thread/started` does not replace the root session.
2. Child deltas/items do not leak into the parent transcript.
3. Child `turn/completed` does not finish the parent run.
4. Root completion waits for active children and releases after the final child settles.
5. Nested agents and first-seen ordering remain stable.
6. Preview categories, bounds, whitespace normalization, reasoning privacy, and item-id dedupe match Codex CLI.
7. Old structured payloads still parse.
8. Renderer shows status and empty variants with no `Open` button or mention hint.
9. `/agent` and `/subagents` are local commands and do not launch a provider request.

### Verification

- focused Node tests first;
- `pnpm test:quality`;
- theme coverage in both light and dark;
- narrow Playwright/Electron flow with a fake app-server emitting root plus child notifications;
- broader regression only as justified by the provider-stream and UI surface risk;
- `pnpm electron:build` after the bug-risk changes are verified.
