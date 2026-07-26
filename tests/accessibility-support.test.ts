import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  accessibilitySupportFlagFileName,
  readAccessibilitySupportFlag,
  resolveAccessibilitySupportEnabled,
  writeAccessibilitySupportFlag,
} from '../electron/accessibility-support.ts'

const withTempDir = (run: (dir: string) => void) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chill-vibe-a11y-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('accessibility support stays off unless explicitly enabled', () => {
  assert.equal(resolveAccessibilitySupportEnabled({}), false)
  assert.equal(resolveAccessibilitySupportEnabled({ persistedFlag: null }), false)
  assert.equal(resolveAccessibilitySupportEnabled({ persistedFlag: false }), false)
  assert.equal(resolveAccessibilitySupportEnabled({ persistedFlag: true }), true)
})

test('environment overrides take precedence over the persisted flag', () => {
  assert.equal(
    resolveAccessibilitySupportEnabled({ enableOverride: '1', persistedFlag: false }),
    true,
  )
  assert.equal(
    resolveAccessibilitySupportEnabled({ disableOverride: '1', persistedFlag: true }),
    false,
  )
  // Disable wins when both are set, so support triage can always force it off.
  assert.equal(
    resolveAccessibilitySupportEnabled({
      enableOverride: '1',
      disableOverride: '1',
      persistedFlag: true,
    }),
    false,
  )
  // Anything other than the exact opt-in value is ignored.
  assert.equal(resolveAccessibilitySupportEnabled({ enableOverride: 'true' }), false)
})

test('the startup flag survives a write/read round trip', () => {
  withTempDir((dir) => {
    const dataDir = path.join(dir, 'nested', 'data')

    assert.equal(readAccessibilitySupportFlag(dataDir), null)

    writeAccessibilitySupportFlag(dataDir, true)
    assert.equal(readAccessibilitySupportFlag(dataDir), true)

    writeAccessibilitySupportFlag(dataDir, false)
    assert.equal(readAccessibilitySupportFlag(dataDir), false)

    const raw = JSON.parse(
      readFileSync(path.join(dataDir, accessibilitySupportFlagFileName), 'utf8'),
    ) as { enabled?: unknown }
    assert.equal(raw.enabled, false)
  })
})

test('a hand-written flag file with a UTF-8 BOM still counts', () => {
  withTempDir((dir) => {
    // Windows PowerShell's `Set-Content -Encoding utf8` prepends a BOM, so a
    // support-triage edit of this file must not silently degrade to the default.
    writeFileSync(
      path.join(dir, accessibilitySupportFlagFileName),
      String.fromCharCode(0xfeff) + JSON.stringify({ enabled: true }),
      'utf8',
    )
    assert.equal(readAccessibilitySupportFlag(dir), true)
  })
})

test('a corrupt or foreign flag file never breaks startup', () => {
  withTempDir((dir) => {
    const flagPath = path.join(dir, accessibilitySupportFlagFileName)

    writeFileSync(flagPath, 'not json at all', 'utf8')
    assert.equal(readAccessibilitySupportFlag(dir), null)

    writeFileSync(flagPath, JSON.stringify({ enabled: 'yes' }), 'utf8')
    assert.equal(readAccessibilitySupportFlag(dir), null)

    writeFileSync(flagPath, JSON.stringify([1, 2, 3]), 'utf8')
    assert.equal(readAccessibilitySupportFlag(dir), null)
  })
})
