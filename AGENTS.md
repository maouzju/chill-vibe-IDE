# Repo Notes For AI Agents

## Project Overview

**Chill Vibe IDE** — a lightweight, local-first AI IDE for parallel vibe coding.
Board-first layout with multiple workspace columns, each bound to a provider (`codex` or `claude`) CLI.
Ships as an Electron desktop app.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, styled-components, Primer React |
| Backend | Express 5, Node 20+ |
| Desktop | Electron 36, electron-builder |
| Validation | Zod |
| Build | Vite (client), tsup (Electron), ESLint |
| Tests | Node native `--test` runner (unit), Playwright (E2E / visual regression) |
| Music | Netease Cloud Music API |

## Directory Map

```
src/              React app — components, state, styles
server/           Express API — chat, git, providers, music, persistence
shared/           Zod schemas, default state, shared types (imported by both client and server)
electron/         Main process, preload, backend bridge
tests/            Unit tests + Playwright specs + visual regression snapshots
docs/             UI principles, design docs
scripts/          PowerShell/Node dev & test harnesses
build/            Electron build assets (icons, etc.)
```

## First Rule

Changes fall into three tiers with different verification requirements:

### Tier 1 — Logic changes (risk-based TDD)
Applies to: bug fixes, behavior changes, state mutations, server handlers, schemas, Electron bridges.

- Default to strict `red → green` for high-risk logic: bug fixes, reducer/state mutations, persistence or restore paths, server handlers, schemas, Electron bridges, and any change that can corrupt saved state or cross process boundaries.
- For those high-risk changes, write or update a focused test **before** changing production code.
- Run that test first and confirm it **fails** so the issue is demonstrated, not assumed.
- Only after a failing test is observed may you implement the fix.
- Low-risk logic changes may use a prove-after path when red-first would add more ceremony than signal: pure refactors with no intended behavior change, small glue code, logging/telemetry wiring, prototypes, or exploratory spikes.
- The prove-after path still requires targeted verification before handoff: add or update the narrowest relevant test after implementation when practical, or explain why runtime/manual verification is the better fit.
- If you skip red-first for a logic change, say why in the handoff and keep the verification narrow and concrete.
- Before ending your response, rerun the relevant tests and confirm they pass.

### Tier 2 — Style / UI changes (visual regression)
Applies to: CSS, layout, theme tokens, component styling, animations.

- No hand-written unit test required — visual regression snapshots are the primary gate.
- If the change touches a theme-sensitive surface, run `pnpm test:theme` and review snapshot diffs.
- If no existing snapshot covers the changed surface, add one to [`tests/theme-check.spec.ts`](./tests/theme-check.spec.ts).
- Before ending your response, confirm snapshots are updated deliberately, not blindly accepted.

### Tier 3 — Config / docs / tooling (exempt)
Applies to: `AGENTS.md`, `CLAUDE.md`, `docs/`, ESLint config, CI scripts, `package.json` metadata.

- No test required. Verify the change is syntactically valid where applicable (e.g. `pnpm test:quality` for lint/type-check config).

### Shared rule across all tiers
- Do not finish with an unverified code change. Every tier has its own verification step — follow it.

## Docs-first Operating Contract

This section governs agents working on **this Chill Vibe IDE repository**. It is not a product feature and must not be implemented by injecting extra prompts into Chill Vibe-launched Codex/Claude runtime sessions unless the user explicitly asks for that.

- Start every non-trivial repo task from the docs, not from source code. Read `AGENTS.md` first, then the most relevant file under `docs/` or `docs/specs/` before editing production code.
- For net-new features, multi-step behavior changes, cross-cutting product work, or any request that asks for a spec / requirements / design / plan, create or update `docs/specs/<slug>/requirements.md`, `design.md`, and `tasks.md` before touching `src/`, `server/`, `shared/`, or `electron/`.
- For behavior, workflow, UX, packaging, persistence, provider-routing, or test-process changes, update the matching docs in the same task. Code and docs should land together.
- Small scoped bug fixes, pure refactors, and docs/config/tooling-only edits may skip a new SPEC, but the handoff must say why skipping SPEC was reasonable and which existing docs/rules were checked.
- If an agent realizes it started from code without the required docs pass, it must stop, read the relevant docs, and correct the process before continuing.
- Do not treat app runtime prompt changes as a substitute for this repository-level agent contract. The source of truth for agent behavior while developing Chill Vibe is this `AGENTS.md` plus the relevant docs/specs.

## SPEC-first Workflow

- For net-new features, multi-step behavior changes, cross-cutting product work, or any task where the user explicitly asks for a spec / requirements / design / plan, start with a SPEC under `docs/specs/<slug>/`.
- The minimum SPEC set is `requirements.md`, `design.md`, and `tasks.md`. Treat those documents as the source of truth for the implementation.
- Do not edit production code in `src/`, `server/`, `shared/`, or `electron/` until `requirements.md` and `design.md` are coherent and `tasks.md` contains a clear first implementation slice.
- If requirements or design are ambiguous, stop and ask the user to review or clarify the SPEC before coding.
- Small, well-scoped bug fixes, refactors with no intended behavior change, and docs-only/config-only edits may skip SPEC-first, but the handoff should say why skipping it was reasonable.
- Maintain SPEC docs directly under `docs/specs/`; do not depend on any in-app SPEC card or tool to enforce this workflow.

## Agent Posture

- Before changing production code, read `AGENTS.md` and the most relevant docs under `docs/` or `docs/specs/`; do not start from code alone.
- If the task changes behavior, workflow, or user expectations, update the matching docs in the same task so they do not drift.
- The agent should act as an optimizer for the team's workflow, not wait for the user to repeatedly point out the same friction.
- When a repeated collaboration issue, review comment, or operating preference becomes clear, convert it into a durable rule in `AGENTS.md` instead of relying on the user to restate it.
- Prefer proactive process improvement and memory capture over reactive compliance on repetitive issues.

## Handoff Style

- Final answers should default to plain human language. Do not make the user ask for a separate “说人话版” summary after the main report.
- Lead with what changed, what now works, and anything the user actually needs to care about; keep implementation trivia secondary unless it matters for risk or follow-up.
- When technical terms are necessary, explain them briefly in context instead of stacking jargon.
- When referencing files in chat, prefer a plain absolute path link target and mention line numbers in prose instead of appending `#L...` to Windows paths, because this UI may not open anchored file links reliably.

## Packaging Defaults

- For routine Windows handoff builds, default to a zipped app payload instead of a single-file `portable` executable.
- Windows zip handoff artifacts should extract into a single top-level `Chill Vibe IDE` folder instead of spilling loose binaries into the unzip target.
- Every published version release must include a matching Windows `.zip` asset on the cloud/GitHub release; a versioned release is not complete until that zip is uploaded and visible on the release page.
- Only build `portable` or `nsis` artifacts when the user explicitly asks for them.
- If a collaborator has made it clear they expect a ready-to-run Windows handoff, do not stop at handing over a `.zip` path; also provide a no-manual-unzip path by extracting to `dist/release/win-unpacked` or by producing the installer they asked for, and state the exact executable or installer path.
- Prefer the repo scripts (`pnpm electron:build`, `pnpm electron:build:zip`, `pnpm electron:build:installer`, `pnpm electron:build:portable`) over ad-hoc `electron-builder` commands so the packaging mode stays consistent.
- For manual Windows handoff packaging, prefer a fresh timestamped output root such as `dist/release-YYYYMMDD-HHmmss` so side-by-side zip extraction and reruns do not collide with an older `win-unpacked`.
- Keep a simple runnable `.bat` entry under `dist\` for the timestamped packaging flow when a collaborator asks for a double-clickable handoff build command.
- When publishing or refreshing a GitHub release, verify the release asset list after upload and include the final zip asset name plus direct download path in the handoff instead of assuming the CLI upload completed just because the command exited.

## Theme Safety

- This app ships with both `light` and `dark` themes. Any UI change must be checked in both themes before you finish.
- Prefer shared tokens in [`src/index.css`](./src/index.css) over hard-coded light-only colors.
- When you add or restyle UI, verify these states in both themes: default, hover, focus, selected, empty, drag/drop, and disabled.
- Theme-sensitive surfaces include empty states, drop targets, menus, inputs, buttons, cards, and headers.
- If you add a new theme-sensitive surface, extend [`tests/theme-check.spec.ts`](./tests/theme-check.spec.ts) with a regression check.

## UI Governance

- Frontend changes must follow [`docs/ui-principles.md`](./docs/ui-principles.md) before they are presented for review.
- Treat board seams, header/body alignment, and idle interaction chrome as product invariants, not styling preferences.
- Default to subtractive design: if a border, divider, guide, glow, or handle is not needed at rest, hide or remove it.
- For layout changes, verify both desktop and a narrow viewport instead of judging only one breakpoint.
- PM surfaces should feel like an ongoing conversation with a product manager, not a dashboard; keep agent chat as the execution core and present PM-maintained todo boards plus concise user-facing updates.

## State & Schema Conventions

- All shared types live in [`shared/schema.ts`](./shared/schema.ts) as Zod schemas. When adding or modifying a data shape, update the schema first.
- Default values and factory functions (`createCard`, `createColumn`, `createDefaultSettings`) live in [`shared/default-state.ts`](./shared/default-state.ts).
- Client state is managed by a pure reducer (`ideReducer` in [`src/state.ts`](./src/state.ts)). Add new mutations as `IdeAction` union members; do not reach for external state libraries.
- When a new field is added to any persisted type, add normalization logic in `normalizeAppSettings()` or the relevant restore path so existing saved state upgrades gracefully.

## AI Request Routing

- All AI requests (chat, white noise generation, etc.) must go through the local CLI (`claude`/`codex`) routing path — the same path used by Agent chat cards.
- The CLI resolves authentication and base URLs from the provider profile configured in Settings → Routing.
- Only fall back to direct API calls via local settings if the CLI routing is not available.
- When adding a new feature that needs AI, reuse `resolveCommand` and `resolveProviderRuntime` from [`server/providers.ts`](./server/providers.ts) rather than making direct HTTP API calls.

## Test Organization

- **Unit tests** use Node's native `--test` runner via tsx. Every test file must be registered in [`tests/index.test.ts`](./tests/index.test.ts) — adding a file without an import there means it will never run.
- **Playwright specs** (`.spec.ts`) handle E2E and visual regression. Visual snapshots live alongside their spec in `*-snapshots/` dirs.
- When updating UI that has visual regression coverage, expect snapshot diffs. Update snapshots deliberately; do not blindly accept.
- When a failing test, fixture, or snapshot is clearly out of sync with the current intended product behavior, update that coverage in the same task instead of preserving a known-stale assertion. Confirm the live behavior first, then align the test.

## Regression Workflow

- Treat changes to production logic, persistence, Electron bridges, server handlers, schemas, shared state, and interactive UI behavior as risky changes.
- Prefer the narrowest proof that matches the risk: strict red-first TDD for high-risk logic, targeted post-change verification for low-risk logic, and only expand to broader suites when the surface area or the user request justifies it.
- For a broad regression sweep, release verification, or any task where the user explicitly wants comprehensive validation, invoke the repo-local `chill-vibe-full-regression` skill and follow its workflow.
- Do not treat `pnpm test:risk` or `pnpm test:full` as unconditional handoff gates for every risky change; start with the narrowest proving test unless the user asks for a wider sweep.
- Use the repo Playwright scripts instead of bare `playwright test`; `pnpm test:playwright` is the default smoke sweep, `pnpm test:playwright:full` is the exhaustive suite, and `pnpm test:theme` covers theme snapshots through the same harness.
- Repo-local browser verification is headless-only by default and by policy; do not add headed validation scripts back into the standard release/test workflow.
- Repo-local Electron validation is hidden-window by default; do not rely on visible desktop windows as a standard release gate.
- When a narrow failing test is enough to iterate locally, run it first and expand coverage only as far as the task and user request justify.
- For Git-related changes, include the real card switch flow: switch a normal card to the `Git` model and verify the Git tool UI after the switch, not only a pre-seeded Git card state.

### Quick Reference — Test Scripts

| Command | What it runs |
|---------|-------------|
| `pnpm test` | Unit tests (Node `--test` via tsx) |
| `pnpm test:theme` | Headless Playwright visual regression (theme-check + board-layout) via the repo harness |
| `pnpm test:playwright` | Default Playwright smoke suite via the repo harness in headless mode |
| `pnpm test:playwright:full` | Full Playwright suite via PowerShell harness |
| `pnpm test:perf` | Headless browser performance smoke: compaction + memoization + add-card freeze regression |
| `pnpm test:perf:electron` | Hidden-window Electron responsiveness smoke for desktop-only performance issues |
| `pnpm test:electron` | Hidden-window Electron runtime tests |
| `pnpm test:quality` | ESLint + TypeScript type-check |
| `pnpm test:risk` | quality → unit → Playwright smoke → electron |
| `pnpm test:full` | quality → unit → full Playwright → electron → production build |

## Runtime Restart

- After making changes, restart the runtime the user is actively using before you finish.
- If the user is working in the browser, restart the web server.
- If the user is working in Electron, restart the Electron client.
- Never stop, kill, or restart a packaged/release Chill Vibe instance that the user may be actively using unless the user explicitly asks for that exact instance to be closed or restarted.
- Treat running packaged builds as user-work surfaces, not disposable test processes; when dev/runtime conflicts appear, isolate or restart the dev instance first instead of touching the release app.
- Restart only the currently active surface unless the user explicitly asks for both.
- If it is unclear which surface the user has open, inspect the running project processes or ports, make the best-supported choice, and state that assumption in your handoff.
- In this repo, a listener on `5173` is usually the Electron renderer dev server, not proof of a standalone web product.
- Prefer `pnpm dev:restart` for repo-local runtime restarts; it should restart the Electron runtime when this repo is configured for `electron:dev`.

## CSS Architecture

- All global styles and theme tokens live in [`src/index.css`](./src/index.css). Component-level overrides use the same token variables.
- Theme switching is driven by `data-theme` attribute on `:root` (`light` | `dark`). Dark theme overrides are scoped under `:root[data-theme='dark']`.
- When adding a new color or spacing value, check for an existing token before introducing a literal. If the literal appears more than twice, promote it to a CSS custom property.

## Known Pitfalls

A living list of traps that have wasted time before. **When you hit a new pitfall during a task, add it here before finishing** — this list is part of the project's institutional memory.

| # | Pitfall | Why it bites |
|---|---------|-------------|
| 1 | Running bare `playwright test` instead of the repo Playwright scripts | The bare command discovers Node `--test` entrypoints and tries to run them as Playwright specs, causing false failures. Always use `pnpm test:playwright`, `pnpm test:playwright:full`, or `pnpm test:theme`. |
| 2 | Port `5173` ≠ standalone web app | In this repo `5173` is the Vite dev server for the Electron renderer. Do not treat it as proof of a running web product. |
| 3 | Adding a test file without importing it in [`tests/index.test.ts`](./tests/index.test.ts) | Node's `--test` runner only sees files imported from the entrypoint. A new `.test.ts` file that is not registered there will silently never run. |
| 4 | Hard-coding colors instead of using theme tokens | Looks fine in one theme, broken in the other. Always use CSS custom properties from [`src/index.css`](./src/index.css). |
| 5 | Forgetting normalization when adding a persisted field | Old saved state won't have the new field. Add a default in `normalizeAppSettings()` or the relevant restore path, or the app crashes on existing installs. |
| 6 | Editing `shared/schema.ts` without updating `default-state.ts` | Zod schema and factory functions must stay in sync. A schema-only change breaks `createCard` / `createColumn` / `createDefaultSettings`. |
| 7 | Mock chat messages in Playwright fixtures must include `createdAt` | `appStateSchema` rejects incomplete message objects during hydration, so the page falls into the generic load-error shell before the UI under test ever renders. |
| 8 | Running Playwright or theme checks while another checkout already owns port `5173` | The specs target a fixed renderer port, so they can silently validate the wrong worktree unless you restart the intended runtime or isolate the port first. |
| 9 | `tests/add-card-freeze.spec.ts` still seeds `settings.greedyLastCard`, but the current app no longer reads that flag | The test's “stretched last card” precondition can fail before the add-card assertion runs, so do not treat that failure as evidence that card insertion regressed. |
| 10 | Fresh git worktrees do not inherit `node_modules` from the main checkout | `node --import tsx` and `pnpm` commands can fail with missing-package errors until dependencies are installed or `node_modules` is linked into the worktree. |
| 11 | A checkout can have packages under `node_modules/.pnpm` but still be missing top-level links and `.bin` shims | `tsx`, `playwright`, and normal package imports fail until `pnpm install` restores the links, and active repo Electron processes may need to be stopped first to release the `electron` binary. |
| 12 | `pnpm dev:restart` can reuse a renderer dev server from another checkout if that process already owns port `5173` | Restarting Electron alone does not guarantee the renderer matches the current repo; verify the `5173` owner or stop the conflicting Vite process before trusting UI tests. |
| 13 | Fixed Playwright mouse coordinates can land outside the default viewport | Hard-coded positions like `y = 860` may target empty space instead of the app under the default 1280×720 viewport, so base wheel/drag points on `page.viewportSize()` or element bounds. |
| 14 | Electron runtime tests can exit immediately when another Chill Vibe Electron instance already holds the single-instance lock | The launch looks like a clean process exit instead of an app crash; set a test-only bypass or stop the active Electron dev window before trusting `test:electron` results. |
| 14 | `electron-builder` can fail during Windows packaging before installer creation because `app-builder.exe rcedit` downloads `winCodeSign` and 7-Zip cannot create its cached macOS symlinks without the required Windows privilege | A normal `pnpm electron:build` may fail even after `pnpm build` succeeds; if that happens on this machine, packaging with `--config.win.signAndEditExecutable=false` avoids the `rcedit` toolchain download and still produces unsigned Windows artifacts. |
| 15 | A stale `.chill-vibe/state.wal` is promoted the next time any helper or benchmark script calls `loadState()` | Read-only perf/debug scripts can unexpectedly rewrite `state.json` and add recovery I/O noise, so check for WAL recovery before trusting persistence measurements. |
| 16 | `scripts/run-playwright-specs.ps1` does not forward extra Playwright CLI flags like `--update-snapshots` | `pnpm test:theme` is still the right verification path, but deliberate snapshot refreshes need an explicit file-scoped `pnpm exec playwright test ... -u` run or the wrapper will ignore the flag. |
| 17 | Removing a failed worktree cleanup can leave the main checkout without `node_modules/.bin` shims if `node_modules` was linked across checkouts | Restore the links with `pnpm install --frozen-lockfile` before rerunning Electron dev scripts, or `pnpm dev:restart` can fail at `tsup` lookup. |
| 18 | Reinstalling dependencies can still leave Electron unusable when pnpm prints `Ignored build scripts: electron` | `pnpm dev:restart` then fails with `Electron failed to install correctly` until you explicitly run `node node_modules/electron/install.js` or otherwise allow Electron's postinstall to download the binary. |
| 18 | `pnpm dev:restart` can falsely say Electron never became ready from a worktree when the app still launches through the main checkout's shared `node_modules` electron binary | The restart may actually succeed with the renderer `--app-path` pointing at the worktree, so verify the running command line and `5173` owner before treating the restart as failed. |
| 19 | `pnpm test:quality` can fail inside ESLint with `ENOENT ... scandir '...\\test-results'` after Playwright cleanup removed the repo-root `test-results` directory | Recreate `test-results` before rerunning lint/type checks or the failure looks like a code issue even though the app code is fine. |
| 20 | Topbar ambience tool launchers activate a new tool tab in the remembered pane immediately | Tests that still need the chat composer or its model picker must assert that state before clicking a topbar launcher, or switch back to a chat tab first. |
| 21 | Collapsing layout too early during same-column drag-to-split can delete the brand-new empty target pane before the dragged tab is inserted | For same-column cross-pane drops, create the destination pane with the dragged tab already inside it, or use an atomic reducer path instead of split-then-move through an empty pane. |
| 22 | Some Claude-compatible `/v1/messages` streams end right after a terminal `message_delta.stop_reason` and never emit `message_stop` | Treating `message_stop` as the only completion signal inflates proxy disconnect stats and triggers an unnecessary retry for otherwise successful replies. |
| 23 | Pane Playwright locators that target `.composer textarea` or `.model-select-shell` without scoping to `.pane-tab-panel.is-active` can become ambiguous | Inactive pane tabs stay mounted for state/layout preservation, so broad selectors can hit hidden controls and fail even when the visible tab behaves correctly. |
| 24 | `pnpm test:theme` in a dirty UI checkout can fail on unrelated snapshot churn even when the targeted surface is correct | Run a file-scoped Playwright check for the touched theme surface first, then treat the broad suite as an integration signal that may still reflect other in-progress visual work. |
| 25 | Repo-local `pnpm exec playwright test ...` invocations can currently fail before discovery on Windows with `Playwright Test did not expect test() to be called here`, including `pnpm test:theme` and direct file-scoped spec runs | The runner never registers the suite, so treat the failure as tooling noise, verify touched UI surfaces through manual browser checks or another harness, and do not assume a file-scoped fallback will work until the Playwright setup is fixed. |
| 26 | A shell session with `ELECTRON_RUN_AS_NODE=1` makes both `electron .` and packaged `Chill Vibe.exe` launches behave like plain Node processes | If Electron APIs suddenly resolve to the executable path string or the packaged app exits immediately, clear that env var for the child process before diagnosing app code. |
| 27 | `tsup --format esm` still writes `main.js` by default, so a package `main` entry that expects `dist/electron/main.mjs` breaks unless the build script renames the file and marks `dist/electron` as `type: "module"` | The failure looks like a missing entrypoint even though the build succeeded, and the fix lives in the packaging script rather than the Electron source itself. |
| 28 | React 19 `useEffectEvent` callbacks cannot be called from ordinary click/input handlers or listed in effect dependency arrays | A tool card can work at runtime but still fail `pnpm test:quality` under the React hooks lint rules, so event-driven card helpers should use normal callbacks or refs instead. |
| 29 | `pnpm dev:restart` can exit cleanly even when Electron dev never stays up because Chromium fails to create or move its disk cache and then reports `ERR_FAILED` loading `http://localhost:5173` | The renderer dev server may still return HTTP 200, so check `.chill-vibe/electron-dev.stderr.log` before blaming source changes when the dev window never appears. |
| 30 | `pnpm install --frozen-lockfile` can fail with `ENOENT ... node_modules\\.pnpm\\...\\package.json` even when the lockfile is current | A shared or partially corrupted `node_modules` tree can be missing package contents, so rebuild or relink dependencies before treating install, Playwright, or Electron script failures as source regressions. |
| 34 | `pnpm test:playwright` and direct `pnpm exec playwright test ...` can currently fail before discovery on Windows with `Playwright Test did not expect test() to be called here` across ordinary smoke specs, not only the theme suite | Treat that runner error as tooling noise for now and fall back to narrow Node tests or other verification until the Playwright harness/config issue is fixed. |
| 32 | Packaged Electron launches can inherit a different home directory than VSCode/Codex when `HOME` and `USERPROFILE` disagree | External history imports then look empty unless the scanner checks both homes instead of assuming `os.homedir()` matches where `.codex` / `.claude` live. |
| 33 | Dev Electron and packaged Chill Vibe must not share the same Electron `userData` / `sessionData` profile | Shared Chromium caches and single-instance state can make `pnpm dev:restart` fight the packaged app and tempt agents to kill the wrong window. |
| 35 | Playwright specs that import a helper which itself calls `page.addInitScript(...)` can silently fall into the desktop-bridge-disconnected shell with `__name is not defined` before the app renders | Inline the init script in the spec or otherwise avoid that transpiled helper path, or locator failures can look like app regressions even though the browser bootstrap is what broke. |
| 36 | JSX hidden behind `false && (...)` still has to parse and resolve every referenced identifier | A stale “disabled” block with adjacent siblings or missing refs/imports can blank the whole app and block unrelated Playwright work even though that branch never renders. |
| 37 | Reusing `dist/release` can fail when a packaged app is still running from `dist/release/win-unpacked` | Windows locks `Chill Vibe.exe` and `app.asar`, so cleanup and `pnpm electron:build` may fail unless you close that exact build or package to a fresh output directory. |
| 38 | `git worktree remove` on Windows can unregister a worktree even when it fails to delete the directory because a log or dev-server file is still open | Always re-check both `git worktree list` and the filesystem, then stop any process rooted in that path and remove the leftover folder before calling cleanup finished. |

| 39 | `pnpm install --frozen-lockfile` can still report `Already up to date` while leaving a damaged `node_modules` tree without top-level `.bin` shims or fresh links | If scripts suddenly stop resolving `eslint`, `tsup`, or `electron` after a partial install, stop any repo-local Electron process and rebuild the dependency links with `pnpm install --force`, then rerun `node node_modules/electron/install.js` if pnpm says Electron build scripts were ignored. |

| 40 | Persisted `column.model` values can drift behind `settings.requestModels` after the provider default model changes | New tabs, new columns, and cross-column rebinds must resolve future chat models from the current request-model settings or stale values like `claude-opus-4-6` keep resurfacing. |

| 41 | Fixing source and rebuilding `dist/release` does not help a user who is still launching an older timestamped `dist/release-*` package directory | White-screen triage can look like the fix failed until you compare the running executable path or patch the exact packaged folder the user actually opened. |

| 42 | Codex or Claude CLI can exit with status `0` after emitting partial stream items but before any terminal `turn.completed` / `result` event | Treating a bare zero-exit as success leaves chats stuck with only tool blocks or partial text after a real upstream disconnect, so provider runs must require an explicit terminal event before reporting success. |

| 43 | `tests/git-tool-switch.spec.ts` still assumes the Git tool is selected from the model dropdown, but the current UI exposes Git primarily through the empty-state quick tool launcher | Playwright runs can fail before any Git assertions with `Git` option-not-found noise unless the spec follows the live entry path or a narrower spec is added for the changed Git behavior. |

| 44 | `tests/theme-check.spec.ts` snapshots for `git-tool-analysis-panel-docked-*.png` can drift to an older, much wider card capture even when the layout assertions still pass | File-scoped Playwright checks then fail on image-size mismatch before the visual diff is useful, so review the generated actual image and refresh only those specific snapshots deliberately instead of assuming the docked panel regressed. |

| 45 | Persisting full `message.meta.structuredData` for large completed command outputs can quietly inflate release `state.json` into tens of megabytes | Release builds may then white-screen during startup or recovery even though the visible chat text is small, so cap persisted command-output metadata and compact oversized historical state on load/save. |

| 46 | A branch can intentionally delete a feature slice like `PmCard.tsx`, `pm-card-utils.ts`, and their tests while shared model constants and legacy cleanup paths still remain elsewhere | When unrelated work touches adjacent files, treat those deletions as active product intent and avoid reintroducing imports or helpers from the removed slice unless the user explicitly asks to restore it. |

| 47 | Compacting oversized command-output metadata only in active cards is not enough because `sessionHistory` can keep the original giant `structuredData` blobs and re-bloat packaged `state.json` on the next save | Any release-safety compaction for chat messages must cover both live column cards and archived session-history entries, or startup white-screen fixes appear to work in tests but fail on real persisted history. |

| 48 | Composer-specific typing fixes do not remove renderer jank when a release profile still carries a 50MB+ `state.json`, multiple visible streaming chats, and hidden pane tabs that stay mounted | If packaged input still lags after local composer optimization, inspect the real release `userData` state size and the live pane/tab mix before blaming the textarea again; board-wide transcript work can dominate the frame budget. |

| 49 | `updateCard` no-op patches used to still create a fresh board state and new `updatedAt`, so mount effects that re-sent an unchanged card field could escalate into renderer update loops in release builds | Short-circuit identical card patches before `touchState()`, or seemingly harmless status/profile sync effects can churn every mounted pane tab at once. |

| 50 | A super-long Codex chat with no `/compact` boundary can still bloat packaged `state.json` into a crash-prone size even after each command block was “already truncated” to the older ~32KB save budget | Release-safety compaction has to stay aggressive enough for thousands of persisted `command` messages, or the next packaged launch can fall over on one legacy long-running session instead of one obviously giant output. |

| 51 | Ref-driven composer optimizations can silently disable draft persistence if `createDraftSyncScheduler` is initialized with `idleMs: 0` | The textarea still feels fast locally, but idle saves never fire, Playwright draft-persistence checks stall at zero snapshot writes, and reload drops unsaved drafts until a background/pagehide flush happens. |

| 52 | Follow-up sends on an existing chat card can wrap the outbound request as a continuation prompt that embeds prior transcript, not just the raw latest textarea text | Playwright assertions that expect the second request body to equal the visible draft will fail against correct behavior unless they assert the latest user text is included rather than demanding an exact match. |

| 53 | Sending a lightweight renderer-only `sessionHistory` preview back through `saveState()` can silently overwrite the full archived transcript on disk | Startup trimming fixes renderer memory pressure, but without save-time merge-by-entry-id the next ordinary state save drops archived message metadata and makes history restore incomplete. |
| 54 | Queued full-state persistence during active streaming can hammer packaged Electron with repeated multi-megabyte IPC + stringify + disk writes | On large release profiles this shows up as browser/main memory spikes and tab/run instability even when renderer DOM is already windowed, so stream deltas should not keep routine snapshot saves hot. |
| 55 | Routing packaged startup through `loadState()` can still OOM the main process if that path fully hydrates large archived `sessionHistory` before trimming it for the renderer | Even a ~1.7MB `state.json` can blow past 2GB private memory in `Chill Vibe.exe`, so renderer startup needs a dedicated history-preview load path instead of reusing the full restore path. |
| 56 | Wrapping chat-draft flushes in `startTransition` can skip the durable save when a same-pane tab switch unmounts the active chat immediately after blur | The textarea still looks correct while typing, but the blurred tab can miss its last `setCardDraft` commit and never reach queued snapshot persistence before the pane swaps cards. |
| 57 | Fixing packaged startup with `loadStateForRenderer()` is not enough if preview-state saves or archived-session restores still fall back to full `loadState()` | The first post-startup tab switch can trigger a save that rehydrates the entire persisted app state, OOM the packaged main process, and look like a random delayed flash-exit instead of a persistence-path bug. |
| 58 | Splitting renderer startup and archived-session reads off `loadState()` can accidentally bypass valid `state.wal` recovery if the lightweight helpers read `state.json` directly | The flash-exit OOM may be gone, but crash recovery regresses to stale state unless every lightweight persistence entrypoint preserves WAL promotion semantics. |
| 59 | Screenshot triage can point at the wrong runtime when repo-local Electron dev and packaged `dist/release/.../Chill Vibe.exe` are both open with the same window title | A `pnpm dev:restart` success does not prove the user-visible window changed; check running process paths and frontmost app before deciding a UI fix “didn't apply.” |
| 60 | Recoverable stream retries can loop forever if placeholder transport text like `Reconnecting... 1/5` resets the retry counter | Session reattach noise is not proof the stream recovered; only reset the retry budget after meaningful assistant output or activity, or the final provider error never reaches the user. |
| 61 | Editing Electron desktop backend files like `server/providers.ts` or `electron/backend.ts` while relying on renderer HMR can leave the visible app on stale runtime logic | Vite refreshes the UI, but the active Electron main/backend process keeps the old handlers until `pnpm dev:restart` (or an equivalent full Electron restart) is run. |
| 62 | Codex app-server `thread/resume` can return an idle thread for an interrupted card, and a follow-up `turn/start` with `input: []` then fails with `input must not be empty` | Resume recovery looks like a silent no-op unless the idle resumed thread is nudged with a blank text input item, not an empty input array. |
| 63 | `pnpm test:quality` can be red from pre-existing unused variables in `src/components/GitFullDialog.tsx` even when the touched column-resize change is fine | Use file-scoped lint plus the narrow unit/Playwright checks for the changed surface, and treat the broad quality failure as unrelated branch debt unless you are also fixing that dialog. |
| 63 | Launching Electron from a shell that already exports `CHILL_VIBE_DATA_DIR` can make dev and packaged runtimes accidentally share the same persistence folder | Cross-runtime crash recovery, state files, and archived sessions can bleed across surfaces unless Electron pins its own runtime-specific data dir or the override is an explicit opt-in. |
| 64 | Double-clicking a newer packaged `dist/release.../Chill Vibe.exe` while an older packaged build is still running can leave the old executable active because Electron's single-instance lock just refocuses the existing window | Users can sincerely believe they “opened the new package” even though Task Manager still shows the older path, so always verify the live process path and start time before judging whether a packaged fix applied. |

| 65 | In this Codex exec sandbox, direct `node --import tsx --test ...` runs can fail with `spawn EPERM` before the repo test code even loads because `tsx`/`esbuild` try to launch helper processes | When a narrow unit test is needed here, emit a temporary JS build with `pnpm exec tsc`, patch relative import extensions if required, and run the compiled test with plain `node --test` instead of assuming the normal TS runner is usable. |
| 66 | In this Codex exec sandbox, the normal Windows packaging path can fail with `spawn EPERM` inside `pnpm legal:generate`, Vite's bundled config loader, `tsup`, or `electron-builder` helper EXEs before app code is touched | Build the renderer with Vite's native config loader, compile Electron with top-level CLI binaries like `esbuild.cmd`, and if `app-builder.exe` is still blocked, fall back to a manually zipped Electron payload instead of misdiagnosing the source tree. |
| 67 | Git subset commits can fail when a staged-added file was deleted from the working tree before the Git card re-stages paths and then calls `git commit --only -- <paths>` | The vanished addition shows up as `AD`; unless the card drops that stale staged addition from the index first, the dead path can block committing the still-valid selected files. |
| 68 | Some local Codex CLI builds reject `codex app-server --listen stdio://` even though newer builds accept it and already default to stdio | For broad CLI compatibility, launch `codex app-server` without the optional `--listen` flag unless Chill Vibe actually needs a non-default transport. |
| 69 | Claude Code image input works by passing plain local image paths in the prompt, not by wrapping them in custom `[Attached image: ...]` markers and telling Claude to use `Read` on the binary file | The custom marker path looks reasonable in chat logs but can bypass Claude's native vision path handling, so pasted-image prompts should follow the documented `Analyze this image:` / image-path format instead. |
| 70 | `electron:compile` can accidentally copy `electron/tsconfig.json` into `dist/electron`, which makes a live Vite renderer treat the build as a tsconfig change and force a full reload during Electron runtime tests | If the copied tsconfig lands under `dist/electron`, `pnpm test:electron` can open a blank first window or miss persisted Git UI before React remounts, so runtime asset copying must explicitly exclude `tsconfig*.json`. |
| 70 | A pane can show a Codex chat while its hidden `column.provider` and stale `lastModel` still point at Claude | New-tab creation must seed from the active pane chat before falling back to column/global defaults, or users see fresh chats reopen as Claude/Opus even though the current card is Codex. |
| 71 | Dev Electron can silently ignore a test `CHILL_VIBE_DATA_DIR` override unless the launch also opts into shared data dirs with `CHILL_VIBE_ALLOW_SHARED_DATA_DIR=1` (or `--allow-shared-data-dir`) | An "isolated" repro then keeps loading the default `.chill-vibe` profile, so runtime tests must set both knobs before trusting which state directory Electron actually used. |
| 71 | In this Windows Codex exec environment, invoking bare `pnpm` from PowerShell can fail before the script runs because PowerShell resolves `pnpm.ps1` and local execution policy blocks it | Prefer `pnpm.cmd ...` for repo commands here, or verification failures can look like project issues even though the shell never launched pnpm. |
| 72 | Reusing the same `dist/release` root for multiple manual handoff zips can mix old and new unpacked payloads during extraction or reruns | Put each package build under a fresh timestamped `dist/release-*` directory so `win-unpacked` and zip artifacts stay isolated. |
| 73 | In this Windows Codex exec sandbox, `node:child_process` can still hit `spawn EPERM` for ordinary `.exe` launches like packaged `Chill Vibe.exe`, `electron.exe`, or even nested `powershell.exe` smoke checks | If you need packaging verification here, rely on shell-level commands or pure-JS staging/zip validation instead of assuming a Node-launched Windows executable can be used for runtime smoke tests. |
| 74 | Playwright locators that grab `.message-entry-user`.first() can hit the sticky overlay clone instead of the real transcript row | Theme and fork-action specs should scope to `.message-list` or filter for the visible control they care about, or assertions can fail against the wrong copy of the same message. |
| 75 | Theme assertions that read `background-color` from gradient-backed surfaces like `.message-attachment-frame` can misread them as transparent black in light mode | When a UI surface paints through `background-image`, assert the gradient/image presence or use a screenshot instead of assuming `background-color` carries the visible tone. |
| 76 | `tests/electron-bridge-runtime.test.ts` can time out under full-suite load even when the Electron bridge is healthy because the cold renderer launch sometimes needs longer than 15 seconds on this Windows setup | Keep the bridge smoke wait budget aligned with real cold-start latency during `pnpm test:full`, or the suite flakes red only at the end of an otherwise clean run. |
| 77 | `server/proxy-stats-store.ts` used to instantiate its shared tracker before Electron finished setting `CHILL_VIBE_DATA_DIR`, so packaged proxy stats could read the wrong folder and show all zeros | Any singleton that resolves persistence paths at import time can drift away from the runtime-selected data dir; keep those stores lazy or explicitly rebind them after desktop environment setup. |
| 78 | Packaged one-click environment setup cannot resolve `scripts/setup-ai-cli.ps1` via `process.cwd()` because the current working directory may be the user's workspace or an unpacked release folder that does not contain the repo `scripts/` tree | Resolve setup/install helpers from the module location or `process.resourcesPath`, and explicitly ship the script in Electron `extraResources`, or the Settings installer fails before it can install a missing CLI. |
| 79 | `createDesktopBackend()` used to eagerly construct managers like `MusicManager` before Electron called `configureDesktopEnvironment()`, so any constructor-time state reads could still hit the wrong fallback data dir | Keep desktop backend services lazy unless they are pure, or packaged/runtime-specific path setup can be bypassed during startup by an innocent top-level constructor. |
| 80 | Sticky-prompt theme checks that scroll a latest text prompt only a few pixels past the top can stay unstuck because the current transcript logic waits for the following reply to become the top visible content before cloning the sticky overlay | When updating sticky transcript coverage, assert “no sticky yet” until the reply actually takes over the reading area, or the spec will fail even though the UI matches the newer boundary rule. |
| 81 | The first-open onboarding Playwright flow can stay stuck on “Not started yet” if the mock only flips setup completion from a later `/api/setup/status` poll after `/api/setup/run` | For onboarding wizard coverage that is really about the happy-path guide flow, mock `/api/setup/run` to return success directly instead of depending on asynchronous status polling semantics. |
| 82 | Codex synthetic `<ask-user-question>` replies can stream raw XML into the live assistant bubble before the final structured `ask-user` activity arrives | If the activity is only appended, the transcript shows both the XML blob and a second ask-user card; replace the in-flight assistant bubble when promoting that activity. |
| 83 | `pnpm legal:check` can disagree between Windows dev and Ubuntu CI because `pnpm licenses list --json` includes platform-specific optional binary packages | Generate and verify the legal inventory with `--no-optional`, or the checked-in `THIRD_PARTY_LICENSES.md` will churn by OS and fail CI even when dependencies did not really change. |
| 84 | Large GitHub release zip uploads can take long enough that a foreground `gh release upload` looks hung even though the transfer is still the critical path | Start the upload in the background or with generous timeout, then poll the release asset list instead of blocking the whole session and assuming a slow upload means failure. |
| 85 | Replacing a release asset in place with `gh release upload --clobber` can leave the release temporarily assetless if the old file is removed before the new large upload is confirmed | For slow or flaky large-file uploads, prefer uploading under a unique temporary asset name first, verify it appears on the release, then clean up or rename instead of deleting the only downloadable zip up front. |
| 86 | In GitHub CLI, `gh release upload <file>#<text>` treats the `#<text>` suffix as the asset label, not as a renamed asset filename | If you need a different release asset filename, rename/copy the local file first or patch the uploaded asset name through the API instead of assuming the `#` suffix changes the download filename. |
| 87 | Codex app-server `item/agentMessage/delta` chunks can carry structured payloads like commentary JSON instead of user-visible prose | Forwarding those deltas straight to the renderer leaks raw JSON into chat, so buffer suspected structured deltas and let the completed item decide whether they should become reasoning / ask-user blocks. |
| 88 | Rendering the startup state-recovery prompt as a full-screen blur overlay on top of a large restored board can make packaged Electron feel frozen before the user chooses an option | Treat startup recovery as a blocking shell that skips mounting the heavy workspace behind it, or corrupted-state recovery can look like an unresponsive app instead of a recoverable prompt. |
| 89 | Playwright specs that loop multiple mocked tool states through a single `page` and keep stacking `page.route(...)` handlers can pass in isolation but fail in the full suite with stale fixture responses | Split each mocked state into its own test or explicitly `unroute` between iterations, or later cases can render the wrong surface and look like a product regression. |
| 90 | Playwright freeze regressions that add a short explicit action timeout like `click({ timeout: 5000 })` can flake under full parallel load even when the real assertion is the post-click UI state and absence of renderer errors | Let the click use the normal action budget and assert the resulting tab/render state instead, or suite-wide resource contention will produce false reds that are not real freeze regressions. |
| 91 | Codex app-server can emit only transient `Reconnecting... n/5` assistant deltas and then exit without `turn/completed` | Treat those errors as recoverable but do not count them against the UI retry budget; otherwise the card hits a false hard-failure loop even though no real assistant output ever arrived. |
| 92 | Codex app-server `thread/resume` can fail with rollout-file errors such as `empty session file` or `no rollout found for thread id` | Fall back to a fresh thread with the latest prompt/attachments instead of surfacing the raw rollout error, or one stale local CLI session blocks continued work. |
| 93 | `pnpm test -- --test-name-pattern ...` still boots the repo-wide `tests/index.test.ts`, so narrow Node test runs can crash on unrelated React/CSS imports before your targeted reducer test executes | For focused logic debugging in this repo, run `node --import tsx --test <file>.ts` on the exact test file instead of relying on the package script’s name-pattern filter. |

| 94 | Ubuntu GitHub Actions runners can fail `pnpm test` in the CI `quality` job with `Missing X server or $DISPLAY` because the Node test suite launches hidden Electron runtime tests through Playwright | Wrap the Ubuntu `pnpm test` step with `xvfb-run -a` (or provide an equivalent virtual display), or the release commit looks red in CI even when the app itself is fine. |
| 95 | Windows PowerShell 5.1 can parse a BOM-less UTF-8 `.ps1` update script with mojibake paths like `D:\涓嬭浇\...`, even when the script body itself sets `UTF8Encoding` after launch | When an updater or helper script may include Chinese/non-ASCII paths, write the `.ps1` file with a UTF-8 BOM or the update can close the app, fail silently, and relaunch nothing. |

| 96 | If "read docs first / maintain docs" is only implied by product ideas or runtime prompts, repo agents can still skip it while modifying Chill Vibe itself | Put the docs-first rule in the repo contract itself (`AGENTS.md`) and require agents to read/update relevant docs before production code, or each new task risks repeating the same workflow mistake. |
| 97 | A Playwright run that starts the repo Vite web server on `127.0.0.1:5173` can leave that process behind after the suite exits, so the next Playwright launch fails immediately with “port already used” | Before a second Playwright run in the same session, verify who owns `5173` and stop the leftover repo-local `vite.js --host 127.0.0.1 --strictPort` process instead of assuming the prior run cleaned it up. |

| 98 | Waiting only for the packaged Electron main PID is not enough during a Windows in-place update because renderer/GPU/utility child processes from the same `Chill Vibe.exe` path can keep `app.asar` and the executable locked after the main process exits | The zip updater must wait for or kill every matching app process under the installed executable path before clearing the app folder, or auto-update can silently die at the copy step even when the script itself launches correctly. |

| 99 | Claude CLI bypass mode acceptance is controlled by the top-level `skipDangerousModePermissionPrompt`, while file access outside the workspace still needs `permissions.additionalDirectories` / `--add-dir` | Setting only `permissions.defaultMode: "bypassPermissions"` can still leave the outer IDE stuck on Claude's own warning or `~/.claude` access prompt, so the launcher must seed both knobs together. |

| 100 | Windows packaged auto-update can still close the app and do nothing if the updater spawns bare `powershell` via `PATH` and never waits for the child process `spawn` event | Launch the update script via the absolute `SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` path when available, and treat spawn errors as install failures before quitting so the app stays open instead of silently exiting. |
| 101 | Ask-user 选项卡在提交答案后如果直接移除底部 footer，会让整张卡片高度瞬间缩短并造成“底部上移”的错觉 | 这类交互卡片的 answered 态要保留稳定的底部占位，只把控件切成已提交/锁定状态，避免消息区和 composer 跟着跳动。 |
| 102 | `spawn('powershell.exe', args, { detached: true, stdio: 'ignore', windowsHide: true })` 能成功 fire `'spawn'` 事件，但 PowerShell 会立刻以 exit code 0 退出且从不执行脚本——apply-update.log 保持 0 字节，更新彻底失效 | 走 `cmd.exe /c start "" /B <powershell> <args>` 包一层来真正分离进程，或者 auto-update 会表现为"点了安装窗口关了但啥都没发生"；直接 spawn powershell 再加 detached 是不可靠的。 |
| 103 | Ask-user 不能只靠“卡里有 ask-user 消息”来判断是否等待用户回答，也不能忘记实时 activity 到达时打等待标记 | 实时 ask-user activity 必须立刻把当前 stream 标成等待回答；恢复态只应把“最新用户消息之后的 ask-user”视为待回答，否则会出现点击答案自中断，或旧 ask-user 禁掉正常打断。 |

| 104 | Local provider `resume-session` recovery must continue the existing proxy-stats run instead of starting a fresh one | Restarting stats on auto-resume double-counts `request` and loses the earlier disconnect marker, so settings can still show zero recoveries/failures even though the chat visibly reconnected or failed. |
| 105 | A provider session can become a dead archive that only resumes into transient `Reconnecting... n/5` placeholder output forever | After a few placeholder-only `resume-session` attempts, clear the stale session id and replay the visible transcript into a fresh provider session instead of reusing the dead session. |


| 106 | Codex app-server can emit only transient `Reconnecting... n/5` placeholders and then exit nonzero | The exit text alone is not one of the generic recoverable phrases, so preserve the observed placeholder-only state and still mark it `resume-session` + `transientOnly` instead of surfacing a hard disconnect. |

| 107 | Editing UTF-8 source files with Windows PowerShell `Get-Content` / `Set-Content` can silently mojibake Chinese strings and add a BOM | Use .NET `File.ReadAllText(..., UTF8)` plus `UTF8Encoding(false)` or a patch tool that preserves encoding, then review the diff before running lint. |

| 108 | Codex app-server reconnect placeholders can arrive split across multiple `item/agentMessage/delta` chunks | Track transient placeholder prefixes per item id before deciding the stream produced real assistant output; otherwise partial chunks like `Reconnect` / `ing` falsely mark the run durable and let a placeholder-only turn finish as `done`. |

### Self-maintenance rule

- When you encounter a new non-obvious failure mode — a test that fails for environmental reasons, a build step with hidden prerequisites, a runtime behavior that contradicts the docs — append a row to this table before you finish the task.
- Keep entries concise: one sentence for the pitfall, one for why it matters.
- If a pitfall is resolved permanently (e.g. tooling was fixed), remove its row instead of leaving stale warnings.

## Worktree Policy

- If a task touches 3+ files or spans multiple modules, work in a git worktree (`EnterWorktree`) so that parallel agents do not interfere with each other.
- Single-file fixes, config tweaks, or quick questions can stay on the current branch.
- Within the same user session window, default to the current branch or current worktree for follow-up requests instead of opening a new worktree for each new requirement. Only start another worktree when the user asks for isolation, parallel work, or a truly separate line of work.
- A worktree is not considered cleaned up until both the Git registration and the on-disk directory are gone; verify `git worktree list` and the matching `chill-vibe-*` folder set before handoff.
- If a merged worktree is dirty at cleanup time, preserve its delta first with `git stash push -u` or an equivalent explicit backup, then remove the worktree in the same task instead of leaving a merged-but-dirty checkout behind.
- The agent must handle the full worktree lifecycle autonomously — the user should not need to manage worktrees manually:
  1. `EnterWorktree` to start isolated work.
  2. Commit all changes inside the worktree.
  3. Merge the worktree branch back to main (`git checkout main && git merge <branch>`).
  4. Run `pnpm test:full` after merge to verify integration.
  5. `ExitWorktree` with `action: "remove"` to clean up.
  6. If merge conflicts occur, resolve them automatically; only ask the user when the intent is ambiguous.
- When multiple agents run in parallel, split tasks along module boundaries (e.g., `shared/` vs `src/components/`) to minimize merge conflicts.
