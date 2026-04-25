# Long Chat Auto Collapse Requirements

## Goal

Long chat cards should stay responsive without asking the user to manually collapse old content after every long session.

## User stories

- As a user, when a chat grows very long, I want Chill Vibe to automatically hide older rendered messages so the board does not get slower over time.
- As a user, I want the current / latest conversation segment to stay visible and usable after automatic hiding.
- As a user, I want to be able to reveal the hidden older messages when I need to inspect history.

## Acceptance criteria

- Given a normal chat has fewer than the long-chat threshold, when the card renders, then all messages remain visible.
- Given a normal chat crosses the long-chat threshold, when the card renders, then older messages are folded through the existing compacted-history banner and the latest messages remain visible.
- Given a command/tool-heavy chat crosses its lower performance threshold, when the card renders, then earlier structured activity is folded earlier than plain text chat.
- Given hidden history exists only because of performance windowing, when the next provider request is sent, then the request still uses the full provider session rather than replaying the hidden UI window as a new transcript.
- Given the user clicks the reveal action, then the hidden messages can be restored in the UI.

## Non-goals

- Do not trigger provider-side `/compact` automatically in this slice.
- Do not change the persisted chat schema.
- Do not collapse entire cards or hide the composer; only fold older transcript rendering.
