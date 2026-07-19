# Release Pipeline Optimization — Requirements

## Background

Recent releases spend roughly 36–56 minutes from local verification start to a downloadable GitHub asset, while the server-side release workflow itself averages about four minutes. The main waste comes from repeated local work: the Node test entrypoint accidentally executes a full Windows package build when it imports a helper, release verification is fail-fast and not resumable, and ZIP packaging compresses the same payload twice.

## Goals

1. Reduce release verification wall-clock time without removing any existing release gate.
2. Ensure importing packaging helpers never starts a real package build.
3. Produce the canonical Windows ZIP with one archive-compression pass.
4. Make release verification resumable only when the exact Git working tree is unchanged.
5. Preserve readable per-stage logs, timings, and a trustworthy final exit code.
6. Keep the existing `tests/index.test.ts` registration contract as the source of truth for Node tests.

## Functional Requirements

### R1 — Side-effect-free packaging imports

- `scripts/build-timestamped-release.mjs` must execute its CLI only when launched directly.
- Importing its pure helpers from a test must not create `dist/release-*`, run Vite, invoke electron-builder, or generate a ZIP.

### R2 — Single-pass ZIP packaging

- ZIP builds must ask electron-builder for an unpacked Windows application, not an intermediate ZIP that is later overwritten.
- The existing custom ZIP writer remains responsible for the final archive and the required top-level `Chill Vibe IDE` folder.
- Installer and portable targets must retain their current electron-builder targets.

### R3 — Faster isolated Node tests

- `pnpm test` must continue to run every Node test registered by `tests/index.test.ts`.
- Registered files should run as separate Node test files so process-global environment mutations are isolated and independent files can execute concurrently.
- Concurrency must be bounded and configurable to avoid overwhelming Windows disk/process resources.
- A focused-file option must remain available for narrow verification.

### R4 — Resumable release verification

- Add a repo script that runs the release gates: legal inventory, quality, Node tests, full Playwright, Electron runtime, and production build.
- Each stage must have its own log and elapsed time.
- By default, later independent stages still run after an earlier failure so one pass reveals the complete failure set.
- Successful stages may be reused only when HEAD, tracked changes, staged changes, and untracked file contents produce the same verification fingerprint.
- `--fresh` must force all stages to run again.
- The command must exit non-zero whenever any required stage is not green.

### R5 — Release workflow integration

- `pnpm test:release` becomes the release-pipeline verification command.
- `pnpm test:full` remains available as a compatibility alias.
- The release-pipeline skill must use the new resumable verifier and explain when cached stage evidence is valid.

## Non-Goals

- Skipping full release verification based only on changed file paths.
- Replacing the GitHub Actions Windows build with a locally uploaded happy-path asset.
- Running Playwright and Electron simultaneously on the same fixed renderer port.
- Changing product runtime behavior.

## Success Criteria

- A focused test proves importing the packaging module is side-effect free.
- ZIP dry-run output shows electron-builder `--win --dir`, not `--win zip`.
- The Node test runner discovers the same registered test set while excluding only explicitly dedicated non-unit entries, if any.
- Re-running the release verifier on an unchanged tree skips previously green stages; changing a tracked or untracked file changes the fingerprint.
- A real Windows ZIP build succeeds and contains one top-level `Chill Vibe IDE` directory.
- Verification and packaging durations are reported in the handoff.
