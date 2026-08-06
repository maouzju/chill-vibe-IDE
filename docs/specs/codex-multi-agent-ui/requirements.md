# Requirements: Codex Multi-Agent UI Parity

## Background

Codex CLI `0.144.1` exposes two related multi-agent surfaces:

1. collaboration history rows for spawn, send-input, resume, wait, close, and v2 sub-agent lifecycle events;
2. a bounded `/agent` status view that lists currently running v2 sub-agents by canonical path and shows their latest useful activity.

Chill Vibe already parses legacy `collabAgentToolCall` items, but the current card is only a tool-call snapshot. It does not route child-thread notifications separately, understand `subAgentActivity`, retain bounded child activity, or protect the parent stream from a child `turn/completed` notification. The existing disabled `Open` control and mention hint also do not match the current Codex CLI v2 status surface.

The source of truth for this SPEC is the installed Codex CLI (`codex-cli 0.144.1`) and the matching official `openai/codex` tag `rust-v0.144.1` (commit `44918ea10c0f99151c6710411b4322c2f5c96bea`), especially:

- `codex-rs/tui/src/multi_agents.rs`
- `codex-rs/tui/src/app/agent_status_feed.rs`
- `codex-rs/tui/src/app/session_lifecycle.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`

## User stories

1. As a user, when Codex creates one or more sub-agents, I can see a single quiet live panel rather than raw JSON or a flood of child-thread messages.
2. As a user, I can identify nested sub-agents by their canonical paths, such as `/root/reviewer`.
3. As a user, I can see the latest meaningful work for every running sub-agent, such as a command, reasoning summary, file update, tool call, search, or short response.
4. As a user, child-agent output never appears as if it were the parent agent's answer.
5. As a user, the parent chat does not finish early merely because one child agent finished its own turn.
6. As a user, legacy Codex collaboration calls still render their historical spawn/send/wait/resume/close result correctly.
7. As a user, `/agent` and `/subagents` show the latest locally known status without sending a prompt to the model.

## Acceptance criteria

### Event routing and lifecycle

- `thread/started` notifications with `thread.parentThreadId` are treated as child threads and never replace the card's parent `sessionId`.
- `item/started`, `item/completed`, delta, turn, status, and close notifications whose `threadId` belongs to a child are routed to the child tracker instead of the parent transcript.
- A child `turn/completed` notification never calls the parent stream's completion path.
- If the parent turn completes while tracked children are still running, the provider process remains attached until those children settle or the user stops the run.
- While that completion is deferred, a separate absolute hard cap remains armed; a silent child cannot leave the card streaming forever.
- Nested sub-agents are supported when a known child creates another child.
- Unknown or malformed child events are ignored safely and do not corrupt the parent session.

### Live status panel

- A stable structured activity id is reused for the live status panel, so updates replace the same message instead of adding an unbounded sequence of cards.
- Running agents remain in first-seen spawn order.
- Each entry exposes `threadId`, canonical `path` when available, status, and bounded activity previews.
- A newly started child appears immediately from its nickname/role/thread id metadata; the panel must not stay empty while waiting for a later event to provide its canonical path.
- The panel title and empty state follow Codex CLI semantics: `Sub-agents running` and `No sub-agents running.` (localized in Chill Vibe).
- Completed, interrupted, failed, idle, or closed agents leave the running list; their historical tool-call/lifecycle activity remains available in the transcript.
- No disabled `Open` button or unsupported mention hint is shown.

### Preview parity

- At most six recent previewable items are retained per agent.
- The renderer shows at most three recent visual lines per agent.
- Each preview is whitespace-normalized and bounded to 240 Unicode grapheme clusters before rendering.
- Preview summaries match Codex CLI categories:
  - agent message or plan text;
  - latest reasoning summary only, never raw reasoning content;
  - `$ <command>` without command output;
  - `Updated N file(s)`;
  - `MCP server/tool`;
  - `Tool namespace/tool` or `Tool tool`;
  - collaboration and sub-agent lifecycle summaries;
  - web search, viewed image, generated image, review-mode, and compaction summaries.
- User messages, hook prompts, sleeps, raw command output, and raw reasoning are excluded.
- Repeated started/completed notifications for the same item id do not duplicate the preview.

### Compatibility and persistence

- Existing `collabAgentToolCall` parsing remains backward compatible for `spawnAgent`, `sendInput`, `resumeAgent`, `wait`, and `closeAgent`.
- Existing persisted `agents` structured messages continue to parse.
- The live panel is persisted through `message.meta.structuredData`; no new persisted card field is required.
- Older Codex versions that do not emit v2 child-thread events continue to use the legacy collaboration card.

### Visual and accessibility

- The panel uses existing theme tokens and remains legible in light and dark themes.
- The surface is compact and content-first, with no decorative idle chrome.
- Long paths and activity text wrap safely without horizontal overflow.
- Status is communicated with text, not color alone.
- Desktop and narrow layouts preserve the same information hierarchy.

## Non-goals

- Do not invent backend controls that the Codex CLI v2 `/agent` status view does not expose.
- Do not add a fake or disabled child-thread `Open` action.
- Do not persist complete child transcripts or raw child reasoning in the parent card.
- Do not change Codex's orchestration decisions, prompts, or maximum sub-agent count.
