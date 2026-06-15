# Chat Completion Glow Tasks

- [x] Define requirements and design.
- [x] Add the ChatCard completion-glow state class.
- [x] Add CSS tokens and breathing glow styles for light/dark/reduced-motion.
- [x] Ensure pointer/focus/input interactions dismiss the glow through existing mark-read behavior.
- [x] Add focused unit coverage for class rendering.
- [x] Run focused tests, quality checks, theme verification, restart runtime, and package the verified app.



## Follow-up: glow on the visible card too (requirement 1 fix)

- [x] Introduce runtime-only `completionGlow` flag on the chat card schema (optional, not persisted).
- [x] Set `completionGlow: true` on normal stream completion regardless of pane visibility; keep stopped/errored streams clear of the success glow.
- [x] Switch the glow class trigger from `card.unread` to `card.completionGlow`; keep the unread dot on `card.unread`.
- [x] Clear both `unread` and `completionGlow` on user interaction; keep visible-pane auto-read clearing only `unread`.
- [x] Add `completionGlow` to the `updateCard` action patch whitelist so tsc accepts the patches.
- [x] Red-then-green via the SSR glow test; rerun state/regression tests and `pnpm test:quality`.