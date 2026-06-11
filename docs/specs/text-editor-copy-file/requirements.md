# Text Editor "Copy File" Button — Requirements

## Background

Users open generated files (e.g. `code-review-report.md`) in the text editor card and want to
hand the file itself to someone else — paste it into Explorer, WeChat, DingTalk, etc.
Today the editor toolbar only offers diff/save affordances; copying the file requires
leaving the app and finding it on disk.

## User Story

As a Chill Vibe user with a file open in the text editor card, I want a **Copy file**
button at the top-right of the card so the file (as a file, not its text) lands on the
system clipboard in one click.

## Acceptance Criteria

1. The text editor card toolbar (top-right action area) shows a **Copy file** button
   (zh: 复制文件) whenever a file is open — including binary / too-large guard states,
   where copying the file is still meaningful.
2. Clicking it places the file itself on the OS clipboard (Windows `FileDropList`,
   macOS file reference), so pasting in Explorer/Finder or a chat app inserts the file.
3. Success feedback: the button briefly reads "Copied" (zh: 已复制) for ~2s, then reverts.
4. Failure feedback: the button briefly reads "Copy failed" (zh: 复制失败); no dialog.
5. Works in both runtimes: Electron desktop (IPC bridge) and browser + local server (HTTP).
6. Path safety: only files inside the workspace (per `ensureWithinWorkspace`) can be copied;
   traversal attempts are rejected server-side.
7. Unsupported platforms (non win32/darwin server host) return a clear error message.
8. Both light and dark themes render the button with existing toolbar-button tokens.

## Out of Scope

- Copying file *content* as text (Monaco selection + Ctrl+C already covers it).
- Multi-file copy from the file tree card.
- Linux clipboard file support (no stable portal-free standard; error is acceptable).
