import assert from 'node:assert/strict'
import test from 'node:test'

import { runBackendSideEffect, toAmbientAudioBuffer } from '../electron/backend-call-guards.ts'

// 症状 — 窗口每 20 秒消失一次（2026-07-26，畸形 wake-timer 队列条目）。
// 根因 — `ipcMain.on('desktop:queue-state-save')` 没有回复通道，handler 里逃出来的
//   任何东西都变成 uncaughtException 并终结整个 app。后端搬进 utilityProcess 之后
//   `queueStateSave` 由同步抛变成 rejected Promise，原来那圈 try/catch 直接成为死
//   代码 —— 症状会原样复发。
test('a rejected backend side effect is caught instead of killing the app', { timeout: 10_000 }, async () => {
  const caught: string[] = []

  runBackendSideEffect(
    () => Promise.reject(new Error('queued save exploded')),
    (error) => {
      caught.push(error.message)
    },
  )

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(caught, ['queued save exploded'])
})

test('a synchronous throw from the same call site is still caught', { timeout: 10_000 }, async () => {
  const caught: string[] = []

  runBackendSideEffect(
    () => {
      throw new Error('same-process throw')
    },
    (error) => {
      caught.push(error.message)
    },
  )

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(caught, ['same-process throw'])
})

test('a successful side effect reports nothing', { timeout: 10_000 }, async () => {
  const caught: string[] = []

  runBackendSideEffect(
    () => Promise.resolve('fine'),
    (error) => {
      caught.push(error.message)
    },
  )

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(caught, [])
})

// 症状 — 白噪音音频读出来是一段"看起来对但用不了"的数据。
// 根因 — `backend.readAmbientAudioBuffer` 声明返回 `Buffer`，结构化克隆只保字节、
//   不保原型，跨进程之后到手的是普通 `Uint8Array`。调用点按 Buffer 用（`.toString`
//   之类）就会走到完全不同的实现上。
test('an ambient audio payload that lost its Buffer prototype is restored byte for byte', { timeout: 10_000 }, () => {
  const original = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff])
  const crossedTheBoundary = new Uint8Array(original)

  assert.equal(Buffer.isBuffer(crossedTheBoundary), false, 'the fixture is not modelling the bug')

  const restored = toAmbientAudioBuffer(crossedTheBoundary)

  assert.equal(Buffer.isBuffer(restored), true)
  assert.deepEqual([...restored], [...original])
})

test('a payload that is already a Buffer is not copied again', { timeout: 10_000 }, () => {
  const original = Buffer.from('ambient')

  assert.equal(toAmbientAudioBuffer(original), original)
})

// 视图窗口必须被尊重：结构化克隆可以把一个 subarray 还原成"整块 ArrayBuffer + 偏移"，
// 用 Buffer.from(view.buffer) 会多带出前后的字节。
test('a byte-offset view keeps its own window', { timeout: 10_000 }, () => {
  const backing = new Uint8Array([1, 2, 3, 4, 5])
  const view = backing.subarray(1, 4)

  assert.deepEqual([...toAmbientAudioBuffer(view)], [2, 3, 4])
})
