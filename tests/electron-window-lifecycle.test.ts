import assert from 'node:assert/strict'
import test from 'node:test'

import {
  flashWindowOnce,
  focusPrimaryWindow,
  presentWindow,
  resolveWindowCloseAction,
} from '../electron/window-lifecycle.ts'

const createWindow = ({
  destroyed = false,
  visible = false,
  minimized = false,
  focused = false,
}: {
  destroyed?: boolean
  visible?: boolean
  minimized?: boolean
  focused?: boolean
} = {}) => {
  const calls: string[] = []

  return {
    calls,
    win: {
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      isMinimized: () => minimized,
      isFocused: () => focused,
      restore: () => {
        calls.push('restore')
        minimized = false
      },
      show: () => {
        calls.push('show')
        visible = true
      },
      focus: () => {
        calls.push('focus')
      },
      moveTop: () => {
        calls.push('moveTop')
      },
      flashFrame: (value: boolean) => {
        calls.push(`flash:${value}`)
      },
    },
  }
}

test('presentWindow restores, shows, and focuses a minimized hidden window', () => {
  const target = createWindow({ visible: false, minimized: true })

  assert.equal(presentWindow(target.win), true)
  assert.deepEqual(target.calls, ['restore', 'show', 'moveTop', 'focus'])
})

test('presentWindow ignores destroyed windows', () => {
  const target = createWindow({ destroyed: true })

  assert.equal(presentWindow(target.win), false)
  assert.deepEqual(target.calls, [])
})

test('focusPrimaryWindow presents the first live window', () => {
  const dead = createWindow({ destroyed: true })
  const live = createWindow({ visible: true, minimized: false })

  assert.equal(focusPrimaryWindow([dead.win, live.win]), true)
  assert.deepEqual(dead.calls, [])
  assert.deepEqual(live.calls, ['moveTop', 'focus'])
})

test('flashWindowOnce requests attention briefly for a background window', async () => {
  const target = createWindow({ visible: true, minimized: false, focused: false })

  assert.equal(flashWindowOnce(target.win, 10), true)
  await new Promise((resolve) => setTimeout(resolve, 140))

  assert.deepEqual(target.calls, ['flash:true', 'flash:false'])
})

test('flashWindowOnce skips already focused windows', () => {
  const target = createWindow({ visible: true, minimized: false, focused: true })

  assert.equal(flashWindowOnce(target.win, 10), false)
  assert.deepEqual(target.calls, [])
})

test('window close minimizes when the close behavior asks for the taskbar', () => {
  assert.equal(
    resolveWindowCloseAction({
      platform: 'win32',
      closeBehavior: 'minimize',
      quitAfterFlushPending: false,
    }),
    'minimize',
  )
})

// 症状：用户开了“关闭后最小化到任务栏”，点 X 只是把窗口缩起来，应用仍占着任务栏，
//   与“—”按钮没有区别，用户判定该设置“根本没实现”。
// 根因：只有 minimize 一档，从来没有真正把窗口藏起来的路径。
// 被否决的替代：把 minimize 直接改成 hide —— 那会删掉一部分用户依赖的任务栏入口，
//   所以改为三态，让两种期望各自可选。
test('window close hides to the tray when the close behavior asks for it', () => {
  assert.equal(
    resolveWindowCloseAction({
      platform: 'win32',
      closeBehavior: 'tray',
      quitAfterFlushPending: false,
    }),
    'hide-to-tray',
  )
})

test('window close never blocks an explicit quit already in progress', () => {
  for (const closeBehavior of ['minimize', 'tray'] as const) {
    assert.equal(
      resolveWindowCloseAction({
        platform: 'win32',
        closeBehavior,
        quitAfterFlushPending: true,
      }),
      'allow-close',
    )
  }
})

test('window close preserves the existing platform behavior when set to quit', () => {
  assert.equal(
    resolveWindowCloseAction({
      platform: 'win32',
      closeBehavior: 'quit',
      quitAfterFlushPending: false,
    }),
    'quit-after-flush',
  )
  assert.equal(
    resolveWindowCloseAction({
      platform: 'darwin',
      closeBehavior: 'quit',
      quitAfterFlushPending: false,
    }),
    'allow-close',
  )
})

// macOS 没有 Windows 那种任务栏/托盘二分，托盘档在那里等价于隐藏窗口留 Dock 图标，
// 但绝不能变成退出，否则勾了“不退出”的用户反而丢掉正在跑的 Agent。
test('tray behavior still keeps macOS windows alive', () => {
  assert.equal(
    resolveWindowCloseAction({
      platform: 'darwin',
      closeBehavior: 'tray',
      quitAfterFlushPending: false,
    }),
    'hide-to-tray',
  )
})
