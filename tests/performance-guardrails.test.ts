import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts?: Record<string, string>
}
const releaseVerifierSource = readFileSync('scripts/run-release-verification.mjs', 'utf8')
const chatPerfRunnerSource = readFileSync('scripts/run-electron-chat-performance.ps1', 'utf8')
const chatPerfTestSource = readFileSync('tests/electron-chat-stream-performance.test.ts', 'utf8')
const chatPerfFixtureSource = readFileSync('tests/chat-stream-performance-fixture.ts', 'utf8')
const fakeCodexSource = readFileSync('tests/fixtures/fake-codex-chat-stress.cjs', 'utf8')

test('release verification includes a bounded chat performance gate after the production build', () => {
  assert.equal(
    packageJson.scripts?.['test:perf:chat:electron:release'],
    'powershell -ExecutionPolicy Bypass -File scripts/run-electron-chat-performance.ps1 -DurationSeconds 30 -SkipBuild',
  )

  const buildStageIndex = releaseVerifierSource.indexOf("{ id: 'build'")
  const chatPerfStageIndex = releaseVerifierSource.indexOf("{ id: 'chat-perf'")
  assert.ok(buildStageIndex >= 0, 'release verifier should retain the production build stage')
  assert.ok(chatPerfStageIndex > buildStageIndex, 'chat performance should reuse the completed production build')
  assert.match(
    releaseVerifierSource,
    /id: 'chat-perf'[\s\S]*args: \['test:perf:chat:electron:release'\]/,
  )
})

test('release chat performance runner can skip only its duplicate build', () => {
  assert.match(chatPerfRunnerSource, /\[switch\]\$SkipBuild/)
  assert.match(chatPerfRunnerSource, /if \(-not \$SkipBuild\) \{[\s\S]*& \$pnpm\.Source 'build'/)
})

test('visible Electron chat rendering fails when a frame stalls for 500ms', () => {
  assert.match(
    chatPerfTestSource,
    /metrics\.frameMaxGapMs < 500/,
    'the paint-frame gate must match the documented sub-500ms responsiveness target',
  )
})

test('Electron chat performance gate exercises fourteen tabs per pane and twenty live agents', () => {
  assert.match(chatPerfTestSource, /chatStreamStressTabsPerPane/)
  assert.match(chatPerfTestSource, /chatStreamStressConcurrentStreamCount/)
  assert.match(chatPerfTestSource, /chatStreamStressVisibleStreamColumnCount/)
  assert.match(chatPerfTestSource, /getChatStreamStressBackgroundTitle/)
  assert.match(chatPerfFixtureSource, /\[4, 4, 3, 3, 3, 3\]/)
  assert.match(chatPerfTestSource, /queuedSendP95Ms/)
  assert.match(chatPerfTestSource, /contextmenu/)
  assert.match(
    chatPerfTestSource,
    /querySelectorAll\('\.pane-tab\.is-streaming'\)\.length === expectedCount/,
    'background streams must be counted from tab chrome because their full card bodies are intentionally unmounted',
  )
})

test('Electron chat stress uses the local fake Codex runtime without model-token traffic', () => {
  assert.match(chatPerfTestSource, /createFakeCodexBin/)
  assert.match(chatPerfTestSource, /PATH: `\$\{fakeBin\}\$\{path\.delimiter\}/)
  assert.match(fakeCodexSource, /app-server/)
  assert.doesNotMatch(fakeCodexSource, /https?:\/\//)
  assert.doesNotMatch(fakeCodexSource, /\bfetch\s*\(/)
})
