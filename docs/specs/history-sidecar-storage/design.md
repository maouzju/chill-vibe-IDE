# Design — History sidecar storage

## Storage layout

- `state.json`: board layout, settings, active cards, and lightweight `sessionHistory` preview entries.
- `session-history/<base64url(entryId)>.json`: one full archived session entry per file.

## Save flow

1. Sanitize incoming app state.
2. Keep routine renderer preview saves lightweight: do not enumerate or hydrate every `session-history/` sidecar during ordinary board saves.
3. Merge lightweight renderer previews only with an already-full in-process cache when available; otherwise preserve existing sidecars and leave previews lightweight.
4. Write complete incoming archived entries to `session-history/` files.
5. Write `state.json` with `renderSessionHistoryForRenderer(...)` output only.
6. Cache the lightweight state so ordinary settings/provider reads do not hydrate archived transcripts.
7. When several chats are streaming or live transcripts are already large, batch renderer saves into a wider window and compact oversized `structuredData` before crossing the Electron IPC bridge.
8. If queued saves keep replacing each other or individual writes become slow, open the state-save circuit breaker: delay the next write, keep only the newest pending state, and throttle routine snapshots while the circuit is open.

## Load flow

- Renderer startup reads `state.json` and gets only lightweight history entries.
- Restoring one internal history item calls `loadSessionHistoryEntry({ entryId })`, which reads only that entry's sidecar file; if missing, it falls back to legacy `state.json` for migration compatibility.

## Compatibility

- Existing states with full `sessionHistory` remain readable.
- Existing renderer preview saves preserve full transcripts by leaving unchanged sidecar files in place; per-entry restore reads the matching sidecar on demand.
- `AppState` schema remains compatible: preview entries are still valid `SessionHistoryEntry` values via existing `messageCount` and `messagesPreview` fields.

## Risk controls

- Add focused state-store tests for sidecar writes, lightweight `state.json`, and per-entry restore.
- Add focused renderer queue tests for multi-session save backoff, compact queued IPC payloads, and circuit-breaker snapshot throttling.
- Do not change UI styling; no visual snapshot update needed.
