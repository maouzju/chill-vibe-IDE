# Design — History sidecar storage

## Storage layout

- `state.json`: board layout, settings, active cards, and lightweight `sessionHistory` preview entries.
- `session-history/<base64url(entryId)>.json`: one full archived session entry per file.

## Save flow

1. Sanitize incoming app state.
2. Merge lightweight renderer previews with existing full sidecar entries, falling back to legacy `state.json` history during migration.
3. Write complete archived entries to `session-history/` files.
4. Write `state.json` with `renderSessionHistoryForRenderer(...)` output only.
5. Cache the lightweight state so ordinary settings/provider reads do not hydrate archived transcripts.

## Load flow

- Renderer startup reads `state.json` and gets only lightweight history entries.
- Restoring one internal history item calls `loadSessionHistoryEntry({ entryId })`, which reads only that entry's sidecar file; if missing, it falls back to legacy `state.json` for migration compatibility.

## Compatibility

- Existing states with full `sessionHistory` remain readable.
- Existing renderer preview saves still preserve full transcripts because merge uses sidecar/legacy persisted content before writing the lightweight state.
- `AppState` schema remains compatible: preview entries are still valid `SessionHistoryEntry` values via existing `messageCount` and `messagesPreview` fields.

## Risk controls

- Add focused state-store tests for sidecar writes, lightweight `state.json`, and per-entry restore.
- Do not change UI styling; no visual snapshot update needed.
