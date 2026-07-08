import assert from 'node:assert/strict'
import test from 'node:test'

// The packaging script is plain JS with no .d.ts; the pure helper is typed by
// its usage below. ts-expect-error keeps the tsconfig.test type-check green
// without adding a declaration file just for one exported function.
// @ts-expect-error - no type declarations for the .mjs packaging script
import { selectReleaseDirsToPrune } from '../scripts/build-timestamped-release.mjs'

// dist/ accumulated 49 release-* dirs / 31GB (2026-07-07) because each ~636MB
// build was never cleaned up. These pin the pruning decision: keep the newest N,
// delete the rest, never touch the just-built dir, and fail safe (keep all) on a
// bad keep value so an accidental 0 cannot wipe every build.

test('keeps the newest N release dirs and prunes the rest', () => {
  const dirs = [
    'release-20260625-093005',
    'release-20260706-115623',
    'release-20260707-165148',
    'release-20260707-230900',
  ]
  const pruned = selectReleaseDirsToPrune(dirs, 2)
  assert.deepEqual(pruned, ['release-20260625-093005', 'release-20260706-115623'])
})

test('never prunes protected dirs (e.g. the just-built one)', () => {
  const dirs = [
    'release-20260625-093005',
    'release-20260706-115623',
    'release-20260707-230900',
  ]
  // keep=1 would normally drop everything but the newest, but the protected
  // just-built dir must survive regardless.
  const pruned = selectReleaseDirsToPrune(dirs, 1, ['release-20260625-093005'])
  assert.ok(!pruned.includes('release-20260625-093005'))
})

test('keep < 1 disables pruning (fail safe against an accidental 0)', () => {
  const dirs = ['release-20260625-093005', 'release-20260707-230900']
  assert.deepEqual(selectReleaseDirsToPrune(dirs, 0), [])
  assert.deepEqual(selectReleaseDirsToPrune(dirs, -3), [])
  assert.deepEqual(selectReleaseDirsToPrune(dirs, Number.NaN), [])
})

test('ignores non-release directories entirely', () => {
  const dirs = ['win-unpacked', 'builder-debug', 'release-20260707-230900', 'node_modules']
  const pruned = selectReleaseDirsToPrune(dirs, 1)
  assert.deepEqual(pruned, [])
})

test('sorts chronologically by timestamped name, not insertion order', () => {
  const dirs = [
    'release-20260707-230900',
    'release-20260625-093005',
    'release-20260707-165148',
  ]
  const pruned = selectReleaseDirsToPrune(dirs, 1)
  // newest is 20260707-230900; the two older ones are pruned
  assert.deepEqual(pruned.sort(), ['release-20260625-093005', 'release-20260707-165148'])
})

test('handles suffixed release dir names', () => {
  const dirs = [
    'release-20260707-120000-demo',
    'release-20260707-230900',
  ]
  const pruned = selectReleaseDirsToPrune(dirs, 1)
  assert.deepEqual(pruned, ['release-20260707-120000-demo'])
})
