# Text Editor "Copy File" Button — Design

## Approach

Copying a *file* (not text) to the OS clipboard has no browser API, so the work happens
on the local host process. Both runtimes already share one implementation surface for
file operations: `server/file-system.ts`, reached via HTTP (`/api/files/*`) in the browser
and via the desktop bridge (`electron/backend.ts` → same server functions) in Electron.
The copy operation follows the exact same lane.

Platform mechanics (host-side):

| Platform | Mechanism |
|----------|-----------|
| win32    | `powershell.exe -NoProfile -NonInteractive -Command "Set-Clipboard -LiteralPath '<abs>'"` — Windows PowerShell 5.1 supports `-LiteralPath` (FileDropList). `pwsh` 7 dropped it, so the absolute `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` path is preferred (see pitfall #100). |
| darwin   | `osascript -e 'set the clipboard to (POSIX file "<abs>")'` |
| other    | Throw a clear "not supported" error. |

## Pieces

1. **`server/file-system.ts`** — `copyWorkspaceFileToClipboard(request, options?)`
   - `ensureWithinWorkspace` for path safety, `stat` to require an existing *file*.
   - `options` injects `platform` and a `run(command, args)` runner so unit tests cover
     every platform branch without touching the real clipboard (CI runs on Ubuntu).
   - Single-quote escaping for PowerShell (`'` → `''`), backslash/quote escaping for AppleScript.
   - Non-zero exit → error including trimmed stderr.
2. **`server/index.ts`** — `POST /api/files/copy-to-clipboard`, body validated with the
   existing `fileReadRequestSchema` (same shape; `nearest-tsconfig` sets that precedent).
3. **Electron bridge** — `desktop:copy-file-to-clipboard` IPC: `preload.ts` exposes
   `copyFileToClipboard`, `main.ts` routes to `backend.ts`, which parses with
   `fileReadRequestSchema` and calls the server function. Declared in `src/electron.d.ts`.
4. **`src/api.ts`** — `copyFileToClipboard(workspacePath, relativePath)`: desktop bridge
   first, HTTP fallback, error message surfaced from the JSON payload.
5. **`src/components/TextEditorCard.tsx`** — toolbar button (normal + guard branches),
   reusing `.text-editor-toolbar-button`. Click → async copy → `copyState`
   `'copied' | 'failed'` for 2s (timer cleared on unmount). Disabled while in flight.
6. **`src/components/tool-card-text.ts`** — `copyFile` / `copied` / `copyFailed` strings
   (en + zh, `\uXXXX` escapes per file convention).

## Testing

- Tier 1 (server logic): `tests/file-clipboard.test.ts`, red-first — traversal rejection,
  missing file rejection, win32 command shape (escaping included), darwin command shape,
  unsupported platform, runner failure propagation. Registered in `tests/index.test.ts`.
- Tier 2 (toolbar styling): reuses existing toolbar-button class — no new theme surface;
  verify both themes manually (Playwright runner is currently flaky on this host, pitfalls #25/#34).
