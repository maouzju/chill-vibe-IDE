# Lossless Fork — Design

## Overview

Fork becomes a two-step flow: the renderer first asks the server to fork the native provider
session (`POST /api/chat/fork-session`), then dispatches the existing `forkConversation` reducer
action carrying the returned `forkedSessionId` (or nothing, on fallback). All file surgery lives in
a new server module `server/session-fork.ts` with pure, unit-testable core functions.

## Native formats (verified on this machine)

### Claude (`~/.claude/projects/<slug>/<sessionId>.jsonl`)

- One JSON object per line. Conversation entries carry `sessionId`, `uuid`, `parentUuid`,
  `isSidechain`, `type` (`user` / `assistant` / `queue-operation` / snapshots...).
- Real user prompt turns: `type === 'user'`, `isSidechain !== true`, `message.role === 'user'`,
  `message.content[]` contains a `{type:'text'}` block, and the entry is not a tool_result carrier
  (no `content[].type === 'tool_result'`) and has no `attachment` key.
- The CLI resolves `-r <id>` by locating `<id>.jsonl` in the project slug dir derived from `cwd`.

**Fork:** read all lines of the source file, find the cut line (see mapping), keep lines strictly
before it, rewrite every JSON line's `sessionId` field to the new UUID, write to
`<newId>.jsonl` in the same directory. Lines that fail to parse are copied verbatim (they carry no
session id). `--fork-session` is NOT used: it only forks at the tip; file surgery covers any point
with the same on-disk format the CLI itself writes.

### Codex (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`)

- First line `{"type":"session_meta","payload":{"id":<threadId>, ...}}`.
- User turns: `{"type":"response_item","payload":{"type":"message","role":"user","content":
  [{"type":"input_text","text":...}]}}`. Synthetic `<environment_context>` entries share this shape
  but never match real user text.
- `codex exec resume <id>` locates the rollout by scanning the sessions tree for the id in the
  filename.

**Fork:** keep the original filename timestamp segment, swap the trailing uuid for the new one
(`rollout-<ts>-<newId>.jsonl`, written into today's `YYYY/MM/DD` dir to keep scan freshness),
rewrite `session_meta.payload.id`, truncate strictly before the cut line.

## Fork-point mapping (R6)

Input: the fork-point UI message (`content`, `createdAt`). Request prompts may WRAP the raw text
(seeded replay wrapper, `Analyze this image:` prefix, slash-answer wrapping), so:

1. Collect candidate native user-turn entries (provider-specific predicates above).
2. Keep candidates whose text **contains** the trimmed UI content (when UI content is non-empty).
3. Pick the candidate with the smallest `|entry.timestamp − createdAt|`; require it within a
   tolerance window (10 minutes) when both timestamps exist.
4. Empty-content fork points (attachment-only) fall back to pure timestamp matching: the first
   candidate with `timestamp >= createdAt − 5s`.
5. No confident candidate → return `null` → renderer proceeds without `forkedSessionId` (today's
   behavior).

Injected native-only turns (`Please continue.` continuations, auto-resume nudges) never break the
mapping because matching is content-anchored, not ordinal.

## API

`POST /api/chat/fork-session`
Request (zod, `shared/schema.ts`): `{ provider, workspacePath, sessionId,
forkPoint: { content, createdAt } }`
Response: `{ sessionId: string | null }` — null means "fall back".
The handler never throws to the client; all errors map to `{ sessionId: null }`.

## Renderer flow

`App.tsx` `onForkConversation` becomes async-ish: it dispatches nothing until the fork-session call
resolves (fast local IO; UI latency negligible). Then dispatches
`{ type: 'forkConversation', ..., forkedSessionId?, sessionModel? }`.

`state.ts` `forkConversation` action gains optional `forkedSessionId`. When present the forked card
gets `sessionId: forkedSessionId`, `sessionModel: sourceCard.sessionModel` (context belongs to that
model — pitfall 47), and `providerSessions: {}` (only the active provider's session is forked).
`hasSeededChatTranscript` then naturally skips seeding because `sessionId` exists.

## Failure containment

- Fork file surgery is synchronous-read/atomic-write (`writeFile` to final name; ids are fresh
  UUIDs so no collision).
- If the forked session later fails to resume (corrupt tail, CLI mismatch), the existing
  stale-session fallbacks already recover into a fresh session; the forked card still holds its
  visible messages.

## Testing

- Unit (red → green): `tests/session-fork.test.ts` over fixture JSONL strings — cut-point mapping
  tiers, id rewriting, meta rewriting, verbatim copy of unparseable lines, fallback returns null.
- Manual smoke (real CLIs): fork a real Claude session file and `claude -p -r <newId>` a trivial
  prompt; fork a real Codex rollout and `codex exec resume <newId>` a trivial prompt; assert the
  reply demonstrates pre-fork context and the parent file is byte-identical afterwards.
