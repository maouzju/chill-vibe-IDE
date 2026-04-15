import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  getAppDataDir,
  getAttachmentsDir,
  getDefaultWorkspacePath,
  getStateFilePath,
} from '../server/app-paths.ts'

const withEnv = (
  patch: Partial<Record<'CHILL_VIBE_DATA_DIR' | 'CHILL_VIBE_DEFAULT_WORKSPACE', string | undefined>>,
  run: () => void,
) => {
  const previousEntries = Object.fromEntries(
    Object.keys(patch).map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }

    process.env[key] = value
  }

  try {
    run()
  } finally {
    for (const [key, value] of Object.entries(previousEntries)) {
      if (value === undefined) {
        delete process.env[key]
        continue
      }

      process.env[key] = value
    }
  }
}

test('app paths default to the workspace-local storage directory', () => {
  withEnv(
    {
      CHILL_VIBE_DATA_DIR: undefined,
      CHILL_VIBE_DEFAULT_WORKSPACE: undefined,
    },
    () => {
      const expectedDataDir = path.join(process.cwd(), '.chill-vibe')

      assert.equal(getAppDataDir(), expectedDataDir)
      assert.equal(getStateFilePath(), path.join(expectedDataDir, 'state.json'))
      assert.equal(getAttachmentsDir(), path.join(expectedDataDir, 'attachments'))
      assert.equal(getDefaultWorkspacePath(), process.cwd())
    },
  )
})

test('app paths honor configured data and default workspace directories', () => {
  withEnv(
    {
      CHILL_VIBE_DATA_DIR: path.join(process.cwd(), 'tmp', 'persisted-state'),
      CHILL_VIBE_DEFAULT_WORKSPACE: path.join(process.cwd(), 'tmp', 'default-workspace'),
    },
    () => {
      const expectedDataDir = path.resolve(process.cwd(), 'tmp', 'persisted-state')
      const expectedWorkspace = path.resolve(process.cwd(), 'tmp', 'default-workspace')

      assert.equal(getAppDataDir(), expectedDataDir)
      assert.equal(getStateFilePath(), path.join(expectedDataDir, 'state.json'))
      assert.equal(getAttachmentsDir(), path.join(expectedDataDir, 'attachments'))
      assert.equal(getDefaultWorkspacePath(), expectedWorkspace)
    },
  )
})

test('an explicitly empty default workspace stays blank', () => {
  withEnv(
    {
      CHILL_VIBE_DATA_DIR: undefined,
      CHILL_VIBE_DEFAULT_WORKSPACE: '',
    },
    () => {
      assert.equal(getDefaultWorkspacePath(), '')
    },
  )
})
