import assert from 'node:assert/strict'
import { describe, it, afterEach } from 'node:test'

// 症状：打字/切 tab 时整窗卡顿，长时间使用后无退出日志地闪退。
// 根因：2026-08-11 实测 saveState 的返回值从未被使用（usePersistence.ts:39 只 await），
// 但渲染进程仍对回传的完整 1.17MB state 跑一次 appStateSchema.parse，
// 每次保存白白阻塞主线程 ~5ms 并制造 ~1.17MB 深克隆垃圾。
// 不能只在调用点忽略返回值：parse 发生在 api.saveState 内部，必须在这里断掉。
describe('saveState response handling', () => {
  const originalWindow = (globalThis as { window?: unknown }).window

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
  })

  const installDesktopBridge = (saveStateImpl: (state: unknown) => Promise<unknown>) => {
    const calls: unknown[] = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        saveState: (state: unknown) => {
          calls.push(state)
          return saveStateImpl(state)
        },
      },
    }
    return calls
  }

  it('does not re-validate the desktop response against the full app schema', async () => {
    const { saveState } = await import('../src/api.ts')
    const { createDefaultState } = await import('../shared/default-state.ts')
    const state = createDefaultState('')

    // 主进程已经校验过入参并自行构造返回值；渲染进程再校验一次是纯浪费。
    // 回传一个不合 schema 的值时不应抛错——抛错即证明仍在做全量 parse。
    installDesktopBridge(async () => undefined)

    await assert.doesNotReject(() => saveState(state))
  })

  it('still forwards the complete state to the desktop bridge', async () => {
    const { saveState } = await import('../src/api.ts')
    const { createDefaultState } = await import('../shared/default-state.ts')
    const state = createDefaultState('')

    const calls = installDesktopBridge(async () => undefined)
    await saveState(state)

    assert.equal(calls.length, 1)
    // 立即保存必须保全量数据：排队路径才做有损裁剪（structuredData 超预算会被截断）。
    assert.deepEqual(calls[0], state)
  })
})
