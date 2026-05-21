# Closed Workspace Restore Design

## Data model

Add an optional `lastClosedColumn` field to `AppState`.

The value is a sanitized `BoardColumn` snapshot:

- keep column identity and content fields so the user's workspace column can visually return as it was;
- clear every card's `streamId`;
- force cards that were `streaming` back to `idle`;
- normalize the column layout against its cards.

Only the most recently closed column is stored. A new close replaces the previous snapshot.

## Reducer changes

- `removeColumn`
  - archive card messages to session history exactly as today;
  - store the sanitized removed column in `lastClosedColumn`;
  - remove the column and redistribute widths as today.
- `addColumn`
  - keep existing behavior for fresh columns;
  - allow an explicit `column` payload to be inserted and clear `lastClosedColumn` after any add.
- new `dismissLastClosedColumnRestore`
  - clears `lastClosedColumn` without adding a column.

The App UI can restore by dispatching `addColumn` with the saved snapshot. It can create fresh by dispatching plain `addColumn`.

## UI flow

- Topbar **Add workspace** click:
  - if `appState.lastClosedColumn` exists, open a modal dialog;
  - otherwise dispatch plain `addColumn` immediately.
- Restore dialog copy should be clear and short:
  - title asks whether to restore the last closed workspace;
  - body shows the workspace label/path when available;
  - actions: **新建空白工作区** / **恢复上次状态**.
- Backdrop/close dismisses the dialog without consuming the snapshot, so accidental close does not lose the recovery chance.
- The “fresh workspace” action consumes the snapshot and creates the normal new workspace.

## Persistence / normalization

`appStateSchema` defaults `lastClosedColumn` to `null` so old state files load safely. `createDefaultState` starts with `lastClosedColumn: null`.

No backend API changes are required because the normal state save path already persists the whole `AppState`.

## Verification

- Reducer unit test: removing a column stores a sanitized restorable snapshot and adding it restores then clears the snapshot.
- Source/UI guard test: Add workspace is routed through the restore dialog when a snapshot is present and the dialog renders restore/fresh actions.
- Targeted unit suite rerun.
