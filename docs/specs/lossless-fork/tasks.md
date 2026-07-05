# Lossless Fork — Tasks

1. [x] SPEC (this directory).
2. [x] `server/session-fork.ts` — pure core: `planClaudeSessionFork`, `planCodexSessionFork`,
   turn-boundary residue trim (queue-operation / isMeta / synthetic / turn_context / event_msg),
   duplicate-delivery trim for CLI-level retries, path scan locators, `forkProviderSession` IO
   wrapper. TDD red → green in `tests/session-fork.test.ts` (16 cases), registered in
   `tests/index.test.ts`.
3. [x] `shared/schema.ts` — `forkSessionRequestSchema` / `forkSessionResponseSchema`.
4. [x] Server route `POST /api/chat/fork-session` (`server/index.ts`) + Electron bridge
   (`electron/backend.ts` `forkProviderSession`, `electron/main.ts` IPC, `electron/preload.ts`,
   `src/electron.d.ts`).
5. [x] `src/api.ts` — `forkProviderSession()` client.
6. [x] `src/state.ts` — `forkConversation` accepts optional `forkedSessionId`; forked card keeps
   `sessionModel` (pitfall 47) and fresh `providerSessions`. `resolveForkPointMessage` extracted
   and shared with the App handler. Reducer tests updated red → green.
7. [x] `src/App.tsx` — fork handler requests the native fork first, dispatches with
   `forkedSessionId`, falls back to the old sessionless fork on null/error.
8. [x] Real-CLI smoke:
   - Claude (haiku, 2-turn session, fork at turn 2): forked session verbatim-recalled the turn-1
     message, contained zero turn-2 content, parent file md5 unchanged.
   - Codex: fork of a real rollout accepted by `codex exec resume` (locates + loads the forked
     file; full reply blocked only by an upstream provider outage unrelated to the fork —
     the same outage failed identical resumes of the unforked parent).
9. [x] `pnpm test:quality` + narrow unit tests green; merged to main; `pnpm electron:build`.
