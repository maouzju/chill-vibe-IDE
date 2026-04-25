# Long Chat Auto Collapse Design

## Approach

Reuse the existing chat transcript compaction window in `src/components/chat-card-compaction.ts`.

The app already has two related mechanisms:

1. `/compact` boundaries hide older transcript messages behind a banner.
2. Performance windowing can temporarily hide older messages without changing provider state.

This feature formalizes the second mechanism as the long-chat auto-collapse behavior:

- plain conversations start windowing after 220 messages and keep the latest 140 rendered;
- structured/tool-heavy conversations start windowing after 72 messages and keep the latest 56 rendered;
- the banner copy explains that older messages are temporarily hidden for responsiveness;
- reveal actions reuse the existing compacted-history reveal path.

## Why UI-only windowing

Provider-side compaction is more invasive because it can alter session semantics and requires provider support. The user's immediate problem is renderer slowdown from too much DOM/content on the board, so UI-only folding is the smallest safe slice.

## Boundaries

- The full message array remains in card state.
- Existing explicit compact boundaries still take priority over performance windowing.
- Request seeding keeps `allowPerformanceWindowing: false`, so UI folding does not accidentally truncate a seeded provider prompt.
- Archive recall remains limited to real compact boundaries, not temporary performance windows.

## Verification

- Add/keep focused unit coverage for `getCompactMessageWindow()` thresholds and reveal behavior.
- Add coverage that automatic provider compaction is not requested by this UI-only feature.
- Run the narrow chat compaction test file, then the full unit suite if time permits.
