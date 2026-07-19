# Release Pipeline Optimization — Tasks

## Documentation

- [x] Record requirements and non-goals.
- [x] Document the exact-tree resume model and packaging design.

## Packaging

- [x] Guard `build-timestamped-release.mjs` against execution when imported.
- [x] Add focused coverage for direct execution and target argument selection.
- [x] Change ZIP mode to electron-builder directory output plus one custom ZIP pass.

## Node Tests

- [x] Add a manifest-driven, bounded-concurrency Node test runner.
- [x] Verify focused-file selection and manifest validation.
- [x] Replace the 700-file Git fixture with an in-memory overflow proof plus representative integration coverage.
- [x] Measure the final runner against the historical single-entrypoint duration.

## Release Verification

- [x] Add exact-tree fingerprinting and repo-external state/log storage.
- [x] Add resumable per-stage execution, `--fresh`, `--stage`, and `--plan`.
- [x] Wire `test:release`, `test:full`, and `verify` package scripts.

## Process Documentation

- [x] Update `release-pipeline` skill commands and recovery guidance.
- [x] Update `AGENTS.md`, README, regression skill, and stale script-contract tests.

## Verification

- [x] Run focused tooling tests.
- [x] Run `pnpm test:quality`.
- [x] Run the optimized Node suite and record duration/result.
- [x] Prove release-verifier resume behavior on an unchanged fingerprint.
- [x] Build a real Windows ZIP and inspect its top-level folder.
- [x] Update this task list with final evidence.

## Evidence

- Focused tooling/package-contract verification: 47 tests passed in 1.67 seconds.
- `pnpm test:quality`: passed in 75.7 seconds on the final code state.
- Historical Node release run: 788.99 seconds. Optimized manifest-isolated run with Windows concurrency 2 and force-exit cleanup: 352.83 seconds runner time / 355.7 seconds wall time, about 55% faster.
- The optimized full Node run completed instead of hanging and reported 1,520 passed / 8 failed. Every remaining failure is confined to the pre-existing dirty `tests/provider-system-prompt.test.ts` + `server/providers.ts` work-in-progress; the release-pipeline tooling tests are green.
- The formerly oversized Git pathspec suite completed all 33 tests in 288.34 seconds; its single 700-file case was replaced by a sub-millisecond in-memory overflow proof plus a 12-file integration flow.
- Exact-tree resume proof: the first `legal` stage took 0.9 seconds; the immediate unchanged-tree rerun selected `reuse` and did not execute the command again. Partial `--stage` runs correctly remained non-green because the other mandatory gates were missing.
- Real single-pass ZIP build: 78 seconds, down from the previous local sample of about 123 seconds. Artifact: `D:\Git\chill-vibe\dist\release-20260718-234606\Chill Vibe-0.18.8-win.zip` (161,548,785 bytes).
- ZIP inspection found 78 entries, exactly one top-level `Chill Vibe IDE` directory, and `Chill Vibe IDE/Chill Vibe.exe`.
