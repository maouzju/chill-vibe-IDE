import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  captureWorkspaceSnapshot,
  commitGitWorkspace,
  diffWorkspaceSnapshot,
  initGitWorkspace,
  inspectGitWorkspace,
  setGitWorkspaceStage,
} from '../server/git-workspace.ts'
import { gitStatusSchema } from '../shared/schema.ts'

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
  const repoPath = await mkdtemp(path.join(tmpdir(), 'chill-vibe-git-tool-'))
  tempRoots.push(repoPath)

  await runGit(repoPath, ['init', '--initial-branch=main'])
  await runGit(repoPath, ['config', 'user.name', 'Chill Vibe Tests'])
  await runGit(repoPath, ['config', 'user.email', 'tests@example.com'])

  await writeFile(path.join(repoPath, 'tracked.txt'), 'base\n')
  await runGit(repoPath, ['add', 'tracked.txt'])
  await runGit(repoPath, ['commit', '-m', 'Initial commit'])

  return repoPath
}

after(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('git workspace helpers', () => {
  it('initializes a Git repository when the workspace is not one yet', async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), 'chill-vibe-git-init-'))
    tempRoots.push(workspacePath)
    await writeFile(path.join(workspacePath, 'README.md'), '# Hello\n')

    const beforeInit = await inspectGitWorkspace(workspacePath)
    assert.equal(beforeInit.isRepository, false)

    const initResult = await initGitWorkspace(workspacePath)

    assert.equal(initResult.status.isRepository, true)
    assert.equal(initResult.status.repoRoot, workspacePath)
    assert.ok(initResult.status.branch.length > 0)
    assert.equal(initResult.status.clean, false)
    assert.equal(initResult.status.summary.untracked, 1)
  })

  it('reports changed files and commits a selected subset', async () => {
    const repoPath = await createTempRepo()
    await writeFile(path.join(repoPath, 'tracked.txt'), 'base\nwith change\n')
    await writeFile(path.join(repoPath, 'notes.md'), 'draft note\n')

    const initial = await inspectGitWorkspace(repoPath)

    assert.equal(initial.repoRoot, repoPath)
    assert.equal(initial.branch, 'main')
    assert.equal(initial.summary.unstaged, 1)
    assert.equal(initial.summary.untracked, 1)
    assert.equal(initial.summary.conflicted, 0)
    assert.deepEqual(
      initial.changes.map((change) => [change.path, change.kind]),
      [
        ['notes.md', 'untracked'],
        ['tracked.txt', 'modified'],
      ],
    )

    const commitResult = await commitGitWorkspace({
      workspacePath: repoPath,
      paths: ['tracked.txt'],
      summary: 'Update tracked file',
      description: 'Keep notes out of this commit.',
    })

    assert.equal(commitResult.commit.summary, 'Update tracked file')
    assert.equal(commitResult.commit.description, 'Keep notes out of this commit.')
    assert.match(commitResult.commit.hash, /^[0-9a-f]{7,40}$/)

    const afterCommit = await inspectGitWorkspace(repoPath)
    assert.equal(afterCommit.summary.unstaged, 0)
    assert.equal(afterCommit.summary.untracked, 1)
    assert.deepEqual(
      afterCommit.changes.map((change) => [change.path, change.kind]),
      [['notes.md', 'untracked']],
    )
    assert.equal(afterCommit.lastCommit?.summary, 'Update tracked file')
  })

  it('commits only the requested paths while leaving unrelated staged files checked', async () => {
    const repoPath = await createTempRepo()
    await writeFile(path.join(repoPath, 'second.txt'), 'base\n')
    await runGit(repoPath, ['add', 'second.txt'])
    await runGit(repoPath, ['commit', '-m', 'Add second tracked file'])

    await writeFile(path.join(repoPath, 'tracked.txt'), 'base\nfresh tracked change\n')
    await writeFile(path.join(repoPath, 'second.txt'), 'base\nolder staged change\n')
    await runGit(repoPath, ['add', 'tracked.txt', 'second.txt'])

    const commitResult = await commitGitWorkspace({
      workspacePath: repoPath,
      paths: ['tracked.txt'],
      summary: 'Commit only the new file',
      description: '',
    })

    assert.equal(commitResult.commit.summary, 'Commit only the new file')

    const afterCommit = await inspectGitWorkspace(repoPath)
    assert.deepEqual(
      afterCommit.changes.map((change) => [change.path, change.staged]),
      [['second.txt', true]],
    )
    assert.equal(afterCommit.summary.staged, 1)
    assert.equal(afterCommit.summary.unstaged, 0)
    assert.equal(afterCommit.lastCommit?.summary, 'Commit only the new file')
  })

  it('drops staged additions that were deleted from the workspace before committing the remaining selected files', async () => {
    const repoPath = await createTempRepo()
    const removedFolderPath = path.join(repoPath, 'draft-skill')
    await mkdir(removedFolderPath, { recursive: true })
    await writeFile(path.join(removedFolderPath, 'INDEX.md'), '# Draft\n')
    await writeFile(path.join(repoPath, 'keep.txt'), 'keep me\n')
    await runGit(repoPath, ['add', 'draft-skill/INDEX.md', 'keep.txt'])
    await rm(removedFolderPath, { recursive: true, force: true })

    const beforeCommit = await inspectGitWorkspace(repoPath)
    assert.deepEqual(
      beforeCommit.changes.map((change) => [change.path, change.stagedStatus, change.workingTreeStatus]),
      [
        ['draft-skill/INDEX.md', 'A', 'D'],
        ['keep.txt', 'A', ' '],
      ],
    )

    const commitResult = await commitGitWorkspace({
      workspacePath: repoPath,
      paths: ['draft-skill/INDEX.md', 'keep.txt'],
      summary: 'Keep the surviving file only',
      description: '',
    })

    assert.equal(commitResult.commit.summary, 'Keep the surviving file only')

    const afterCommit = await inspectGitWorkspace(repoPath)
    assert.equal(afterCommit.clean, true)
    assert.equal(afterCommit.changes.length, 0)
    assert.equal(afterCommit.lastCommit?.summary, 'Keep the surviving file only')
  })

  it('includes preview patches for changed files in git status', async () => {
    const repoPath = await createTempRepo()
    await writeFile(path.join(repoPath, 'tracked.txt'), 'base\nwith change\n')

    const status = await inspectGitWorkspace(repoPath)
    const modifiedChange = status.changes.find((change) => change.path === 'tracked.txt') as
      | (typeof status.changes)[number] & {
          patch?: string
          addedLines?: number
          removedLines?: number
        }
      | undefined

    assert.ok(modifiedChange)
    assert.match(modifiedChange.patch ?? '', /\+with change/)
    assert.equal(modifiedChange.addedLines, 1)
    assert.equal(modifiedChange.removedLines, 0)
  })

  it('can skip preview patches when only change metadata is needed', async () => {
    const repoPath = await createTempRepo()
    await writeFile(path.join(repoPath, 'tracked.txt'), 'base\nwith change\n')

    const status = await inspectGitWorkspace(
      repoPath,
      { includeChangePreviews: false },
    )
    const modifiedChange = status.changes.find((change) => change.path === 'tracked.txt') as
      | (typeof status.changes)[number] & {
          patch?: string
          addedLines?: number
          removedLines?: number
        }
      | undefined

    assert.ok(modifiedChange)
    assert.equal(modifiedChange.patch, undefined)
    assert.equal(modifiedChange.addedLines, undefined)
    assert.equal(modifiedChange.removedLines, undefined)
  })

  it('can skip repository details as well as preview patches for faster first paint', async () => {
    const repoPath = await createTempRepo()
    await writeFile(path.join(repoPath, 'tracked.txt'), 'base\nwith change\n')

    const status = await inspectGitWorkspace(
      repoPath,
      { includeChangePreviews: false, includeRepositoryDetails: false },
    )
    const modifiedChange = status.changes.find((change) => change.path === 'tracked.txt') as
      | (typeof status.changes)[number] & {
          patch?: string
          addedLines?: number
          removedLines?: number
        }
      | undefined

    assert.ok(modifiedChange)
    assert.equal(modifiedChange.patch, undefined)
    assert.equal(modifiedChange.addedLines, undefined)
    assert.equal(modifiedChange.removedLines, undefined)
    assert.equal(status.lastCommit, undefined)
    assert.equal(status.description, '')
  })

  it('omits preview patches for oversized changed files to keep git status safe to render', async () => {
    const repoPath = await createTempRepo()
    await writeFile(path.join(repoPath, 'tracked.txt'), `${'large line\n'.repeat(70000)}tail\n`)

    const status = await inspectGitWorkspace(repoPath)
    const modifiedChange = status.changes.find((change) => change.path === 'tracked.txt') as
      | (typeof status.changes)[number] & {
          patch?: string
          addedLines?: number
          removedLines?: number
        }
      | undefined

    assert.ok(modifiedChange)
    assert.equal(modifiedChange.patch, '')
    assert.equal(modifiedChange.addedLines, undefined)
    assert.equal(modifiedChange.removedLines, undefined)
  })

  it('captures only the edits introduced after a workspace snapshot', async () => {
    const repoPath = await createTempRepo()

    await writeFile(path.join(repoPath, 'tracked.txt'), 'base\nexisting dirty line\n')

    const snapshot = await captureWorkspaceSnapshot(repoPath)

    await writeFile(path.join(repoPath, 'tracked.txt'), 'base\nexisting dirty line\nagent line\n')
    await writeFile(path.join(repoPath, 'new-file.ts'), 'export const value = 1\n')

    const diff = await diffWorkspaceSnapshot(snapshot, repoPath)

    assert.equal(diff.files.length, 2)
    assert.deepEqual(
      diff.files.map((file) => [file.path, file.addedLines, file.removedLines]),
      [
        ['new-file.ts', 1, 0],
        ['tracked.txt', 1, 0],
      ],
    )
    assert.match(diff.files[0]?.patch ?? '', /export const value = 1/)
    assert.match(diff.files[1]?.patch ?? '', /\+agent line/)
    assert.doesNotMatch(diff.files[1]?.patch ?? '', /existing dirty line\n\+existing dirty line/)
  })

  it('excludes external file changes when touchedPaths is provided', async () => {
    const repoPath = await createTempRepo()

    await writeFile(path.join(repoPath, 'tracked.txt'), 'base\nexisting dirty line\n')

    const snapshot = await captureWorkspaceSnapshot(repoPath)

    // AI edits tracked.txt
    await writeFile(path.join(repoPath, 'tracked.txt'), 'base\nexisting dirty line\nagent line\n')
    // External process creates an unrelated file
    await writeFile(path.join(repoPath, 'external-file.ts'), 'unrelated change\n')

    const diff = await diffWorkspaceSnapshot(snapshot, repoPath, new Set(['tracked.txt']))

    assert.equal(diff.files.length, 1, 'should only include AI-touched file, not external file')
    assert.equal(diff.files[0]?.path, 'tracked.txt')
    assert.match(diff.files[0]?.patch ?? '', /\+agent line/)
  })

  it('returns last commit timestamps accepted by the shared Git status schema', async () => {
    const repoPath = await createTempRepo()

    const status = await inspectGitWorkspace(repoPath)

    assert.ok(status.lastCommit)
    assert.doesNotThrow(() => {
      gitStatusSchema.parse(status)
    })
  })

  it('keeps staged checkboxes in sync with git index state until explicitly toggled again', async () => {
    const repoPath = await createTempRepo()
    await writeFile(path.join(repoPath, 'tracked.txt'), 'base\nwith change\n')

    const initial = await inspectGitWorkspace(repoPath)
    assert.equal(initial.changes[0]?.path, 'tracked.txt')
    assert.equal(initial.changes[0]?.staged, false)
    assert.equal(initial.summary.staged, 0)
    assert.equal(initial.summary.unstaged, 1)

    const staged = await setGitWorkspaceStage({
      workspacePath: repoPath,
      paths: ['tracked.txt'],
      staged: true,
    })
    assert.equal(staged.changes[0]?.staged, true)
    assert.equal(staged.summary.staged, 1)
    assert.equal(staged.summary.unstaged, 0)
    assert.equal(staged.changes[0]?.patch, undefined)
    assert.equal(staged.changes[0]?.addedLines, undefined)
    assert.equal(staged.changes[0]?.removedLines, undefined)

    const reloadedStaged = await inspectGitWorkspace(repoPath)
    assert.equal(reloadedStaged.changes[0]?.staged, true)
    assert.equal(reloadedStaged.summary.staged, 1)
    assert.match(reloadedStaged.changes[0]?.patch ?? '', /\+with change/)

    const unstaged = await setGitWorkspaceStage({
      workspacePath: repoPath,
      paths: ['tracked.txt'],
      staged: false,
    })
    assert.equal(unstaged.changes[0]?.staged, false)
    assert.equal(unstaged.summary.staged, 0)
    assert.equal(unstaged.summary.unstaged, 1)
    assert.equal(unstaged.changes[0]?.patch, undefined)
    assert.equal(unstaged.changes[0]?.addedLines, undefined)
    assert.equal(unstaged.changes[0]?.removedLines, undefined)

    const reloadedUnstaged = await inspectGitWorkspace(repoPath)
    assert.equal(reloadedUnstaged.changes[0]?.staged, false)
    assert.equal(reloadedUnstaged.summary.staged, 0)
    assert.equal(reloadedUnstaged.summary.unstaged, 1)

    const restaged = await setGitWorkspaceStage({
      workspacePath: repoPath,
      paths: ['tracked.txt'],
      staged: true,
    })
    assert.equal(restaged.changes[0]?.staged, true)
    assert.equal(restaged.summary.staged, 1)
    assert.equal(restaged.summary.unstaged, 0)
  })

  it('stages and commits files whose names contain non-ASCII (Chinese) characters', async () => {
    const repoPath = await createTempRepo()
    const chineseName = '大学笔记.md'
    await writeFile(path.join(repoPath, chineseName), '中文内容\n')

    const initial = await inspectGitWorkspace(repoPath)
    const change = initial.changes.find((entry) => entry.path === chineseName)
    assert.ok(change, `expected a change entry for ${chineseName}, got ${JSON.stringify(initial.changes)}`)

    const staged = await setGitWorkspaceStage({
      workspacePath: repoPath,
      paths: [chineseName],
      staged: true,
    })
    const stagedChange = staged.changes.find((entry) => entry.path === chineseName)
    assert.equal(stagedChange?.staged, true)

    const commitResult = await commitGitWorkspace({
      workspacePath: repoPath,
      paths: [chineseName],
      summary: '新增中文文件',
      description: '',
    })
    assert.equal(commitResult.commit.summary, '新增中文文件')

    const afterCommit = await inspectGitWorkspace(repoPath)
    assert.equal(afterCommit.clean, true)
    assert.equal(afterCommit.changes.length, 0)
  })
})
