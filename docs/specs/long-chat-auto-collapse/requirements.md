# Long Chat Auto Collapse Requirements

## Goal

Long chat cards should stay responsive without hiding context during ordinary work. Automatic hiding is an emergency fallback for transcripts that are genuinely too large for the renderer to carry smoothly.

## User stories

- As a user, when a chat becomes genuinely too large for the renderer to handle smoothly, I want Chill Vibe to hide older rendered messages as a last-resort fallback.
- As a user, I want the current / latest conversation segment to stay visible and usable after automatic hiding.
- As a user, I want to be able to reveal the hidden older messages when I need to inspect history.

## Acceptance criteria

- Given a normal chat has fewer than the long-chat threshold, when the card renders, then all messages remain visible.
- Given a short chat contains one very large command/tool payload, when the card renders, then the transcript should not auto-collapse just because that single payload is heavy.
- Given automatic performance windowing is necessary, when it chooses a visible window, then the latest user turn remains visible with the assistant/tool output that follows it.
- Given a normal chat crosses the emergency long-chat threshold, when the card renders, then older messages are folded through the existing compacted-history banner and the latest messages remain visible.
- Given a command/tool-heavy chat crosses its lower-but-still-emergency threshold, when the card renders, then earlier structured activity is folded earlier than plain text chat.
- Given a command/tool-heavy active pane has accumulated roughly 300 messages, when other panes stream or the user types, then older structured activity is no longer kept mounted merely because the transcript has not reached the old 420-message fallback.
- Given one long-running user turn produces hundreds of consecutive command/tool items, when the latest structured group is still streaming, then the UI renders only a bounded recent tail by default instead of mounting the entire current turn.
- Given older items in a structured group are hidden for responsiveness, when the user asks to inspect them, then the UI reveals them in bounded batches while keeping the newest activity visible.
- Bounded rendering must not delete, compact, reorder, or truncate the card's persisted messages or the provider session; it changes only which structured items are mounted in the UI.
- Given a chat is only moderately content-heavy or metadata-heavy, when the card renders, then it should stay fully visible instead of auto-folding preemptively.
- Given hidden history exists only because of performance windowing, when the next provider request is sent, then the request still uses the full provider session rather than replaying the hidden UI window as a new transcript.
- Given the user clicks the reveal action, then the hidden messages can be restored in the UI.
- Given a structured group grows while streaming, then newly appended items remain visible and previously revealed older batches do not cause the whole group to remount without a bound.

## Non-goals

- Do not trigger provider-side `/compact` automatically in this slice.
- Do not change the persisted chat schema.
- Do not collapse entire cards or hide the composer; only fold older transcript rendering.
