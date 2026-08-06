import assert from 'node:assert/strict'
import test from 'node:test'

import {
  pickWorkspaceFileFallback,
  resolveExistingWorkspaceFilePath,
  type WorkspaceFileLookup,
} from '../src/components/workspace-file-fallback.ts'

type SearchEntry = { path: string; name: string; isDirectory: boolean }

const file = (path: string): SearchEntry => ({
  path,
  name: path.split('/').pop() ?? path,
  isDirectory: false,
})

const dir = (path: string): SearchEntry => ({
  path,
  name: path.split('/').pop() ?? path,
  isDirectory: true,
})

const createLookup = (options: {
  listing?: Record<string, { name: string; isDirectory: boolean }[]>
  search?: SearchEntry[]
  onList?: (relativeDir: string) => void
  onSearch?: (query: string) => void
}): WorkspaceFileLookup => ({
  listDirectory: async (relativeDir) => {
    options.onList?.(relativeDir)
    const entries = options.listing?.[relativeDir]

    if (!entries) {
      throw new Error('Path not found.')
    }

    return entries
  },
  searchFiles: async (query) => {
    options.onSearch?.(query)
    return options.search ?? []
  },
})

test('picks the only workspace file whose basename matches a bare file name', () => {
  const entries = [
    file('Assets/Scripts/Run/PlayerRunSystem.OverflowLoot.cs'),
    file('Assets/Scripts/Run/PlayerRunSystem.cs'),
    dir('Assets/Scripts/Run'),
  ]

  assert.equal(
    pickWorkspaceFileFallback('PlayerRunSystem.OverflowLoot.cs', entries),
    'Assets/Scripts/Run/PlayerRunSystem.OverflowLoot.cs',
  )
})

test('prefers a deeper suffix match over a shallower unrelated one', () => {
  const entries = [
    file('tools/state.ts'),
    file('packages/legacy/src/state.ts'),
  ]

  // `tools/state.ts` sits closer to the root, but only `.../src/state.ts` actually
  // matches the two trailing segments the model referenced.
  assert.equal(
    pickWorkspaceFileFallback('src/state.ts', entries),
    'packages/legacy/src/state.ts',
  )
  assert.equal(pickWorkspaceFileFallback('state.ts', entries), 'tools/state.ts')
})

test('falls back to the shallowest deterministic match when suffixes tie', () => {
  const entries = [
    file('b/deep/nested/notes.md'),
    file('a/notes.md'),
    file('b/notes.md'),
  ]

  assert.equal(pickWorkspaceFileFallback('notes.md', entries), 'a/notes.md')
})

test('ignores directories and unrelated basenames', () => {
  const entries = [
    dir('src/state.ts'),
    file('src/state.test.ts'),
    file('docs/other.md'),
  ]

  assert.equal(pickWorkspaceFileFallback('state.ts', entries), null)
  assert.equal(pickWorkspaceFileFallback('state.ts', []), null)
})

test('matches basenames case-insensitively and tolerates backslash references', () => {
  const entries = [file('Assets/Scripts/PlayerRunSystem.OverflowLoot.cs')]

  assert.equal(
    pickWorkspaceFileFallback('assets\\scripts\\playerrunsystem.overflowloot.cs', entries),
    'Assets/Scripts/PlayerRunSystem.OverflowLoot.cs',
  )
})

test('keeps the original path when the referenced file really exists', async () => {
  const searched: string[] = []
  const lookup = createLookup({
    listing: { 'src/components': [{ name: 'ChatCard.tsx', isDirectory: false }] },
    onSearch: (query) => searched.push(query),
  })

  assert.equal(
    await resolveExistingWorkspaceFilePath('src/components/ChatCard.tsx', lookup),
    'src/components/ChatCard.tsx',
  )
  assert.deepEqual(searched, [])
})

test('rewrites a bare file name to the real workspace path when it is missing at the root', async () => {
  const listed: string[] = []
  const searched: string[] = []
  const lookup = createLookup({
    listing: { '': [{ name: 'package.json', isDirectory: false }, { name: 'Assets', isDirectory: true }] },
    search: [file('Assets/Scripts/Run/PlayerRunSystem.OverflowLoot.cs')],
    onList: (relativeDir) => listed.push(relativeDir),
    onSearch: (query) => searched.push(query),
  })

  assert.equal(
    await resolveExistingWorkspaceFilePath('PlayerRunSystem.OverflowLoot.cs', lookup),
    'Assets/Scripts/Run/PlayerRunSystem.OverflowLoot.cs',
  )
  assert.deepEqual(listed, [''])
  assert.deepEqual(searched, ['PlayerRunSystem.OverflowLoot.cs'])
})

test('rewrites a stale relative path whose parent directory does not exist', async () => {
  const lookup = createLookup({
    search: [file('packages/app/src/state.ts')],
  })

  assert.equal(await resolveExistingWorkspaceFilePath('src/state.ts', lookup), 'packages/app/src/state.ts')
})

test('returns the original path when nothing in the workspace matches', async () => {
  const lookup = createLookup({ search: [] })

  assert.equal(await resolveExistingWorkspaceFilePath('src/ghost.ts', lookup), 'src/ghost.ts')
})

test('returns the original path when the lookup itself fails', async () => {
  const lookup: WorkspaceFileLookup = {
    listDirectory: async () => {
      throw new Error('bridge offline')
    },
    searchFiles: async () => {
      throw new Error('bridge offline')
    },
  }

  assert.equal(await resolveExistingWorkspaceFilePath('src/state.ts', lookup), 'src/state.ts')
})

test('gives up on a slow workspace search instead of blocking the click', async () => {
  const lookup: WorkspaceFileLookup = {
    listDirectory: async () => [],
    searchFiles: () => new Promise(() => {}),
  }

  assert.equal(
    await resolveExistingWorkspaceFilePath('PlayerRunSystem.OverflowLoot.cs', lookup, {
      searchTimeoutMs: 20,
    }),
    'PlayerRunSystem.OverflowLoot.cs',
  )
})

test('gives up on a slow directory probe instead of blocking the click', async () => {
  const lookup: WorkspaceFileLookup = {
    listDirectory: () => new Promise(() => {}),
    searchFiles: async () => [file('Assets/Scripts/Run/PlayerRunSystem.OverflowLoot.cs')],
  }

  assert.equal(
    await resolveExistingWorkspaceFilePath('PlayerRunSystem.OverflowLoot.cs', lookup, {
      searchTimeoutMs: 20,
    }),
    'Assets/Scripts/Run/PlayerRunSystem.OverflowLoot.cs',
  )
})

test('never probes absolute or out-of-workspace paths', async () => {
  let touched = false
  const lookup: WorkspaceFileLookup = {
    listDirectory: async () => {
      touched = true
      return []
    },
    searchFiles: async () => {
      touched = true
      return []
    },
  }

  assert.equal(await resolveExistingWorkspaceFilePath('D:/other/repo/state.ts', lookup), 'D:/other/repo/state.ts')
  assert.equal(await resolveExistingWorkspaceFilePath('/etc/hosts', lookup), '/etc/hosts')
  assert.equal(await resolveExistingWorkspaceFilePath('', lookup), '')
  assert.equal(touched, false)
})
