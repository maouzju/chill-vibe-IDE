# Lossless Fork — Requirements

## Problem

Forking a conversation card (`forkConversation`) currently drops `sessionId`, so the forked card's
next send goes through the seeded-transcript replay path (`buildSeededChatPrompt`), which is a
budgeted, truncated text reconstruction (~6000 chars, structured entries capped at ~1100 chars).
Tool outputs, thinking, and long history are lost. The user requirement is explicit:
**fork must be lossless**.

## Requirements

1. **R1 — Native context fork.** When a card with a native provider session (`sessionId`) is forked,
   the forked card must receive its own new native session that contains the full provider-side
   context up to (and excluding) the fork-point user message. The original card's session must not
   be mutated or shared.
2. **R2 — Fork-at-a-point semantics preserved.** The existing UI semantics stay: fork point is a
   user message; the forked card gets messages strictly before it; the fork-point message text and
   attachments land in the composer draft.
3. **R3 — Both providers.**
   - Claude: session files at `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, per-line `sessionId`.
   - Codex: rollout files at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`,
     first-line `session_meta` carries the id.
4. **R4 — Graceful fallback.** If the native fork cannot be produced (no session file, cut point not
   found, IO error, malformed file), fork behaves exactly as today (no `sessionId` → seeded replay).
   Fork must never fail the UI action.
5. **R5 — No cross-contamination.** The fork writes a NEW session file with a NEW id. Resuming the
   fork must not append to the parent session, and vice versa.
6. **R6 — Fork-point mapping is conservative.** The mapping from the UI fork-point message to a
   native transcript entry must prefer exact/containment text matching (request prompts may wrap the
   raw user text — seeded wrappers, image prefixes, slash-answer wrapping) with timestamp proximity
   as a tie-breaker. If no confident match exists, fall back (R4) instead of guessing.
7. **R7 — Cards without sessions unchanged.** Forking a card that has no `sessionId` keeps today's
   behavior untouched.

## Non-goals

- Changing the seeded replay path itself.
- Forking mid-turn streaming state (the fork uses the session file as-is at fork time).
- A UI toggle; lossless fork is the default whenever possible.
