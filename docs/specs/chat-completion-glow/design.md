# Chat Completion Glow Design

## Behavior

The completion glow is its own runtime-only state, `completionGlow`, decoupled from the unread dot. An earlier revision reused `unread` directly, but `unread` is auto-cleared for any pane the user can currently see (`getAutoReadCardIdsForVisiblePanes`), so the card you are actively looking at never glowed on completion, contradicting requirement 1. The dedicated flag fixes that:

- When a stream finishes normally (not stopped, not errored), the completion patch sets `completionGlow: true` regardless of whether the card is the visible active tab. So a card you are watching glows on completion just like a backgrounded one.
- `card.completionGlow` (with `card.status === 'idle'`) renders the completion glow class. The unread dot still keys off `card.unread` and is unchanged.
- Clicking, pointer interaction, keyboard focus, or input inside the card clears both `unread` and `completionGlow` (the mark-read path now patches both), removing the glow.
- Visible-pane auto-read still clears only `unread` (the dot), not `completionGlow`. Being on-screen no longer silently dismisses the glow; only a real interaction does.
- Streaming cards keep the streaming border animation and never show the completion glow at the same time (status-class precedence: streaming > error > completion glow).
- Stopped/errored streams never show the success glow: `finishStoppedStream` explicitly clears `completionGlow`, and the error path keeps the error treatment.

`completionGlow` is intentionally not persisted: it is omitted from `normalizePersistedChatCard`, so it never reaches `state.json` and a restart never resurrects a stale glow. Old saved state stays compatible (the field is optional; absent means no glow). No new persisted schema field is added.

## Visual treatment

A `::before` halo layer plus the `::after` border line, unchanged from the first implementation. Only the trigger condition moved from `unread` to `completionGlow`; the `is-complete-unread` class name and all CSS stay the same:

- soft cyan/blue outer halo (`--completion-glow-*` tokens)
- thin bright-blue border line
- slow 2.8s ease-in-out breathing opacity/spread
- pane-embedded cards get the same effect even though their normal background/border is transparent
- `prefers-reduced-motion: reduce` disables animation and leaves a stable low-intensity glow

The effect is intentionally separate from the streaming border so finished work reads as ready to review, not still running.

## Testing

- SSR/unit (`tests/chat-card-cli-unavailable.test.tsx`): assert an idle card with `completionGlow: true` renders the glow class; `completionGlow: false`, streaming, and error states do not; and a plain `unread: true` card without `completionGlow` no longer renders the glow (proving the two states are decoupled).
- Reducer (`tests/state.test.ts`): existing `updateCard`/`finishStoppedStream` coverage stays green.
- Quality: `pnpm test:quality` (ESLint + tsc across all four projects, including the new `completionGlow` field on the schema and the `updateCard` action patch whitelist).
- Visual/theme: run the theme snapshot harness when available; if the repo Playwright runner hits the known Windows discovery issue, rely on focused markup plus quality verification and manual runtime check.