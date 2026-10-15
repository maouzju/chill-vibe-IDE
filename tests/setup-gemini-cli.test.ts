import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { summarizeEnvironmentChecks } from '../server/onboarding-status.ts'
import { setupRunRequestSchema } from '../shared/schema.ts'

// 2026-10-15：Gemini CLI 接入后，一键配置/更新 CLI 仍只认 Claude/Codex（docs/specs/gemini-cli-provider）。
// Gemini 是可选 provider：缺了它不能让「环境就绪」变红、不能触发引导弹窗。

const scriptPath = path.resolve(fileURLToPath(new URL('../scripts/setup-ai-cli.ps1', import.meta.url)))

describe('gemini in environment setup', () => {
  it('accepts gemini as an update-cli target', () => {
    assert.equal(setupRunRequestSchema.parse({ mode: 'update-cli', cli: 'gemini' }).cli, 'gemini')
  })

  it('reports a missing Gemini CLI without blocking environment readiness', () => {
    const status = summarizeEnvironmentChecks([
      { id: 'git', available: true },
      { id: 'node', available: true },
      { id: 'claude', available: true },
      { id: 'codex', available: true },
      { id: 'gemini', available: false },
    ])
    assert.equal(status.ready, true)
    const gemini = status.checks.find((check) => check.id === 'gemini')
    assert.deepEqual(gemini, { id: 'gemini', label: 'Gemini CLI', available: false, optional: true })

    const missingRequired = summarizeEnvironmentChecks([
      { id: 'git', available: true },
      { id: 'node', available: true },
      { id: 'claude', available: false },
      { id: 'codex', available: true },
      { id: 'gemini', available: true },
    ])
    assert.equal(missingRequired.ready, false)
  })

  it(
    'update-cli -Cli gemini installs @google/gemini-cli through npm',
    { skip: process.platform !== 'win32' },
    () => {
      const stubDir = mkdtempSync(path.join(tmpdir(), 'cv-setup-gemini-'))
      try {
        writeFileSync(
          path.join(stubDir, 'npm.cmd'),
          '@echo off\r\necho npm-argv: %*\r\necho changed 1 package in 2s\r\nexit /b 0\r\n',
          'utf8',
        )
        writeFileSync(path.join(stubDir, 'gemini.cmd'), '@echo off\r\necho 0.24.5\r\nexit /b 0\r\n', 'utf8')
        const result = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Mode', 'update-cli', '-Cli', 'gemini', '-Version', 'latest'],
          { encoding: 'utf8', env: { ...process.env, CHILL_VIBE_EXTRA_PATH: stubDir } },
        )
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
        assert.match(result.stdout, /npm-argv: install -g @google\/gemini-cli@latest/)
        assert.doesNotMatch(result.stdout, /claude-code|@openai\/codex/)
      } finally {
        rmSync(stubDir, { recursive: true, force: true })
      }
    },
  )
})
