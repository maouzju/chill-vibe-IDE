# Long Chat Auto Collapse Design

## Approach

Reuse the existing chat transcript compaction window in `src/components/chat-card-compaction.ts`.

The app already has two related mechanisms:

1. `/compact` boundaries hide older transcript messages behind a banner.
2. Performance windowing can temporarily hide older messages without changing provider state.

This feature formalizes the second mechanism as an emergency renderer fallback, not routine conversation cleanup:

- plain conversations start windowing after 1200 messages and keep the latest 360 rendered;
- structured/tool-heavy conversations start windowing after 300 messages and keep the latest 160 rendered; this targets the sustained command/edit transcript shape seen in real multi-pane sessions while leaving ordinary and short tool runs untouched;
- content-weight windowing only triggers after both a large transcript length and a multi-megabyte render payload, so moderately heavy command output remains visible;
- the banner copy explains that older messages are temporarily hidden for responsiveness;
- content-weight windowing has a minimum transcript length so one large command output in a short conversation does not hide the whole setup;
- performance window boundaries are clamped back to the latest ordinary user turn so the current question stays visible with its assistant/tool output;
- reveal actions reuse the existing compacted-history reveal path.

### Structured group tail window

Transcript-level prefix folding cannot safely solve the common single-turn shape of `one user message -> hundreds of tool items`: clamping the fold boundary to the latest user message keeps the entire tool run mounted. Add a second, narrower window at the structured-group renderer:

- expanded tool groups render the newest 60 items by default;
- the group header continues to show the full item count;
- when older items are hidden, a quiet inline action above the rendered stack reveals 60 more items per activation;
- newly appended streaming items stay inside the visible tail;
- collapsed groups remain header-only;
- the full `items` array and full card message state remain unchanged, so persistence, provider context, archive recall, and session restore are unaffected.

This window belongs in a pure helper consumed by `StructuredToolGroupCard`, with focused Node tests for boundaries and incremental reveal. The component keeps only the revealed-older count as local UI state. It deliberately avoids virtualizing the whole transcript or changing reducer state in this first reversible slice.

## Why UI-only windowing

Provider-side compaction is more invasive because it can alter session semantics and requires provider support. The user's immediate problem is renderer slowdown from too much DOM/content on the board, so UI-only folding is the smallest safe slice.

## Boundaries

- The full message array remains in card state.
- Existing explicit compact boundaries still take priority over performance windowing.
- Request seeding keeps `allowPerformanceWindowing: false`, so UI folding does not accidentally truncate a seeded provider prompt.
- Archive recall remains limited to real compact boundaries, not temporary performance windows.

## Verification

- Add/keep focused unit coverage for `getCompactMessageWindow()` thresholds and reveal behavior.
- Add pure coverage for a 300-item structured group rendering only the latest 60 items, then 120 after one reveal action, without mutating the source array.
- Add component markup coverage that the hidden-count action is present only for expanded windowed groups and that collapsed groups stay header-only.
- Add coverage that automatic provider compaction is not requested by this UI-only feature.
- Run the narrow chat compaction test file, then the full unit suite if time permits.
