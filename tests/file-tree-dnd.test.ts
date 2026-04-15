import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveFileTreeMoveDestination } from '../src/components/file-tree-dnd.ts'

test('resolveFileTreeMoveDestination moves into a hovered directory in the same workspace', () => {
  assert.deepEqual(
    resolveFileTreeMoveDestination({
      source: {
        workspacePath: 'D:/workspace',
        relativePath: 'src/file.ts',
        isDirectory: false,
      },
      targetWorkspacePath: 'D:/workspace',
      target: {
        path: 'docs',
        isDirectory: true,
      },
    }),
    {
      destinationParentRelativePath: 'docs',
    },
  )
})

test('resolveFileTreeMoveDestination drops onto a file by using that file parent directory', () => {
  assert.deepEqual(
    resolveFileTreeMoveDestination({
      source: {
        workspacePath: 'D:/workspace',
        relativePath: 'src/file.ts',
        isDirectory: false,
      },
      targetWorkspacePath: 'D:/workspace',
      target: {
        path: 'docs/readme.md',
        isDirectory: false,
      },
    }),
    {
      destinationParentRelativePath: 'docs',
    },
  )
})

test('resolveFileTreeMoveDestination allows dropping onto another file card root', () => {
  assert.deepEqual(
    resolveFileTreeMoveDestination({
      source: {
        workspacePath: 'D:/workspace',
        relativePath: 'src/file.ts',
        isDirectory: false,
      },
      targetWorkspacePath: 'D:/workspace',
      target: null,
    }),
    {
      destinationParentRelativePath: '',
    },
  )
})

test('resolveFileTreeMoveDestination rejects cross-workspace drops and moving a folder into its own descendant', () => {
  assert.equal(
    resolveFileTreeMoveDestination({
      source: {
        workspacePath: 'D:/workspace-a',
        relativePath: 'src/file.ts',
        isDirectory: false,
      },
      targetWorkspacePath: 'D:/workspace-b',
      target: null,
    }),
    null,
  )

  assert.equal(
    resolveFileTreeMoveDestination({
      source: {
        workspacePath: 'D:/workspace',
        relativePath: 'src/docs',
        isDirectory: true,
      },
      targetWorkspacePath: 'D:/workspace',
      target: {
        path: 'src/docs/nested',
        isDirectory: true,
      },
    }),
    null,
  )
})
