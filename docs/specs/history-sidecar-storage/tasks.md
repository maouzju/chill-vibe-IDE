# Tasks — History sidecar storage

- [x] Document requirements and design.
- [x] Add red tests proving `state.json` stays lightweight and full history loads from sidecar.
- [x] Implement sidecar path helpers and per-entry read/write.
- [x] Update save/load/merge paths to prefer sidecar and keep main state lightweight.
- [x] Run focused tests and quality checks.
- [x] Diagnose whether Chill Vibe and VSCode use different proxy/VPN paths.
- [x] Add regression tests for lossless first archive and legacy migration.
- [x] Make sidecar replacement atomic and preserve the previous file on failure.
- [x] Prevent stale queued snapshots from overwriting immediate saves and make reset intentionally persist empty state.

