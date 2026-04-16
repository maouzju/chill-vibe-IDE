---
name: chill-vibe-full-regression
description: Run Chill Vibe's repo-local broad regression workflow. Use when working in this repo and the user explicitly wants a comprehensive validation sweep, release verification, or test automation, or when you judge a risky change needs wider coverage than the narrow proving test.
---

# Chill Vibe Full Regression

Use this skill from the `chill-vibe` repo root. Favor the repo scripts over ad hoc commands so Playwright and Electron checks stay aligned with the desktop runtime this app ships. This skill is opt-in broad coverage, not a mandatory finish gate for every risky edit.

## Workflow

1. Write or update the narrowest relevant test before changing production code.
2. Run that narrow test first and confirm it fails when fixing a bug or regression.
3. After each risky change, run `pnpm test:risk`.
4. Before handoff, run `pnpm test:full`.
5. Choose the smallest wider sweep that matches the request:
   - `pnpm test:quality` for lint and type confidence.
   - `pnpm test:risk` for broad runtime coverage without a production build.
   - `pnpm test:full` only when the user asks for full verification, release validation, or a build-confirmed handoff.
6. Restart the active runtime with `pnpm dev:restart` only when the user wants a runtime restart or the handoff specifically needs a live runtime check.

## Command Set

- `pnpm test:quality`: ESLint plus TypeScript checks.
- `pnpm test`: Node unit and integration tests from `tests/index.test.ts`.
- `pnpm test:playwright`: full Playwright browser-flow coverage through `scripts/run-playwright-specs.ps1`.
- `pnpm test:electron`: real Electron runtime smoke coverage through `scripts/run-electron-runtime-tests.ps1`.
- `pnpm test:risk`: quality checks, Node tests, Playwright flows, and Electron runtime smoke coverage.
- `pnpm test:full`: `test:risk` plus the production build. Reserve this for explicit full-verification or release-style requests.
- `pnpm verify`: alias for `pnpm test:full`.
- `pnpm dev:restart`: restart the Electron runtime used for local development in this repo.

## UI Guardrails

- Verify light and dark themes for any UI change.
- For layout changes, verify both desktop and narrow widths.
- Use `pnpm test:playwright` instead of bare `playwright test`.
- For Git-related UI work, include the switch flow in `tests/git-tool-switch.spec.ts` so the card is changed to `Git` through the model picker before asserting the Git tool behavior.
- Extend `tests/theme-check.spec.ts` when adding or restyling a theme-sensitive surface.

## Electron Notes

- This product is Electron-first. A listener on `5173` is usually the Electron renderer dev server, not proof of a separate web product.
- Keep `CHILL_VIBE_DATA_DIR` and `CHILL_VIBE_DEFAULT_WORKSPACE` overrides intact in runtime tests so temporary Git repos and state directories stay isolated.

## Failure Triage

- Start from the failing layer instead of rerunning everything blindly.
- If only a Node test is failing, fix and rerun that narrow test first, then return to the broader sweep you actually need.
- If only a Playwright spec is failing, rerun that spec first through `scripts/run-playwright-specs.ps1`, then return to the broader sweep you actually need.
- If the Electron smoke fails, inspect `.chill-vibe/test-electron-dev.stdout.log` and `.chill-vibe/test-electron-dev.stderr.log`, fix the runtime issue, then rerun `pnpm test:electron` plus whatever broader sweep the task still calls for.
