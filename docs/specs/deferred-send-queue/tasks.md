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
