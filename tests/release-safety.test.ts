import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createReleaseLogRedactor, auditReleaseCandidate } from '../scripts/audit-release-safety.mjs'

import {
  auditReleaseText,
  auditReleasePath,
  createReleaseSafetyFinding,
  redactReleaseLogText,
} from '../scripts/audit-release-safety.mjs'

test('release safety audit catches credential-shaped values without returning them', () => {
  const githubToken = ['ghp_', '123456789012345678901234567890'].join('')
  const privateKeyHeader = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('')
  const findings = auditReleaseText(
    'tests/example.ts',
    `Authorization: Bearer ${githubToken}\n${privateKeyHeader}`,
  )

  assert.deepEqual(findings.map(({ category, path }) => ({ category, path })), [
    { category: 'github-token', path: 'tests/example.ts' },
    { category: 'private-key', path: 'tests/example.ts' },
  ])
  assert.ok(findings.every((finding) => !('match' in finding)))
})

test('release safety audit catches provider and JWT token shapes', () => {
  const anthropic = ['sk-ant-', '123456789012345678901234'].join('')
  const jwt = ['eyJ', 'aaaaaaaaaa', '.', 'bbbbbbbbbb', '.', 'cccccccccc'].join('')
  const findings = auditReleaseText('docs/release-notes.md', `key=${anthropic}\n${jwt}`)
  assert.deepEqual(findings.map(({ category }) => category), ['anthropic-token', 'jwt'])
})

test('release safety audit catches generic bearer values', () => {
  const bearer = ['abcdefghijklmnop', 'qrstuvwx123456'].join('')
  const findings = auditReleaseText('docs/release.md', `Authorization: Bearer ${bearer}`)
  assert.deepEqual(findings.map(({ category }) => category), ['bearer-token'])
})

test('release safety audit allows zero-value test bearer placeholders', () => {
  assert.deepEqual(
    auditReleaseText(
      'tests/automation-board-mcp.test.ts',
      'Authorization: Bearer 00000000000000000000000000000000',
    ),
    [],
  )
})

test('release safety audit flags newly introduced personal and external paths', () => {
  const personalPath = ['C:/Users/', 'alice/.claude/projects/secret'].join('')
  const externalPath = ['D:/Git/', 'other-private-project/file.ts'].join('')
  const findings = auditReleaseText(
    'scripts/bench.ts',
    `${personalPath}\n${externalPath}`,
    { baselineText: '' },
  )

  assert.deepEqual(findings.map(({ category }) => category), [
    'personal-path',
    'external-project-path',
  ])
})

test('release safety audit ignores non-concrete path examples', () => {
  assert.deepEqual(
    auditReleaseText(
      'docs/release.md',
      'C:\\Users\\...\\AppData\\Local\\Temp\\x.log\nD:\\Git\\...\\src\\index.ts\nD:\\Git\\<project>\\src\\index.ts',
      { baselineText: '' },
    ),
    [],
  )
})

test('release safety audit treats single-segment drive paths in tests as synthetic fixtures', () => {
  // `D:/workspace` is this repo's long-standing synthetic workspace root (68
  // uses across 8 baseline test files).  Before this rule only *existing*
  // files got a pass, via the unchanged-baseline check — so the identical
  // fixture reported clean in an old file and `machine-path` in a new one,
  // which pushes authors to rewrite correct tests instead of the detector.
  assert.deepEqual(
    auditReleaseText(
      'tests/state-store-crash-recovery.test.ts',
      "createDefaultState('D:/workspace')\nwithMessages('D:/newer-snapshot')\nwithMessages('D:/quarantine')",
      { baselineText: '' },
    ),
    [],
  )
})

test('release safety audit keeps flagging real drive paths outside tests or with extra segments', () => {
  // Guard the rule above against over-reach: it must stay scoped to tests/,
  // stay single-segment, and never swallow a real user directory.
  const productionFile = auditReleaseText('scripts/bench.mjs', "open('D:/workspace')", {
    baselineText: '',
  })
  assert.deepEqual(productionFile.map(({ category }) => category), ['machine-path'])

  const nestedRealPath = auditReleaseText(
    'tests/example.test.ts',
    ['D:/', '下载/Chill Vibe IDE/resources/app.asar'].join(''),
    { baselineText: '' },
  )
  assert.deepEqual(nestedRealPath.map(({ category }) => category), ['machine-path'])

  const rescueDir = auditReleaseText(
    'tests/example.test.ts',
    ['D:/', 'chill-vibe-rescue-20260825/restore-watcher.ps1'].join(''),
    { baselineText: '' },
  )
  assert.deepEqual(rescueDir.map(({ category }) => category), ['machine-path'])
})

test('release safety audit ignores personal email addresses', () => {
  assert.deepEqual(auditReleaseText('release.txt', 'author@example.com <author@example.com>'), [])
})

test('release safety audit flags debug artifacts by path', () => {
  const finding = createReleaseSafetyFinding('.codex-artifacts/run.json', 'debug-artifact')
  assert.deepEqual(finding, { category: 'debug-artifact', path: '.codex-artifacts/run.json' })
})

test('release safety audit allows the existing synthetic Claude fixture only', () => {
  const fixture = auditReleasePath(
    'tests/fixtures/claude-unsolicited-real-wake.jsonl',
    '{"apiKeySource":"none","origin":{"kind":"test-fixture"}}',
  )
  assert.deepEqual(fixture, [])
  assert.equal(auditReleasePath('tests/fixtures/new-session.jsonl', '{}')[0]?.category, 'debug-artifact')
})

test('release log redaction never exposes secrets or absolute workspace paths', () => {
  const githubToken = ['ghp_', '123456789012345678901234567890'].join('')
  const repoRoot = ['D:/Git/', 'chill-vibe'].join('')
  const homePath = ['C:/Users/', 'alice/secret.txt'].join('')
  const redacted = redactReleaseLogText(
    `token=${githubToken} cwd=${repoRoot} file=${homePath}`,
    { repoRoot },
  )

  assert.ok(!redacted.includes(githubToken))
  assert.ok(!redacted.includes(repoRoot))
  assert.ok(!redacted.includes(['C:/Users/', 'alice'].join('')))
  assert.match(redacted, /<redacted-(?:credential|path)>/)
})

test('streaming release redaction handles credentials split across chunks', () => {
  const prefix = ['ghp_', '123456789012345678901234567890'].join('')
  const redactor = createReleaseLogRedactor({ repoRoot: 'D:/Git/chill-vibe' })
  const first = redactor.push(`begin ${prefix.slice(0, 9)}`)
  const second = redactor.push(`${prefix.slice(9)} end`)
  const tail = redactor.flush()
  const output = first + second + tail
  assert.ok(!output.includes(prefix))
  assert.match(output, /<redacted-credential>/)
})

test('candidate audit fails closed when the base ref cannot be resolved', async () => {
  await assert.rejects(
    auditReleaseCandidate({ repoRoot: process.cwd(), base: 'refs/heads/does-not-exist' }),
    /git .*failed \(exit /u,
  )
})

test('candidate audit scans staged content even when the worktree copy matches the base', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'release-safety-staged-'))
  const runGit = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  try {
    runGit('init', '--quiet')
    runGit('config', 'user.name', 'Release Safety Test')
    runGit('config', 'user.email', 'fixture@example.invalid')
    await writeFile(path.join(root, 'candidate.txt'), 'safe\n', 'utf8')
    runGit('add', 'candidate.txt')
    runGit('commit', '--quiet', '-m', 'base')

    const token = ['ghp_', '123456789012345678901234567890'].join('')
    await writeFile(path.join(root, 'candidate.txt'), `${token}\n`, 'utf8')
    runGit('add', 'candidate.txt')
    await writeFile(path.join(root, 'candidate.txt'), 'safe\n', 'utf8')

    const findings = await auditReleaseCandidate({ repoRoot: root, base: 'HEAD' })
    assert.deepEqual(findings.map(({ category, path: findingPath }) => ({ category, path: findingPath })), [
      { category: 'github-token', path: 'candidate.txt' },
    ])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
