import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createGitPatchBlockIndex,
  decodeGitStreamChunks,
} from '../server/git-workspace.ts'
import type { GitChange } from '../shared/schema.ts'

/**
 * Byte-for-byte copy of the pre-2026-08-10 `findGitPatchBlock` (and the two
 * helpers it leaned on) as it existed at server/git-workspace.ts:921-941.
 *
 * It is kept here on purpose: the rewrite is a performance fix, so the only
 * thing that must be proven is that the fast path answers *exactly* the same
 * block for every shape of git path we can produce. If someone ever changes
 * the matching rules deliberately, this reference has to be updated in the
 * same commit — which is the point.
 */
const legacyDecodeGitStatusPath = (rawPath: string) => {
  const trimmedPath = rawPath.trim()

  if (!trimmedPath.startsWith('"') || !trimmedPath.endsWith('"')) {
    return trimmedPath
  }

  try {
    const decoded = JSON.parse(trimmedPath) as unknown
    return typeof decoded === 'string' ? decoded : trimmedPath
  } catch {
    return trimmedPath.slice(1, -1)
  }
}

const legacyNormalizeGitDiffPath = (rawPath: string) => {
  const withoutTimestamp = rawPath.split('\t', 1)[0] ?? rawPath
  if (withoutTimestamp === '/dev/null') {
    return null
  }

  const decoded = legacyDecodeGitStatusPath(withoutTimestamp)
  return decoded.replace(/^[ab]\//, '')
}

const legacyFindGitPatchBlock = (blocks: string[], change: GitChange) => {
  const expectedOldPath = change.kind === 'added'
    ? null
    : (change.originalPath ?? change.path).replace(/\\/g, '/')
  const expectedNewPath = change.kind === 'deleted'
    ? null
    : change.path.replace(/\\/g, '/')
  const expectedHeader = `diff --git a/${change.originalPath ?? change.path} b/${change.path}`

  return blocks.find((block) => {
    const lines = block.split('\n')
    const oldMarker = lines.find((line) => line.startsWith('--- '))
    const newMarker = lines.find((line) => line.startsWith('+++ '))

    if (oldMarker && newMarker) {
      return legacyNormalizeGitDiffPath(oldMarker.slice(4)) === expectedOldPath &&
        legacyNormalizeGitDiffPath(newMarker.slice(4)) === expectedNewPath
    }

    return lines[0] === expectedHeader
  }) ?? ''
}

const createChange = (overrides: Partial<GitChange> & Pick<GitChange, 'path'>): GitChange => ({
  kind: 'modified',
  stagedStatus: ' ',
  workingTreeStatus: 'M',
  staged: false,
  conflicted: false,
  ...overrides,
})

const modifiedBlock = (oldPath: string, newPath: string, headerOld = oldPath, headerNew = newPath) => [
  `diff --git a/${headerOld} b/${headerNew}`,
  'index 1111111..2222222 100644',
  `--- a/${oldPath}`,
  `+++ b/${newPath}`,
  '@@ -1,2 +1,2 @@',
  '-old line',
  '+new line',
  ' context',
].join('\n')

const addedBlock = (newPath: string) => [
  `diff --git a/${newPath} b/${newPath}`,
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  `+++ b/${newPath}`,
  '@@ -0,0 +1 @@',
  '+hello',
].join('\n')

const deletedBlock = (oldPath: string) => [
  `diff --git a/${oldPath} b/${oldPath}`,
  'deleted file mode 100644',
  'index 3333333..0000000',
  `--- a/${oldPath}`,
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-hello',
].join('\n')

// A mode-only change carries no `---` / `+++` markers, so the legacy matcher
// fell through to comparing the raw `diff --git` header line verbatim.
const modeOnlyBlock = (targetPath: string) => [
  `diff --git a/${targetPath} b/${targetPath}`,
  'old mode 100644',
  'new mode 100755',
].join('\n')

const binaryBlock = (targetPath: string) => [
  `diff --git a/${targetPath} b/${targetPath}`,
  'index 4444444..5555555 100644',
  `Binary files a/${targetPath} and b/${targetPath} differ`,
].join('\n')

describe('createGitPatchBlockIndex', () => {
  it('matches the legacy linear scan for every git path shape', () => {
    const blocks = [
      modifiedBlock('src/plain.ts', 'src/plain.ts'),
      modifiedBlock('docs/my notes.md', 'docs/my notes.md'),
      modifiedBlock('src/文档/说明.md', 'src/文档/说明.md'),
      modifiedBlock('src/old-name.ts', 'src/new-name.ts'),
      modifiedBlock('src/Case.ts', 'src/Case.ts'),
      modifiedBlock('src/case.ts', 'src/case.ts'),
      addedBlock('src/brand-new.ts'),
      deletedBlock('src/gone.ts'),
      modeOnlyBlock('scripts/run.sh'),
      binaryBlock('build/icon.png'),
      // Git still quotes paths containing a literal tab or quote even with
      // core.quotepath=false, so the JSON-unescape path has to keep working.
      [
        'diff --git "a/src/tab\\there.ts" "b/src/tab\\there.ts"',
        'index 6666666..7777777 100644',
        '--- "a/src/tab\\there.ts"',
        '+++ "b/src/tab\\there.ts"',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ].join('\n'),
      // `git diff` can emit a trailing timestamp after a tab on the markers.
      [
        'diff --git a/src/stamped.ts b/src/stamped.ts',
        'index 8888888..9999999 100644',
        '--- a/src/stamped.ts\t2026-08-10 10:00:00.000000000 +0800',
        '+++ b/src/stamped.ts\t2026-08-10 10:00:01.000000000 +0800',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ].join('\n'),
    ]

    const changes: GitChange[] = [
      createChange({ path: 'src/plain.ts' }),
      createChange({ path: 'docs/my notes.md' }),
      createChange({ path: 'src/文档/说明.md' }),
      createChange({
        path: 'src/new-name.ts',
        originalPath: 'src/old-name.ts',
        kind: 'renamed',
        stagedStatus: 'R',
      }),
      createChange({ path: 'src/Case.ts' }),
      createChange({ path: 'src/case.ts' }),
      createChange({ path: 'src/brand-new.ts', kind: 'added', stagedStatus: 'A' }),
      createChange({ path: 'src/gone.ts', kind: 'deleted', workingTreeStatus: 'D' }),
      createChange({ path: 'scripts/run.sh' }),
      createChange({ path: 'build/icon.png' }),
      createChange({ path: 'src/tab\there.ts' }),
      createChange({ path: 'src/stamped.ts' }),
      // Windows-style separators must normalize to `/` before matching.
      createChange({ path: 'src\\plain.ts' }),
      createChange({ path: 'src\\new-name.ts', originalPath: 'src\\old-name.ts', kind: 'renamed' }),
      // Nothing in the batch describes these.
      createChange({ path: 'src/absent.ts' }),
      createChange({ path: 'src/plain.ts', kind: 'added' }),
      createChange({ path: 'src/plain.ts', kind: 'deleted' }),
      createChange({ path: 'src/brand-new.ts' }),
      createChange({ path: 'src/gone.ts' }),
    ]

    const index = createGitPatchBlockIndex(blocks)

    for (const change of changes) {
      assert.equal(
        index.find(change),
        legacyFindGitPatchBlock(blocks, change),
        `mismatch for ${change.kind} ${change.originalPath ?? ''} -> ${change.path}`,
      )
    }
  })

  it('keeps the first block when two blocks claim the same path, like Array#find did', () => {
    const first = modifiedBlock('src/dup.ts', 'src/dup.ts')
    const second = `${modifiedBlock('src/dup.ts', 'src/dup.ts')}\n+extra`
    const blocks = [first, second]
    const change = createChange({ path: 'src/dup.ts' })

    assert.equal(createGitPatchBlockIndex(blocks).find(change), first)
    assert.equal(createGitPatchBlockIndex(blocks).find(change), legacyFindGitPatchBlock(blocks, change))
  })

  it('prefers the earlier block when a header-only match precedes a marker match', () => {
    const headerOnly = modeOnlyBlock('src/both.ts')
    const withMarkers = modifiedBlock('src/both.ts', 'src/both.ts')
    const blocks = [headerOnly, withMarkers]
    const change = createChange({ path: 'src/both.ts' })

    assert.equal(createGitPatchBlockIndex(blocks).find(change), legacyFindGitPatchBlock(blocks, change))
    assert.equal(createGitPatchBlockIndex(blocks).find(change), headerOnly)
  })

  it('returns an empty string for an empty block list', () => {
    const change = createChange({ path: 'src/plain.ts' })
    assert.equal(createGitPatchBlockIndex([]).find(change), '')
  })

  /**
   * The N² guard. The old matcher re-walked (and re-split) every block for
   * every change, so N changes over N blocks cost N² whole-block splits —
   * 60 changed files already meant ~3600 full splits on the Electron main
   * thread. The index must read each block exactly once, no matter how many
   * lookups follow.
   */
  it('touches each block once regardless of how many changes are looked up', () => {
    const size = 200
    const blocks = Array.from({ length: size }, (_, i) =>
      modifiedBlock(`src/file-${i}.ts`, `src/file-${i}.ts`))
    const changes = Array.from({ length: size }, (_, i) =>
      createChange({ path: `src/file-${i}.ts` }))

    let elementReads = 0
    const trackedBlocks = new Proxy(blocks, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          elementReads += 1
        }
        return Reflect.get(target, property, receiver)
      },
    })

    const index = createGitPatchBlockIndex(trackedBlocks)
    const readsAfterBuild = elementReads

    for (const change of changes) {
      assert.equal(index.find(change), blocks[changes.indexOf(change)])
    }

    assert.ok(
      readsAfterBuild <= size,
      `index build read ${readsAfterBuild} elements for ${size} blocks`,
    )
    assert.equal(
      elementReads,
      readsAfterBuild,
      'lookups must not walk the block array again',
    )

    let legacyReads = 0
    const legacyTracked = new Proxy(blocks, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          legacyReads += 1
        }
        return Reflect.get(target, property, receiver)
      },
    })
    for (const change of changes) {
      legacyFindGitPatchBlock(legacyTracked, change)
    }

    assert.ok(
      legacyReads > readsAfterBuild * 10,
      `sanity: the legacy scan should be quadratic (saw ${legacyReads} reads)`,
    )
  })
})

describe('decodeGitStreamChunks', () => {
  it('joins chunks without corrupting a multi-byte character split across them', () => {
    const text = 'abc中文def🙂ghi'
    const full = Buffer.from(text, 'utf8')

    for (let cut = 1; cut < full.length; cut += 1) {
      const chunks = [full.subarray(0, cut), full.subarray(cut)]
      assert.equal(
        decodeGitStreamChunks(chunks),
        text,
        `chunk boundary at byte ${cut} corrupted the decoded output`,
      )
    }
  })

  it('handles zero and single chunk inputs', () => {
    assert.equal(decodeGitStreamChunks([]), '')
    assert.equal(decodeGitStreamChunks([Buffer.from('solo', 'utf8')]), 'solo')
  })

  it('preserves NUL separators used by porcelain/ls-tree output', () => {
    const chunks = [Buffer.from('a\0b', 'utf8'), Buffer.from('\0c\0', 'utf8')]
    assert.equal(decodeGitStreamChunks(chunks), 'a\0b\0c\0')
  })
})
