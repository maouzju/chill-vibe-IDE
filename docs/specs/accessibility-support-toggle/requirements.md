# Requirements — Accessibility Support Toggle

## Problem

External assistive/input tools on Windows (WeChat voice-to-text, screen readers,
dictation, automation helpers) cannot see Chill Vibe's chat composer. They fall
back to clipboard hacks or simply do nothing, because the app exposes no
accessibility tree at all.

Measured on 2026-07-26 against the packaged build via UI Automation:

| Configuration | UIA descendants | `ControlType.Edit` found |
|---|---|---|
| Shipping build (no switches) | 2 | 0 |
| `--force-renderer-accessibility` only | 2 | 0 |
| `app.setAccessibilitySupportEnabled(true)` only | 1 | 0 |
| `--enable-features=UiaProvider` only | 15 | 0 |
| `UiaProvider` + `force-renderer-accessibility` | 19 | **1** (`ValuePattern` + `TextPattern`) |

Repeated UIA queries never lazily activated the renderer tree, so on-demand
activation is not available — the switches must be set explicitly before
`app.whenReady()`.

## Requirements

1. **R1** — Chill Vibe must be able to expose its renderer content (composer
   textarea, buttons, transcript text) to Windows UI Automation clients so
   assistive input tools can write text directly into the focused composer.
2. **R2** — Accessibility exposure must be **opt-in**, defaulting to off. Forcing
   the renderer accessibility tree makes Chromium build and maintain a full a11y
   tree for every mounted pane; this repo already fights renderer memory and
   frame-budget pressure on large transcripts, so it must not become an
   unconditional cost.
3. **R3** — The setting must be user-visible in Settings, in both languages, and
   must state plainly that a restart is required.
4. **R4** — Because Chromium command-line switches must be appended before the
   app is ready, the enabled state must be readable **synchronously at startup**
   without loading the full `state.json` (which can be tens of megabytes — see
   pitfalls #45, #55).
5. **R5** — Existing installs with no persisted value must upgrade cleanly to the
   default (off) rather than crashing hydration.
6. **R6** — Environment overrides must exist for tests and support triage:
   `CHILL_VIBE_ENABLE_ACCESSIBILITY_SUPPORT=1` / `CHILL_VIBE_DISABLE_ACCESSIBILITY_SUPPORT=1`.

## Out of scope

- macOS/Linux assistive verification. `app.setAccessibilitySupportEnabled(true)`
  is still called on those platforms, but only Windows UIA was measured.
- Adding ARIA semantics beyond what the existing DOM already carries.
