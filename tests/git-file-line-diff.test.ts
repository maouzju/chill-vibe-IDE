import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  parseGitUnifiedZeroHunks,
  readGitFileLineDiff,
  readGitHeadFileState,
} from '../server/git-workspace.ts'

const tempRoots: string[] = []

const runGit = async (cwd: string, args: string[]) => {
  const { spawn } = await import('node:child_process')

  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(stderr.trim() || `git ${args.join(' ')} failed with code ${code}`))
    })
  })
}

const createTempRepo = async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'chill-vibe-git-line-diff-'))
  tempRoots.push(repoPath)

  await runGit(repoPath, ['init', '--initial-branch=main'])
  await runGit(repoPath, ['config', 'user.name', 'Chill Vibe Tests'])
  await runGit(repoPath, ['config', 'user.email', 'tests@example.com'])

  await writeFile(path.join(repoPath, 'tracked.txt'), 'line1\nline2\nline3\nline4\n')
  await runGit(repoPath, ['add', 'tracked.txt'])
  await runGit(repoPath, ['commit', '-m', 'Initial commit'])

  return repoPath
}

after(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('parseGitUnifiedZeroHunks', () => {
  it('classifies modified, added, and removed hunks from -U0 output', () => {
    const patch = [
      'diff --git a/tracked.txt b/tracked.txt',
      'index 1111111..2222222 100644',
      '--- a/tracked.txt',
      '+++ b/tracked.txt',
      '@@ -2 +2 @@',
      '-line2',
      '+line2 changed',
      '@@ -4,0 +5,2 @@',
      '+line5',
      '+line6',
      '@@ -7,2 +8,0 @@',
      '-line7',
      '-line8',
      '',
    ].join('\n')

    assert.deepEqual(parseGitUnifiedZeroHunks(patch), {
      added: [{ start: 5, end: 6 }],
      modified: [{ start: 2, end: 2 }],
      removed: [8],
    })
  })

  it('returns empty ranges for an empty diff', () => {
    assert.deepEqual(parseGitUnifiedZeroHunks(''), {
      added: [],
      modified: [],
      removed: [],
    })
  })
})

describe('readGitFileLineDiff', () => {
  it('reports modified line ranges for a tracked file with local edits', async () => {
    const repoPath = await createTempRepo()
    await writeFile(
      path.join(repoPath, 'tracked.txt'),
      'line1\nline2 changed\nline3\nline4\nline5\n',
    )

    const result = await readGitFileLineDiff({
      workspacePath: repoPath,
      relativePath: 'tracked.txt',
    })

    assert.equal(result.isRepository, true)
    assert.equal(result.tracked, true)
    assert.deepEqual(result.modified, [{ start: 2, end: 2 }])
    assert.deepEqual(result.added, [{ start: 5, end: 5 }])
    assert.deepEqual(result.removed, [])
  })

  it('marks untracked files instead of inventing ranges', async () => {
    const repoPath = await createTempRepo()
    await writeFile(path.join(repoPath, 'fresh.txt'), 'new file\n')

    const result = await readGitFileLineDiff({
      workspacePath: repoPath,
      relativePath: 'fresh.txt',
    })

    assert.equal(result.isRepository, true)
    assert.equal(result.tracked, false)
    assert.deepEqual(result.added, [])
  })

  it('reports non-repositories without failing', async () => {
    const plainDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-git-line-diff-plain-'))
    tempRoots.push(plainDir)
    await writeFile(path.join(plainDir, 'a.txt'), 'a\n')

    const result = await readGitFileLineDiff({
      workspacePath: plainDir,
      relativePath: 'a.txt',
    })

    assert.equal(result.isRepository, false)
    assert.equal(result.tracked, false)
  })
})

describe('readGitHeadFileState', () => {
  it('returns the HEAD content for a tracked file', async () => {
    const repoPath = await createTempRepo()
    await writeFile(path.join(repoPath, 'tracked.txt'), 'line1\nlocal change\n')

    const result = await readGitHeadFileState({
      workspacePath: repoPath,
      relativePath: 'tracked.txt',
    })

    assert.equal(result.isRepository, true)
    assert.equal(result.headContent, 'line1\nline2\nline3\nline4\n')
  })

  it('returns null head content for untracked files', async () => {
    const repoPath = await createTempRepo()
    await writeFile(path.join(repoPath, 'fresh.txt'), 'new\n')

    const result = await readGitHeadFileState({
      workspacePath: repoPath,
      relativePath: 'fresh.txt',
    })

    assert.equal(result.isRepository, true)
    assert.equal(result.headContent, null)
  })

  it('flags non-repositories', async () => {
    const plainDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-git-head-plain-'))
    tempRoots.push(plainDir)
    await writeFile(path.join(plainDir, 'a.txt'), 'a\n')

    const result = await readGitHeadFileState({
      workspacePath: plainDir,
      relativePath: 'a.txt',
    })

    assert.equal(result.isRepository, false)
    assert.equal(result.headContent, null)
  })
})
