import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveClaudeRuntimeEnvironment } from '../server/claude-runtime-environment.ts'

test('Windows Claude runtime auto-detects PortableGit bash from PATH entries', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-environment-'))

  try {
    const portableGitRoot = path.join(tempRoot, 'PortableGit')
    const binDir = path.join(portableGitRoot, 'bin')
    const cmdDir = path.join(portableGitRoot, 'cmd')
    const bashPath = path.join(binDir, 'bash.exe')
    const gitPath = path.join(cmdDir, 'git.exe')

    await mkdir(binDir, { recursive: true })
    await mkdir(cmdDir, { recursive: true })
    await writeFile(bashPath, '', 'utf8')
    await writeFile(gitPath, '', 'utf8')

    const runtimeEnv = await resolveClaudeRuntimeEnvironment({
      platform: 'win32',
      env: {
        PATH: [cmdDir, 'C:\\Windows\\System32'].join(path.delimiter),
      },
    })

    assert.equal(runtimeEnv.CLAUDE_CODE_GIT_BASH_PATH, bashPath)
    assert.equal(runtimeEnv.SHELL, bashPath)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
