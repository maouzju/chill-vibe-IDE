import assert from 'node:assert/strict'
import test from 'node:test'

import { attachFileTreeAutoRefreshTriggers } from '../src/components/file-tree-refresh.ts'

type Listener = (event?: unknown) => void

const createFakeWindow = () => {
  const windowListeners = new Map<string, Set<Listener>>()
  const documentListeners = new Map<string, Set<Listener>>()
  const hoverTargetListeners = new Map<string, Set<Listener>>()

  const fakeWindow = {
    addEventListener(name: string, listener: Listener) {
      if (!windowListeners.has(name)) windowListeners.set(name, new Set())
      windowListeners.get(name)!.add(listener)
    },
    removeEventListener(name: string, listener: Listener) {
      windowListeners.get(name)?.delete(listener)
    },
  }

  const fakeDocument = {
    visibilityState: 'visible' as 'visible' | 'hidden',
    addEventListener(name: string, listener: Listener) {
      if (!documentListeners.has(name)) documentListeners.set(name, new Set())
      documentListeners.get(name)!.add(listener)
    },
    removeEventListener(name: string, listener: Listener) {
      documentListeners.get(name)?.delete(listener)
    },
  }

  const fakeHoverTarget = {
    addEventListener(name: string, listener: Listener) {
      if (!hoverTargetListeners.has(name)) hoverTargetListeners.set(name, new Set())
      hoverTargetListeners.get(name)!.add(listener)
    },
    removeEventListener(name: string, listener: Listener) {
      hoverTargetListeners.get(name)?.delete(listener)
    },
  }

  return {
    fakeWindow,
    fakeDocument,
    fakeHoverTarget,
    fire(target: 'window' | 'document' | 'hoverTarget', name: string) {
      const bucket = target === 'window'
        ? windowListeners
        : target === 'document'
          ? documentListeners
          : hoverTargetListeners
      bucket.get(name)?.forEach((listener) => listener())
    },
    listenerCount(target: 'window' | 'document' | 'hoverTarget', name: string) {
      const bucket = target === 'window'
        ? windowListeners
        : target === 'document'
          ? documentListeners
          : hoverTargetListeners
      return bucket.get(name)?.size ?? 0
    },
  }
}

test('attachFileTreeAutoRefreshTriggers runs refresh when the window regains focus', () => {
  const env = createFakeWindow()
  let refreshCalls = 0

  const detach = attachFileTreeAutoRefreshTriggers({
    win: env.fakeWindow,
    doc: env.fakeDocument,
    onRefresh: () => {
      refreshCalls += 1
    },
  })

  env.fire('window', 'focus')
  assert.equal(refreshCalls, 1)

  detach()
})

test('attachFileTreeAutoRefreshTriggers runs refresh when the document becomes visible again', () => {
  const env = createFakeWindow()
  let refreshCalls = 0

  const detach = attachFileTreeAutoRefreshTriggers({
    win: env.fakeWindow,
    doc: env.fakeDocument,
    onRefresh: () => {
      refreshCalls += 1
    },
  })

  env.fakeDocument.visibilityState = 'hidden'
  env.fire('document', 'visibilitychange')
  assert.equal(refreshCalls, 0, 'should not refresh while hidden')

  env.fakeDocument.visibilityState = 'visible'
  env.fire('document', 'visibilitychange')
  assert.equal(refreshCalls, 1, 'should refresh when visible again')

  detach()
})

test('attachFileTreeAutoRefreshTriggers runs refresh every time the file tree card is hovered', () => {
  const env = createFakeWindow()
  let refreshCalls = 0

  const detach = attachFileTreeAutoRefreshTriggers({
    win: env.fakeWindow,
    doc: env.fakeDocument,
    hoverTarget: env.fakeHoverTarget,
    onRefresh: () => {
      refreshCalls += 1
    },
  })

  env.fire('hoverTarget', 'pointerenter')
  env.fire('hoverTarget', 'pointerenter')

  assert.equal(refreshCalls, 2)

  detach()
})

test('attachFileTreeAutoRefreshTriggers detaches all listeners on teardown', () => {
  const env = createFakeWindow()

  const detach = attachFileTreeAutoRefreshTriggers({
    win: env.fakeWindow,
    doc: env.fakeDocument,
    hoverTarget: env.fakeHoverTarget,
    onRefresh: () => undefined,
  })

  assert.equal(env.listenerCount('window', 'focus'), 1)
  assert.equal(env.listenerCount('document', 'visibilitychange'), 1)
  assert.equal(env.listenerCount('hoverTarget', 'pointerenter'), 1)

  detach()

  assert.equal(env.listenerCount('window', 'focus'), 0)
  assert.equal(env.listenerCount('document', 'visibilitychange'), 0)
  assert.equal(env.listenerCount('hoverTarget', 'pointerenter'), 0)
})
