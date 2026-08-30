# Release Pipeline Optimization — Tasks

## Documentation

- [x] Record requirements and non-goals.
- [x] Document the exact-tree resume model and packaging design.

## Packaging

- [x] Guard `build-timestamped-release.mjs` against execution when imported.
- [x] Add focused coverage for direct execution and target argument selection.
- [x] Change ZIP mode to electron-builder directory output plus one custom ZIP pass.
- [x] Stage a frozen, hoisted production dependency tree and force electron-builder's npm collector so deep pnpm-transitive modules are retained.

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

## Branch Synchronization

- [x] Document the local-first release invariant and the v0.18.12/v0.18.13 remote-only divergence failure mode.
- [x] Ban `git push origin HEAD:main` from release worktrees.
- [x] Require the verified candidate to fast-forward local `main` before pushing `origin/main`.
- [x] Add final branch divergence and tag-target equality checks.
- [x] Record the same invariant in `AGENTS.md` packaging defaults.
- [x] Add a focused skill-contract test and register it in the Node test manifest.

## Verification

- [x] Run focused tooling tests.
- [x] Run `pnpm test:quality`.
- [x] Run the optimized Node suite and record duration/result.
- [x] Prove release-verifier resume behavior on an unchanged fingerprint.
- [x] Build a real Windows ZIP and inspect its top-level folder.
- [x] Update this task list with final evidence.

## Sensitive-content guard

- [x] Add the importable release safety scanner and the `release:audit` package script.
- [x] Add credential/path/debug-artifact categories with safe JSON diagnostics and an explicit synthetic-fixture allowlist.
- [x] Redact secrets, home usernames, and absolute workspace paths from release-verification and packaging output.
- [x] Run the audit in `.github/workflows/release-zip.yml` before install/build.
- [x] Add focused tests for detection, allowlisting, fail-closed base resolution, and log redaction.

## Reachable history audit

- [x] Add a streaming, timeout-bounded all-ref blob scanner with safe ref/commit diagnostics.
- [x] Add a focused temporary-repository test proving secrets and personal paths are found while commit emails are ignored.
- [x] Run the history audit in local release verification and the GitHub tag workflow before the candidate audit.
- [x] Back up refs, rewrite the confirmed sensitive blobs in an external mirror, and verify author/committer emails remain byte-for-byte unchanged.
- [x] Verify the controllable GitHub heads/tags after the force-update and record the external PR-ref permission boundary.
- [ ] Obtain GitHub Support confirmation that unreachable historical objects and cached views have been purged. **本次发布明确不包含历史对象重写/清理；该项是外部权限边界，仍未解决，不阻塞本候选未进行历史改写的发布。**

## Evidence

- Branch-convergence skill contract: 2 tests passed; it verifies local fast-forward → `git push origin main` → fetch/divergence proof → tag → GitHub Release ordering and rejects instructional worktree `HEAD:main` pushes.
- `pnpm test:quality` passed after the branch-convergence workflow and contract test changes.
- Focused tooling/package-contract verification: 47 tests passed in 1.67 seconds.
- `pnpm test:quality`: passed in 75.7 seconds on the final code state.
- Historical Node release run: 788.99 seconds. Optimized manifest-isolated run with Windows concurrency 2 and force-exit cleanup: 352.83 seconds runner time / 355.7 seconds wall time, about 55% faster.
- The optimized full Node run completed instead of hanging and reported 1,520 passed / 8 failed. Every remaining failure is confined to the pre-existing dirty `tests/provider-system-prompt.test.ts` + `server/providers.ts` work-in-progress; the release-pipeline tooling tests are green.
- The formerly oversized Git pathspec suite completed all 33 tests in 288.34 seconds; its single 700-file case was replaced by a sub-millisecond in-memory overflow proof plus a 12-file integration flow.
- Exact-tree resume proof: the first `legal` stage took 0.9 seconds; the immediate unchanged-tree rerun selected `reuse` and did not execute the command again. Partial `--stage` runs correctly remained non-green because the other mandatory gates were missing.
- Real single-pass ZIP build: 78 seconds, down from the previous local sample of about 123 seconds. Artifact: `D:\Git\chill-vibe\dist\release-20260718-234606\Chill Vibe-0.18.8-win.zip` (161,548,785 bytes).
- ZIP inspection found 78 entries, exactly one top-level `Chill Vibe IDE` directory, and `Chill Vibe IDE/Chill Vibe.exe`.
- Release safety guard: focused scanner/skill/verifier/performance contracts passed (26 tests), including a real temporary-Git staged-content proof; `pnpm test:quality` passed; `node scripts/audit-release-safety.mjs --base origin/main --json` returned an empty finding list. The audit intentionally ignores commit author/committer email addresses.
