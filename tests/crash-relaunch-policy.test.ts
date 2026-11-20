import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyPreviousRun,
  createSessionEndHandler,
  handleStartupFailure,
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

// 2026-11-20 审查：Windows 关机 / 注销 / 重启不发 before-quit / will-quit，sentinel 停在
// cleanExit=false —— 守护会在关机途中把应用拉起来，下次启动还误记一条「被外部强杀」。
test('session end marks a clean exit first, then only fires a flush without waiting on it', () => {
  const calls: string[] = []
  const handleSessionEnd = createSessionEndHandler({
    markCleanExit: () => calls.push('mark'),
    requestFlush: () => {
      calls.push('flush')
      // A flush that never settles must not hold the handler (and so the shutdown).
      return new Promise<void>(() => undefined)
    },
  })

  assert.equal(handleSessionEnd(), undefined)
  assert.deepEqual(calls, ['mark', 'flush'])
})

test('session end runs once even though every window reports it', () => {
  let marks = 0
  const handleSessionEnd = createSessionEndHandler({
    markCleanExit: () => {
      marks += 1
    },
    requestFlush: () => undefined,
  })

  handleSessionEnd()
  handleSessionEnd()
  assert.equal(marks, 1)
})

test('session end swallows step failures so the other step still runs', () => {
  const calls: string[] = []
  const handleSessionEnd = createSessionEndHandler({
    markCleanExit: () => {
      calls.push('mark')
      throw new Error('disk gone')
    },
    requestFlush: () => {
      calls.push('flush')
      throw new Error('backend gone')
    },
  })

  assert.doesNotThrow(() => handleSessionEnd())
  assert.deepEqual(calls, ['mark', 'flush'])
})

test('a rejected best-effort flush during session end does not become an unhandled rejection', async () => {
  const handleSessionEnd = createSessionEndHandler({
    markCleanExit: () => undefined,
    requestFlush: () => Promise.reject(new Error('backend gone')),
  })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    handleSessionEnd()
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  assert.deepEqual(unhandled, [])
})

// 2026-11-20 审查：whenReady 启动链没有 catch，任一步抛错（如清用户数据时 rm 撞上 EBUSY）
// 进程就成了没有窗口、却占着单实例锁的僵尸；再点图标只会唤起一个没有 IPC handler 的空窗口。
test('a startup failure logs, stands the guard down, releases the lock and exits non-zero', () => {
  const calls: string[] = []
  const failure = new Error('EBUSY: resource busy or locked')
  handleStartupFailure(failure, {
    logError: (error) => calls.push(`log:${(error as Error).message}`),
    markCleanExit: () => calls.push('mark'),
    shutdownBackend: () => calls.push('backend'),
    releaseSingleInstanceLock: () => calls.push('unlock'),
    exit: (code) => calls.push(`exit:${code}`),
  })

  assert.deepEqual(calls, [
    'log:EBUSY: resource busy or locked',
    'mark',
    'backend',
    'unlock',
    'exit:1',
  ])
})

test('a startup failure still exits when logging or cleanup throws', () => {
  const calls: string[] = []
  const boom = () => {
    throw new Error('boom')
  }
  handleStartupFailure(new Error('x'), {
    logError: boom,
    markCleanExit: boom,
    shutdownBackend: boom,
    releaseSingleInstanceLock: boom,
    exit: (code) => calls.push(`exit:${code}`),
  })

  assert.deepEqual(calls, ['exit:1'])
})
