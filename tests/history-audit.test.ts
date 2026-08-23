import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { auditGitHistory } from '../scripts/audit-git-history.mjs'

function runGit(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result
}

test('history audit scans reachable blobs without inspecting commit emails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'chill-vibe-history-audit-'))
  try {
    runGit(root, 'init', '--quiet')
    runGit(root, 'config', 'user.name', 'History Audit Fixture')
    runGit(root, 'config', 'user.email', 'fixture@example.invalid')
    await writeFile(path.join(root, 'safe.txt'), 'author@example.com\n', 'utf8')
    runGit(root, 'add', 'safe.txt')
    runGit(root, 'commit', '--quiet', '-m', 'safe baseline')

    const token = ['ghp_', '123456789012345678901234567890'].join('')
    const bearer = ['abcdefghijklmnop', 'qrstuvwx123456'].join('')
    const personalPath = ['C:/Users/', 'alice/AppData/Local/secret.txt'].join('')
    await writeFile(
      path.join(root, 'leak.txt'),
      personalPath + '\nAuthorization: Bearer ' + bearer + '\n' + token + '\n',
      'utf8',
    )
    runGit(root, 'add', 'leak.txt')
    runGit(root, 'commit', '--quiet', '-m', 'fixture with sensitive values')

    const report = await auditGitHistory({ repoRoot: root, timeoutMs: 10_000 })
    const categories = report.findings.map((finding) => finding.category)
    assert.ok(categories.includes('personal-path'))
    assert.ok(categories.includes('bearer-token'))
    assert.ok(!categories.includes('personal-email'))
    assert.ok(report.findings.every((finding) => !('match' in finding)))
    assert.ok(report.findings.every((finding) => !JSON.stringify(finding).includes(token)))
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
