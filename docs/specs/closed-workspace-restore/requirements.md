# Closed Workspace Restore Requirements

## Goal

When a user closes a workspace column and later opens a new workspace column, Chill Vibe should offer to restore the recently closed column state instead of always creating a blank copied column.

Here, "workspace" means one IDE board column, not the whole app window or disk project folder.

## Requirements

1. Closing a workspace column must keep the existing close confirmation behavior and must still stop active runs / clear queued sends before removing the column.
2. After a column is closed, the app must retain one restorable snapshot of that exact column state, including title, provider, workspace path, model, width, layout, cards, drafts, and messages.
3. The closed column snapshot must not duplicate native active stream state. Restored cards must come back idle, with `streamId` cleared, so no stale backend stream is reused.
4. Clicking **Add workspace** when a restorable closed column exists must show an in-app confirmation dialog: restore the last closed workspace state or create a fresh workspace.
5. Choosing restore must insert the saved column back onto the board and then clear that pending restore snapshot.
6. Choosing fresh workspace must create the normal new column and clear that pending restore snapshot so the same closed column does not keep prompting.
7. If no closed column snapshot exists, **Add workspace** keeps the current one-click behavior.
8. The pending restore snapshot must survive app reload through normal state persistence and must normalize safely for old states that do not have this field.
9. Session history behavior remains unchanged: conversations with messages are still archived during close; restoring the column may therefore bring back the live column state while history remains available.

## Non-goals

- Do not change how full-app/window startup recovery works.
- Do not implement a multi-item closed-workspace trash list in this slice.
- Do not delete project files from disk.
