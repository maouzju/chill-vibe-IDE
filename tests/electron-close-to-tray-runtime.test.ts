import assert from 'node:assert/strict'
import test from 'node:test'

import { _electron as electron } from '@playwright/test'
import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

// 症状：用户开了「关闭后最小化到任务栏」，点 X 只是把窗口缩起来，应用还占着任务栏，
//   与点「—」毫无区别，用户判定这个设置「根本没有实现」（2026-08-17）。
// 根因：主进程只有 win.minimize() 一条路径，从来没有真正隐藏窗口。
// 这条用例守的是两档之间的可观测差异，源码正则守卫替代不了。
// 判别不看 isVisible()：最小化和隐藏之后它都是 false，区分不开两者。
// 看窗口自己发出的终态事件 —— minimize 档发 'minimize'，托盘档发 'hide'。
const launchRuntime = async () => {
  await ensureElectronRuntimeBuild()

  const env = createHeadlessElectronRuntimeEnv({
    VITE_DEV_SERVER_URL: getElectronTestRendererUrl(),
    CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
  })

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env,
  })

  const page = await app.firstWindow()
  // 必须等渲染端把界面挂起来再改设置：启动流程自己会同步一次 runtime settings，
  // 抢在它前面写入的 closeBehavior 会被那次同步覆盖回默认值，
  // 表现为这条用例随机失败在「窗口被销毁」上。
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

const applyCloseBehavior = async (
  page: Awaited<ReturnType<typeof launchRuntime>>['page'],
  closeBehavior: 'quit' | 'minimize' | 'tray',
) => {
  const applied = await page.evaluate(async (behavior) => {
    const api = window.electronAPI as unknown as {
      fetchState: () => Promise<{ settings: Record<string, unknown> }>
      syncRuntimeSettings: (settings: unknown) => Promise<unknown>
    }
    const state = await api.fetchState()
    await api.syncRuntimeSettings({ ...state.settings, closeBehavior: behavior })
    return behavior
  }, closeBehavior)

  assert.equal(applied, closeBehavior)
}

// 主进程里把窗口摆到一个可判定的起点：可见、未最小化。
const showWindow = async (app: Awaited<ReturnType<typeof launchRuntime>>['app']) =>
  app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.show()
    win.restore()
    return { visible: win.isVisible(), minimized: win.isMinimized() }
  })

// 固定延时后采样 isMinimized() 是不稳的（实测同一份代码两次运行结论相反）。
// 改为等窗口自己发出终态事件，断言的就是「关闭到底触发了哪一种归宿」。
const closeAndInspect = async (app: Awaited<ReturnType<typeof launchRuntime>>['app']) =>
  app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]

    // 不要把箭头函数赋给 const：esbuild/tsx 会给具名函数注入 __name(),
    // 而那个 helper 在 Electron 主进程的 evaluate 沙箱里不存在（同 pitfall #35）。
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('none'), 5000)

      win.once('minimize', () => {
        clearTimeout(timer)
        resolve('minimize')
      })
      win.once('hide', () => {
        clearTimeout(timer)
        resolve('hide')
      })
      win.once('closed', () => {
        clearTimeout(timer)
        resolve('closed')
      })
      win.close()
    })

    return {
      outcome,
      destroyed: win.isDestroyed(),
      visible: win.isDestroyed() ? null : win.isVisible(),
    }
  })

test('close-to-tray hides the window instead of only shrinking it', async () => {
  const { app, page } = await launchRuntime()

  try {
    await applyCloseBehavior(page, 'tray')

    const before = await showWindow(app)
    assert.equal(before.visible, true, 'window should start visible')

    const after = await closeAndInspect(app)

    assert.equal(
      after.destroyed,
      false,
      `closing must not destroy the window or quit the app (outcome=${after.outcome}, visible=${after.visible})`,
    )
    // 这一条就是用户抱怨的那个差异：藏起来了，而不是缩在任务栏里。
    assert.equal(after.outcome, 'hide', 'tray behavior must hide rather than shrink to the taskbar')
    assert.equal(after.visible, false, 'tray behavior must actually hide the window')
  } finally {
    await app.close()
  }
})

test('minimize behavior still leaves the window in the taskbar', async () => {
  const { app, page } = await launchRuntime()

  try {
    await applyCloseBehavior(page, 'minimize')

    const before = await showWindow(app)
    assert.equal(before.visible, true, 'window should start visible')

    const after = await closeAndInspect(app)

    assert.equal(
      after.destroyed,
      false,
      `closing must not destroy the window or quit the app (outcome=${after.outcome}, visible=${after.visible})`,
    )
    // 与托盘档的分水岭：最小化保留任务栏格位，托盘档则让出格位。
    assert.equal(after.outcome, 'minimize', 'minimize behavior must minimize the window')
  } finally {
    await app.close()
  }
})
