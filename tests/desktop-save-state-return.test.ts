import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDefaultState } from '../shared/default-state.ts'

// 症状：打字/切 tab/发消息时整窗卡顿，长时间使用后无退出日志地闪退（退出码 0xCFFFFFFF）。
// 根因：2026-08-12 实测 `desktop:save-state` 的 handler 返回了完整 state，ipcMain.handle
// 会把它结构化克隆原路送回渲染进程；用户机 state.json 实测 1,083,925 字节，UTF-16 下
// 一个往返约 4.2MB，而渲染端 usePersistence.ts:39 只 `await` 从不取值。
// 不能只在渲染端忽略返回值：克隆发生在 IPC 层，必须在主进程 handler 处断掉。
describe('desktop save-state IPC return payload', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `chill-vibe-save-return-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    process.env.CHILL_VIBE_DATA_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('does not send the whole app state back across the bridge', async () => {
    const { createDesktopBackend } = await import('../electron/backend.ts')
    const backend = createDesktopBackend()

    try {
      const result = await backend.saveState(createDefaultState('D:/save-return'))

      // ipcMain.handle 会克隆 handler 的返回值，所以这里必须是不可克隆代价的空值。
      assert.equal(result, undefined)
    } finally {
      await backend.dispose()
    }
  })

  it('still rejects when the underlying write fails', async () => {
    const { createDesktopBackend } = await import('../electron/backend.ts')
    const backend = createDesktopBackend()

    const makeState = (content: string) => {
      const state = createDefaultState('D:/save-return-failure')
      state.sessionHistory = [
        {
          id: 'save-return-entry',
          title: 'Atomic',
          sessionId: 'save-return-session',
          provider: 'codex',
          model: 'gpt-5',
          workspacePath: 'D:/save-return-failure',
          archivedAt: '2026-08-12T00:00:00.000Z',
          messages: [
            { id: content, role: 'user', content, createdAt: '2026-08-12T00:00:00.000Z' },
          ],
        },
      ]
      return state
    }

    try {
      await backend.saveState(makeState('old-content'))

      // 占住 sidecar 的原子替换临时路径，让下一次保存在写盘阶段真的失败。
      const sidecarPath = path.join(
        tmpDir,
        'session-history',
        `${Buffer.from('save-return-entry').toString('base64url')}.json`,
      )
      await mkdir(`${sidecarPath}.tmp`)

      await assert.rejects(() => backend.saveState(makeState('new-content')))
    } finally {
      await backend.dispose()
    }
  })

  it('rejects invalid payloads before touching disk', async () => {
    const { createDesktopBackend } = await import('../electron/backend.ts')
    const backend = createDesktopBackend()

    try {
      await assert.rejects(() =>
        backend.saveState({ columns: 'not-an-array' } as unknown as ReturnType<typeof createDefaultState>),
      )
    } finally {
      await backend.dispose()
    }
  })
})
