# Design — Cross-version data maintenance

## Architecture

Add a small server-side maintenance coordinator with versioned task descriptors:

```ts
type DataMaintenanceTask = {
  id: string
  version: number
  runSlice(context): Promise<MaintenanceSliceResult>
}
```

`maintenance-state.json` stores only task version, phase, progress, counters, cursor, and last error.
Task-owned derived output lives in a separate atomic file. Source files are never modified by a
maintenance task.

The coordinator runs at most one slice at a time per data directory. A caller can request work, but
cannot make the coordinator enter an unbounded loop. Each completed slice schedules the next slice
through a timer so the event loop regains control.

## Safety envelope

- Maximum source-file size: skip rather than parse an unexpectedly huge JSON file.
- Maximum aggregate bytes and file count per slice.
- Elapsed-time check between files and between parse operations.
- Bounded read concurrency; never `Promise.all` an unbounded directory.
- Schema validation before accepting an item into derived output.
- Temporary write, read-back validation, then atomic rename.
- Previous valid output remains readable after any failure.
- Failure is represented as `degraded`; it does not propagate into startup failure.

The limits intentionally prefer incomplete recovery over renderer/main-process stalls.

## Session-history catalog task

Files:

- `session-history/catalog.json`: small validated manifest containing the source-name fingerprint,
  known sidecar names, sidecars that were skipped for safety/validation reasons, and referenced
  segment names. Keeping skipped names lets later incremental passes stay `degraded` while the bad
  source still exists, instead of incorrectly reporting `complete` after one new valid archive.
- `maintenance/session-history-catalog/catalog-segment-*.json`: immutable, atomically-written
  lightweight summary batches. Keeping them outside `session-history/` prevents old versions from
  mistaking derived catalog chunks for transcript sidecars.
- `session-history/catalog-hidden.json`: restored/deleted entry and provider-session tombstones.

The task enumerates sidecar file names, subtracts the manifest's durable known-name set, and processes
only a bounded batch of previously unseen files. Each valid sidecar is reduced to:

- id, title, provider, model, session id/model, context-transfer anchor
- exact workspace path
- archived time and real message count
- at most one tiny lifecycle marker message when needed
- source file name

Full message bodies never enter the catalog. Each completed slice writes one small immutable segment,
then atomically advances the manifest. If the manifest write fails, the unreferenced segment is
ignored and the previous catalog remains valid. A newly archived sidecar therefore costs one small
incremental slice instead of rescanning thousands of known files. Entries are not removed merely
because a source file disappears or a pass is interrupted.

Listing history reads the current validated catalog immediately, merges it with recent renderer
entries, filters by exact normalized workspace path, applies tombstones, sorts newest-first, and
deduplicates provider sessions. If the catalog is incomplete, the response carries progress and the
main process schedules another slice.

## UI behavior

Opening internal history requests the catalog-backed list. The menu remains usable and shows partial
results plus a concise maintenance status. Polling is bounded and stops when the menu closes or the
task reaches `complete/degraded`.

Search initially covers catalog metadata and existing renderer previews. Full message-body deep
search remains a separate bounded task from `deep-session-history-search`; catalog recovery must not
wait for it.

## Rollback

The feature is additive. Removing the coordinator leaves `state.json` and every sidecar readable by
the previous path. `catalog.json`, `catalog-hidden.json`, and `maintenance-state.json` are derived or
tombstone metadata and can be ignored by older versions.
