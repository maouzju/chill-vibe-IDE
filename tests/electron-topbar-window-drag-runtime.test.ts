import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

import { _electron as electron } from '@playwright/test'
import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

// 症状：顶栏「Chill Vibe / 接口 / 设置」标签按住拖不动窗口（2026-09-11）。
// 这条用例守的是纯函数测试覆盖不到的那一段：真实 BrowserWindow 在最大化态收到
// `window:pointer-drag-begin` 后，`unmaximize()` 紧接着的 `getBounds()` 必须已经是
// 还原后的尺寸（设计按 Windows 行为推断，此前没有实机证据），并且窗口要落在
// 真实光标下面 —— 主进程读的是 `screen.getCursorScreenPoint()`，不是渲染进程坐标。
// 光标由测试机的真实鼠标决定，所以断言用"光标落在窗口内"这种与位置无关的形式，
// 并留出鼠标在两次采样之间被人挪动的余量。
const launchRuntime = async (context: TestContext) => {
  await ensureElectronRuntimeBuild()
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'chill-topbar-drag-'))
  context.after(() => rm(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

  const env = createHeadlessElectronRuntimeEnv({
    VITE_DEV_SERVER_URL: getElectronTestRendererUrl(),
    CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
    CHILL_VIBE_RUNTIME_PROFILE_ROOT: profileRoot,
    CHILL_VIBE_ALLOW_SHARED_DATA_DIR: '1',
    CHILL_VIBE_DATA_DIR: path.join(profileRoot, 'data'),
  })

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env,
  })
  const page = await app.firstWindow()
  await page.waitForFunction(
    () => {
      const root = document.getElementById('root')
      return (
        typeof window.electronAPI !== 'undefined' &&
        (root?.childElementCount ?? 0) > 0 &&
        Boolean(document.querySelector('.app-shell'))
      )
    },
    undefined,
    { timeout: 30000 },
  )

  return { app, page }
}

type DragBridge = {
  beginWindowPointerDrag: () => Promise<boolean>
  moveWindowPointerDrag: () => void
  endWindowPointerDrag: () => void
}

const restoredSize = { width: 1000, height: 700 }
// 鼠标在 IPC 与主进程采样之间的几毫秒里被人挪动的余量（DIP）。
const cursorJitterTolerance = 80

test('topbar pointer drag restores a maximized window under the real cursor', async (context) => {
  const { app, page } = await launchRuntime(context)

  try {
    const before = await app.evaluate(async ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      // 必须验证真实窗口状态，但不能弹窗抢走用户正在使用的旧包焦点。
      win.setOpacity(0)
      win.setSkipTaskbar(true)
      win.showInactive()
      win.restore()
      win.setBounds({ x: 120, y: 80, width: size.width, height: size.height })

      // 不要把箭头函数赋给 const：esbuild/tsx 会给具名函数注入 __name()，
      // 而那个 helper 在 Electron 主进程的 evaluate 沙箱里不存在（pitfall #35）。
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 5000)
        win.once('maximize', () => {
          clearTimeout(timer)
          resolve('maximize')
        })
        win.maximize()
      })

      return { outcome, maximized: win.isMaximized(), bounds: win.getBounds() }
    }, restoredSize)

    assert.equal(before.maximized, true, `window must be maximized first (outcome=${before.outcome})`)
    assert.ok(
      before.bounds.width > restoredSize.width,
      `maximized width ${before.bounds.width} should exceed the restored width`,
    )

    const began = await page.evaluate(() =>
      (window.electronAPI as unknown as DragBridge).beginWindowPointerDrag(),
    )
    assert.equal(began, true, 'a visible maximized window must accept a pointer drag')

    const afterBegin = await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return {
        maximized: win.isMaximized(),
        bounds: win.getBounds(),
        cursor: screen.getCursorScreenPoint(),
      }
    })

    // unmaximize() 之后 getBounds() 必须已经是还原尺寸 —— 这就是设计里那条"按 Windows
    // 行为推断"的同步性假设，纯函数测试用桩窗口证明不了。
    assert.equal(afterBegin.maximized, false, 'begin must restore a maximized window')
    assert.equal(afterBegin.bounds.width, restoredSize.width, 'restored width must be the pre-maximize width')
    assert.equal(afterBegin.bounds.height, restoredSize.height, 'restored height must be the pre-maximize height')

    const insideX =
      afterBegin.cursor.x >= afterBegin.bounds.x - cursorJitterTolerance &&
      afterBegin.cursor.x <= afterBegin.bounds.x + afterBegin.bounds.width + cursorJitterTolerance
    const insideY =
      afterBegin.cursor.y >= afterBegin.bounds.y - cursorJitterTolerance &&
      afterBegin.cursor.y <= afterBegin.bounds.y + afterBegin.bounds.height + cursorJitterTolerance
    assert.ok(
      insideX && insideY,
      `restored window ${JSON.stringify(afterBegin.bounds)} must sit under the cursor ${JSON.stringify(afterBegin.cursor)}`,
    )

    // 一次 move 之后窗口仍跟着光标：offset 在 begin 时固定，move 只是重新读光标。
    await page.evaluate(() => {
      const bridge = window.electronAPI as unknown as DragBridge
      bridge.moveWindowPointerDrag()
    })
    const afterMove = await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return { bounds: win.getBounds(), cursor: screen.getCursorScreenPoint() }
    })
    assert.equal(afterMove.bounds.width, restoredSize.width)
    assert.ok(
      Math.abs(afterMove.bounds.x - afterBegin.bounds.x) <= cursorJitterTolerance &&
        Math.abs(afterMove.bounds.y - afterBegin.bounds.y) <= cursorJitterTolerance,
      `move with a still cursor must not jump the window (${JSON.stringify(afterBegin.bounds)} → ${JSON.stringify(afterMove.bounds)})`,
    )

    await page.evaluate(() => {
      const bridge = window.electronAPI as unknown as DragBridge
      bridge.endWindowPointerDrag()
    })

    // end 之后再发 move 必须是空操作：会话已经结束，窗口不能再跟着光标跑。
    const parked = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setPosition(200, 150)
      return win.getBounds()
    })
    await page.evaluate(() => {
      const bridge = window.electronAPI as unknown as DragBridge
      bridge.moveWindowPointerDrag()
    })
    const afterStrayMove = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds(),
    )
    assert.deepEqual(
      { x: afterStrayMove.x, y: afterStrayMove.y },
      { x: parked.x, y: parked.y },
      'a move after end must not touch the window',
    )
  } finally {
    await app.close()
  }
})

test('topbar pointer drag refuses a minimized window', async (context) => {
  const { app, page } = await launchRuntime(context)

  try {
    const minimized = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setOpacity(0)
      win.setSkipTaskbar(true)
      win.showInactive()
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 5000)
        win.once('minimize', () => {
          clearTimeout(timer)
          resolve('minimize')
        })
        win.minimize()
      })
      return { outcome, minimized: win.isMinimized() }
    })
    assert.equal(minimized.minimized, true, `window must be minimized first (outcome=${minimized.outcome})`)

    const began = await page.evaluate(() =>
      (window.electronAPI as unknown as DragBridge).beginWindowPointerDrag(),
    )
    assert.equal(began, false, 'a minimized window must refuse a pointer drag')
  } finally {
    await app.close()
  }
})
