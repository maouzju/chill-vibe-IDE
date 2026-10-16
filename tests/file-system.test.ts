import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
  normalizeEntryName,
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

test('ensureWithinWorkspace allows absolute paths under ~/.codex/', () => {
  const workspace = path.resolve('/projects/my-app')
  const codexSessionFile = path.join(os.homedir(), '.codex', 'sessions', 'log.md')
  const result = ensureWithinWorkspace(workspace, codexSessionFile)
  assert.equal(result, codexSessionFile)
})

test('workspace file reads reject directory links that escape the workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-link-boundary-'))
  const workspace = path.join(root, 'workspace')
  const outside = path.join(root, 'outside')
  await mkdir(workspace)
  await mkdir(outside)
  await writeFile(path.join(outside, 'secret.txt'), 'outside-secret', 'utf8')
  await symlink(outside, path.join(workspace, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir')

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  await assert.rejects(
    readWorkspaceFile({
      workspacePath: workspace,
      relativePath: 'linked-outside/secret.txt',
    }),
    /Path traversal is not allowed/,
  )
})

test('workspace file writes reject directory links that escape the workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-link-write-boundary-'))
  const workspace = path.join(root, 'workspace')
  const outside = path.join(root, 'outside')
  await mkdir(workspace)
  await mkdir(outside)
  await writeFile(path.join(outside, 'secret.txt'), 'outside-secret', 'utf8')
  await symlink(outside, path.join(workspace, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir')

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  await assert.rejects(
    writeWorkspaceFile({
      workspacePath: workspace,
      relativePath: 'linked-outside/secret.txt',
      content: 'overwritten',
      encoding: 'utf8',
    }),
    /Path traversal is not allowed/,
  )
})

test(
  'ensureWithinWorkspace matches agent home whitelists case-insensitively on Windows',
  { skip: process.platform !== 'win32' },
  () => {
    const workspace = path.resolve('/projects/my-app')
    const claudePlanFile = path.join(os.homedir(), '.claude', 'plans', 'my-plan.md')
    // Renderer-normalized paths can arrive with a lowercase drive letter.
    const loweredDrive = claudePlanFile.charAt(0).toLowerCase() + claudePlanFile.slice(1)
    const result = ensureWithinWorkspace(workspace, loweredDrive)
    assert.equal(result, path.resolve(loweredDrive))
  },
)

test('ensureWithinWorkspace opts in to absolute paths outside the workspace', () => {
  const workspace = path.resolve('/projects/my-app')
  const outsideFile = path.resolve('/other-repo/src/main.rs')
  const result = ensureWithinWorkspace(workspace, outsideFile, { allowOutsideWorkspace: true })
  assert.equal(result, outsideFile)
})

test('ensureWithinWorkspace still rejects relative traversal even when opted in', () => {
  const workspace = path.resolve('/projects/my-app')
  assert.throws(
    () => ensureWithinWorkspace(workspace, '../../etc/passwd', { allowOutsideWorkspace: true }),
    /Path traversal is not allowed/,
  )
})

test('readWorkspaceFile reads an agent-edited file outside the workspace when opted in', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-outside-read-'))
  const workspace = path.join(root, 'workspace')
  const outside = path.join(root, 'other-project')
  await mkdir(workspace)
  await mkdir(outside)
  const outsideFile = path.join(outside, 'notes.md')
  await writeFile(outsideFile, '# edited by the agent\n', 'utf8')

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  await assert.rejects(
    readWorkspaceFile({ workspacePath: workspace, relativePath: outsideFile }),
    /Path traversal is not allowed/,
  )

  const result = await readWorkspaceFile(
    { workspacePath: workspace, relativePath: outsideFile },
    { allowOutsideWorkspace: true },
  )
  assert.equal(result.content, '# edited by the agent\n')
})

test('writeWorkspaceFile saves a file outside the workspace when opted in', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-outside-write-'))
  const workspace = path.join(root, 'workspace')
  const outside = path.join(root, 'other-project')
  await mkdir(workspace)
  await mkdir(outside)
  const outsideFile = path.join(outside, 'notes.md')
  await writeFile(outsideFile, 'before\n', 'utf8')

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  await writeWorkspaceFile(
    {
      workspacePath: workspace,
      relativePath: outsideFile,
      content: 'after\n',
      encoding: 'utf8',
    },
    { allowOutsideWorkspace: true },
  )

  const saved = await readWorkspaceFile(
    { workspacePath: workspace, relativePath: outsideFile },
    { allowOutsideWorkspace: true },
  )
  assert.equal(saved.content, 'after\n')
})

test('opting in does not unlock workspace links that escape the workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-outside-link-'))
  const workspace = path.join(root, 'workspace')
  const outside = path.join(root, 'outside')
  await mkdir(workspace)
  await mkdir(outside)
  await writeFile(path.join(outside, 'secret.txt'), 'outside-secret', 'utf8')
  await symlink(outside, path.join(workspace, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir')

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // The opt-in is for absolute paths the user actually clicked, not for relative
  // addressing that silently leaves the workspace through a link.
  await assert.rejects(
    readWorkspaceFile(
      { workspacePath: workspace, relativePath: 'linked-outside/secret.txt' },
      { allowOutsideWorkspace: true },
    ),
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

// NTFS and default APFS fold case; probe the actual temp volume instead of assuming by platform.
const isCaseInsensitiveDirectory = async (directory: string) => {
  const probePath = path.join(directory, '.case-probe')
  await writeFile(probePath, '', 'utf8')
  try {
    await stat(path.join(directory, '.CASE-PROBE'))
    return true
  } catch {
    return false
  } finally {
    await rm(probePath, { force: true })
  }
}

test('renameWorkspaceEntry performs case-only renames of files and directories', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-rename-case-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await mkdir(path.join(workspace, 'src'), { recursive: true })
  await mkdir(path.join(workspace, 'docs'), { recursive: true })
  await writeFile(path.join(workspace, 'src', 'readme.md'), '# keep me\n', 'utf8')
  await writeFile(path.join(workspace, 'docs', 'inner.txt'), 'inner\n', 'utf8')

  await renameWorkspaceEntry({
    workspacePath: workspace,
    relativePath: 'src/readme.md',
    nextName: 'README.md',
  })
  await renameWorkspaceEntry({
    workspacePath: workspace,
    relativePath: 'docs',
    nextName: 'Docs',
  })

  assert.deepEqual(await readdir(path.join(workspace, 'src')), ['README.md'])
  const rootEntries = await readdir(workspace)
  assert.equal(rootEntries.includes('Docs'), true)
  assert.equal(rootEntries.includes('docs'), false)
  assert.equal(await readFile(path.join(workspace, 'src', 'README.md'), 'utf8'), '# keep me\n')
  assert.deepEqual(await readdir(path.join(workspace, 'Docs')), ['inner.txt'])
})

test('renameWorkspaceEntry keeps rejecting a different existing entry with the exact message', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-rename-collide-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await mkdir(path.join(workspace, 'src', 'folder'), { recursive: true })
  await writeFile(path.join(workspace, 'src', 'notes.md'), 'notes\n', 'utf8')
  await writeFile(path.join(workspace, 'src', 'todo.md'), 'todo\n', 'utf8')

  const renameNotesTo = (nextName: string) =>
    renameWorkspaceEntry({ workspacePath: workspace, relativePath: 'src/notes.md', nextName })

  await assert.rejects(renameNotesTo('todo.md'), { message: 'Target already exists.' })
  await assert.rejects(renameNotesTo('folder'), { message: 'Target already exists.' })

  if (await isCaseInsensitiveDirectory(path.join(workspace, 'src'))) {
    // Folding case must not turn "rename onto a different file" into an overwrite.
    await assert.rejects(renameNotesTo('TODO.md'), { message: 'Target already exists.' })
    await assert.rejects(renameNotesTo('FOLDER'), { message: 'Target already exists.' })
  }

  assert.equal(await readFile(path.join(workspace, 'src', 'notes.md'), 'utf8'), 'notes\n')
  assert.equal(await readFile(path.join(workspace, 'src', 'todo.md'), 'utf8'), 'todo\n')
})

test('renameWorkspaceEntry rejects a hard link that merely shares the inode', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-rename-hardlink-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'original.md'), 'shared\n', 'utf8')
  try {
    await link(path.join(workspace, 'original.md'), path.join(workspace, 'alias.md'))
  } catch (error) {
    t.skip(`hard links unsupported here: ${(error as NodeJS.ErrnoException).code}`)
    return
  }

  await assert.rejects(
    renameWorkspaceEntry({ workspacePath: workspace, relativePath: 'original.md', nextName: 'alias.md' }),
    { message: 'Target already exists.' },
  )
  assert.deepEqual((await readdir(workspace)).sort(), ['alias.md', 'original.md'])
})

test('renameWorkspaceEntry rejects case-variant siblings that are distinct entries on case-sensitive filesystems', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-rename-case-sensitive-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  if (await isCaseInsensitiveDirectory(workspace)) {
    t.skip('volume folds case, so case-variant siblings cannot coexist')
    return
  }

  // Same inode under two spellings: identity alone would wrongly call this a case-only rename.
  await writeFile(path.join(workspace, 'notes.md'), 'notes\n', 'utf8')
  await link(path.join(workspace, 'notes.md'), path.join(workspace, 'NOTES.md'))
  await assert.rejects(
    renameWorkspaceEntry({ workspacePath: workspace, relativePath: 'notes.md', nextName: 'NOTES.md' }),
    { message: 'Target already exists.' },
  )

  // stat() follows links, so readme.md -> README.md also looks like "the same file";
  // renaming over README.md would replace the real file with a self-referencing link.
  await writeFile(path.join(workspace, 'README.md'), '# real\n', 'utf8')
  await symlink('README.md', path.join(workspace, 'readme.md'), 'file')
  await assert.rejects(
    renameWorkspaceEntry({ workspacePath: workspace, relativePath: 'readme.md', nextName: 'README.md' }),
    { message: 'Target already exists.' },
  )
  assert.equal(await readFile(path.join(workspace, 'README.md'), 'utf8'), '# real\n')
})

test('renameWorkspaceEntry treats a dangling link at the target name as an existing entry', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-rename-dangling-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await mkdir(path.join(workspace, 'src'), { recursive: true })
  await mkdir(path.join(workspace, 'gone'), { recursive: true })
  await writeFile(path.join(workspace, 'src', 'source.md'), 'mine\n', 'utf8')
  await symlink(
    path.join(workspace, 'gone'),
    path.join(workspace, 'src', 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await rm(path.join(workspace, 'gone'), { recursive: true })

  await assert.rejects(
    renameWorkspaceEntry({ workspacePath: workspace, relativePath: 'src/source.md', nextName: 'link' }),
    { message: 'Target already exists.' },
  )
  assert.equal(await readFile(path.join(workspace, 'src', 'source.md'), 'utf8'), 'mine\n')
})

const windowsInvalidEntryNames: Array<[string, RegExp]> = [
  ['a:b.md', /these characters/i],
  ['existing.md:evil', /these characters/i],
  ['what?.md', /these characters/i],
  ['star*.md', /these characters/i],
  ['a<b.md', /these characters/i],
  ['a>b.md', /these characters/i],
  ['quote".md', /these characters/i],
  ['pipe|.md', /these characters/i],
  ['bell\u0007.md', /control characters/i],
  ['notes.', /end with a dot or a space/i],
  ['notes.md. ', /end with a dot or a space/i],
  ['notes. .', /end with a dot or a space/i],
  ['CON', /reserved/i],
  ['con.txt', /reserved/i],
  ['NUL.tar.gz', /reserved/i],
  ['Aux', /reserved/i],
  ['prn.md', /reserved/i],
  ['Com1', /reserved/i],
  ['lpt9.log', /reserved/i],
]

test('normalizeEntryName applies the Windows naming rules only for win32', () => {
  for (const [name, expected] of [...windowsInvalidEntryNames, ['COM¹', /reserved/i] as [string, RegExp]]) {
    assert.throws(() => normalizeEntryName(name, 'win32'), expected, JSON.stringify(name))
    assert.equal(normalizeEntryName(name, 'linux'), name.trim())
    assert.equal(normalizeEntryName(name, 'darwin'), name.trim())
  }

  for (const name of ['console.md', 'COM10.txt', 'nul-check.md', '.env', 'README.md', 'my file.txt', 'a.b.c']) {
    assert.equal(normalizeEntryName(name, 'win32'), name)
  }
  assert.equal(normalizeEntryName('  padded.md  ', 'win32'), 'padded.md')
  assert.throws(() => normalizeEntryName('nested/file.md', 'win32'), /path separators/i)
  assert.throws(() => normalizeEntryName('   ', 'win32'), /required/i)
})

test(
  'workspace entry names Windows cannot represent are rejected before touching the disk',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-win-names-'))
    t.after(async () => {
      await rm(workspace, { recursive: true, force: true })
    })

    await mkdir(path.join(workspace, 'src'), { recursive: true })
    await writeFile(path.join(workspace, 'src', 'existing.md'), 'keep\n', 'utf8')

    for (const [name, expected] of windowsInvalidEntryNames) {
      await assert.rejects(
        renameWorkspaceEntry({ workspacePath: workspace, relativePath: 'src/existing.md', nextName: name }),
        expected,
        `rename -> ${JSON.stringify(name)}`,
      )
      await assert.rejects(
        createWorkspaceFile({ workspacePath: workspace, parentRelativePath: 'src', name }),
        expected,
        `new file ${JSON.stringify(name)}`,
      )
      await assert.rejects(
        createWorkspaceDirectory({ workspacePath: workspace, parentRelativePath: 'src', name }),
        expected,
        `new folder ${JSON.stringify(name)}`,
      )
    }

    assert.deepEqual(await readdir(path.join(workspace, 'src')), ['existing.md'])
    assert.equal(await readFile(path.join(workspace, 'src', 'existing.md'), 'utf8'), 'keep\n')
    // "existing.md:evil" would otherwise land in a hidden NTFS alternate data stream.
    await assert.rejects(readFile(path.join(workspace, 'src', 'existing.md:evil'), 'utf8'), /ENOENT/)

    // Look-alikes that Windows does accept must keep working.
    for (const name of ['console.md', 'COM10.txt', 'nul-check.md', '.env', 'my file.txt']) {
      await createWorkspaceFile({ workspacePath: workspace, parentRelativePath: 'src', name })
    }
  },
)

test(
  'POSIX hosts keep accepting names that are only invalid on Windows',
  { skip: process.platform === 'win32' },
  async (t) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-posix-names-'))
    t.after(async () => {
      await rm(workspace, { recursive: true, force: true })
    })

    for (const name of ['a:b.md', 'CON', 'notes.']) {
      await createWorkspaceFile({ workspacePath: workspace, parentRelativePath: '', name })
    }
    assert.deepEqual((await readdir(workspace)).sort(), ['CON', 'a:b.md', 'notes.'])
  },
)

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
  assert.equal(result.mimeType, 'image/png')
  assert.equal(result.dataBase64, 'iVBORw0KGgoAAAAN')
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

// 2026-10-14：文件树里的条目已被外部删掉/挪走时，改名/移动/删除抛的是带绝对路径的原始
// "ENOENT: no such file or directory, stat '<workspace>'"；`if (!sourceStats)` 守卫是死代码，从没生效。
test('rename, move and delete report a vanished source as "Path not found." instead of a raw ENOENT', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-vanished-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await mkdir(path.join(workspace, 'docs'), { recursive: true })

  await assert.rejects(
    renameWorkspaceEntry({ workspacePath: workspace, relativePath: 'gone.md', nextName: 'still-gone.md' }),
    { message: 'Path not found.' },
  )
  await assert.rejects(
    moveWorkspaceEntry({ workspacePath: workspace, relativePath: 'gone.md', destinationParentRelativePath: 'docs' }),
    { message: 'Path not found.' },
  )
  await assert.rejects(
    deleteWorkspaceEntry({ workspacePath: workspace, relativePath: 'gone.md' }),
    { message: 'Path not found.' },
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
