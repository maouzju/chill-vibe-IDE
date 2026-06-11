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
  readWorkspaceFile,
  renameWorkspaceEntry,
  searchWorkspaceFiles,
  writeWorkspaceFile,
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

test('readWorkspaceFile flags oversized files without loading their content', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-read-huge-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'huge.log'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x61))

  const result = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'huge.log' })

  assert.equal(result.tooLarge, true)
  assert.equal(result.content, '')
  assert.equal(result.size, 10 * 1024 * 1024 + 1)
})

test('readWorkspaceFile flags binary files instead of returning mojibake', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-read-binary-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(
    path.join(workspace, 'image.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
  )

  const result = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'image.png' })

  assert.equal(result.binary, true)
  assert.equal(result.content, '')
})

test('readWorkspaceFile marks large-but-editable files and still returns content', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-read-large-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'big.txt'), Buffer.alloc(2 * 1024 * 1024, 0x62))

  const result = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'big.txt' })

  assert.equal(result.large, true)
  assert.equal(result.content.length, 2 * 1024 * 1024)
  assert.equal(result.tooLarge, undefined)
  assert.equal(result.binary, undefined)
})

test('readWorkspaceFile returns a content revision that changes with the content', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-read-revision-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  const target = path.join(workspace, 'note.md')
  await writeFile(target, 'first version\n', 'utf8')

  const first = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'note.md' })
  const second = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'note.md' })

  assert.equal(typeof first.revision, 'string')
  assert.ok(first.revision)
  assert.equal(first.revision, second.revision)

  await writeFile(target, 'second version\n', 'utf8')
  const third = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'note.md' })

  assert.notEqual(third.revision, first.revision)
})

test('writeWorkspaceFile rejects a stale expectedRevision instead of overwriting external changes', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-write-conflict-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  const target = path.join(workspace, 'shared.ts')
  await writeFile(target, 'const original = 1\n', 'utf8')

  const read = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'shared.ts' })

  // Simulate an external (agent) edit landing between read and save.
  await writeFile(target, 'const externalEdit = 2\n', 'utf8')

  await assert.rejects(
    () =>
      writeWorkspaceFile({
        workspacePath: workspace,
        relativePath: 'shared.ts',
        content: 'const mine = 3\n',
        expectedRevision: read.revision,
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { conflict?: boolean }).conflict === true,
  )

  const { readFile: readRaw } = await import('node:fs/promises')
  assert.equal(await readRaw(target, 'utf8'), 'const externalEdit = 2\n')
})

test('writeWorkspaceFile succeeds when expectedRevision matches and returns the new revision', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-write-match-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  const target = path.join(workspace, 'shared.ts')
  await writeFile(target, 'const original = 1\n', 'utf8')

  const read = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'shared.ts' })
  const result = await writeWorkspaceFile({
    workspacePath: workspace,
    relativePath: 'shared.ts',
    content: 'const mine = 3\n',
    expectedRevision: read.revision,
  })

  const { readFile: readRaw } = await import('node:fs/promises')
  assert.equal(await readRaw(target, 'utf8'), 'const mine = 3\n')

  const after = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'shared.ts' })
  assert.equal(result?.revision, after.revision)
})

test('writeWorkspaceFile without expectedRevision keeps the legacy overwrite behavior', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-write-legacy-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  const target = path.join(workspace, 'legacy.txt')
  await writeFile(target, 'old\n', 'utf8')
  await writeFile(target, 'external\n', 'utf8')

  await writeWorkspaceFile({
    workspacePath: workspace,
    relativePath: 'legacy.txt',
    content: 'forced\n',
  })

  const { readFile: readRaw } = await import('node:fs/promises')
  assert.equal(await readRaw(target, 'utf8'), 'forced\n')
})

test('writeWorkspaceFile with expectedRevision still writes when the file was deleted externally', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-write-deleted-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  const target = path.join(workspace, 'gone.txt')
  await writeFile(target, 'original\n', 'utf8')

  const read = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'gone.txt' })
  await rm(target)

  await writeWorkspaceFile({
    workspacePath: workspace,
    relativePath: 'gone.txt',
    content: 'restored\n',
    expectedRevision: read.revision,
  })

  const { readFile: readRaw } = await import('node:fs/promises')
  assert.equal(await readRaw(target, 'utf8'), 'restored\n')
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
