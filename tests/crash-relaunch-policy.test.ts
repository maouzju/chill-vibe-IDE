import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyPreviousRun,
  parseRunSentinel,
  serializeRunSentinel,
  shouldRelaunch,
  type RunSentinel,
} from '../electron/crash-relaunch-policy.ts'

const sentinel = (overrides: Partial<RunSentinel> = {}): RunSentinel => ({
  pid: 5960,
  startedAtIso: '2026-08-11T22:45:14.000Z',
  cleanExit: false,
  ...overrides,
})

test('no sentinel means there is nothing to recover', () => {
  assert.equal(classifyPreviousRun(null, { alive: false }), 'none')
})

test('a sentinel marked clean is a normal shutdown, never relaunched', () => {
  const verdict = classifyPreviousRun(sentinel({ cleanExit: true }), { alive: false })
  assert.equal(verdict, 'clean-exit')
})

test('a live process with a matching start time is still running', () => {
  const verdict = classifyPreviousRun(sentinel(), {
    alive: true,
    startedAtIso: '2026-08-11T22:45:14.000Z',
  })
  assert.equal(verdict, 'running')
})

test('a vanished process that never marked a clean exit was hard-killed', () => {
  assert.equal(classifyPreviousRun(sentinel(), { alive: false }), 'hard-kill')
})

// A watchdog that trusts a bare PID would see a number that now belongs to
// somebody else, call it "still running", and silently never recover. This is
// about PID identity being unsound on its own, not about any particular killer
// -- the "recycled PID" theory of who does the killing was refuted on
// 2026-08-12 (see electron/crash-relaunch-policy.ts), but the (pid, start time)
// pair is the right identity regardless.
test('a live PID whose start time disagrees is a different process, not ours', () => {
  const verdict = classifyPreviousRun(sentinel(), {
    alive: true,
    startedAtIso: '2026-08-12T01:03:00.000Z',
  })
  assert.equal(verdict, 'hard-kill')
})

test('a live PID with an unknown start time is not trusted as running', () => {
  const verdict = classifyPreviousRun(sentinel(), { alive: true })
  assert.equal(verdict, 'hard-kill')
})

test('start times are compared with a tolerance for clock granularity', () => {
  const verdict = classifyPreviousRun(sentinel(), {
    alive: true,
    startedAtIso: '2026-08-11T22:45:14.900Z',
  })
  assert.equal(verdict, 'running')
})

const t = (iso: string) => Date.parse(iso)

test('a first crash relaunches', () => {
  const ok = shouldRelaunch([], t('2026-08-12T01:00:00.000Z'))
  assert.equal(ok, true)
})

// Without a cap, an app that is killed the instant it starts would respawn
// forever and burn PIDs -- feeding the very problem it is recovering from.
test('a relaunch storm is capped', () => {
  const history = [
    t('2026-08-12T00:58:00.000Z'),
    t('2026-08-12T00:59:00.000Z'),
    t('2026-08-12T00:59:30.000Z'),
  ]
  const ok = shouldRelaunch(history, t('2026-08-12T01:00:00.000Z'))
  assert.equal(ok, false)
})

test('relaunches outside the window do not count toward the cap', () => {
  const history = [
    t('2026-08-12T00:00:00.000Z'),
    t('2026-08-12T00:10:00.000Z'),
    t('2026-08-12T00:20:00.000Z'),
  ]
  const ok = shouldRelaunch(history, t('2026-08-12T01:00:00.000Z'))
  assert.equal(ok, true)
})

test('the cap and window are configurable', () => {
  const history = [t('2026-08-12T00:59:50.000Z')]
  assert.equal(shouldRelaunch(history, t('2026-08-12T01:00:00.000Z'), { maxRelaunches: 1 }), false)
  assert.equal(shouldRelaunch(history, t('2026-08-12T01:00:00.000Z'), { maxRelaunches: 2 }), true)
})

test('a sentinel round-trips through its serialized form', () => {
  const record = sentinel({ pid: 4242, cleanExit: false })
  const parsed = parseRunSentinel(serializeRunSentinel(record))

  assert.deepEqual(parsed, record)
})

// The watchdog reads this file while the app is writing it, and it survives
// power loss. Anything unreadable must degrade to "no sentinel" rather than
// throw, because throwing in the watchdog means no recovery at all.
test('unreadable sentinels degrade to null instead of throwing', () => {
  assert.equal(parseRunSentinel(''), null)
  assert.equal(parseRunSentinel('not json'), null)
  assert.equal(parseRunSentinel('{"pid":"nope"}'), null)
  assert.equal(parseRunSentinel('{"pid":4242}'), null)
  assert.equal(parseRunSentinel('null'), null)
  assert.equal(parseRunSentinel('[]'), null)
})

test('a truncated sentinel is treated as absent, not as a hard kill', () => {
  const partial = serializeRunSentinel(sentinel()).slice(0, 20)
  assert.equal(parseRunSentinel(partial), null)
  assert.equal(classifyPreviousRun(parseRunSentinel(partial), { alive: false }), 'none')
})
