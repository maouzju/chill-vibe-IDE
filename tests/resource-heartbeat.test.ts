import assert from 'node:assert/strict'
import test from 'node:test'

import { buildResourceHeartbeatSnapshot } from '../electron/resource-heartbeat.ts'

test('resource heartbeat aggregates byte-based Node memory and KB-based Electron metrics in MB', () => {
  const snapshot = buildResourceHeartbeatSnapshot({
    processMemory: {
      rss: 256 * 1024 * 1024,
      heapUsed: 96 * 1024 * 1024,
      external: 12 * 1024 * 1024,
      arrayBuffers: 4 * 1024 * 1024,
    },
    systemFreeBytes: 8 * 1024 * 1024 * 1024,
    systemTotalBytes: 32 * 1024 * 1024 * 1024,
    appMetrics: [
      { memory: { privateBytes: 256 * 1024, workingSetSize: 192 * 1024 } },
      { memory: { privateBytes: 128 * 1024, workingSetSize: 96 * 1024 } },
    ],
  })

  assert.deepEqual(snapshot, {
    systemFreeMb: 8192,
    systemTotalMb: 32768,
    mainRssMb: 256,
    mainHeapUsedMb: 96,
    mainExternalMb: 16,
    electronProcessCount: 2,
    electronPrivateMb: 384,
    electronWorkingSetMb: 288,
  })
})

const baseInput = {
  processMemory: {
    rss: 256 * 1024 * 1024,
    heapUsed: 96 * 1024 * 1024,
    external: 12 * 1024 * 1024,
    arrayBuffers: 4 * 1024 * 1024,
  },
  systemFreeBytes: 8 * 1024 * 1024 * 1024,
  systemTotalBytes: 64 * 1024 * 1024 * 1024,
  appMetrics: [],
}

// 症状：08-06/08-09 三次整窗口闪退，Windows 事件日志无崩溃记录、crashReporter 无 dump、
// main.log 无 process exit —— 三缺，无从下手。
// 根因：系统提交内存顶到上限（实测 118.8/131.9 GB = 90%），新提交失败导致主进程被立即终止；
// 连写 minidump 都要提交内存，所以证据全灭。心跳当时只记录 systemFreeMb（物理空闲 5-8GB，看着完全正常）。
// 为什么不能换写法：Node 的 os.freemem() 拿不到提交量。Windows 上 GlobalMemoryStatusEx 的
// ullTotalPageFile/ullAvailPageFile 才是 commit limit / 剩余可提交，Electron 通过
// process.getSystemMemoryInfo() 的 swapTotal/swapFree 暴露它们。Linux 上同名字段是真 swap，
// 语义不同，所以按 platform 门控。
test('resource heartbeat reports Windows commit charge from swap fields', () => {
  const snapshot = buildResourceHeartbeatSnapshot({
    ...baseInput,
    platform: 'win32',
    systemMemoryInfo: {
      swapTotal: 131.9 * 1024 * 1024,
      swapFree: 13.1 * 1024 * 1024,
    },
  })

  assert.equal(snapshot.systemCommitLimitMb, 135066)
  assert.equal(snapshot.systemCommittedMb, 121651)
  assert.equal(snapshot.systemCommitPercent, 90)
  assert.equal(snapshot.commitPressure, 'high')
})

test('resource heartbeat flags critical commit pressure past 93 percent', () => {
  const snapshot = buildResourceHeartbeatSnapshot({
    ...baseInput,
    platform: 'win32',
    systemMemoryInfo: { swapTotal: 100 * 1024 * 1024, swapFree: 5 * 1024 * 1024 },
  })

  assert.equal(snapshot.systemCommitPercent, 95)
  assert.equal(snapshot.commitPressure, 'critical')
})

test('resource heartbeat omits commit fields when swap semantics do not mean commit charge', () => {
  const linux = buildResourceHeartbeatSnapshot({
    ...baseInput,
    platform: 'linux',
    systemMemoryInfo: { swapTotal: 8 * 1024 * 1024, swapFree: 8 * 1024 * 1024 },
  })
  assert.equal('systemCommitPercent' in linux, false)
  assert.equal('commitPressure' in linux, false)

  // Windows 也可能关掉页面文件或拿不到数据，此时不能凭空报压力
  const noData = buildResourceHeartbeatSnapshot({
    ...baseInput,
    platform: 'win32',
    systemMemoryInfo: { swapTotal: 0, swapFree: 0 },
  })
  assert.equal('systemCommitPercent' in noData, false)
})

