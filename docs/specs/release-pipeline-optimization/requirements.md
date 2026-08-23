# Release Pipeline Optimization — Requirements

## Background

Recent releases spend roughly 36–56 minutes from local verification start to a downloadable GitHub asset, while the server-side release workflow itself averages about four minutes. The main waste comes from repeated local work: the Node test entrypoint accidentally executes a full Windows package build when it imports a helper, release verification is fail-fast and not resumable, and ZIP packaging compresses the same payload twice.

The v0.18.12 and v0.18.13 releases also exposed a branch-integrity gap: an isolated release worktree pushed `HEAD:main` directly, while the checked-out local `main` was never advanced to the published commit. The release succeeded, but the normal workspace immediately appeared behind `origin/main` and required a conflict-prone merge to recover.

## Goals

1. Reduce release verification wall-clock time without removing any existing release gate.
2. Ensure importing packaging helpers never starts a real package build.
3. Produce the canonical Windows ZIP with one archive-compression pass.
4. Make release verification resumable only when the exact Git working tree is unchanged.
5. Preserve readable per-stage logs, timings, and a trustworthy final exit code.
6. Keep the existing `tests/index.test.ts` registration contract as the source of truth for Node tests.
7. Finish every release with local `main`, `origin/main`, and the release tag on the same commit.

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

### R6 — Local/remote branch convergence

- A release worktree may prepare and verify a candidate, but it must never push its `HEAD` directly to `origin/main`.
- The final verified candidate must first be integrated into the checked-out local `main`, normally by fast-forward.
- The publish step must push the local `main` ref, not an arbitrary worktree or detached `HEAD` refspec.
- Before tag creation, the workflow must fetch `origin/main` and prove that local `main` and `origin/main` resolve to the same commit and have divergence `0 0`.
- The annotated release tag must resolve to that same synchronized commit.
- If local `main` is dirty, conflicted, concurrently moving, contains excluded WIP, or cannot safely accept the candidate, the release is blocked until the work is moved to a separate branch/worktree and `main` becomes release-ready. Remote-only publication is not an acceptable fallback.
- Temporary release worktrees may be removed only after the convergence checks pass.
- A focused repository test must enforce the ordering of local integration, `main` push, convergence proof, tag creation, and GitHub Release creation, and must reject any instructional use of `git push origin HEAD:main`.

### R7 — Sensitive-content release guard

- The release pipeline must run an automated safety audit before version bumping, committing, tagging, or publishing.
- The audit must inspect the complete candidate surface: staged and unstaged tracked changes, non-ignored untracked files, and the candidate tree relative to the chosen base ref. It must not inspect commit author/committer email addresses as a leak signal.
- The audit must reject high-confidence credentials and authentication material (private-key blocks, provider/API tokens, GitHub/Slack/AWS tokens, JWTs, and non-placeholder bearer values) even when they occur in documentation, fixtures, generated files, or release notes.
- The audit must reject newly introduced personal-machine paths and external-project paths by comparing them with the base ref, while allowing the repository's documented synthetic fixtures and the public repository path explicitly approved by the project owner.
- The audit must reject debug/session artifacts such as `.codex-artifacts`, release scratch files, raw session captures, and untracked logs or screenshots unless an explicit, auditable allowlist entry covers the path.
- Findings must include only a safe path and pattern category; matched credential values and full sensitive lines must never be printed.
- Release-verification and packaging logs must redact credential-like values, home-directory usernames, and absolute workspace paths before writing to stdout or persistent log files. Child processes may retain required runtime environment variables, but their output must be treated as untrusted.
- The audit must be runnable in CI without GitHub credentials and must fail closed when the base ref cannot be resolved or the candidate cannot be enumerated deterministically.
- A focused test must prove the audit catches representative secrets, new local/external paths, and debug artifacts, allows zero-value test placeholders and approved synthetic paths, and redacts matched values from diagnostics.

### R8 ? Reachable Git history audit

- The release pipeline must scan every blob reachable from local heads, remote-tracking refs, tags, stash, and other refs before versioning or publishing.
- The scanner must use bounded, streaming Git object reads so a large history cannot hang the release indefinitely.
- Findings may expose only category, repository-relative path, line, object id, commit id, and ref names; matched values and source excerpts remain secret.
- Commit author/committer metadata, including personal email addresses, is intentionally excluded from the scan and from history rewriting.
- Explicit synthetic test fixtures may be allowlisted narrowly, while a concrete personal path or external-project path in any controllable ref blocks the release.
- Third-party fork/PR refs that cannot be rewritten must be reported as an external permissions boundary rather than counted as cleaned.
- After a rewrite, the pipeline must verify the controllable GitHub refs and record a server-side purge request when an old commit/blob is still retrievable by SHA; the cleanup remains unresolved until GitHub's unreachable-object/cache purge is confirmed.

## Non-Goals

- Skipping full release verification based only on changed file paths.
- Replacing the GitHub Actions Windows build with a locally uploaded happy-path asset.
- Running Playwright and Electron simultaneously on the same fixed renderer port.
- Changing product runtime behavior.
- Automatically force-pushing, resetting, stashing, or discarding local work to manufacture branch equality.

## Success Criteria

- A focused test proves importing the packaging module is side-effect free.
- ZIP dry-run output shows electron-builder `--win --dir`, not `--win zip`.
- The Node test runner discovers the same registered test set while excluding only explicitly dedicated non-unit entries, if any.
- Re-running the release verifier on an unchanged tree skips previously green stages; changing a tracked or untracked file changes the fingerprint.
- A real Windows ZIP build succeeds and contains one top-level `Chill Vibe IDE` directory.
- Verification and packaging durations are reported in the handoff.
- A focused contract test proves the documented publish sequence advances local `main` before the remote push, ends with explicit hash/divergence/tag equality checks, and mentions `git push origin HEAD:main` only as a prohibition.
