# Design: Codex Multi-Agent UI

## Data path

Codex app-server v2 exposes collaboration tool calls as `ThreadItem` entries with `type: "collabAgentToolCall"`. The relevant shape is:

- `tool`: `spawnAgent | sendInput | resumeAgent | wait | closeAgent`
- `status`: `inProgress | completed | failed`
- `receiverThreadIds`: target child threads
- `prompt`, `model`, `reasoningEffort`
- `agentsStates`: map of thread id to `{ status, message }`

The existing server parser `server/codex-structured-output.ts` already maps `item.started` / `item.completed` events into `StreamActivity`. Add a new activity kind `agents` that preserves normalized collab fields.

## Rendering

Reuse the existing structured message path:

1. `parseCodexResponseEvent()` emits `StreamActivity` kind `agents`.
2. `createStructuredActivityMessage()` stores the payload in `message.meta.structuredData`.
3. `parseStructuredAgentsMessage()` reads it in the renderer.
4. `StructuredAgentsCard` renders a compact panel.

For wait activity, render the screenshot-like group:

- Header: icon + `N background agents` / `N 个后台智能体` + helper text `use @ to mention agents`.
- Rows: `nickname (role)` + status + `Open` button.
- The `Open` button is disabled for now and labelled as a coming backend handoff if clicked support is not present.

For single-agent operations such as spawn/send/resume/close, render a concise structured row with the target agent and optional prompt preview.

## Styling

Use existing structured card tokens:

- `--structured-card-bg`
- `--structured-card-border`
- `--structured-group-bg`
- `--ink-*`
- `--accent-*`
- `--danger`
- `--warn`

The surface should be compact like command/tool rows and not introduce a loud dashboard card.

## Testing

- Unit-level server parser test: `collabAgentToolCall` events produce `agents` activity.
- Renderer parsing/rendering test: structured agents payload renders rows and status labels.
- Narrow quality verification: targeted unit tests, then `pnpm test:quality` if feasible.
- Theme verification: prefer `pnpm test:theme`; if Playwright runner hits the known Windows discovery bug, report it and rely on token-based styling plus unit markup coverage.
