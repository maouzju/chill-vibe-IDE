import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import {
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntry,
  ensureWithinWorkspace,
  listFiles,
  moveWorkspaceEntry,
  renameWorkspaceEntry,
  searchWorkspaceFiles,
} from '../server/file-system.js'

test('ensureWithinWorkspace allows paths inside the workspace', () => {
  const workspace = path.resolve('/projects/my-app')
  const result = ensureWithinWorkspace(workspace, 'src/index.ts')
  assert.equal(result, path.join(workspace, 'src', 'index.ts'))
})

test('ensureWithinWorkspace rejects paths outside the workspace', () => {
  const workspace = path.resolve('/projects/my-app')
  assert.throws(
    () => ensureWithinWorkspace(workspace, '../../etc/passwd'),
    /Path traversal is not allowed/,
  )
})

test('ensureWithinWorkspace allows absolute paths under ~/.claude/', () => {
  const workspace = path.resolve('/projects/my-app')
  const claudePlanFile = path.join(os.homedir(), '.claude', 'plans', 'my-plan.md')
  const result = ensureWithinWorkspace(workspace, claudePlanFile)
  assert.equal(result, claudePlanFile)
})

test('ensureWithinWorkspace rejects absolute paths outside workspace and ~/.claude/', () => {
  const workspace = path.resolve('/projects/my-app')
  assert.throws(
    () => ensureWithinWorkspace(workspace, path.resolve('/tmp/evil.txt')),
    /Path traversal is not allowed/,
  )
})

test('listFiles includes dotfiles and dot directories while still skipping heavy internal folders', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-list-hidden-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await mkdir(path.join(workspace, '.github'), { recursive: true })
  await mkdir(path.join(workspace, '.git'), { recursive: true })
  await mkdir(path.join(workspace, 'node_modules'), { recursive: true })
  await mkdir(path.join(workspace, 'src'), { recursive: true })

  await writeFile(path.join(workspace, '.env'), 'TOKEN=dev\n', 'utf8')
  await writeFile(path.join(workspace, '.gitignore'), 'node_modules\n', 'utf8')
  await writeFile(path.join(workspace, '.github', 'workflow.yml'), 'name: ci\n', 'utf8')
  await writeFile(path.join(workspace, '.git', 'config'), '[core]\n', 'utf8')
  await writeFile(path.join(workspace, 'node_modules', 'package.json'), '{}\n', 'utf8')

  const rootEntries = await listFiles({
    workspacePath: workspace,
    relativePath: '',
  })
  const rootEntryNames = rootEntries.entries.map((entry) => entry.name)

  assert.equal(rootEntryNames.includes('.github'), true)
  assert.equal(rootEntryNames.includes('.env'), true)
  assert.equal(rootEntryNames.includes('.gitignore'), true)
  assert.equal(rootEntryNames.includes('src'), true)
  assert.equal(rootEntryNames.includes('.git'), false)
  assert.equal(rootEntryNames.includes('node_modules'), false)

  const githubEntries = await listFiles({
    workspacePath: workspace,
    relativePath: '.github',
  })

  assert.deepEqual(githubEntries.entries, [
    {
      name: 'workflow.yml',
      isDirectory: false,
    },
  ])
})

test('searchWorkspaceFiles finds nested file matches across the workspace path, including dot directories, and skips ignored directories', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-search-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await mkdir(path.join(workspace, 'src', 'components'), { recursive: true })
  await mkdir(path.join(workspace, 'docs'), { recursive: true })
  await mkdir(path.join(workspace, 'node_modules', 'tooling'), { recursive: true })
  await mkdir(path.join(workspace, '.github'), { recursive: true })
  await mkdir(path.join(workspace, '.git'), { recursive: true })

  await writeFile(path.join(workspace, 'src', 'components', 'FileTreeCard.tsx'), 'export {}\n', 'utf8')
  await writeFile(path.join(workspace, 'docs', 'file-tree.md'), '# search\n', 'utf8')
  await writeFile(path.join(workspace, 'node_modules', 'tooling', 'file-tree.js'), 'module.exports = {}\n', 'utf8')
  await writeFile(path.join(workspace, '.github', 'file-tree.yml'), 'name: hidden\n', 'utf8')
  await writeFile(path.join(workspace, '.git', 'file-tree.yml'), 'name: internal\n', 'utf8')

  const treeMatches = await searchWorkspaceFiles({
    workspacePath: workspace,
    query: 'tree',
    limit: 20,
  })
  const folderMatches = await searchWorkspaceFiles({
    workspacePath: workspace,
    query: 'components',
    limit: 20,
  })

  assert.deepEqual(
    treeMatches.entries.map((entry) => entry.path),
    ['.github/file-tree.yml', 'docs/file-tree.md', 'src/components/FileTreeCard.tsx'],
  )
  assert.equal(treeMatches.entries.every((entry) => entry.isDirectory === false), true)
  assert.deepEqual(folderMatches.entries.map((entry) => entry.path), ['src/components/FileTreeCard.tsx'])
})

test('searchWorkspaceFiles is case-insensitive and respects the result limit', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-search-limit-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await mkdir(path.join(workspace, 'src'), { recursive: true })
  await writeFile(path.join(workspace, 'README.md'), '# root\n', 'utf8')
  await writeFile(path.join(workspace, 'src', 'ReadMe.test.ts'), 'export {}\n', 'utf8')
  await writeFile(path.join(workspace, 'src', 'read-model.ts'), 'export {}\n', 'utf8')

  const matches = await searchWorkspaceFiles({
    workspacePath: workspace,
    query: 'READ',
    limit: 2,
  })

  assert.equal(matches.entries.length, 2)
  assert.equal(matches.entries[0]?.path, 'README.md')
  assert.equal(
    matches.entries.every((entry) => entry.name.toLowerCase().includes('read')),
    true,
  )
})

test('create, rename, and delete workspace entries stay inside the workspace', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-mutate-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await mkdir(path.join(workspace, 'src'), { recursive: true })

  await createWorkspaceDirectory({
    workspacePath: workspace,
    parentRelativePath: 'src',
    name: 'notes',
  })
  await createWorkspaceFile({
    workspacePath: workspace,
    parentRelativePath: 'src/notes',
    name: 'todo.md',
  })

  const createdFilePath = path.join(workspace, 'src', 'notes', 'todo.md')
  const createdDirectoryPath = path.join(workspace, 'src', 'notes')

  assert.equal(path.basename(createdDirectoryPath), 'notes')
  assert.equal(path.basename(createdFilePath), 'todo.md')

  await renameWorkspaceEntry({
    workspacePath: workspace,
    relativePath: 'src/notes/todo.md',
    nextName: 'done.md',
  })

  await assert.rejects(
    () => import('node:fs/promises').then(({ stat }) => stat(createdFilePath)),
    /ENOENT/,
  )

  await deleteWorkspaceEntry({
    workspacePath: workspace,
    relativePath: 'src/notes',
  })

  await assert.rejects(
    () => import('node:fs/promises').then(({ stat }) => stat(createdDirectoryPath)),
    /ENOENT/,
  )
})

test('workspace entry mutations reject invalid names and duplicate targets', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-mutate-invalid-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await mkdir(path.join(workspace, 'src'), { recursive: true })
  await writeFile(path.join(workspace, 'src', 'existing.md'), '# existing\n', 'utf8')

  await assert.rejects(
    () =>
      createWorkspaceFile({
        workspacePath: workspace,
        parentRelativePath: 'src',
        name: 'nested/file.md',
      }),
    /path separators/i,
  )

  await assert.rejects(
    () =>
      renameWorkspaceEntry({
        workspacePath: workspace,
        relativePath: 'src/existing.md',
        nextName: '../escape.md',
      }),
    /path separators/i,
  )

  await assert.rejects(
    () =>
      createWorkspaceFile({
        workspacePath: workspace,
        parentRelativePath: 'src',
        name: 'existing.md',
      }),
    /already exists|EEXIST/i,
  )
})

test('moveWorkspaceEntry relocates entries across directories and rejects moving folders into their descendants', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-move-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await mkdir(path.join(workspace, 'src', 'notes', 'nested'), { recursive: true })
  await mkdir(path.join(workspace, 'docs'), { recursive: true })
  await writeFile(path.join(workspace, 'src', 'notes', 'todo.md'), '# todo\n', 'utf8')

  await moveWorkspaceEntry({
    workspacePath: workspace,
    relativePath: 'src/notes/todo.md',
    destinationParentRelativePath: 'docs',
  })

  await assert.rejects(
    () => import('node:fs/promises').then(({ stat }) => stat(path.join(workspace, 'src', 'notes', 'todo.md'))),
    /ENOENT/,
  )
  const { stat } = await import('node:fs/promises')
  assert.equal((await stat(path.join(workspace, 'docs', 'todo.md'))).isFile(), true)

  await assert.rejects(
    () =>
      moveWorkspaceEntry({
        workspacePath: workspace,
        relativePath: 'src/notes',
        destinationParentRelativePath: 'src/notes/nested',
      }),
    /descendant/i,
  )
})
