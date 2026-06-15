# Chat Completion Glow Requirements

## Goal

When an agent finishes a chat task, the finished chat window should keep a calm bright-blue breathing glow so the user can notice completion without needing sound or window flashing.

## Requirements

1. A chat card that transitions from an active stream to a completed idle state must show a persistent completion glow.
2. The glow must be bright blue, animated with a slow breathing rhythm, and visible in both light and dark themes.
3. The glow must be quieter than active streaming chrome: it should guide attention, not make the board feel alarmed.
4. Any user interaction with that chat window must dismiss the glow, including mouse click, pointer/touch interaction, keyboard focus, or typing in the composer.
5. Existing unread behavior must remain intact; the completion glow may reuse the unread flag visually but must not depend on the unread dot being visible.
6. Stopped or errored streams should not show the completion glow as a success state.
7. The glow must work for normal cards and pane-embedded cards.
8. The implementation must respect reduced-motion preferences by keeping a static blue emphasis instead of continuous breathing animation.

## Non-goals

- No new persisted schema field for completion glow.
- No extra sound or notification preference in this slice.
- No broad redesign of card chrome.
