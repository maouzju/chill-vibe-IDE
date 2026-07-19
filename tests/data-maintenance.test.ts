import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  readDataMaintenanceLedger,
  resetDataMaintenanceCoordinatorForTests,
  runDataMaintenanceSlice,
  type DataMaintenanceTask,
} from '../server/data-maintenance.ts'

describe('cross-version data maintenance coordinator', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    resetDataMaintenanceCoordinatorForTests()
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  const makeDataDir = async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-maintenance-'))
    tempDirs.push(directory)
    return directory
  }

  it('persists resumable task progress and only reruns a completed task when its version increases', async () => {
    const dataDir = await makeDataDir()
    const seenCursors: Array<string | undefined> = []
    const makeTask = (version: number): DataMaintenanceTask => ({
      id: 'fixture-task',
      version,
      async runSlice({ previous }) {
        seenCursors.push(previous?.cursor)
        if (previous?.cursor !== 'halfway') {
          return {
            phase: 'running',
            cursor: 'halfway',
            processedDelta: 2,
            total: 4,
          }
        }
        return {
          phase: 'complete',
          cursor: 'done',
          processedDelta: 2,
          total: 4,
        }
      },
    })

    await runDataMaintenanceSlice({ dataDir, tasks: [makeTask(1)] })
    await runDataMaintenanceSlice({ dataDir, tasks: [makeTask(1)] })
    await runDataMaintenanceSlice({ dataDir, tasks: [makeTask(1)] })

    assert.deepEqual(seenCursors, [undefined, 'halfway'])
    const completed = (await readDataMaintenanceLedger(dataDir)).tasks['fixture-task']
    assert.ok(completed)
    assert.match(completed.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual({ ...completed, updatedAt: '<timestamp>' }, {
      version: 1,
      phase: 'complete',
      cursor: 'done',
      processed: 4,
      skipped: 0,
      total: 4,
      updatedAt: '<timestamp>',
      lastError: undefined,
    })

    await runDataMaintenanceSlice({ dataDir, tasks: [makeTask(2)] })
    assert.equal(seenCursors.at(-1), undefined, 'a higher task version must start from a clean checkpoint')
  })

  it('single-flights concurrent slices and degrades a throwing task without rejecting startup callers', async () => {
    const dataDir = await makeDataDir()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const task: DataMaintenanceTask = {
      id: 'single-flight-task',
      version: 1,
      async runSlice() {
        calls += 1
        await gate
        throw new Error('fixture maintenance failure')
      },
    }

    const first = runDataMaintenanceSlice({ dataDir, tasks: [task] })
    const second = runDataMaintenanceSlice({ dataDir, tasks: [task] })
    release?.()
    const [firstResult, secondResult] = await Promise.all([first, second])

    assert.equal(calls, 1)
    assert.deepEqual(firstResult, secondResult)
    assert.equal(firstResult.tasks['single-flight-task']?.phase, 'degraded')
    assert.match(firstResult.tasks['single-flight-task']?.lastError ?? '', /fixture maintenance failure/)
  })
})
