# Tasks: Archive Recall MCP

> SPEC-first rule: Do not start production code until requirements.md and design.md are reviewed and this task list is actionable.

- [x] Confirm the MVP scope: Codex-only, compacted-current-thread-only, no UI browser.
- [x] Add focused MCP server tests for `search_compacted_history` and `read_compacted_history`.
- [x] Extend shared request schema with optional archive recall payload.
- [x] Implement the renderer helper and temporary Codex MCP runtime wiring.
- [x] Add red tests for multiple compaction boundaries and the 500-message persistence cap.
- [x] Persist cumulative compacted-card history before active-card trimming.
- [x] Merge the cumulative sidecar with the renderer snapshot when starting Codex.
- [x] Prove later lightweight saves cannot shorten the cumulative archive.
- [x] Run targeted tests and quality verification.
- [x] Package and restart the active Electron runtime.
