# Tasks — Deferred Send Queue

- [x] Capture requirements and design before production edits.
- [x] Add runtime queue summaries/actions in `App.tsx`.
- [x] Thread queue props through `WorkspaceColumn`, `LayoutRenderer`, and `PaneView`.
- [x] Update `ChatCard` send/right-click/UI controls.
- [x] Add focused Playwright coverage for queue behavior.
- [x] Run targeted verification and quality checks.

## Restart-persistence follow-up

- [x] Update requirements/design for per-card queue persistence and safe startup behavior.
- [x] Add a red proving test for queued prompt/attachment save-and-load restoration.
- [x] Add `queuedSends` to the shared schema, defaults, and legacy-state normalization.
- [x] Synchronize renderer enqueue/dequeue/cancel state with persisted card state and hydrate the runtime cache on load.
- [x] Re-run the focused tests and `pnpm test:quality`.
- [x] Hand packaging and the active-development-runtime restart to the release pipeline, which owns the canonical server-built Windows zip and must not touch packaged instances.

## 2026-07-28 stale-stream follow-up

- [x] Add a red browser test where stop succeeds but the old stream never emits `done`.
- [x] Finalize only the matching stale `streamId` after a short grace period and dispatch the queued send.
- [x] Preserve normal completion, `/compact`, ask-user, and newer-stream ownership semantics.

## 2026-07-28 compact-boundary deadlock follow-up

- [x] Add a red browser test proving **Send now** does not requeue behind a stale `/compact` boundary.
- [x] Let explicit interrupt mode bypass only the compact-boundary wait while preserving ordinary `/compact` queuing.
- [x] Locally settle impossible `streaming` cards that have no live or persisted stream ID.
- [x] Re-run focused browser coverage, quality checks, and Windows packaging.
