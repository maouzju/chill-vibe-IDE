# Cross-Provider Context Transfer — Design

## Overview

Add a lightweight persisted `contextTransfer` anchor to chat cards. It records the most recent
alternate provider/model/session that owns the visible conversation context. Model selection still
invalidates incompatible active sessions, but it no longer forgets where the conversation came
from.

The first Codex send without a matching target session uses a new `model-transfer` replay mode.
This mode keeps every meaningful user/assistant text entry in chronological order. Structured-only
activities remain disposable and use the existing per-entry truncation, so a tail of command output
cannot consume the dialogue budget.

## Data shape

`ChatCard` and `SessionHistoryEntry` gain an optional field:

```ts
contextTransfer?: {
  sourceProvider: Provider
  sourceModel: string
  sourceSessionId?: string
}
```

The field is optional for backwards compatibility. Persistence normalization accepts only known
providers and normalized non-empty model/session strings.

## Model selection

When the effective provider/model changes on a non-empty chat:

1. Keep the existing native-session invalidation guard.
2. If the current card has a native session, store its provider, effective session model, and id as
   `contextTransfer`.
3. If the card is already waiting to transfer and has no target session yet, preserve the older
   anchor instead of replacing it with an empty intermediate selection.
4. If the selected provider/model matches the anchor, restore the anchored native session and swap
   the current matching session back into the anchor when available.

Tool-card selection does not create transfer metadata.

## Request construction

`buildSeededChatPrompt` gains an explicit replay mode:

- `fallback` (default): current bounded behavior, including the small prompt budget.
- `model-transfer`: meaningful user/assistant prose is protected from total-budget eviction;
  structured-only entries remain bounded/disposable.

`App.sendMessage` selects `model-transfer` only when:

- the target provider is Codex;
- the card has `contextTransfer` metadata; and
- no provider-native session matches the requested target model.

Once Codex emits its new session id, the active `sessionId/sessionModel` match the card model, so
subsequent sends resume normally and do not seed again. The alternate anchor remains available for
an explicit switch back.

## Persistence and history

- State normalization preserves valid transfer metadata and drops malformed legacy values.
- Archiving copies the anchor into the session-history sidecar/preview entry.
- Restoring a history item copies the anchor back to the card.
- Reset/new conversation clears the anchor.

## Testing

1. Reducer red-first test: Fable → Sol stores a return anchor and clears the incompatible active
   session; switching back restores the Fable session.
2. Seeding red-first test: hundreds of recent structured activities cannot evict the earliest
   meaningful dialogue in `model-transfer` mode, while fallback mode remains bounded.
3. Persistence tests: transfer metadata survives normalize/archive/restore and malformed metadata
   is discarded.
4. App helper test: only pending Codex transfers choose the high-fidelity replay mode.

