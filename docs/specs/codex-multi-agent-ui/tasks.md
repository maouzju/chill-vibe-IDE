# Tasks: Codex Multi-Agent UI

## Slice 1 — structured activity plumbing

- [ ] Add `agents` to `StreamActivity` schema and type helpers.
- [ ] Parse Codex `collabAgentToolCall` items in `server/codex-structured-output.ts`.
- [ ] Add focused parser tests.

## Slice 2 — renderer UI

- [ ] Add renderer parsing for structured agents messages.
- [ ] Add `StructuredAgentsCard` with compact rows and Open affordances.
- [ ] Add CSS using existing theme tokens.
- [ ] Add focused render tests.

## Slice 3 — verification

- [ ] Run targeted unit tests.
- [ ] Run quality check.
- [ ] Try theme verification or document the known Playwright blocker.
- [ ] Restart the active dev runtime before handoff.
