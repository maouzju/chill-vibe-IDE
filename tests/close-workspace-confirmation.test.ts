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
