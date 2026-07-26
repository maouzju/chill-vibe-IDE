import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  classifyUnresponsiveBlocking,
  resolveCrashDumpDirectory,
  selectNewCrashDumps,
  summarizeChildProcessMetrics,
} from '../electron/native-hang-forensics'

// Why this module exists at all.
//
// Every "used it for a while and it froze" investigation has died at the same
// step: `collectJavaScriptCallStack()` resolves to '' — the main thread is NOT
// in app JS — and there is no further evidence to read, so the root cause is
// re-declared "unknown" every single time. The one artifact that carries a
// native stack (a Crashpad minidump) was never produced, because the crash
// reporter was never started; `forcefullyCrashRenderer()` therefore destroyed
// the only remaining evidence on every recovery.
//
// These tests pin the decision core that turns an empty JS stack from a dead
// end into a pointer at a real, on-disk native artifact.

test('an absent JS stack is classified as a native/GC hang, not "unknown"', () => {
  const verdict = classifyUnresponsiveBlocking({
    jsStackAvailable: false,
    crashDumpDirectory: 'C:/data/crash-dumps',
  })
  assert.equal(verdict.blockingClass, 'native-or-gc')
  // The whole point: an empty JS stack must still hand triage somewhere to look.
  assert.equal(verdict.nextEvidence, 'C:/data/crash-dumps')
  assert.equal(verdict.actionable, true)
})

test('a populated JS stack keeps the JS stack as the evidence', () => {
  const verdict = classifyUnresponsiveBlocking({
    jsStackAvailable: true,
    crashDumpDirectory: 'C:/data/crash-dumps',
  })
  assert.equal(verdict.blockingClass, 'renderer-js')
  assert.equal(verdict.nextEvidence, null)
  assert.equal(verdict.actionable, true)
})

test('crash dumps live beside the app logs so a report can name one path', () => {
  const dir = resolveCrashDumpDirectory('C:/Users/u/AppData/Roaming/chill-vibe-ide/data')
  assert.equal(
    path.normalize(dir),
    path.normalize('C:/Users/u/AppData/Roaming/chill-vibe-ide/data/crash-dumps'),
  )
})

test('only dumps created by this recovery are reported', () => {
  // A stale dump from a previous freeze must not be mistaken for the fresh one,
  // otherwise triage reads a months-old native stack as today's root cause.
  const fresh = selectNewCrashDumps(
    ['old-a.dmp', 'old-b.dmp'],
    ['old-a.dmp', 'old-b.dmp', 'new-c.dmp'],
  )
  assert.deepEqual(fresh, ['new-c.dmp'])
})

test('no new dump is reported when the crash produced none', () => {
  assert.deepEqual(selectNewCrashDumps(['old-a.dmp'], ['old-a.dmp']), [])
})

test('process metrics separate a stuck renderer from a stuck GPU process', () => {
  // If the GPU process is also pinned, the hang is below the renderer and no
  // amount of renderer-side JS work will ever explain it. This distinction has
  // never been recorded, so every freeze looked identical in the logs.
  const summary = summarizeChildProcessMetrics({
    rendererProcessId: 45156,
    metrics: [
      { pid: 100, type: 'Browser', cpu: { percentCPUUsage: 1.2 } },
      { pid: 45156, type: 'Tab', cpu: { percentCPUUsage: 99.4 } },
      { pid: 777, type: 'GPU', cpu: { percentCPUUsage: 96.1 } },
    ],
  })
  assert.equal(summary.stuckRendererCpuPercent, 99.4)
  assert.equal(summary.gpuProcessId, 777)
  assert.equal(summary.gpuCpuPercent, 96.1)
  assert.equal(summary.gpuAlsoSaturated, true)
})

test('a quiet GPU process points the blame back at the renderer', () => {
  const summary = summarizeChildProcessMetrics({
    rendererProcessId: 45156,
    metrics: [
      { pid: 45156, type: 'Tab', cpu: { percentCPUUsage: 98 } },
      { pid: 777, type: 'GPU', cpu: { percentCPUUsage: 0.4 } },
    ],
  })
  assert.equal(summary.gpuAlsoSaturated, false)
})

test('missing metrics never throw during a freeze', () => {
  const summary = summarizeChildProcessMetrics({ rendererProcessId: 1, metrics: [] })
  assert.equal(summary.stuckRendererCpuPercent, null)
  assert.equal(summary.gpuProcessId, null)
  assert.equal(summary.gpuAlsoSaturated, false)
})

test('main.ts starts the crash reporter locally and reports the dump after a forced crash', () => {
  const main = readFileSync(path.join(process.cwd(), 'electron/main.ts'), 'utf8')
  assert.match(
    main,
    /crashReporter\.start\(/,
    'without crashReporter.start() a forced renderer crash produces no minidump, destroying the only native-stack evidence',
  )
  assert.match(
    main,
    /uploadToServer:\s*false/,
    'crash dumps must stay on the local machine',
  )
  assert.match(
    main,
    /classifyUnresponsiveBlocking/,
    'an empty JS stack must be classified and pointed at the dump directory instead of logged as a dead end',
  )
  assert.match(
    main,
    /summarizeChildProcessMetrics/,
    'the freeze log must record whether the GPU process was saturated too',
  )
  // Log analysis of 22 freezes showed the 5 minutes before each one are empty
  // apart from resource heartbeats, so there is no record of what the app was
  // doing. lastInput was only ever attached to the later reload line; putting
  // it on the unresponsive event itself is the one context clue available.
  assert.match(
    main,
    /BrowserWindow became unresponsive\.', \{[\s\S]{0,200}lastInput/,
    'the unresponsive event must carry the last user input, or the freeze has no context at all',
  )
})
