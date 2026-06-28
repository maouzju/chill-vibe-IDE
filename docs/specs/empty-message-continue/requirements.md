# Requirements — Empty Message Continue

## Problem

When an agent chat card already has a conversation — the AI has finished its answer on its own, or the run was interrupted for some reason — the user often just wants the agent to **keep going / continue** on the existing context. Today the composer forbids sending an empty message: the send button and Enter key are disabled whenever the draft is blank and there is no attachment (`sendDisabled` in `src/components/ChatCard.tsx`). The user has to type a filler line like "please continue" every time.

## Goals

1. **Empty send = continue** — On a chat card that already has conversation history (or a resumable session) and is **not currently streaming**, sending an empty message tells the agent to continue from the existing context.
2. **Both providers behave the same** — Empty continuation works for both `claude` and `codex` cards. Neither should fail to launch, error out, or send a meaningless blank turn to the model.
3. **No empty user bubble** — An empty continuation must not leave a blank user message bubble in the transcript; the user typed nothing, so nothing user-authored should appear.
4. **Send affordances reflect it** — The send button and Enter key are enabled for an empty draft only when the card is in a continuable state.

## Non-goals

- Empty send on a brand-new card with no history and no session (there is nothing to continue — stays disabled).
- Empty send on tool cards (Git / Music / White-noise / Weather / Sticky / Files / Brainstorm / Text-editor / Image-editor) — their send semantics differ.
- Changing streaming-time behavior. While a card is streaming, the existing queue / interrupt logic owns the send button; this feature only relaxes the "blank draft is disabled" gate for idle cards.
- Persisting any new state or schema change.

## Continuable state

A card may send an empty continuation when **all** of:

- It is a normal chat card (not a tool card).
- `card.status !== 'streaming'` (idle, done, or error are all fine).
- It has a resumable session (`card.sessionId` is set) **or** at least one `user`/`assistant` message in history. A card with only a `system` notice is not continuable.

## Acceptance

- On a claude card that just finished an answer, clearing the composer and pressing Enter starts a new turn and the agent continues; no blank user bubble appears.
- Same on a codex card.
- On a fresh empty card (no history, no session), the send button stays disabled for a blank draft.
- The schema-level chat request validation (`shared/schema.ts`) is unchanged and still accepts these requests (resumable session, or seeded transcript for sessionless history).
