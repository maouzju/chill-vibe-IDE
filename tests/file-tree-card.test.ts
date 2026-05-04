import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  applyRefreshedFileTreeDirectories,
  collectExpandedFileTreeDirectoryPaths,
} from '../src/components/file-tree-refresh.ts'

type TestTreeNode = {
  name: string
  path: string
  isDirectory: boolean
  children?: TestTreeNode[]
  loaded?: boolean
  expanded?: boolean
}

const directory = (
  path: string,
  children: TestTreeNode[] = [],
  options?: Partial<Pick<TestTreeNode, 'loaded' | 'expanded'>>,
): TestTreeNode => ({
  name: path.split('/').at(-1) ?? path,
  path,
  isDirectory: true,
  children,
  loaded: options?.loaded ?? true,
  expanded: options?.expanded ?? true,
})

const file = (path: string): TestTreeNode => ({
  name: path.split('/').at(-1) ?? path,
  path,
  isDirectory: false,
})

test('collectExpandedFileTreeDirectoryPaths walks nested expanded directories in depth order', () => {
  const nodes = [
    directory('src', [
      directory('src/components', [
        file('src/components/FileTreeCard.tsx'),
      ]),
      directory('src/hooks', [file('src/hooks/useThing.ts')], {
        expanded: false,
      }),
    ]),
    directory('docs', [file('docs/notes.md')], {
      expanded: false,
    }),
    file('README.md'),
  ]

  assert.deepEqual(collectExpandedFileTreeDirectoryPaths(nodes), ['src', 'src/components'])
})

test('applyRefreshedFileTreeDirectories updates nested expanded directories without dropping expansion state', () => {
  const currentNodes = [
    directory('src', [
      directory('src/components', [
        file('src/components/Old.tsx'),
      ]),
    ]),
    file('README.md'),
  ]

  const refreshedByPath = new Map<string, TestTreeNode[]>([
    ['', [
      directory('src', [], {
        loaded: false,
        expanded: false,
      }),
      file('README.md'),
    ]],
    ['src', [
      directory('src/components', [], {
        loaded: false,
        expanded: false,
      }),
      file('src/utils.ts'),
    ]],
    ['src/components', [
      file('src/components/FileTreeCard.tsx'),
      file('src/components/New.tsx'),
    ]],
  ])

  const nextNodes = applyRefreshedFileTreeDirectories(currentNodes, refreshedByPath)

  assert.deepEqual(nextNodes, [
    {
      name: 'src',
      path: 'src',
      isDirectory: true,
      loaded: true,
      expanded: true,
      children: [
        {
          name: 'components',
          path: 'src/components',
          isDirectory: true,
          loaded: true,
          expanded: true,
          children: [
            {
              name: 'FileTreeCard.tsx',
              path: 'src/components/FileTreeCard.tsx',
              isDirectory: false,
            },
            {
              name: 'New.tsx',
              path: 'src/components/New.tsx',
              isDirectory: false,
            },
          ],
        },
        {
          name: 'utils.ts',
          path: 'src/utils.ts',
          isDirectory: false,
        },
      ],
    },
    {
      name: 'README.md',
      path: 'README.md',
      isDirectory: false,
    },
  ])
})

test('file tree name actions avoid Electron unsupported native prompt dialogs', async () => {
  const source = await readFile(new URL('../src/components/FileTreeCard.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /window\.prompt\s*\(/)
  assert.match(source, /file-tree-name-dialog/)
})
