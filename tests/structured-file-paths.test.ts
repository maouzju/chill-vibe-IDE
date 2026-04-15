import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveWorkspaceRelativeFilePath } from '../src/components/structured-file-paths.ts'

test('keeps repo-relative structured file paths openable in the editor', () => {
  assert.equal(
    resolveWorkspaceRelativeFilePath('D:/Git/chill-vibe', 'docs/release-notes.md'),
    'docs/release-notes.md',
  )
  assert.equal(
    resolveWorkspaceRelativeFilePath('D:/Git/chill-vibe', './docs/../docs/release-notes.md'),
    'docs/release-notes.md',
  )
})

test('converts absolute workspace file paths into workspace-relative editor paths', () => {
  assert.equal(
    resolveWorkspaceRelativeFilePath('D:/Git/chill-vibe', 'D:/Git/chill-vibe/docs/release-notes.md'),
    'docs/release-notes.md',
  )
  assert.equal(
    resolveWorkspaceRelativeFilePath('D:/Git/chill-vibe', 'D:\\Git\\CHILL-VIBE\\docs\\release-notes.md'),
    'docs/release-notes.md',
  )
  assert.equal(
    resolveWorkspaceRelativeFilePath('D:/Git/chill-vibe', 'file:///D:/Git/chill-vibe/docs/release-notes.md'),
    'docs/release-notes.md',
  )
})

test('rejects structured file paths that resolve outside the active workspace', () => {
  assert.equal(
    resolveWorkspaceRelativeFilePath('D:/Git/chill-vibe', '../outside.md'),
    null,
  )
  assert.equal(
    resolveWorkspaceRelativeFilePath('D:/Git/chill-vibe', 'D:/Git/other-repo/outside.md'),
    null,
  )
  assert.equal(
    resolveWorkspaceRelativeFilePath('D:/Git/chill-vibe', 'D:/Git/chill-vibe'),
    null,
  )
})
