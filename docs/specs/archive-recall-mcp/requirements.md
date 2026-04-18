# Requirements: Archive Recall MCP

## Goal

- Let Codex recover **当前线程里已经被 /compact 或自动压缩隐藏**的旧消息、日志和图片，而不是在压缩后直接失忆。
- Keep the implementation **lightweight**: no global knowledge base, no embeddings, no cross-thread search, no always-on replay.

## User Stories

- As a user, when I mention “前面那张图 / 刚才那段日志 / 被压缩掉的那部分”, I want Codex to look it up from archived thread history so I do not have to re-upload or re-paste it.
- As a user, I want this recall path to stay scoped to the current thread’s compacted history so it remains fast and predictable.
- As a maintainer, I want the archive recall path to be read-only and ephemeral per run so it does not add a heavy persistence or indexing system.

## Acceptance Criteria

- [ ] Given a Codex chat card has hidden history behind the latest compact boundary, when a new Codex turn starts, then Chill Vibe exposes a read-only MCP server scoped to that hidden history for that run.
- [ ] Given the compacted history contains an earlier screenshot or log, when Codex uses the archive MCP tools, then it can search the archived messages and read back the matching text and attached images.
- [ ] Given there is no compacted hidden history, when a Codex turn starts, then Chill Vibe does not inject the archive MCP server.
- [ ] Given Codex is deciding how to respond to “前面那张图/日志”, when archive recall is available, then Chill Vibe’s instructions tell Codex to check archive recall before claiming the old attachment is unavailable.
- [ ] Given the run ends or fails, when the temporary archive snapshot is no longer needed, then Chill Vibe cleans it up.

## Out of Scope

- Cross-thread or cross-workspace recall.
- Embedding / vector retrieval or semantic ranking.
- A user-facing archive browser UI in this first slice.
- Claude provider support in this first slice.
