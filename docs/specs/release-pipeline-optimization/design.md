# Release Pipeline Optimization — Design

## Current Bottlenecks

1. `tests/release-prune.test.ts` imports `build-timestamped-release.mjs`, whose unconditional `main()` call starts a full package build. A successful release therefore packages once during Node tests and again in the explicit build/release stages.
2. ZIP mode passes `zip` to electron-builder, then patches the unpacked executable and overwrites the archive with the custom ZIP writer. The first compression is discarded.
3. `tests/index.test.ts` imports all tests into one Node test process. This limits file-level isolation and lets process-global test state collide.
4. `test:full` is a shell `&&` chain. A late failure loses information about unreached stages and encourages full reruns after host interruption.
5. A Git pathspec regression creates 700 real long-named files to exceed the Windows command-line limit even though the behavior under test is the NUL-delimited stdin encoder. That one fixture previously consumed about 262 seconds.

## Packaging Changes

### Direct-execution guard

Export a small `isDirectExecution(moduleUrl, argvEntry)` helper. Resolve both paths with `fileURLToPath`/`path.resolve` and call `main()` only when they match. Pure exports remain safe to import.

### Electron-builder target selection

Create a pure `createElectronBuilderArgs(target, outputDir)` helper:

- `zip` → `--win --dir`
- `nsis` → `--win nsis`
- `portable` → `--win portable`

All modes keep `signAndEditExecutable=false` and the timestamped output directory. ZIP mode then patches the executable and invokes `writeZipFromDirectory` exactly once.

## Node Test Runner

Add `scripts/run-node-tests.mjs`.

1. Read `tests/index.test.ts` as a manifest.
2. Parse static side-effect imports matching `./*.test.*`.
3. Resolve and validate every registered path.
4. Launch Node with `--import tsx --test --test-concurrency=<N>` and the registered files as separate entrypoints.
5. Default concurrency is 2 on Windows (4 elsewhere, bounded by available CPUs) and configurable through `CHILL_VIBE_TEST_CONCURRENCY` or `--concurrency`.
6. `--files` accepts a comma-separated focused subset while still validating that each requested file is registered.
7. Probe whether the active Node supports `--test-force-exit`; enable it when available so a completed file with leaked handles cannot hold the whole release gate open.

Running each file as its own Node test entrypoint isolates `process.env`, module caches, and other process-global state. Node can schedule independent files concurrently instead of treating the manifest as one large test file.

Electron runtime/performance files move out of the Node manifest and into one Electron harness invocation. The release still executes the same runtime and responsiveness coverage, but no test launches twice.

The long-path Git regression is split into a pure encoder boundary test using 700 in-memory paths and a representative 12-file integration flow. This preserves the Windows overflow guarantee without manufacturing hundreds of filesystem entries.

## Release Verification Runner

Add `scripts/run-release-verification.mjs`.

### Fingerprint

The verifier hashes:

- repository identity and absolute root;
- `git rev-parse HEAD`;
- `git diff --binary HEAD` (covers staged and unstaged tracked changes);
- every untracked path plus its content hash.

The state directory lives outside the repository under the OS temp directory. This avoids changing the tree being verified and survives Codex/terminal restarts.

### State

Each fingerprint directory contains:

- `state.json` with stage status, command, start/end time, duration, and log path;
- one UTF-8 log per stage.

Only `passed` stages for the same fingerprint are reused. Failed, interrupted, missing, or malformed state is rerun. `--fresh` ignores prior results.

### Execution

Stages remain sequential because Playwright, Electron, Vite, and build outputs share ports/directories. The runner does not stop at the first failure: it completes all selected stages and prints one summary table. This improves diagnosis without introducing resource races.

Supported controls:

- `--fresh`: rerun every stage;
- `--stage <id>`: run one or more named stages;
- `--plan`: print the fingerprint and resume decision without executing commands.

## Package Scripts

- `test` → new Node test runner.
- `test:release` → release verification runner.
- `test:full` and `verify` → aliases of `test:release` for compatibility.
- Individual gates remain unchanged for narrow reruns.

## Branch Convergence and Publish Gate

The default release source is the checked-out local `main`. An isolated worktree remains useful for long verification or for assembling an audited candidate without disturbing unrelated work, but it is no longer a remote publication surface.

### Candidate preparation

1. Fetch `origin/main` and confirm local `main` is not behind it before candidate assembly.
2. Keep unfinished work off `main`. If the current checkout mixes releasable and excluded work, move the excluded work to a named branch/worktree before the final release gate; do not hide it with an implicit stash or discard it.
3. Create any release worktree from the current local `main` commit, not from a stale `origin/main` baseline.
4. Run verification and create the versioned release commit on the release branch when isolation is necessary.

### Local-first integration

Before any push to `origin/main`:

1. Re-check the recorded refs: `origin/main` must still equal the remote base; when a release worktree was used, local `main` must still equal its local base; when the candidate was committed directly on `main`, local `main` must equal the verified candidate commit. An unexpected move invalidates the exact-tree fingerprint and requires reconciliation plus verification of the new candidate.
2. Require the primary `main` checkout to be clean and free of unmerged paths.
3. Integrate the verified release branch into local `main` with `git merge --ff-only release/vX.Y.Z`. If fast-forward is impossible, stop and reconcile deliberately; do not bypass the problem with `git push origin HEAD:main`.
4. Push with `git push origin main`.

This ordering ensures the branch visible in the user's normal workspace is the branch that is published.

### Convergence proof

Immediately after the push and before creating the tag:

1. `git fetch origin main`
2. Compare `git rev-parse main` and `git rev-parse origin/main`.
3. Require `git rev-list --left-right --count main...origin/main` to print `0 0`.
4. Create the annotated tag from local `main`, then require `git rev-parse vX.Y.Z^{}` to equal both branch hashes.

Any mismatch leaves the release incomplete. The workflow must repair the branch state and re-verify as needed rather than reporting success or cleaning up the release worktree.

### Documentation contract test

`tests/release-pipeline-skill.test.ts` reads the checked-in skill and treats the publish order as a repository contract. It verifies that local fast-forward integration precedes `git push origin main`, that the post-push fetch/divergence proof precedes tag and Release creation, and that every occurrence of `git push origin HEAD:main` is explicitly prohibitive. This keeps a future skill rewrite from silently restoring the remote-only failure mode.

### Concurrency behavior

If another agent is actively changing the primary checkout, verification may continue in isolation, but publication waits. The release is blocked until the local-first integration and convergence proof can run safely. This trades a delayed release for a deterministic branch history and avoids recreating the v0.18.12/v0.18.13 remote-only divergence.

## Safety

- Resume is content-addressed, not time-based or path-risk-based.
- Any tracked/staged/untracked content change invalidates all cached evidence.
- The verifier never marks an interrupted process green.
- Existing full Playwright, Electron, legal, quality, and build gates remain mandatory.
- Release isolation must not leave the primary local branch behind the branch it publishes.
- Force-push, hard reset, automatic stash, and direct worktree-to-`main` refspecs are not convergence mechanisms.
