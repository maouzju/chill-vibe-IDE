import assert from 'node:assert/strict'
import test from 'node:test'

import { flashWindowOnce, focusPrimaryWindow, presentWindow } from '../electron/window-lifecycle.ts'

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
