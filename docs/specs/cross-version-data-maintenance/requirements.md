# Requirements — Cross-version data maintenance

## Goal

Chill Vibe upgrades must be able to repair or migrate durable local data without making startup,
the Electron main process, or the renderer unresponsive. Maintenance is best-effort: if a task is
unsafe, too large, damaged, timed out, or fails validation, the app keeps the previous data and
continues running.

## Requirements

1. Cross-version maintenance uses a generic versioned task registry and a separate durable ledger;
   it must not overload `AppState.version` or require every migration to rewrite `state.json`.
2. Normal startup and state loading never wait for a maintenance task to finish. Maintenance runs
   only in bounded asynchronous slices and yields between slices.
3. Every task defines hard limits for files per slice, bytes per slice, individual file size, and
   elapsed time. Hitting a limit pauses or skips work; it never expands the limit automatically.
4. A damaged, oversized, unreadable, or schema-invalid source item is skipped and counted. One bad
   item must not fail the whole task or prevent the app from opening.
5. Maintenance output is written to a sibling temporary file, validated, then atomically renamed.
   A failed write or validation leaves the previous valid output untouched.
6. A task records resumable progress. Process exit, update, crash, or cancellation may repeat a
   bounded slice but must not corrupt the source data or restart all work unnecessarily.
7. The first registered task rebuilds a lightweight internal-session catalog from durable
   `session-history/*.json` sidecars. Sidecars remain the source of truth; `state.json` history is
   only a recent cache.
8. The catalog contains only lightweight restore metadata and bounded lifecycle preview data. It
   must not duplicate full transcripts or hydrate all history into renderer state.
9. History UI can list orphaned sidecars for the exact workspace path even when `state.json` has no
   matching index entries. Duplicate copies of one provider session show only the newest archive.
10. Catalog building is demand-triggered and reports `idle | running | complete | degraded` plus
    processed/total/skipped counts. Partial valid results may be shown while building.
11. Restoring or deleting a catalog result persists a hidden entry/session key, so old sidecars do
    not immediately reappear. A genuinely new archive of that session clears the session tombstone.
12. Maintenance never deletes sidecars, user projects, active cards, provider-native history, or a
    previous valid catalog automatically.
13. Tests must inject oversized files, malformed JSON, read/write failures, time/byte limits, and
    interrupted progress. The proving tests must fail before production changes.

## Non-goals

- No mandatory all-history scan during startup.
- No SQLite, embeddings, or full transcript duplication in the catalog.
- No automatic deletion of old or duplicate sidecars.
- No promise to recover a file that exceeds safety limits or fails schema validation.

## Acceptance

- A profile with an empty `state.json` history index and valid orphan sidecars can list and restore
  those sessions after bounded background maintenance.
- A profile containing a deliberately huge or malformed sidecar remains responsive and usable;
  the maintenance status becomes degraded instead of blocking or crashing.
- Focused tests, `pnpm test:quality`, the relevant Electron/runtime checks, and Windows packaging pass.
