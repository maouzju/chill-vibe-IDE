import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cliCompatNeedsAction,
  compareCliVersions,
  isCliVersionInRange,
  type CliCompatEntry,
} from '../shared/cli-compat.ts'

// 2026-09-23 用户截图：系统 CLI 已经就是兼容版本，还在提示「下载兼容版并切换」。
const base: CliCompatEntry = {
  provider: 'claude',
  compatibleVersion: '2.1.280',
  installed: false,
  active: false,
  activeVersion: null,
  systemVersion: '2.1.280',
  task: null,
}

test('system CLI already on the compatible version needs no switch', () => {
  assert.equal(cliCompatNeedsAction(base), false)
})

test('mismatched system CLI or stale compat copy still needs action', () => {
  assert.equal(cliCompatNeedsAction({ ...base, systemVersion: '2.1.200' }), true)
  assert.equal(cliCompatNeedsAction({ ...base, systemVersion: null }), true)
  assert.equal(
    cliCompatNeedsAction({ ...base, systemVersion: '2.1.200', installed: true, active: true, activeVersion: '2.1.100' }),
    true,
  )
})

test('using the compatible private copy needs no action', () => {
  assert.equal(
    cliCompatNeedsAction({ ...base, systemVersion: '2.1.200', installed: true, active: true, activeVersion: '2.1.280' }),
    false,
  )
})

// 2026-09-29：每个 IDE 版本兼容一个 CLI 区间 [minCompatibleVersion, compatibleVersion]，
// IDE 升级抬了推荐版本后，系统 CLI 或旧兼容副本只要还在区间内就不催用户更新。
const ranged: CliCompatEntry = { ...base, compatibleVersion: '2.1.284', minCompatibleVersion: '2.1.280' }

test('system CLI inside the verified range needs no action', () => {
  assert.equal(cliCompatNeedsAction({ ...ranged, systemVersion: '2.1.280' }), false)
  assert.equal(cliCompatNeedsAction({ ...ranged, systemVersion: '2.1.282' }), false)
  assert.equal(cliCompatNeedsAction({ ...ranged, systemVersion: '2.1.284' }), false)
})

test('system CLI outside the verified range still needs action', () => {
  assert.equal(cliCompatNeedsAction({ ...ranged, systemVersion: '2.1.279' }), true)
  assert.equal(cliCompatNeedsAction({ ...ranged, systemVersion: '2.1.285' }), true)
  assert.equal(cliCompatNeedsAction({ ...ranged, systemVersion: '2.2.0' }), true)
})

test('an older compat copy still inside the range keeps working without re-download', () => {
  assert.equal(
    cliCompatNeedsAction({ ...ranged, systemVersion: null, installed: false, active: false, activeVersion: '2.1.280' }),
    false,
  )
  assert.equal(
    cliCompatNeedsAction({ ...ranged, systemVersion: '2.1.284', installed: false, active: false, activeVersion: '2.1.100' }),
    true,
  )
})

test('versions compare numerically, not lexically', () => {
  assert.equal(compareCliVersions('0.158.0', '0.156.1') > 0, true)
  assert.equal(compareCliVersions('2.1.100', '2.1.99') > 0, true)
  assert.equal(compareCliVersions('0.158.0', '0.158.0'), 0)
  assert.equal(isCliVersionInRange('0.157.2', '0.156.1', '0.158.0'), true)
  assert.equal(isCliVersionInRange(null, '0.156.1', '0.158.0'), false)
})
