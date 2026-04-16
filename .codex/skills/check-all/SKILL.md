---
name: check-all
description: Run Chill Vibe's exhaustive repo-local verification flow, collect screenshot and log evidence, analyze failing tests and UI regressions, identify improvable UI surfaces, and delegate bounded fixes to subagents. Use when the user asks for "check all", full-repo testing, screenshot-backed bug hunting, automated UI review, or parallelized cleanup after broad validation.
---

# Check All

Use this skill from the `chill-vibe` repo root when the goal is broader than "rerun one test". The workflow collects evidence first, turns that evidence into a ranked issue list, and only then fixes independent problems in parallel.

## Workflow

1. Start in an isolated worktree when you expect to edit 3+ files or multiple modules. Do not disturb a user's dirty checkout.
2. Create a timestamped evidence folder and run the broad sweep with [scripts/run-check-all.ps1](scripts/run-check-all.ps1):
   - `-Mode full` runs `pnpm test:full`, then `pnpm test:theme`.
   - `-Mode risk` runs `pnpm test:quality`, `pnpm test`, `pnpm test:playwright`, `pnpm test:theme`, and `pnpm test:electron` as separate logged steps.
   - `-DryRun` previews the planned commands and artifact paths without writing files.
   - Add `-ContinueOnError` when you want the full evidence set even after the first failure.
3. Read the JSON summary from the script and inspect the first failing layer before changing code:
   - quality or unit failures: inspect the matching log first
   - Playwright or theme failures: inspect copied `test-results`, `playwright-report`, and snapshot diffs first
   - Electron failures: inspect copied `.chill-vibe/test-electron-dev.*.log` files first
4. Convert the evidence into a concrete issue list before fixing anything. Give each issue:
   - a type: product bug, env or harness issue, or UI improvement
   - proof: failing test name, screenshot, diff, or log line
   - likely write scope
   - the narrowest proving test to rerun after the fix
5. Fix the smallest clear issue locally first. Spawn subagents only for independent issues with disjoint write scopes.
6. After each fix, rerun the narrow proving test first, then return to the broader sweep the user requested.
7. Before handoff, rerun [scripts/run-check-all.ps1](scripts/run-check-all.ps1) at the level the task still requires, then restart the active runtime if the changed surface needs a live check.

## Evidence Rules

- Favor the repo wrappers: `pnpm test:playwright`, `pnpm test:playwright:full`, `pnpm test:theme`, and `pnpm test:electron`. Never use bare `playwright test`.
- Treat screenshot evidence as first-class. If a UI problem is visible but not covered, extend `tests/theme-check.spec.ts` or a narrow Playwright spec before changing production UI.
- Verify both `light` and `dark` themes and both desktop and narrow widths for UI work.
- Rule out repo-specific environment pitfalls from `AGENTS.md` before calling something a product regression.

## UI Audit Rubric

Review screenshots and rendered surfaces for:

- alignment drift across title bars, pane tabs, headers, and board seams
- unnecessary idle chrome such as borders, dividers, handles, or glows
- theme-token misuse, weak contrast, or light-only or dark-only styling
- missing interaction states: hover, focus, selected, empty, drag/drop, disabled
- narrow-width overflow, clipped tab titles, broken safe zones, or scroll traps

If the issue is subjective but still worth improving, record it as a UI opportunity with screenshot evidence instead of mixing it into objective test failures.

## Delegation Rules

- Only spawn workers after evidence exists and the fix scope is bounded.
- Give each worker one issue, one proving test, and a disjoint write scope.
- Keep the blocking investigation local; do not outsource the very next fact you need.
- Tell workers they are not alone in the codebase and must not revert unrelated edits.
- Let the main agent own integration, final reruns, and the ranked findings summary.

Use [references/repair-playbook.md](references/repair-playbook.md) when you need triage heuristics, UI review prompts, or worker prompt templates.

## Suggested Prompt Shapes

- `Use $check-all to run a full repo check, capture screenshot evidence, and fix the top two independent issues.`
- `Use $check-all in risk mode to audit this UI change in both themes and tighten any snapshot coverage you need.`
- `Use $check-all to collect logs and screenshots first; do not edit until you have a ranked issue list.`
