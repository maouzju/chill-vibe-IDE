import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveWhitenoiseCliCwd } from '../server/whitenoise/whitenoise-generator.ts'

test('white-noise CLI uses the configured default workspace when it exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'chill-vibe-whitenoise-'))
  const workspaceDir = path.join(root, 'workspace')
  const appDataDir = path.join(root, 'app-data')

  try {
    await mkdir(workspaceDir, { recursive: true })
    const resolved = await resolveWhitenoiseCliCwd({
      defaultWorkspacePath: workspaceDir,
      appDataDir,
    })

    assert.equal(resolved, workspaceDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('white-noise CLI falls back to the app data dir instead of process cwd when no workspace is configured', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'chill-vibe-whitenoise-'))
  const appDataDir = path.join(root, 'app-data')

  try {
    const resolved = await resolveWhitenoiseCliCwd({
      defaultWorkspacePath: '',
      appDataDir,
    })

    assert.equal(resolved, appDataDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
