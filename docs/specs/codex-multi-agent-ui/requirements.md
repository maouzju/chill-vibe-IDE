# Requirements: Codex Multi-Agent UI

## Background

Codex CLI now emits collaboration / multi-agent activity for spawned background agents. Chill Vibe already renders commands, tools, edits, todos, and ask-user cards, but it does not give users a clear front-end view for these Codex agent-control items. The target interaction matches Codex TUI's compact list: users should see how many background agents exist, each agent's nickname/role/status, and an obvious way to open the agent when the runtime supports it.

## User stories

1. As a user, when Codex spawns or waits on multiple agents, I can see a compact agent list instead of raw JSON or invisible activity.
2. As a user, I can tell whether each agent is running, completed, interrupted, errored, closed, or missing.
3. As a user, I see the agent nickname and role such as `Lorentz (explorer)` so I can understand the delegation.
4. As a user, I see an `Open` affordance for each listed agent. In this slice it may be a non-destructive UI affordance if no thread-opening backend exists yet.
5. As a user, the panel stays quiet and theme-safe in both light and dark themes.

## Acceptance criteria

- Codex app-server `collabAgentToolCall` items from `item.started` / `item.completed` become structured chat activity.
- Activity supports at least these tools: `spawnAgent`, `sendInput`, `resumeAgent`, `wait`, `closeAgent`.
- A `wait` call with multiple `receiverThreadIds` renders a grouped list like `3 background agents` and one row per agent.
- Completed/errored/running/interrupted/shutdown/not-found states render localized labels.
- The structured message is persisted through the existing message `meta.structuredData` path without changing card schema.
- The UI uses existing theme tokens; no hard-coded light-only colors.

## Non-goals for this slice

- No new orchestration or automatic Pair Mode behavior.
- No backend endpoint to switch into a child thread yet.
- No schema changes to persisted cards beyond the existing structured activity JSON payload.
