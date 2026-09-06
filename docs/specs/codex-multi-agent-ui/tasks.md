# Tasks: Codex Multi-Agent UI Parity

## Regression fix - empty completed wait history (2026-09-06)

- [x] Inspect installed 0.153.4 protocol and freeze the historical wait filtering boundary.
- [x] Add red-first cases for saved empty waits, invalid results, preserved failures/in-progress/metadata, live empty status, and terminal activity delivery.
- [x] Filter only content-free completed waits at render parsing; keep provider lifecycle updates intact.
- [x] Run focused parser/renderer tests and quality checks.
- [x] Inspect both themes at desktop and narrow widths; all four new snapshots deliberately reviewed.
- [x] Package through the parent task.

Verification: three new renderer proving tests failed before implementation; all 48 parser/renderer tests passed afterward. The related parser/performance/agent-status sweep passed 116 tests. `pnpm test:quality` passed. The provider completion test confirms both started and completed updates remain available under the same item id.

Integrated verification: 2026-09-06, 151 focused Node tests and 21 recovery/theme Playwright cases passed; quality passed. Four empty-wait snapshots (light/dark, 1280/440px) and two native-retry snapshots were deliberately reviewed. `pnpm test:theme` was blocked by another project's 5173 listener; the relevant theme and runtime cases ran with the existing repo config derived on isolated port 5198. Windows zip: `dist/release-20260906-232949/Chill Vibe-0.20.15-win.zip`; runnable executable: `win-unpacked/Chill Vibe.exe` in the same release directory. The user's packaged instance was not restarted. This scoped bug fix extends the existing SPEC and follows `docs/ui-principles.md`; no new feature SPEC is needed.

## Slice 1 - freeze parity and proving tests

- [x] Inspect installed Codex CLI version and matching official source tag.
- [x] Document root/child routing, v2 activity, bounded preview, and rendering contracts.
- [x] Add failing tracker tests for v2 child lifecycle, nesting, stable order, dedupe, privacy, and bounds.
- [x] Add failing provider tests for root/child session and completion isolation.
- [x] Add failing renderer/parser tests for live and empty status panels.
- [x] Add failing local slash-command coverage for `/agent` and `/subagents`.

## Slice 2 - structured schema and tracker

- [x] Extend the existing `agents` payload compatibly with `view`, `path`, and `activity`.
- [x] Add the pure Codex child-agent status tracker and activity summarizer.
- [x] Route child thread/item/delta/status/close events away from the parent transcript.
- [x] Defer parent completion while child agents are still active.
- [x] Emit one stable live status activity that updates in place.

## Slice 3 - renderer and local command parity

- [x] Render Codex-style live and empty status views.
- [x] Preserve and tighten legacy tool-call history rendering.
- [x] Remove the unsupported disabled `Open` control and mention hint.
- [x] Add `/agent` and `/subagents` to Codex slash commands and handle them locally.
- [x] Add theme-safe, narrow-safe styles using existing tokens.

## Slice 4 - verification and handoff

- [x] Run focused tracker, parser, provider, reducer, and renderer tests.
- [x] Run `pnpm test:quality`.
- [x] Run theme verification in light and dark; inspect diffs deliberately.
- [x] Run a fake app-server integration flow covering parent plus nested child events.
- [x] Add a red-first regression proving a silent child still trips the absolute hard cap after root completion.
- [x] Run the justified broader regression gate for provider-stream changes.
- [x] Build the Windows zip handoff with `pnpm electron:build`.
- [x] Restart the active development runtime and verify the intended checkout owns it.

## Regression fix - child visible before canonical path (2026-08-04)

- [x] Add a focused tracker regression for `thread/started` arriving before canonical-path activity.
- [x] Keep the running child visible through nickname/role/thread-id fallback until its path arrives.

## Regression fix - completed activity remains running (2026-09-06)

- [x] Compare root/child native completion records with the saved card and inspect the installed 0.153.4 protocol.
- [x] Add red-first tracker/provider tests for completed activities before/after root completion, concurrent/nested agents, and exactly-once completion.
- [x] Map the new terminal activity kind without changing ordinary parent/child waiting semantics.
- [x] Run focused regressions and quality checks, then package a Windows zip/executable without stopping the user's release instance.

Verification: four new proving cases failed before the tracker fix and passed afterward; 155 related Node tests passed, followed by 39 tracker/label tests after the final label adjustment. `pnpm test:quality` passed. The existing light/dark command-group Playwright case passed on isolated port 5196 with no snapshot updates (5173 belongs to another project). Build: `dist/release-20260906-224336/Chill Vibe-0.20.15-win.zip`, executable in its `win-unpacked/`. The currently used packaged instance was deliberately left running; no runtime restart or user-state rewrite was performed.
