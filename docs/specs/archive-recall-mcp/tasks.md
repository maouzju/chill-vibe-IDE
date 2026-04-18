# Tasks: Archive Recall MCP

> SPEC-first rule: Do not start production code until requirements.md and design.md are reviewed and this task list is actionable.

- [ ] Confirm the MVP scope: Codex-only, compacted-current-thread-only, no UI browser.
- [ ] Add narrow failing tests for compacted archive snapshot derivation and Codex runtime injection.
- [ ] Add focused MCP server tests for `search_compacted_history` and `read_compacted_history`.
- [ ] Extend shared request schema with optional archive recall payload.
- [ ] Implement the renderer helper that derives compacted archive snapshots from hidden messages.
- [ ] Implement backend temp-snapshot + Codex MCP runtime wiring.
- [ ] Implement the archive recall MCP stdio server.
- [ ] Run targeted unit tests and restart the active runtime.
