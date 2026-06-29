# Design — Empty Message Continue

## Overview

Three layers currently stop a blank send; only two need changes, because the request-schema and Claude provider paths already tolerate empty continuation.

| Layer | File | Current behavior | Change |
|-------|------|------------------|--------|
| Composer gate | `src/components/ChatCard.tsx` | `sendDisabled` blocks blank draft with no attachment | Relax when the card is continuable |
| App send | `src/App.tsx` `sendMessage` | Always appends a `user` message | Skip the empty user bubble on empty continuation |
| Codex input | `server/providers.ts` `buildCodexAppServerInput` | Sends `text: ''` for blank prompt + sessionId | Fall back to a neutral `'Please continue.'` |
| Schema | `shared/schema.ts` | Allows blank prompt when attachment or sessionId present | **No change** — both continuation cases already pass |
| Auto Urge evaluation | `src/components/chat-auto-urge.ts` | Trims and skips blank urge messages | Allow blank messages when the target chat is continuable |
| Auto Urge settings | `shared/default-state.ts` | Normalization treats blank message as missing and restores default text | Preserve explicit empty messages so users can configure "continue only" profiles |
| Claude input | `server/providers.ts` `getClaudePrompt` | Already returns `'Please continue.'` for blank + sessionId | **No change** |

## 1. Continuable-state helper — `src/app-helpers.ts`

A pure, exported predicate placed next to `getResumeSessionIdForModel`:

```ts
export const canSendEmptyContinuation = (
  card: Pick<ChatCard, 'messages' | 'sessionId' | 'status'>,
): boolean => {
  if (card.status === 'streaming') return false
  const hasResumableSession = Boolean(card.sessionId?.trim())
  const hasHistory = card.messages.some(
    (message) => message.role === 'user' || message.role === 'assistant',
  )
  return hasResumableSession || hasHistory
}
```

Pure and unit-testable (matches the existing `app-helpers.test.ts` style). Tool-card exclusion is applied at the call site (the composer already knows `isToolCard`).

## 2. Composer gate — `src/components/ChatCard.tsx`

- Import `canSendEmptyContinuation`.
- `const canContinueEmpty = !isToolCard && canSendEmptyContinuation(card)`.
- `sendDisabled` first clause becomes:
  `(!draftHasText && !hasPendingAttachments && !canContinueEmpty)`.
- The other two clauses (image-unsupported, no-workspace) are unchanged. A card with history always has a workspace, so the `!localSlashDraft && !workspacePath.trim()` clause does not block continuation.
- `handleSubmit` keeps `const prompt = draftValueRef.current.trim()`, which is `''` for an empty continuation — no other change needed there.

## 3. No empty user bubble — `src/App.tsx`

In `sendMessage`, before building `startActions`:

```ts
const isEmptyContinuation =
  prompt.trim().length === 0 &&
  attachments.length === 0 &&
  !MODEL_PICKER_HIDDEN_TOOL_MODELS.has(card.model) &&
  canSendEmptyContinuation(card)
```

When `isEmptyContinuation`, the `appendMessages` action uses `messages: []` instead of `[userMessage]`. Everything else (status → `streaming`, `streamId`, `requestChat`) is unchanged.

The same predicate is computed before the provider-availability branch. If the
local CLI is unavailable, the app still appends the system error notice, but it
does not append a blank user bubble for the empty continuation attempt.

- `nextTitle` is only taken when `card.messages.length === 0`, so an empty continuation (which always has history) never re-titles.
- `requestPrompt` keeps its existing value: `''` when a `sessionId` is resumed, or the seeded transcript when the card is sessionless-with-history. The provider layer supplies the continuation nudge.

## 4. Auto Urge blank-message continuation

Auto Urge uses the same send path as the composer (`onSend(message, [])`). To make a blank Auto Urge mean "continue":

- `ChatCard.tsx` stores `canSendEmptyContinuation: !isToolCard && canSendEmptyContinuation(card)` in `autoUrgeStateRef`.
- `evaluateAutoUrge()` no longer treats a blank `message.trim()` as an unconditional skip. It returns `{ kind: 'send', message: '' }` when the chat is continuable.
- The normal `sendMessage` empty-continuation logic then skips the user bubble and routes the request through the existing continuation behavior.
- `createAutoUrgeProfile()` preserves an explicit empty `message` string while still using the default message when the field is absent/non-string. This keeps legacy settings upgraded safely but allows deliberate "continue only" profiles.

## 5. Codex continuation fallback — `server/providers.ts`

`buildCodexAppServerInput` text fallback, aligned with Claude's `getClaudePrompt`:

```ts
text:
  prompt ||
  (attachmentPaths.length > 0 ? getCodexPrompt(request, attachmentPaths) : '') ||
  (request.sessionId ? 'Please continue.' : ''),
```

So: blank prompt + no attachment + sessionId → `'Please continue.'`. The sessionless-with-history case never reaches this blank branch because the client seeds a non-empty transcript into `requestPrompt`.

Export `buildCodexAppServerInput` (`const` → `export const`) for unit testing.

## Why no schema change

`App.sendMessage` resolves the request prompt before the schema sees it:
- **Resumed session** (`sessionId` set): `requestPrompt = ''` but `hasResumeSession` passes the refine.
- **Sessionless history**: `hasSeededChatTranscript` is true, so `buildSeededChatPrompt` fills `requestPrompt` with the transcript (non-empty), passing the refine on `hasPrompt`.

Both continuation paths already satisfy `chatRequestSchema.refine`.
