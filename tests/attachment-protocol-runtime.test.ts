import assert from 'node:assert/strict'
import test from 'node:test'

test('Electron runtime re-exports the attachment protocol scheme used by the main process', async () => {
  const runtimeTargetModule = (await import('../electron/runtime-target.ts')) as Record<
    string,
    unknown
  >

  assert.equal(runtimeTargetModule.attachmentProtocolScheme, 'chill-vibe-attachment')
})
