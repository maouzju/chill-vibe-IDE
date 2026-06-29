# Tasks — Empty Message Continue

## Slice 1 — Continuable-state helper (red → green)

- [x] Add failing unit tests in `tests/app-helpers.test.ts` for `canSendEmptyContinuation`:
  - history (assistant) + not streaming → `true`
  - sessionId + no history + not streaming → `true`
  - streaming → `false`
  - no history + no session → `false`
  - only a `system` message → `false`
- [x] Implement and export `canSendEmptyContinuation` in `src/app-helpers.ts`.
- [x] Run the test file, confirm green.

## Slice 2 — Composer gate

- [x] Import the helper in `src/components/ChatCard.tsx`; compute `canContinueEmpty = !isToolCard && canSendEmptyContinuation(card)`.
- [x] Relax `sendDisabled` first clause to include `&& !canContinueEmpty`.

## Slice 3 — No empty user bubble (App)

- [x] In `src/App.tsx` `sendMessage`, compute `isEmptyContinuation` and skip appending the empty `user` message in `startActions` when true.
- [x] Also skip the empty user bubble on the provider-unavailable branch so a blank continue attempt never creates visible blank user text.

## Slice 4A — Auto Urge blank message continuation (red → green)

- [x] Add failing unit coverage in `tests/chat-auto-urge.test.ts` showing a blank Auto Urge message sends `''` when the chat is continuable.
- [x] Add failing settings coverage in `tests/auto-urge-settings.test.ts` showing an explicitly empty profile message is preserved.
- [x] Thread `canSendEmptyContinuation(card)` into Auto Urge evaluation at the ChatCard call site.
- [x] Preserve explicit empty Auto Urge messages in `createAutoUrgeProfile()` while keeping the default for absent/non-string values.
- [x] Run the focused tests and confirm green.

## Slice 4 — Codex continuation fallback (red → green)

- [x] Export `buildCodexAppServerInput` from `server/providers.ts`.
- [x] Add failing test `tests/codex-empty-continuation.test.ts` (register in `tests/index.test.ts`):
  - blank prompt + sessionId + no attachment → `input[0].text === 'Please continue.'`
  - non-empty prompt → `input[0].text === <prompt>`
- [x] Implement the text fallback in `buildCodexAppServerInput`.
- [x] Update older provider-system-prompt assertions to expect the neutral continue nudge instead of a blank turn.
- [x] Run the test file, confirm green.

## Slice 5 — Verify

- [x] `node --import tsx --test tests/app-helpers.test.ts tests/codex-empty-continuation.test.ts` (file-scoped; not `pnpm test -- --test-name-pattern`).
- [ ] `pnpm test:quality`.
- [ ] Release verification via `pnpm test:risk` / `pnpm test:full`.
- [ ] Runtime: `pnpm dev:restart`, on a card that already chatted, clear input → send → confirm both claude and codex continue, no blank bubble.

## Slice 6 — Package

- [ ] After verification, `pnpm electron:build:zip`; report the artifact path in the release handoff.
