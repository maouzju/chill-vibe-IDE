import assert from 'node:assert/strict'
import test from 'node:test'

import { isEnvironmentHealthAllOk, type EnvironmentHealth } from '../src/components/settings/settings-model.ts'

// 2026-09-23：用户截图反馈「环境健康一直在上面」——三盏灯全绿时仍占满一屏，挤掉「基础」设置。
// 全绿只需一行结论（卡片据此折叠），出问题才展开明细。
const ok = { state: 'ok', fix: null, providers: [] }

test('all-green health counts as all ok (card collapses)', () => {
  assert.equal(isEnvironmentHealthAllOk({ cli: ok, account: ok, version: ok } as unknown as EnvironmentHealth), true)
})

test('any warn/unknown light keeps the card expanded', () => {
  for (const state of ['warn', 'error', 'unknown']) {
    const health = { cli: ok, account: { ...ok, state }, version: ok } as unknown as EnvironmentHealth
    assert.equal(isEnvironmentHealthAllOk(health), false)
  }
})
