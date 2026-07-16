---
name: release-pipeline
description: Audit the current Chill Vibe repo diff for sensitive or irrelevant changes, run release-safety verification, bump the version, commit and push to GitHub, then publish a new GitHub release with the verified Windows zip asset. Use when the user asks for one-stop release work, safe publish, version bump plus release, or wants local changes reviewed before pushing and releasing.
---

# Release Pipeline

Use this skill from the `chill-vibe` repo root when the task is not just “run tests”, but “safely turn the current checkout into a shipped GitHub release”.

Reuse the verification posture from `../chill-vibe-full-regression/SKILL.md`, but own the full release chain: pre-flight → diff audit → verification → version bump → commit/push/tag → release (server-side build) → asset verification.

**Primary asset path: pushing the `v*` tag triggers `.github/workflows/release-zip.yml`, which builds the Windows zip server-side, uploads the canonical `Chill.Vibe-<version>-win.zip` (spaces normalized to dots), and verifies asset state + download URL itself — all within ~4 minutes.** Do NOT build the zip locally or `gh release upload` manually on the happy path; that wastes minutes and races the workflow (HTTP 404/409). Local build is a fallback only (step 6b).

## Workflow

1. Pre-flight — inspect repo state and rule out interference before touching anything:
   - `git status --short --branch`, `git diff --stat`, `git remote -v`, `gh auth status`
   - read `package.json` version and `git tag --sort=-version:refname` (top few), then check the authoritative remote state with `gh release list --limit 5` or `git ls-remote --tags origin`; local tags can diverge from GitHub and the package version can lag an already-published release, so choose the next version above the highest published remote tag instead of trusting either source alone
   - if `git fetch --tags` reports `would clobber existing tag`, do not force-rewrite tags during the release. Record the mismatch, use the remote tag/release state for versioning and collision checks, and leave unrelated local tag repair for a separate task.
   - **Concurrency check: `git reflog -8`.** If another agent made checkout/merge entries within the last few minutes, do NOT verify or release from the main checkout — a concurrent agent can switch HEAD mid-run, so a long `pnpm test:risk` silently validates the wrong tree (happened for v0.17.11: the merge result was checked out away 28s after merging). Instead: `git worktree add -b release/vX.Y.Z .claude/worktrees/<name> <commit>` (use `git rev-parse HEAD` for the commit if the current tree is the intended release state), `pnpm install` there, and run ALL remaining steps (verify, bump, commit, tag, push) from that worktree. Remove the worktree after the release.
2. Audit the pending diff for release blockers before any commit:
   - look for secrets, tokens, auth headers, local absolute paths, debug-only noise, or unrelated files
   - treat obvious test fixtures like `sk-test` as expected only if they stay inside tests
   - explicitly review new docs/spec files so accidental scratch notes do not ship
   - treat changed SPEC task lists with unchecked implementation/verification boxes as a release blocker until the corresponding slice is completed or explicitly excluded; run any newly added proving test narrowly so an intentional red test cannot hide inside the later full-suite output
   - if the checkout mixes a release-ready slice with unfinished user/agent WIP, preserve that WIP in place: create a repo-external detached release worktree from the intended base commit, apply only a path-limited patch for the audited slice, and run verification there. After verification, mirror and stage only those exact verified paths plus the version/skill updates on the target branch; do not stash, revert, or accidentally commit the excluded WIP.
   - if something is suspicious, stop and fix or exclude it before continuing
3. Verify — a release warrants the release posture from `../chill-vibe-full-regression/SKILL.md`:
   - run `pnpm test:full` (it already includes `pnpm build`, so it also proves the production build)
   - **run long verification decoupled from the host session.** Background shell tasks die silently (no partial output) when the driving CLI session restarts — v0.18.1 lost two full `test:full` runs this way. Launch via `Start-Process -WindowStyle Hidden cmd.exe '/c', 'pnpm test:full > <repo-external log> 2>&1 && echo ALL_GATES_GREEN >> <log> || echo GATE_FAILED >> <log>'`, then tail/monitor the log. Do NOT trust `echo EXITCODE=%ERRORLEVEL%` after an unconditional `&` — in a single-line `cmd /c` string `%ERRORLEVEL%` expands at parse time and always prints 0; use the `&& echo GREEN || echo FAILED` marker pair instead. On session restart, re-read the log to resume instead of rerunning.
   - `pnpm test:risk` is acceptable mid-iteration, but the final pre-tag gate for a real release is `test:full`
   - The Node suite currently exercises the timestamped Windows zip packager and can create `dist/release-*` plus a local `Chill Vibe-<version>-win.zip` during `test:full`. Treat those as verification artifacts, not the release asset or fallback path: do not upload them, and keep the server-side `release-zip.yml` workflow canonical unless step 6b is actually needed.
   - if Playwright tooling noise from `AGENTS.md` blocks a clean run, capture the exact failure and continue with the strongest proven alternative only if the release is still honestly defensible
   - if a narrow failure looks pre-existing, prove that instead of guessing: reproduce the same test against `origin/main` in a temporary detached comparison worktree, then remove it. Only classify the failure as baseline noise when the release candidate's affected/targeted gates pass and the baseline shows the same failure.
   - if the Node test stage prints its final assertions but the wrapper stays alive with no output or CPU because of leaked handles, terminate only that verified wrapper process tree and rerun the same suite with `node --import tsx --test --test-force-exit tests/index.test.ts` to obtain a trustworthy pass/fail summary. If the force-exit run still lacks a summary, search its log for completed failing cases and inspect descendants before stopping anything: let active Electron/Git children finish, then rerun every reported failure narrowly (and baseline-compare it when needed). Do not treat assertion output without the runner summary as a green unit gate.
   - Node test files run concurrently inside `tests/index.test.ts`. New tests must not mutate process-global routing/home environment variables (`HOME`, `USERPROFILE`, `CHILL_VIBE_EXTERNAL_HISTORY_HOME`, etc.) while unrelated suites are active; inject file locators or dependencies instead. If full-suite-only failures disappear in isolated tests, audit for global-state collisions before calling them flaky.
   - when `test:full` exits early, run the unreached stages separately (`test:quality`, the strongest practical unit/Playwright gates, `test:electron`, and `build`). An early wrapper failure is not evidence that later gates passed.
   - when a standalone harness has printed its final green summary but the detached marker never arrives, inspect the process tree and port `5173` before calling it hung. `test:electron` can leave only its repo-local Vite child alive after all tests pass; stop only that verified test server, record the printed summary as the gate result, and never touch a packaged Chill Vibe process.
4. Bump the version only after the code is judged releasable:
   - default to the next patch version unless the diff clearly justifies a bigger bump
   - update `package.json` and any other repo-owned version references that must stay in sync
   - stage the version bump together with the already-audited product changes
   - if the bump touched files covered by verification, rerun the strongest relevant gate
5. Commit, push, tag, and **immediately create the release** (order is load-bearing):
   - write a concise release-oriented commit message; `git add` only the intended files; `git commit`; `git push origin <current-branch>`
   - `git tag -a v<version> -m "v<version>"` and `git push origin v<version>`
   - **immediately after the tag push:** `gh release create v<version> --verify-tag --title v<version> --notes <concise notes>`
   - Why immediately: the tag push already started `release-zip.yml`, and its "Remove stale in-progress zip assets" step does `gh api releases/tags/<tag>` — it hard-fails with HTTP 404 if no release exists yet (v0.17.8 and v0.17.11 both died here after 3+ min of server build). Recovery is cheap (`gh release create v<tag> --verify-tag --notes ...` then `gh run rerun <failed-run-id>`), but the right order avoids it entirely.
6. Let the workflow deliver the asset, then verify:
   - `gh run list --workflow release-zip.yml --limit 1 --json databaseId,status,conclusion` then `gh run watch <databaseId>` (expect ~4 minutes)
   - the workflow itself verifies `assets[].state == 'uploaded'` and that the download URL returns HTTP 200, so a green run IS the asset verification
   - confirm and record: `gh release view v<version> --json url,assets --jq '{url, assets: [.assets[] | {name, size, state}]}'`
   - 6b. Fallback, ONLY if the workflow failed or never produced the asset:
     - first try `gh workflow run release-zip.yml -f tag=v<version>` (server-side rebuild — preferred; it builds from the tag and self-verifies)
     - only if server-side is unusable: build locally with `pnpm electron:build:zip`, take the newest `dist/release-*` zip, upload with the call-operator form `& gh release upload v<version> $zip --clobber`, then re-verify the asset list yourself
7. Restart the active repo runtime before handoff:
   - follow `AGENTS.md`; prefer `pnpm dev:restart`
   - **skip the restart if the concurrency check (step 1) found another active agent** — never restart the shared dev runtime while another agent is working
   - remove any release worktree created in step 1
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
- Also check for silent drift even on a clean run: do the commands and file paths this skill references (`.github/workflows/release-zip.yml`, `package.json` scripts like `test:full` / `electron:build:zip`, `gh` invocations) still exist and behave as described? If the repo moved, move the skill.
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
- If the full Playwright suite collapses after Chromium reports `FATAL ... Failed to start BrowserThread:IO`, expect cascading `ERR_CONNECTION_REFUSED` once the Vite web server dies. Treat that as a local browser harness/resource failure, stop only orphaned `ms-playwright` Chromium processes, verify `5173` is free, then rerun the strongest practical gates (`pnpm test:risk` or targeted Playwright + smoke + Electron + build) instead of blindly looping the full suite.
- If `pnpm test:risk` fails with `ENOSPC` while tests copy `node.exe` into `%TEMP%`, move `TEMP`/`TMP` to a repo-external drive with free space (for example `D:\Temp\chill-vibe-release-temp`) before rerunning. Do not point temp at a directory inside this repo: fake CLI `.js` files then inherit the repo `"type": "module"` package scope and fail with `require is not defined`.
- Avoid piping release verification commands through `Tee-Object` when their harness launches Vite, Electron, or other background children. A detached child can inherit the pipe, or a repo-local Vite child can survive harness cleanup, after the tests have already printed a green summary; inspect the log/process tree, stop only the verified test child, and use the printed summary instead of waiting forever for a wrapper marker.
- Baseline-comparison worktrees: create them OUTSIDE the repo (e.g. `D:\Temp\...`) — a worktree under `.claude/worktrees/` can stay locked by zombie test processes after the specs finish, and even `Remove-Item -Recurse -Force` fails with "in use" (v0.18.1 left an undeletable dir shell). If a `node_modules` junction resists deletion, remove it with `[System.IO.Directory]::Delete($junction)` first; if the dir is still handle-locked, delete the files inside and leave the empty shell for the next reboot.
- Clean up release scratch files before final handoff (`.tmp-release-notes-*`, `.tmp-gh-upload-*`, `.tmp-curl-*`) unless they are intentionally needed for audit evidence.
- A release worktree install can fail with `EPERM` when an active Electron runtime locks the shared pnpm Electron package; never stop a user-facing packaged app just to unblock verification. Reuse an already verified dependency tree through a safe worktree junction or wait for the lock to clear.
- If repeated `gh run watch` calls are cut off by a short host command timeout, poll `gh run view <id> --json status,conclusion,jobs,url` instead; this keeps the server-side build authoritative without restarting or duplicating it.

## Suggested Prompt Shapes

- `Use $release-pipeline to audit this checkout, bump the version, and publish a GitHub release if it is safe.`
- `Use $release-pipeline for a full one-stop release: inspect for leaks, verify, commit, push, tag, package, and release.`
