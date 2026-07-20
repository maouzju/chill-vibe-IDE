---
name: release-pipeline
description: Audit the current Chill Vibe repo diff for sensitive or irrelevant changes, run release-safety verification, bump the version, commit and push to GitHub, then publish a new GitHub release with the verified Windows zip asset. Use when the user asks for one-stop release work, safe publish, version bump plus release, or wants local changes reviewed before pushing and releasing.
---

# Release Pipeline

Use this skill from the `chill-vibe` repo root when the task is not just “run tests”, but “safely turn the current checkout into a shipped GitHub release”.

Reuse the verification posture from `../chill-vibe-full-regression/SKILL.md`, but own the full release chain: pre-flight → diff audit → final version bump → exact-tree verification → local `main` integration → push/convergence proof → tag/release (server-side build) → asset verification.

**Primary asset path: pushing the `v*` tag triggers `.github/workflows/release-zip.yml`, which builds the Windows zip server-side, uploads the canonical `Chill.Vibe-<version>-win.zip` (spaces normalized to dots), and verifies asset state + download URL itself — normally within ~3–4 minutes.** Do NOT build the zip locally or `gh release upload` manually on the happy path; that wastes minutes and races the workflow (HTTP 404/409). Local build is a fallback only (step 6b).

## Workflow

1. Pre-flight — inspect repo state and rule out interference before touching anything:
   - `git status --short --branch`, `git diff --stat`, `git remote -v`, `gh auth status`
   - `git fetch origin main`; record `git rev-parse main` and `git rev-parse origin/main`. The release target is the local `main` branch. If local `main` is behind or diverged, reconcile it before assembling a candidate; do not build a new release on a stale branch graph.
   - read `package.json` version and `git tag --sort=-version:refname` (top few), then check the authoritative remote state with `gh release list --limit 5` or `git ls-remote --tags origin`; local tags can diverge from GitHub and the package version can lag an already-published release, so choose the next version above the highest published remote tag instead of trusting either source alone
   - if `git fetch --tags` reports `would clobber existing tag`, do not force-rewrite tags during the release. Record the mismatch, use the remote tag/release state for versioning and collision checks, and leave unrelated local tag repair for a separate task.
   - **Concurrency check: `git reflog -8`, recent dirty-file mtimes, and live repo-launched provider sessions.** Reflog only records ref movement; it does not reveal another card/agent that is still editing the shared working tree. If recent writes or multiple active Codex/Claude app-server sessions make concurrent work plausible, do NOT run long verification in the main checkout — a concurrent agent can switch HEAD or mutate files mid-run, so a long release gate can silently validate the wrong tree (happened for v0.17.11). Instead, create a repo-external worktree from the recorded local `main` commit: `git worktree add -b release/vX.Y.Z <external-path> <local-main-commit>`, install there, snapshot the audited candidate only after its source mtimes are stable, and prepare/verify it there. **That worktree is verification isolation only: it must never run `git push origin HEAD:main`, create the final tag, or publish the release.** Final integration and publication return to the primary local `main` checkout after concurrent writes stop.
2. Audit the pending diff for release blockers before any commit:
   - look for secrets, tokens, auth headers, local absolute paths, debug-only noise, or unrelated files
   - treat obvious test fixtures like `sk-test` as expected only if they stay inside tests
   - explicitly review new docs/spec files so accidental scratch notes do not ship
   - treat changed SPEC task lists with unchecked implementation/verification boxes as a release blocker until the corresponding slice is completed or explicitly excluded; run any newly added proving test narrowly so an intentional red test cannot hide inside the later full-suite output
   - if the checkout mixes a release-ready slice with unfinished user/agent WIP, preserve the WIP on a named branch/worktree and make local `main` release-ready before publication. A repo-external release worktree may assemble and verify a path-limited candidate, but it does not make remote-only publication safe. Do not stash, revert, discard, or accidentally commit excluded WIP; if local `main` cannot safely become clean and accept the candidate, the release is blocked.
   - if something is suspicious, stop and fix or exclude it before continuing
3. Set the final release version after the audit and before the final verification:
   - default to the next patch version unless the diff clearly justifies a bigger bump
   - update `package.json` and any other repo-owned version references that must stay in sync
   - stage the version bump together with the already-audited product changes
   - the final release verifier fingerprints the complete tree, so changing the version after verification would invalidate every cached gate and force another full pass
4. Verify the final versioned tree — a release warrants the release posture from `../chill-vibe-full-regression/SKILL.md`:
   - after installing dependencies in a fresh worktree, verify `node_modules/electron/dist/electron.exe` exists. pnpm may report `Ignored build scripts: electron`; when the executable is missing, run `node node_modules/electron/install.js` before the release verifier. Otherwise the Node icon test and every Electron runtime test fail for environment setup rather than candidate code.
   - run `pnpm test:release` (`pnpm test:full` remains a compatibility alias). It runs legal inventory, quality, manifest-isolated Node tests, full Playwright, one combined Electron runtime/performance session, and the production build.
   - the verifier stores per-stage logs and evidence outside the repo, keyed by HEAD plus staged, unstaged, and untracked content. It only reuses a green stage when the exact fingerprint is unchanged; any source, test, version, or untracked-content change creates a new verification set.
   - **run long verification decoupled from the host session.** Launch via `Start-Process -WindowStyle Hidden cmd.exe '/d', '/s', '/c', 'pnpm test:release > <repo-external log> 2>&1 && echo ALL_GATES_GREEN >> <log> || echo GATE_FAILED >> <log>'`, then monitor the outer log plus the evidence directory printed near the top. If the driving CLI restarts, run `pnpm test:release` again: passed stages for the unchanged fingerprint are reused, while interrupted/running/failed stages run again.
   - `pnpm test:risk` is acceptable mid-iteration, but the final pre-tag gate for a real release is `test:release`
   - the verifier deliberately continues after a failed stage so one pass reveals the complete failure set. Do not manually restart unreached stages unless the verifier itself crashed before recording them.
   - use `pnpm test:release --stage <id>` only to retry an environmental failure on an unchanged tree. If code or test files changed, the fingerprint changes and the command remains non-green until every required stage passes for the new tree.
   - in a fresh isolated worktree, the first Electron stage can expose an artifact-creation race when several runtime files call `ensureElectronRuntimeBuild()` before `dist/client` and `dist/electron` exist. If the failures are only missing/rename/access errors inside those generated directories, let the verifier's production-build stage finish, then retry `pnpm test:release --stage electron` on the unchanged fingerprint; investigate or baseline-compare any failure that remains after the artifacts exist.
   - use `pnpm test:release --plan` to inspect resume decisions and `pnpm test:release --fresh` only when matching cached evidence must be discarded intentionally.
   - Node tests run as separate registered files with bounded concurrency. Rerun one file with `pnpm test --files=<name>.test.ts`; the extra standalone `--` is parsed as an unknown argument by the repo runner. Do not boot the old all-imports entrypoint for focused triage.
   - importing the timestamped packager is side-effect free, so Node verification must not create a release directory or ZIP. The only happy-path package build remains the server-side `release-zip.yml` workflow.
   - if Playwright tooling noise from `AGENTS.md` blocks a clean run, capture the exact failure and continue with the strongest proven alternative only if the release is still honestly defensible
   - if a narrow failure looks pre-existing, prove that instead of guessing: reproduce the same test against `origin/main` in a repo-external detached comparison worktree, then remove it. Only classify the failure as baseline noise when the release candidate's affected/targeted gates pass and the baseline shows the same failure.
   - when a broad Playwright run mixes baseline snapshot drift with candidate-only snapshot changes, baseline-compare the failing spec first. For candidate-only diffs, inspect the actual/diff images in both themes and narrow layouts, update only the snapshots whose new rendering is intentional, then rerun those exact specs without `--update-snapshots`; never accept unrelated baseline drift along with them.
   - if fixed port `5173` is owned by an unrelated checkout, do not stop or reuse that process. Record the Playwright gate as port-blocked, then prove Electron runtime coverage against a free strict Vite port with the repo-local test environment. Do not run the stock `test:electron` while an unrelated service owns `5173`; its harness can validate the wrong renderer.
   - when a standalone harness has printed its final green summary but its process stays alive, inspect the process tree and port `5173` before calling it hung. Stop only the verified test child, record the printed summary, and never touch a packaged Chill Vibe process.
5. Integrate into local `main`, push, prove convergence, tag, and **immediately create the release** (order is load-bearing):
   - write a concise release-oriented commit message and commit only the intended verified files. If the commit was created in a release worktree, record its branch and commit hash, then return to the primary checkout.
   - before publication, fetch `origin/main` again and require it to still equal the recorded remote base. If a release worktree was used, require local `main` to still equal its recorded local base; if the candidate was committed directly on local `main`, require `main` to equal the verified candidate commit. Also require the primary checkout to have no unmerged paths or unrelated dirty files. If an expected ref moved or the checkout cannot safely integrate, stop, reconcile, and rerun verification for the changed fingerprint.
   - advance the primary local branch first: when a release branch was used, run `git merge --ff-only release/v<version>` from the local `main` checkout. If fast-forward is impossible, do not bypass it with a direct refspec; reconcile the history deliberately and re-verify.
   - push only the local branch ref: `git push origin main`. **Never use `git push origin HEAD:main` from a release worktree or detached checkout.**
   - immediately run `git fetch origin main`, require `git rev-parse main` to equal `git rev-parse origin/main`, and require `git rev-list --left-right --count main...origin/main` to return `0 0`. A release is not publishable while the normal local workspace is ahead, behind, or diverged from the remote branch it just updated.
   - create the annotated tag from synchronized local `main`: `git tag -a v<version> -m "v<version>" main`. Require `git rev-parse v<version>^{}` to equal both branch hashes, then `git push origin v<version>`.
   - **immediately after the tag push:** `gh release create v<version> --verify-tag --title v<version> --notes <concise notes>`
   - Why immediately: the tag push already started `release-zip.yml`, and its "Remove stale in-progress zip assets" step does `gh api releases/tags/<tag>` — it hard-fails with HTTP 404 if no release exists yet (v0.17.8 and v0.17.11 both died here after 3+ min of server build). Recovery is cheap (`gh release create v<tag> --verify-tag --notes ...` then `gh run rerun <failed-run-id>`), but the right order avoids it entirely.
6. Let the workflow deliver the asset, then verify:
   - `gh run list --workflow release-zip.yml --limit 1 --json databaseId,status,conclusion` then `gh run watch <databaseId>` (expect ~3–4 minutes)
   - the workflow itself verifies `assets[].state == 'uploaded'` and that the download URL returns HTTP 200, so a green run IS the asset verification
   - confirm and record: `gh release view v<version> --json url,assets --jq '{url, assets: [.assets[] | {name, size, state}]}'`
   - 6b. Fallback, ONLY if the workflow failed or never produced the asset:
     - first try `gh workflow run release-zip.yml -f tag=v<version>` (server-side rebuild — preferred; it builds from the tag and self-verifies)
     - only if server-side is unusable: build locally with `pnpm electron:build:zip`, take the newest `dist/release-*` zip, upload with the call-operator form `& gh release upload v<version> $zip --clobber`, then re-verify the asset list yourself
7. Restart the active repo runtime before handoff:
   - follow `AGENTS.md`; prefer `pnpm dev:restart`
   - **skip the restart if the concurrency check (step 1) found another active agent** — never restart the shared dev runtime while another agent is working
   - remove any release worktree created in step 1 only after local `main`, `origin/main`, and the release tag have passed the equality checks and the release asset is verified
8. Retrospect and update this skill (mandatory, see Skill Self-Maintenance):
   - review the run you just did: where did reality diverge from this document? Which step was wasted, wrong, missing, or only survived thanks to improvisation?
   - apply the resulting edits to this SKILL.md before handoff — a release is not finished while the skill still describes a flow you did not actually follow

## Audit Rules

- Do not assume “no leak” because the diff looks code-like. Search for:
  - real secrets or keys
  - bearer tokens or auth headers
  - local machine paths such as `C:\Users\...` or `D:\...`
  - temp/debug leftovers (`console.log`, `debugger`, scratch docs, throwaway fixtures)
- Expected test-only placeholders are acceptable when they are fake and obviously scoped to tests.
- Review deleted files too; make sure a deletion is intentional, not accidental.
- If unrelated files slipped in, unstage or revert them before the release commit.

## Verification Rules

- Prefer repo scripts over ad hoc commands.
- Use the release posture from `../chill-vibe-full-regression/SKILL.md`.
- If a verification command fails, do not publish anyway unless the failure is clearly a pre-existing harness issue and you can explain why the release remains safe.

## Versioning Rules

- Default bump: patch.
- Tag format: `v<package.json version>`.
- Keep the release title equal to the tag unless the user asked for a different naming scheme.
- Release notes can be concise and derived from the audited diff summary; do not paste huge raw diffs.

## GitHub Release Rules

- Server-side build via `release-zip.yml` is the canonical asset path; a green workflow run is the asset verification.
- Local `main`, `origin/main`, and the annotated release tag must resolve to the same commit before the release is created. Remote-only success is a failed release handoff.
- Confirm the release asset actually exists after the run; do not trust command success alone.
- In the final handoff, report:
  - commit hash
  - pushed branch
  - new version
  - tag
  - GitHub release URL
  - final downloadable asset URL (and local zip path only if the fallback was used)

## Skill Self-Maintenance

This skill maintains itself. Step 8 of the Workflow is not optional: every run ends with a retrospective edit pass over this file. History shows why — the "push tag → create release immediately" rule and the concurrency worktree rule both sat in the pitfall list for multiple releases while the main Workflow kept teaching the outdated local-build flow, and agents following the main flow re-hit the same failures.

Classify every lesson from the run before writing it down:

- **It changed how the release should be done** (a step order, a command, a decision rule) → edit the Workflow step itself. Never record a flow change only as a pitfall bullet; that is how the main flow drifts.
- **It was a one-off accident with a recovery trick** (a hang, a quoting bug, an environment failure) → add a bullet to Release Pitfalls / Fast Recovery.
- **A recorded pitfall no longer applies** (the main flow now prevents it, or the referenced tool/workflow changed) → delete it. Stale pitfalls are as harmful as missing ones.

Guardrails:

- Keep Release Pitfalls under roughly 10 bullets. Before adding a new one over that budget, merge or delete an old one first.
- Also check for silent drift even on a clean run: do the commands and file paths this skill references (`.github/workflows/release-zip.yml`, `package.json` scripts like `test:release` / `electron:build:zip`, `gh` invocations) still exist and behave as described? If the repo moved, move the skill.
- If the release commit/tag is already pushed, make the skill update a separate follow-up commit so the shipped tag stays immutable. Otherwise fold it into the release commit.
- Release-specific traps belong here, not only in `AGENTS.md`.

## Release Pitfalls / Fast Recovery

- `gh release create` can time out after partially creating a draft or empty release. After any timeout, do not rerun blindly:
  - stop orphaned `gh.exe` create/upload processes first, then inspect `gh release view v<tag> --json apiUrl,uploadUrl,url,assets,isDraft,isPrerelease,tagName,publishedAt`;
  - if the release exists but has no asset, keep it and let the workflow (or a `workflow_dispatch` rerun) upload the asset;
  - if it is an accidental draft with an `untagged-*` URL, verify whether it still exists through the API/list view before deleting or recreating.
- If a manual `gh release upload` (fallback path only) hangs on the large zip while a tiny probe asset uploads successfully, prefer `gh workflow run release-zip.yml -f tag=v<tag>` so GitHub builds/uploads/verifies server-side. Use a manual `curl.exe --http1.1` upload against the release `uploadUrl` only as a last resort; put the token only in a temporary curl config, never echo it to logs, and delete probe assets immediately after the check.
- When uploading a Windows zip whose path contains spaces, avoid `Start-Process -ArgumentList @(..., $zip, ...)` unless the path is explicitly quoted; PowerShell joins the array into one string and `gh release upload` can split `Chill Vibe-...zip` at the space. Prefer the call operator form: `& gh release upload v<tag> $zip --clobber`.
- When generating temporary curl config lines in PowerShell, wrap concatenated strings in parentheses inside arrays, e.g. `('output = "' + $path + '"')`; otherwise PowerShell can split the config value across multiple lines and curl fails before uploading.
- Do not keep retrying the full regression wrapper when it is blocked by known fixed-port `5173` ownership or a flaky Playwright check. Capture the exact wrapper failure, confirm the port owner is repo-local before stopping it, and rerun the failing spec or strongest targeted gate in isolation.
- A baseline comparison worktree may intentionally share `node_modules` through a junction. Do not run `pnpm install` there when pnpm says it will remove the shared modules directory; use the already-linked dependencies or create a fresh isolated baseline worktree instead.
- If the full Playwright suite collapses after Chromium reports `FATAL ... Failed to start BrowserThread:IO`, expect cascading `ERR_CONNECTION_REFUSED` once the Vite web server dies. Treat that as a local browser harness/resource failure, stop only orphaned `ms-playwright` Chromium processes, verify `5173` is free, then rerun the strongest practical gates (`pnpm test:risk` or targeted Playwright + smoke + Electron + build) instead of blindly looping the full suite.
- If `pnpm test:risk` fails with `ENOSPC` while tests copy `node.exe` into `%TEMP%`, move `TEMP`/`TMP` to a repo-external drive with free space (for example `D:\Temp\chill-vibe-release-temp`) before rerunning. Do not point temp at a directory inside this repo: fake CLI `.js` files then inherit the repo `"type": "module"` package scope and fail with `require is not defined`.
- Avoid piping release verification commands through `Tee-Object` when their harness launches Vite, Electron, or other background children. A detached child can inherit the pipe, or a repo-local Vite child can survive harness cleanup, after the tests have already printed a green summary; inspect the log/process tree, stop only the verified test child, and use the printed summary instead of waiting forever for a wrapper marker.
- Baseline-comparison worktrees: create them OUTSIDE the repo (e.g. `D:\Temp\...`) — a worktree under `.claude/worktrees/` can stay locked by zombie test processes after the specs finish, and even `Remove-Item -Recurse -Force` fails with "in use" (v0.18.1 left an undeletable dir shell). If a `node_modules` junction resists deletion, remove it with `[System.IO.Directory]::Delete($junction)` first; if the dir is still handle-locked, delete the files inside and leave the empty shell for the next reboot.
- Clean up release scratch files before final handoff (`.tmp-release-notes-*`, `.tmp-gh-upload-*`, `.tmp-curl-*`) unless they are intentionally needed for audit evidence.
- If repeated `gh run watch` calls are cut off by a short host command timeout, poll `gh run view <id> --json status,conclusion,jobs,url` instead; this keeps the server-side build authoritative without restarting or duplicating it.

## Suggested Prompt Shapes

- `Use $release-pipeline to audit this checkout, bump the version, and publish a GitHub release if it is safe.`
- `Use $release-pipeline for a full one-stop release: inspect for leaks, verify, commit, push, tag, package, and release.`
