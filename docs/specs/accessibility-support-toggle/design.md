# Design — Accessibility Support Toggle

## Startup path (the constraint that shapes everything)

`app.commandLine.appendSwitch(...)` only takes effect before `app.whenReady()`.
`configureDesktopEnvironment()` runs *inside* `whenReady`, and `loadState()` is
far too heavy for the pre-ready path (R4). So the enabled state lives in a tiny
sidecar file next to the app data, read synchronously at module scope.

```
<dataDir>/accessibility-support.json   ->   { "enabled": true }
```

`electron/accessibility-support.ts` owns that file:

- `resolveAccessibilitySupportEnabled({ enableOverride, disableOverride, persistedFlag })`
  — pure precedence function: disable override wins, then enable override, then
  the persisted flag, else `false`.
- `readAccessibilitySupportFlag(dataDir)` — synchronous, returns `null` on any
  missing/corrupt file so startup never throws.
- `writeAccessibilitySupportFlag(dataDir, enabled)` — creates the directory and
  writes the sidecar.

`electron/main.ts` at module scope resolves the same data dir that
`configureDesktopEnvironment()` will later use, reads the flag, and when enabled
appends both switches proven necessary by the measurements in `requirements.md`:

```ts
app.commandLine.appendSwitch('enable-features', 'UiaProvider')
app.commandLine.appendSwitch('force-renderer-accessibility')
```

After ready it also calls `app.setAccessibilitySupportEnabled(true)` so
`app.isAccessibilitySupportEnabled()` reports the truth and macOS gets the same
opt-in.

## Settings plumbing

`settings.accessibilitySupportEnabled` is the user-facing source of truth
(`shared/schema.ts`, defaulted `false`; `shared/default-state.ts` mirrors it in
`createDefaultSettings` and `normalizeAppSettings` per pitfalls #5/#6).

The renderer pushes changes down through a dedicated IPC channel rather than
`syncRuntimeSettings`, because this one does not affect provider routing:

```
App.tsx effect -> api.syncAccessibilitySupport(enabled)
              -> preload  desktop:set-accessibility-support
              -> main     writeAccessibilitySupportFlag(dataDir, enabled)
```

The effect runs on mount too, so a profile that already has the setting on keeps
its sidecar in sync even if the file was deleted.

Changing the toggle only rewrites the sidecar — Chromium switches cannot be
changed at runtime, so the Settings copy tells the user to restart.

## Why a sidecar instead of reading settings from `state.json`

`state.json` is loaded through paths that already caused packaged OOM
(pitfalls #55, #57). A 30-byte sidecar keeps the pre-ready read to one small
`readFileSync` and cannot regress startup memory.

## Verification

- Node unit tests for the precedence function and the sidecar round-trip
  (`tests/accessibility-support.test.ts`, registered in `tests/index.test.ts`).
- `tests/default-state.test.ts` covers schema default + normalization upgrade.
- Runtime proof: launch the packaged build with the flag on and assert a
  `ControlType.Edit` node with `ValuePattern` appears in the UIA tree.
