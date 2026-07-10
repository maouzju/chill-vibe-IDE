import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('Codex Fast mode requires an in-app cost confirmation before enabling', async () => {
  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const localeSource = await readFile(new URL('../shared/i18n.ts', import.meta.url), 'utf8')

  assert.match(appSource, /codexFastModeDialogOpen/)
  assert.match(appSource, /handleCodexFastModeToggle/)
  assert.equal(
    appSource.match(/handleCodexFastModeToggle\(event\.target\.checked\)/g)?.length,
    2,
  )
  assert.match(appSource, /confirmCodexFastMode/)
  assert.match(appSource, /codex-fast-mode-dialog-title/)
  assert.match(appSource, /role="dialog"/)
  assert.doesNotMatch(appSource, /patch: \{ codexFastMode: event\.target\.checked \}/)

  assert.match(localeSource, /codexFastModeDialogTitle/)
  assert.match(localeSource, /codexFastModeDialogWarning/)
  assert.match(localeSource, /codexFastModeDialogConfirm/)
})
