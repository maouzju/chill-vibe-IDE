import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { FileWatcherManager } from '../server/file-watcher.js'

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

test('file watcher notifies subscribers when the watched file changes', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-watch-basic-'))
  let notified = 0
  const manager = new FileWatcherManager(() => {
    notified += 1
  })
  t.after(async () => {
    manager.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'a.txt'), 'one\n', 'utf8')

  assert.deepEqual(manager.subscribe(workspace, 'a.txt', 'sub-1'), { subscribed: true })

  // fs.watch needs a beat to arm on Windows before the first mutation.
  await new Promise((resolve) => setTimeout(resolve, 100))
  await writeFile(path.join(workspace, 'a.txt'), 'two\n', 'utf8')

  assert.equal(await waitFor(() => notified > 0), true)
})

test('file watcher stops notifying after unsubscribe', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-watch-unsub-'))
  let notified = 0
  const manager = new FileWatcherManager(() => {
    notified += 1
  })
  t.after(async () => {
    manager.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'a.txt'), 'one\n', 'utf8')

  manager.subscribe(workspace, 'a.txt', 'sub-1')
  manager.unsubscribe('sub-1')

  await new Promise((resolve) => setTimeout(resolve, 100))
  await writeFile(path.join(workspace, 'a.txt'), 'two\n', 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.equal(notified, 0)
})

test('file watcher keeps sibling-file subscriptions independent in a shared directory', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-watch-sibling-'))
  let aNotified = 0
  let bNotified = 0
  const manager = new FileWatcherManager(({ subscriptionId }) => {
    if (subscriptionId === 'sub-a') {
      aNotified += 1
    }
    if (subscriptionId === 'sub-b') {
      bNotified += 1
    }
  })
  t.after(async () => {
    manager.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'a.txt'), 'a\n', 'utf8')
  await writeFile(path.join(workspace, 'b.txt'), 'b\n', 'utf8')

  manager.subscribe(workspace, 'a.txt', 'sub-a')
  manager.subscribe(workspace, 'b.txt', 'sub-b')

  await new Promise((resolve) => setTimeout(resolve, 100))
  await writeFile(path.join(workspace, 'b.txt'), 'b2\n', 'utf8')

  assert.equal(await waitFor(() => bNotified > 0), true)
  // Give any stray a.txt event a moment to prove itself absent.
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(aNotified, 0)

  // Unsubscribing one sibling must keep the other alive on the shared watcher.
  manager.unsubscribe('sub-b')
  await new Promise((resolve) => setTimeout(resolve, 100))
  await writeFile(path.join(workspace, 'a.txt'), 'a2\n', 'utf8')
  assert.equal(await waitFor(() => aNotified > 0), true)
})

test('file watcher rejects paths outside the workspace', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-watch-escape-'))
  const manager = new FileWatcherManager(() => {})
  t.after(async () => {
    manager.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  assert.deepEqual(manager.subscribe(workspace, '../escape.txt', 'sub-1'), {
    subscribed: false,
    reason: 'outside-workspace',
  })
})

test('file watcher survives watching a missing directory by reporting failure', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-watch-missing-'))
  const manager = new FileWatcherManager(() => {})
  t.after(async () => {
    manager.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  assert.deepEqual(manager.subscribe(workspace, 'no-such-dir/never.txt', 'sub-1'), {
    subscribed: false,
    reason: 'watch-failed',
  })
})

test('dispose closes every watcher and clears subscriptions', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-watch-dispose-'))
  let notified = 0
  const manager = new FileWatcherManager(() => {
    notified += 1
  })
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'a.txt'), 'a\n', 'utf8')

  manager.subscribe(workspace, 'a.txt', 'sub-1')
  manager.dispose()

  await new Promise((resolve) => setTimeout(resolve, 100))
  await writeFile(path.join(workspace, 'a.txt'), 'a2\n', 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.equal(notified, 0)
})
