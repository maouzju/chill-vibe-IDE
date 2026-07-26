# Tasks — Accessibility Support Toggle

## Slice 1 — startup flag (red → green)

- [x] `tests/accessibility-support.test.ts`: precedence + sidecar round-trip, registered in the manifest.
- [x] `electron/accessibility-support.ts`: `resolveAccessibilitySupportEnabled`, `readAccessibilitySupportFlag`, `writeAccessibilitySupportFlag`.
- [x] `electron/main.ts`: pre-ready switch append + post-ready `setAccessibilitySupportEnabled`.

## Slice 2 — persisted setting

- [x] `shared/schema.ts`: `accessibilitySupportEnabled` defaulted `false`.
- [x] `shared/default-state.ts`: `createDefaultSettings` + `normalizeAppSettings`.
- [x] `tests/default-state.test.ts`: default + upgrade coverage.

## Slice 3 — renderer plumbing

- [x] IPC handler `desktop:set-accessibility-support` in `electron/main.ts`.
- [x] `electron/preload.ts` + `src/electron.d.ts` + `src/api.ts`.
- [x] `src/App.tsx` effect syncing the flag on mount and on change.

## Slice 4 — Settings UI

- [x] Toggle in the Environment settings group with restart-required copy.
- [x] `shared/i18n.ts` strings for zh-CN and en.

## Slice 5 — verification

- [x] Node tests green.
- [x] `pnpm test:quality`.
- [x] Packaged runtime UIA proof: `ControlType.Edit` with `ValuePattern` visible.
