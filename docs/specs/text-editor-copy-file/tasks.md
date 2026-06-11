# Text Editor "Copy File" Button — Tasks

- [x] 1. Red: `tests/file-clipboard.test.ts` covering traversal rejection, missing-file
       rejection, win32 PowerShell command shape, darwin osascript shape, unsupported
       platform, runner failure propagation; register in `tests/index.test.ts`; confirm it fails.
- [x] 2. Green: implement `copyWorkspaceFileToClipboard` in `server/file-system.ts` and the
       `POST /api/files/copy-to-clipboard` route in `server/index.ts`; confirm the test passes.
- [x] 3. Bridge: `desktop:copy-file-to-clipboard` across `electron/preload.ts`,
       `electron/main.ts`, `electron/backend.ts`, typed in `src/electron.d.ts`.
- [x] 4. Client: `copyFileToClipboard` helper in `src/api.ts`; toolbar button + feedback in
       `TextEditorCard.tsx` (normal + guard branches); strings in `tool-card-text.ts`.
- [x] 5. Verify: narrow unit test (7/7) + `pnpm test:quality`; `text-editor-card.spec.ts`
       11/11 with binary-guard/conflict-banner snapshots refreshed deliberately in both themes;
       real end-to-end smoke confirmed the file lands on the Windows clipboard as a
       `FileDropList` entry. Merge + worktree cleanup tracked in the session.
