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
- [x] 2026-08-06：现场 8,863 个 sidecar / 约 974MB 取证；移除 provider、web 启动、旧工作区回退和缺失历史回退中的全量 sidecar 水合，保留旧命名与 WAL 兼容，并用真实文件系统观测测试锁住“不枚举/不读取无关 sidecar”。

