import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  dependencies?: Record<string, string>
}

test('qrcode runtime dependencies are declared for packaged production', () => {
  for (const dependency of ['dijkstrajs', 'pngjs']) {
    assert.ok(
      packageJson.dependencies?.[dependency],
      `${dependency} must be a direct production dependency so electron-builder includes it in app.asar`,
    )
  }
})

test('the installed production tree can load qrcode', () => {
  const require = createRequire(import.meta.url)
  assert.doesNotThrow(() => require('qrcode'))
})

test('packaged smoke uses the renderer fetchState RPC as its ready signal', () => {
  const smokeScript = readFileSync(
    new URL('../scripts/smoke-packaged-backend-rpc.mjs', import.meta.url),
    'utf8',
  )

  assert.match(smokeScript, /connectOverCDP\(/)
  assert.match(smokeScript, /window\.electronAPI\.fetchState\(\)/)
  assert.match(smokeScript, /CHILL_VIBE_PACKAGED_RPC_OK/)
})
