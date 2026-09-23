import assert from 'node:assert/strict'
import test from 'node:test'

import { cliCompatNeedsAction, type CliCompatEntry } from '../shared/cli-compat.ts'

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
