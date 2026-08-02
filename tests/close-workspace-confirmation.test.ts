import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { runWorkspaceClose } from '../src/app-helpers.ts'

type CloseTrace = string[]

/**
 * 驱动真正的关闭编排，记录副作用发生的先后。
 * `liveColumn` 只有在 flush 跑过之后才会变成"带上缓冲区内容"的那一份——这样测试就能
 * 分辨快照到底读的是 flush 前还是 flush 后的数据，而不是只看代码文本的先后。
 */
const runCloseWithTrace = async (options: {
  cardIds: string[]
  snapshotFails?: boolean
} = { cardIds: ['card-1', 'card-2'] }) => {
  const trace: CloseTrace = []
  const flushed = new Set<string>()
  let snapshotted: { flushedCardCount: number } | null = null

  const run = runWorkspaceClose<{ workspacePath: string; flushedCardCount: number }>({
    cardIds: options.cardIds,
    flushCardBuffers: (cardId) => {
      flushed.add(cardId)
      trace.push(`flush:${cardId}`)
    },
    readColumn: () => {
      trace.push('readColumn')
      return { workspacePath: 'D:/repo', flushedCardCount: flushed.size }
    },
    shouldSnapshot: (column) => Boolean(column.workspacePath.trim()),
    saveSnapshot: async (column) => {
      trace.push('saveSnapshot')
      snapshotted = { flushedCardCount: column.flushedCardCount }
      if (options.snapshotFails) {
        throw new Error('disk full')
      }
    },
    clearQueuedSends: (cardId) => trace.push(`clearQueuedSends:${cardId}`),
    closeStream: async (cardId) => {
      trace.push(`closeStream:${cardId}`)
    },
    removeColumn: () => trace.push('removeColumn'),
  })

  return { run, trace, getSnapshotted: () => snapshotted }
}

test('workspace close is guarded by an in-app confirmation dialog', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

  assert.match(source, /closeWorkspaceDialogColumnId/)
  assert.match(source, /role="dialog"/)
  assert.match(source, /closeWorkspaceDialogHistory/)
  assert.match(source, /onRemoveColumn=\{\(\) => openCloseWorkspaceDialog\(column\.id\)\}/)
  assert.doesNotMatch(source, /onRemoveColumn=\{\(\) => void removeColumn\(column\.id\)\}/)
})

// 旧版这三条断言是对 App.tsx 源码切片做 indexOf 比大小的文本快照：它证明不了运行时顺序，
// 对等价重构会误红，而且恰恰放过了"快照抢在 flush 之前"这个真实回归——文本上快照确实
// 排在破坏性步骤之前，全绿，可缓冲区里的最后一段回复照样丢了。改成驱动真实编排。
test('workspace close flushes render buffers before it snapshots', async () => {
  const { run, trace, getSnapshotted } = await runCloseWithTrace({ cardIds: ['card-1', 'card-2'] })
  await run

  const snapshotIndex = trace.indexOf('saveSnapshot')
  assert.ok(snapshotIndex >= 0, 'closing should still save a snapshot')

  for (const cardId of ['card-1', 'card-2']) {
    const flushIndex = trace.indexOf(`flush:${cardId}`)
    assert.ok(flushIndex >= 0, `${cardId} should have its render buffers flushed`)
    assert.ok(
      flushIndex < snapshotIndex,
      `${cardId}: buffered assistant text must reach the state before the snapshot is taken`,
    )
  }

  // 光有顺序还不够：快照读到的必须是 flush **之后**那一份数据。以前的写法用的是函数
  // 入口捕获的旧引用，顺序对了内容还是旧的。
  assert.deepEqual(
    getSnapshotted(),
    { flushedCardCount: 2 },
    'the snapshot must read the column re-read after flushing, not a stale pre-flush reference',
  )
})

test('workspace close persists the snapshot before any destructive teardown', async () => {
  const { run, trace } = await runCloseWithTrace({ cardIds: ['card-1', 'card-2'] })
  await run

  const snapshotIndex = trace.indexOf('saveSnapshot')
  const firstDestructiveIndex = trace.findIndex(
    (step) => step.startsWith('clearQueuedSends:') || step.startsWith('closeStream:'),
  )

  assert.ok(firstDestructiveIndex >= 0, 'closing should still tear the column down')
  assert.ok(
    snapshotIndex < firstDestructiveIndex,
    'the queued sends and running agents must already be durable before anything is destroyed',
  )
  assert.equal(trace.at(-1), 'removeColumn', 'the column is removed last')
})

// 快照是整条链路里唯一可能失败的一步（磁盘满 / 权限 / 桥断）。它失败时如果破坏性步骤
// 已经跑过，重试只会存下一个空队列——所以必须一步都还没做。
test('a failed workspace-close snapshot aborts before destroying anything', async () => {
  const { run, trace } = await runCloseWithTrace({
    cardIds: ['card-1', 'card-2'],
    snapshotFails: true,
  })

  await assert.rejects(run, /disk full/)

  assert.deepEqual(
    trace.filter((step) => step.startsWith('clearQueuedSends:') || step.startsWith('closeStream:')),
    [],
    'a failed snapshot must not clear any queue or kill any agent',
  )
  assert.ok(!trace.includes('removeColumn'), 'a failed snapshot must not remove the column')
})

test('workspace close saves a restorable snapshot before removal and reopen consumes it', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const saveSnapshotIndex = source.indexOf('await saveClosedWorkspaceSnapshot({')
  const removeColumnIndex = source.indexOf("applyAction({ type: 'removeColumn', columnId, workspaceCloseId })")

  assert.ok(saveSnapshotIndex >= 0, 'closing should save the exact workspace tab snapshot')
  assert.ok(removeColumnIndex > saveSnapshotIndex, 'the sidecar must be durable before the column is removed')
  assert.match(source, /await loadClosedWorkspaceSnapshot\(\{ workspacePath: trimmedPath \}\)/)
  assert.match(source, /type: 'restoreClosedWorkspace'/)
  assert.match(source, /type: 'restoreLegacyClosedWorkspace'/)
})
