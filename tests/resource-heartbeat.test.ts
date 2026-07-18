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

