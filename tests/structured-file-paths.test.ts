import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveOpenableFilePath,
  resolveWorkspaceRelativeFilePath,
} from '../src/components/structured-file-paths.ts'

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

test('resolveOpenableFilePath keeps workspace files relative for the editor', () => {
  assert.equal(
    resolveOpenableFilePath('D:/Git/chill-vibe', 'docs/release-notes.md'),
    'docs/release-notes.md',
  )
  assert.equal(
    resolveOpenableFilePath('D:/Git/chill-vibe', 'D:/Git/chill-vibe/docs/release-notes.md'),
    'docs/release-notes.md',
  )
})

test('resolveOpenableFilePath opens out-of-workspace absolute paths with their absolute path', () => {
  assert.equal(
    resolveOpenableFilePath('D:/Git/chill-vibe', 'C:\\Users\\demo\\.claude\\projects\\demo\\MEMORY.md'),
    'C:/Users/demo/.claude/projects/demo/MEMORY.md',
  )
  assert.equal(
    resolveOpenableFilePath('D:/Git/chill-vibe', 'D:/Git/other-repo/outside.md'),
    'D:/Git/other-repo/outside.md',
  )
})

test('resolveOpenableFilePath preserves drive letter casing for out-of-workspace paths', () => {
  // Server-side ~/.claude whitelist comparisons must see the original casing.
  assert.equal(
    resolveOpenableFilePath('D:/Git/chill-vibe', 'c:/Users/demo/.claude/plans/plan.md'),
    'c:/Users/demo/.claude/plans/plan.md',
  )
})

test('resolveOpenableFilePath still rejects unresolvable or workspace-root paths', () => {
  assert.equal(resolveOpenableFilePath('D:/Git/chill-vibe', '../outside.md'), null)
  assert.equal(resolveOpenableFilePath('D:/Git/chill-vibe', 'D:/Git/chill-vibe'), null)
  assert.equal(resolveOpenableFilePath('D:/Git/chill-vibe', ''), null)
})
