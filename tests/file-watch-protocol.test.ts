import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDesktopBackend } from '../electron/backend.ts'
import { routeFileWatchEvent } from '../electron/file-watch-routing.ts'
import {
  FileWatcherManager,
  isFileWatchArmed,
  type FileWatchEvent,
} from '../server/file-watcher.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      return false
    }
    await sleep(25)
  }
  return true
}

test('an out-of-workspace path reports a named failure, not a bare false', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-watch-proto-escape-'))
  const manager = new FileWatcherManager(() => {})
  t.after(async () => {
    manager.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  const result = manager.subscribe(workspace, '../escape.txt', 'sub-1')

  assert.deepEqual(result, { subscribed: false, reason: 'outside-workspace' })
  assert.equal(isFileWatchArmed(result), false)
  // The whole point of the reshape: it survives a process boundary unchanged.
  assert.deepEqual(structuredClone(result), result)
})

test('a directory fs.watch cannot arm reports a named failure', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-watch-proto-missing-'))
  const manager = new FileWatcherManager(() => {})
  t.after(async () => {
    manager.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  const result = manager.subscribe(workspace, 'no-such-dir/never.txt', 'sub-1')

  assert.deepEqual(result, { subscribed: false, reason: 'watch-failed' })
  assert.equal(isFileWatchArmed(result), false)
  assert.deepEqual(structuredClone(result), result)
})

test('a lost directory entry reports a named failure', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-watch-proto-lost-'))
  const manager = new FileWatcherManager(() => {})

  // Force the third failure path: the freshly created entry never lands in the
  // directory map, so the post-create lookup comes back empty.
  const directories = (manager as unknown as {
    directories: Map<string, { watcher: { close: () => void } }>
  }).directories
  let orphan: { watcher: { close: () => void } } | null = null
  directories.set = ((_key: string, value: { watcher: { close: () => void } }) => {
    orphan = value
    return directories
  }) as typeof directories.set

  t.after(async () => {
    try {
      orphan?.watcher.close()
    } catch {
      // Best effort: the orphaned watcher never reached the manager's map.
    }
    manager.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'a.txt'), 'one\n', 'utf8')

  const result = manager.subscribe(workspace, 'a.txt', 'sub-1')

  assert.deepEqual(result, { subscribed: false, reason: 'watcher-lost' })
  assert.equal(isFileWatchArmed(result), false)
  assert.deepEqual(structuredClone(result), result)
})

test('a live subscription pushes cloneable events through the shared sink and stops after unsubscribe', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-watch-proto-live-'))
  const events: FileWatchEvent[] = []
  const manager = new FileWatcherManager((event) => {
    events.push(event)
  })
  t.after(async () => {
    manager.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'a.txt'), 'one\n', 'utf8')

  const result = manager.subscribe(workspace, 'a.txt', 'sub-1')
  assert.deepEqual(result, { subscribed: true })
  assert.equal(isFileWatchArmed(result), true)

  // fs.watch needs a beat to arm on Windows before the first mutation.
  await sleep(100)
  await writeFile(path.join(workspace, 'a.txt'), 'two\n', 'utf8')

  assert.equal(await waitFor(() => events.length > 0), true)
  assert.deepEqual(events[0], { subscriptionId: 'sub-1' })
  assert.deepEqual(structuredClone(events[0]), events[0])

  manager.unsubscribe('sub-1')
  events.length = 0

  await sleep(100)
  await writeFile(path.join(workspace, 'a.txt'), 'three\n', 'utf8')
  await sleep(400)

  assert.equal(events.length, 0)
})

test('the desktop backend exposes watchFile as data plus a single event channel', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-watch-proto-backend-'))
  const events: FileWatchEvent[] = []
  const backend = createDesktopBackend({
    onFileWatchEvent: (event) => {
      events.push(event)
    },
  })
  t.after(async () => {
    backend.disposeFileWatchers()
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'a.txt'), 'one\n', 'utf8')

  assert.deepEqual(backend.watchFile(workspace, '../escape.txt', 'bad'), {
    subscribed: false,
    reason: 'outside-workspace',
  })

  const armed = backend.watchFile(workspace, 'a.txt', 'sub-1')
  assert.equal(isFileWatchArmed(armed), true)

  await sleep(100)
  await writeFile(path.join(workspace, 'a.txt'), 'two\n', 'utf8')

  assert.equal(await waitFor(() => events.length > 0), true)
  assert.deepEqual(events[0], { subscriptionId: 'sub-1' })

  backend.unwatchFile('sub-1')
  events.length = 0
  await sleep(100)
  await writeFile(path.join(workspace, 'a.txt'), 'three\n', 'utf8')
  await sleep(400)
  assert.equal(events.length, 0)
})

test('disposeFileWatchers stops the backend event channel', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-watch-proto-dispose-'))
  const events: FileWatchEvent[] = []
  const backend = createDesktopBackend({
    onFileWatchEvent: (event) => {
      events.push(event)
    },
  })
  t.after(async () => {
    backend.disposeFileWatchers()
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'a.txt'), 'one\n', 'utf8')
  assert.equal(isFileWatchArmed(backend.watchFile(workspace, 'a.txt', 'sub-1')), true)

  backend.disposeFileWatchers()

  await sleep(100)
  await writeFile(path.join(workspace, 'a.txt'), 'two\n', 'utf8')
  await sleep(400)

  assert.equal(events.length, 0)
})

// 路由表现在留在主进程，事件通道是唯一的转发点，所以"渲染进程已经死了"这条
// 分支也变成了唯一会在清理路径之外删条目的地方 —— 它必须连带退订后端。
// 症状：删掉路由表条目却不退订 = FileWatcherManager 里那条订阅（及其共享目录
//   的 fs.watch 句柄）永远不会被回收，因为 cleanupSubscriptionsForContentsId
//   是按 fileWatchSubscriptions 遍历的，条目一删它就再也找不到这条订阅了。
// 根因：2026-08-12 —— 旧写法的检查在 per-subscription 闭包里，只是 `return`，
//   条目原样留着等窗口关闭时统一清理；改成进程级 sink 之后这里改成了 delete。
// 为什么不能换写法：不能只是"别 delete"（那就退回到每个事件都对死 sender 做一次
//   isDestroyed 探测），也不能只靠 cleanupSubscriptionsForContentsId（render-process-gone
//   与 isCrashed() 置位之间存在窗口，且它按同一张表遍历）。退订必须在删之前。
// 原来这条用 readFileSync + indexOf 比 main.ts 的源码先后 —— 它既证明不了运行时
// 行为，也会被一次无害的重命名误红（pitfall 248）。现在驱动真实编排、断言真实的
// 调用顺序。
test('the main-process file-watch channel unsubscribes the backend before dropping a dead route', () => {
  const calls: string[] = []
  const routes = new Map<string, { dead: boolean }>([
    ['sub-dead', { dead: true }],
    ['sub-live', { dead: false }],
  ])

  const deps = {
    lookup: (subscriptionId: string) => routes.get(subscriptionId),
    isSenderDead: (target: { dead: boolean }) => target.dead,
    unwatch: (subscriptionId: string) => {
      calls.push(`unwatch:${subscriptionId}`)
    },
    forget: (subscriptionId: string) => {
      calls.push(`forget:${subscriptionId}`)
      routes.delete(subscriptionId)
    },
    deliver: (_target: { dead: boolean }, subscriptionId: string) => {
      calls.push(`deliver:${subscriptionId}`)
    },
  }

  assert.equal(routeFileWatchEvent(deps, 'sub-live'), 'delivered')
  assert.equal(routeFileWatchEvent(deps, 'sub-dead'), 'dropped-dead-renderer')
  assert.equal(routeFileWatchEvent(deps, 'never-registered'), 'unknown')

  assert.deepEqual(
    calls,
    ['deliver:sub-live', 'unwatch:sub-dead', 'forget:sub-dead'],
    'unsubscribe the backend first: after the delete nothing can find this subscription again',
  )
  assert.equal(routes.has('sub-dead'), false, 'the dead-renderer branch no longer drops the route')
})

test('a send failure to a live renderer is reported without dropping the route', () => {
  const reported: string[] = []
  const outcome = routeFileWatchEvent(
    {
      lookup: () => ({}),
      isSenderDead: () => false,
      unwatch: () => assert.fail('a live renderer must not be unwatched'),
      forget: () => assert.fail('a live renderer must not be forgotten'),
      deliver: () => {
        throw new Error('render frame is gone')
      },
      onDeliveryFailed: (subscriptionId, error) => {
        reported.push(`${subscriptionId}:${(error as Error).message}`)
      },
    },
    'sub-live',
  )

  assert.equal(outcome, 'send-failed')
  assert.deepEqual(reported, ['sub-live:render frame is gone'])
})

test('isFileWatchArmed refuses to treat an unresolved promise as success', () => {
  // The exact cross-process trap: once watchFile becomes async, `if (result)`
  // is true for every rejected/failed arm because a Promise is always truthy.
  const pending = Promise.resolve({ subscribed: false, reason: 'watch-failed' })
  assert.equal(isFileWatchArmed(pending), false)

  assert.equal(isFileWatchArmed({ subscribed: true }), true)
  assert.equal(isFileWatchArmed({ subscribed: false, reason: 'watch-failed' }), false)
  assert.equal(isFileWatchArmed({ subscribed: false, reason: 'outside-workspace' }), false)
  assert.equal(isFileWatchArmed({ subscribed: false, reason: 'watcher-lost' }), false)
  assert.equal(isFileWatchArmed(true), false)
  assert.equal(isFileWatchArmed(undefined), false)
  assert.equal(isFileWatchArmed(null), false)
})
