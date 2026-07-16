# Long Chat Auto Collapse Tasks

- [x] Read `AGENTS.md` and relevant UI/design docs.
- [x] Inspect existing compacted-history and tool-group collapse code.
- [x] Add or align focused tests for long-chat automatic transcript folding.
- [x] Implement the smallest UI-only auto-collapse change using the existing compaction window.
- [x] Add regression coverage for short heavy command payloads and latest-user-turn preservation.
- [x] Raise automatic folding thresholds so performance windowing is an emergency fallback instead of routine cleanup.
- [x] Run focused tests and restart the active dev runtime.

## 2026-07-16 unresponsive follow-up

- [x] Capture live evidence from the packaged app and confirm the renderer entered `BrowserWindow unresponsive` without recovering.
- [x] Confirm the blocking stack is empty (native layout/paint/GPU/GC side rather than a capturable JS loop).
- [x] Benchmark the real 263-item expanded tool group against a 60-item tail and collapsed rendering.
- [x] Add red tests for a pure structured-group tail window and bounded reveal.
- [x] Implement default 60-item tail rendering in expanded structured tool groups.
- [x] Add quiet "reveal older activity" UI with 60-item increments.
- [x] Verify focused tests, repo quality, the new dark/light theme snapshot, Electron runtime coverage, and a production build from an isolated release worktree without shipping unrelated deep-session-history-search WIP.
