---
name: release-pipeline
description: Audit the current Chill Vibe repo diff for sensitive or irrelevant changes, run release-safety verification, bump the version, commit and push to GitHub, then publish a new GitHub release with the verified Windows zip asset. Use when the user asks for one-stop release work, safe publish, version bump plus release, or wants local changes reviewed before pushing and releasing.
---

# Release Pipeline

Use this skill from the `chill-vibe` repo root when the task is not just “run tests”, but “safely turn the current checkout into a shipped GitHub release”.

Reuse the verification posture from `../chill-vibe-full-regression/SKILL.md`, but own the full release chain: diff audit → verification → version bump → commit/push → tag/release → asset verification.

## Workflow

1. Inspect the repo state before touching anything:
   - `git status --short --branch`
   - `git diff --stat`
   - `git remote -v`
   - `gh auth status`
   - read `package.json` version
2. Audit the pending diff for release blockers before any commit:
   - look for secrets, tokens, auth headers, local absolute paths, debug-only noise, or unrelated files
   - treat obvious test fixtures like `sk-test` as expected only if they stay inside tests
   - explicitly review new docs/spec files so accidental scratch notes do not ship
   - if something is suspicious, stop and fix or exclude it before continuing
3. Verify the code at the narrowest level that still matches release risk:
   - for a real release, prefer the `chill-vibe-full-regression` path
   - start with `pnpm test:risk`
   - if release confidence is still needed or the user asked to publish, run `pnpm test:full`
   - if Playwright tooling noise from `AGENTS.md` blocks a clean run, capture the exact failure and continue with the strongest proven alternative only if the release is still honestly defensible
4. Bump the version only after the code is judged releasable:
   - inspect recent tags with `git tag --sort=-version:refname`
   - default to the next patch version unless the diff clearly justifies a bigger bump
   - update `package.json` and any other repo-owned version references that must stay in sync
   - stage the version bump together with the already-audited product changes
5. Commit and publish the source changes:
   - write a concise release-oriented commit message
   - `git add` only the intended files
   - `git commit`
   - `git push origin <current-branch>`
   - create and push the matching annotated tag like `v0.14.2`
6. Create the GitHub release and attach the verified zip:
   - first build the Windows zip locally with `pnpm electron:build:zip`
   - capture the newest timestamped `dist/release-*` directory and the zip path inside it
   - create the release with `gh release create` if it does not already exist
   - upload the zip asset
   - verify the asset list after upload and record the final direct download URL
7. Restart the active repo runtime before handoff:
   - follow `AGENTS.md`
   - prefer `pnpm dev:restart` for the repo-local dev runtime

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
- Before shipping, rerun the strongest relevant verification after the version bump if the bump touched tracked files.
- If a verification command fails, do not publish anyway unless the failure is clearly a pre-existing harness issue and you can explain why the release remains safe.

## Versioning Rules

- Default bump: patch.
- Tag format: `v<package.json version>`.
- Keep the release title equal to the tag unless the user asked for a different naming scheme.
- Release notes can be concise and derived from the audited diff summary; do not paste huge raw diffs.

## GitHub Release Rules

- Prefer the local zip artifact produced by `pnpm electron:build:zip`.
- Confirm the release asset actually exists after upload; do not trust command success alone.
- In the final handoff, report:
  - commit hash
  - pushed branch
  - new version
  - tag
  - local zip path
  - GitHub release URL
  - final downloadable asset URL

## Release Pitfalls / Fast Recovery

- Release-specific slowdown traps belong here, not only in `AGENTS.md`. If a release run hits a repeatable release-only failure, update this skill before handoff. If the release commit/tag is already pushed, make the skill update as a separate follow-up commit so the shipped tag stays immutable.
- `gh release create` can time out after partially creating a draft or empty release. After any timeout, do not rerun blindly:
  - stop orphaned `gh.exe` create/upload processes first, then inspect `gh release view v<tag> --json apiUrl,uploadUrl,url,assets,isDraft,isPrerelease,tagName,publishedAt`;
  - if the release exists but has no asset, keep it and upload the asset explicitly;
  - if it is an accidental draft with an `untagged-*` URL, verify whether it still exists through the API/list view before deleting or recreating.
- For large Windows zip assets, prefer a two-step publish: create the release notes/tag release first, then upload the zip, then verify `assets[].name`, `assets[].size`, `assets[].state`, and the direct download URL. This makes partial failures easier to recover than a single `gh release create ... <zip>` call.
- If `gh release upload` hangs on the large zip while a tiny probe asset uploads successfully, prefer the repo's existing `release-zip.yml` workflow_dispatch for the tag so GitHub builds/uploads/verifies the canonical asset server-side. Use a manual `curl.exe --http1.1` upload against the release `uploadUrl` only as a fallback; put the token only in a temporary curl config, never echo it to logs, and delete probe assets immediately after the check.
- When generating temporary curl config lines in PowerShell, wrap concatenated strings in parentheses inside arrays, e.g. `('output = "' + $path + '"')`; otherwise PowerShell can split the config value across multiple lines and curl fails before uploading.
- Do not keep retrying the full regression wrapper when it is blocked by known fixed-port `5173` ownership or a flaky Playwright check. Capture the exact wrapper failure, confirm the port owner is repo-local before stopping it, and rerun the failing spec or strongest targeted gate in isolation.
- Clean up release scratch files before final handoff (`.tmp-release-notes-*`, `.tmp-gh-upload-*`, `.tmp-curl-*`) unless they are intentionally needed for audit evidence.

## Suggested Prompt Shapes

- `Use $release-pipeline to audit this checkout, bump the version, and publish a GitHub release if it is safe.`
- `Use $release-pipeline for a full one-stop release: inspect for leaks, verify, commit, push, tag, package, and release.`
