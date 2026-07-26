import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('workspace close is guarded by an in-app confirmation dialog', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

  assert.match(source, /closeWorkspaceDialogColumnId/)
  assert.match(source, /role="dialog"/)
  assert.match(source, /closeWorkspaceDialogHistory/)
  assert.match(source, /onRemoveColumn=\{\(\) => openCloseWorkspaceDialog\(column\.id\)\}/)
  assert.doesNotMatch(source, /onRemoveColumn=\{\(\) => void removeColumn\(column\.id\)\}/)
})

test('workspace close saves a restorable snapshot before removal and reopen consumes it', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const saveSnapshotIndex = source.indexOf('await saveClosedWorkspaceSnapshot({')
  const removeColumnIndex = source.indexOf("applyAction({ type: 'removeColumn', columnId, workspaceCloseId })")

  assert.ok(saveSnapshotIndex >= 0, 'closing should save the exact workspace tab snapshot')
  assert.ok(removeColumnIndex > saveSnapshotIndex, 'the sidecar must be durable before the column is removed')
  assert.match(source, /await loadClosedWorkspaceSnapshot\(\{ workspacePath: trimmedPath \}\)/)
  assert.match(source, /type: 'restoreClosedWorkspace'/)
  assert.match(source, /type: 'restoreLegacyClosedWorkspace'/)
})
