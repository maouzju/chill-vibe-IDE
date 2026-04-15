import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { createDefaultState } from '../shared/default-state.ts'
import { getImageAttachmentUrl } from '../shared/chat-attachments.ts'
import {
  closeWindow,
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntry,
  fetchSlashCommands,
  fetchState,
  flashWindowOnce,
  isWindowMaximized,
  minimizeWindow,
  moveWorkspaceEntry,
  onWindowMaximizedChanged,
  openChatStream,
  queueStateSave,
  renameWorkspaceEntry,
  toggleMaximizeWindow,
} from '../src/api.ts'

type ElectronBridgeWindow = Window & typeof globalThis & {
  electronAPI?: {
    minimizeWindow?: () => Promise<void>
    toggleMaximizeWindow?: () => Promise<boolean>
    closeWindow?: () => Promise<void>
    flashWindowOnce?: () => Promise<boolean>
    isWindowMaximized?: () => Promise<boolean>
    onWindowMaximizedChanged?: (listener: (maximized: boolean) => void) => () => void
    fetchState?: () => Promise<ReturnType<typeof createDefaultState>>
    fetchSlashCommands?: (request: { provider: 'codex' | 'claude'; workspacePath: string; language: 'en' | 'zh-CN' }) => Promise<Array<{ name: string; description?: string; source?: 'app' | 'native' }>>
    queueStateSave?: (state: ReturnType<typeof createDefaultState>) => void
    getAttachmentUrl?: (attachmentId: string) => string
    createFile?: (request: { workspacePath: string; parentRelativePath: string; name: string }) => Promise<void>
    createDirectory?: (request: { workspacePath: string; parentRelativePath: string; name: string }) => Promise<void>
    renameEntry?: (request: { workspacePath: string; relativePath: string; nextName: string }) => Promise<void>
    moveEntry?: (request: { workspacePath: string; relativePath: string; destinationParentRelativePath: string }) => Promise<void>
    deleteEntry?: (request: { workspacePath: string; relativePath: string }) => Promise<void>
    subscribeChatStream?: (streamId: string, subscriptionId: string) => Promise<void>
    unsubscribeChatStream?: (subscriptionId: string) => Promise<void>
  }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource')
const originalFetch = globalThis.fetch

const restoreGlobals = () => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }

  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', originalNavigator)
  } else {
    Reflect.deleteProperty(globalThis, 'navigator')
  }

  if (originalEventSource) {
    Object.defineProperty(globalThis, 'EventSource', originalEventSource)
  } else {
    Reflect.deleteProperty(globalThis, 'EventSource')
  }

  globalThis.fetch = originalFetch
}

const setWindow = (value: ElectronBridgeWindow | undefined) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: value as unknown,
  })
}

beforeEach(() => {
  setWindow(undefined)
})

afterEach(() => {
  restoreGlobals()
})

test('fetchState uses the Electron bridge when available', async () => {
  const expectedState = createDefaultState('D:/workspace')
  let fetchCalls = 0

  globalThis.fetch = (async () => {
    fetchCalls += 1
    throw new Error('fetch should not be used in Electron mode')
  }) as typeof fetch

  setWindow({
    electronAPI: {
      fetchState: async () => expectedState,
    },
  } as ElectronBridgeWindow)

  const state = await fetchState()

  assert.deepEqual(state, {
    state: expectedState,
    recovery: {
      startup: null,
      recentCrash: null,
      interruptedSessions: null,
    },
  })
  assert.equal(fetchCalls, 0)
})

test('fetchState requires the Electron bridge and does not fall back to HTTP', async () => {
  let fetchCalls = 0

  globalThis.fetch = (async () => {
    fetchCalls += 1
    throw new Error('fetch should not be used without the Electron bridge')
  }) as typeof fetch

  await assert.rejects(
    () => fetchState(),
    /Electron desktop bridge is unavailable/,
  )
  assert.equal(fetchCalls, 0)
})

test('queueStateSave flushes through the Electron bridge when available', () => {
  const snapshot = createDefaultState('D:/workspace')
  let queuedState: ReturnType<typeof createDefaultState> | null = null

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      sendBeacon: () => {
        throw new Error('sendBeacon should not be used in Electron mode')
      },
    },
  })

  setWindow({
    electronAPI: {
      queueStateSave: (state) => {
        queuedState = state
      },
    },
  } as ElectronBridgeWindow)

  assert.equal(queueStateSave(snapshot), true)
  assert.deepEqual(queuedState, snapshot)
})

test('queueStateSave requires the Electron bridge and does not fall back to beacon or fetch', () => {
  const snapshot = createDefaultState('D:/workspace')
  let beaconCalls = 0
  let fetchCalls = 0

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      sendBeacon: () => {
        beaconCalls += 1
        return true
      },
    },
  })

  globalThis.fetch = (async () => {
    fetchCalls += 1
    return new Response('{}')
  }) as typeof fetch

  assert.throws(() => queueStateSave(snapshot), /Electron desktop bridge is unavailable/)
  assert.equal(beaconCalls, 0)
  assert.equal(fetchCalls, 0)
})

test('fetchSlashCommands caches per language so translated menus refresh immediately', async () => {
  const requests: Array<'en' | 'zh-CN'> = []

  setWindow({
    electronAPI: {
      fetchSlashCommands: async (request) => {
        requests.push(request.language)
        return [
          {
            name: 'help',
            description: request.language === 'en' ? 'Help' : '帮助',
            source: 'app',
          },
        ]
      },
    },
  } as ElectronBridgeWindow)

  const english = await fetchSlashCommands({
    provider: 'claude',
    workspacePath: 'D:/workspace/slash-cache-en',
    language: 'en',
  })
  const chinese = await fetchSlashCommands({
    provider: 'claude',
    workspacePath: 'D:/workspace/slash-cache-en',
    language: 'zh-CN',
  })

  assert.deepEqual(requests, ['en', 'zh-CN'])
  assert.equal(english[0]?.description, 'Help')
  assert.equal(chinese[0]?.description, '帮助')
})

test('openChatStream requires the Electron bridge and does not fall back to EventSource', () => {
  let eventSourceCalls = 0

  Object.defineProperty(globalThis, 'EventSource', {
    configurable: true,
    writable: true,
    value: class {
      constructor() {
        eventSourceCalls += 1
      }
    },
  })

  assert.throws(
    () =>
      openChatStream('stream-1', {
        onError: () => undefined,
      }),
    /Electron desktop bridge is unavailable/,
  )
  assert.equal(eventSourceCalls, 0)
})

test('openChatStream forwards recoverable desktop error payloads unchanged', async () => {
  const capturedErrors: Array<{ message: string; recoverable?: boolean; recoveryMode?: string }> = []
  let subscriptionId = ''
  const eventTarget = new EventTarget() as ElectronBridgeWindow

  eventTarget.electronAPI = {
    subscribeChatStream: async (_streamId, nextSubscriptionId) => {
      subscriptionId = nextSubscriptionId
    },
    unsubscribeChatStream: async () => undefined,
  }

  setWindow(eventTarget)

  const source = openChatStream('stream-1', {
    onError: (payload) => {
      capturedErrors.push(payload)
    },
  })

  assert.ok(subscriptionId, 'openChatStream should subscribe through the Electron bridge')

  eventTarget.dispatchEvent(
    new CustomEvent('chill-vibe:chat-stream', {
      detail: {
        subscriptionId,
        event: 'error',
        data: {
          message: 'Temporary disconnect.',
          recoverable: true,
          recoveryMode: 'resume-session',
        },
      },
    }),
  )

  assert.deepEqual(capturedErrors, [
    {
      message: 'Temporary disconnect.',
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  ])

  source.close()
})

test('createWorkspaceFile uses the Electron bridge when available', async () => {
  let fetchCalls = 0
  let receivedRequest:
    | { workspacePath: string; parentRelativePath: string; name: string }
    | null = null

  globalThis.fetch = (async () => {
    fetchCalls += 1
    throw new Error('fetch should not be used in Electron mode')
  }) as typeof fetch

  setWindow({
    electronAPI: {
      createFile: async (request) => {
        receivedRequest = request
      },
    },
  } as ElectronBridgeWindow)

  await createWorkspaceFile('D:/workspace', 'src/components', 'FileTreeCard.tsx')

  assert.deepEqual(receivedRequest, {
    workspacePath: 'D:/workspace',
    parentRelativePath: 'src/components',
    name: 'FileTreeCard.tsx',
  })
  assert.equal(fetchCalls, 0)
})

test('workspace file mutation APIs fall back to HTTP routes when the Electron bridge is unavailable', async () => {
  const requests: Array<{ input: string; body: string | undefined }> = []

  globalThis.fetch = (async (input, init) => {
    requests.push({
      input: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
    })

    return new Response(null, { status: 204 })
  }) as typeof fetch

  await createWorkspaceFile('D:/workspace', 'src', 'new-file.ts')
  await createWorkspaceDirectory('D:/workspace', 'src', 'nested')
  await renameWorkspaceEntry('D:/workspace', 'src/new-file.ts', 'renamed.ts')
  await moveWorkspaceEntry('D:/workspace', 'src/renamed.ts', 'docs')
  await deleteWorkspaceEntry('D:/workspace', 'src/renamed.ts')

  assert.deepEqual(
    requests.map((request) => request.input),
    [
      '/api/files/create',
      '/api/files/create-directory',
      '/api/files/rename',
      '/api/files/move',
      '/api/files/delete',
    ],
  )
  assert.deepEqual(
    requests.map((request) => request.body),
    [
      JSON.stringify({
        workspacePath: 'D:/workspace',
        parentRelativePath: 'src',
        name: 'new-file.ts',
      }),
      JSON.stringify({
        workspacePath: 'D:/workspace',
        parentRelativePath: 'src',
        name: 'nested',
      }),
      JSON.stringify({
        workspacePath: 'D:/workspace',
        relativePath: 'src/new-file.ts',
        nextName: 'renamed.ts',
      }),
      JSON.stringify({
        workspacePath: 'D:/workspace',
        relativePath: 'src/renamed.ts',
        destinationParentRelativePath: 'docs',
      }),
      JSON.stringify({
        workspacePath: 'D:/workspace',
        relativePath: 'src/renamed.ts',
      }),
    ],
  )
})

test('moveWorkspaceEntry uses the Electron bridge when available', async () => {
  let fetchCalls = 0
  let receivedRequest:
    | { workspacePath: string; relativePath: string; destinationParentRelativePath: string }
    | null = null

  globalThis.fetch = (async () => {
    fetchCalls += 1
    throw new Error('fetch should not be used in Electron mode')
  }) as typeof fetch

  setWindow({
    electronAPI: {
      moveEntry: async (request) => {
        receivedRequest = request
      },
    },
  } as ElectronBridgeWindow)

  await moveWorkspaceEntry('D:/workspace', 'src/new-file.ts', 'docs')

  assert.deepEqual(receivedRequest, {
    workspacePath: 'D:/workspace',
    relativePath: 'src/new-file.ts',
    destinationParentRelativePath: 'docs',
  })
  assert.equal(fetchCalls, 0)
})

test('attachment URLs switch to the Electron protocol when available', () => {
  setWindow({
    electronAPI: {
      getAttachmentUrl: (attachmentId) => `chill-vibe-attachment://local/${attachmentId}`,
    },
  } as ElectronBridgeWindow)

  assert.equal(
    getImageAttachmentUrl('image-1.png'),
    'chill-vibe-attachment://local/image-1.png',
  )
})

test('attachment URLs no longer fall back to HTTP API routes', () => {
  setWindow(undefined)

  assert.equal(
    getImageAttachmentUrl('image-1.png'),
    'chill-vibe-attachment://local/image-1.png',
  )
})

test('window controls use the Electron bridge when available', async () => {
  let minimized = 0
  let closed = 0
  let flashed = 0
  const maximizeEvents: boolean[] = []

  setWindow({
    electronAPI: {
      minimizeWindow: async () => {
        minimized += 1
      },
      toggleMaximizeWindow: async () => true,
      closeWindow: async () => {
        closed += 1
      },
      flashWindowOnce: async () => {
        flashed += 1
        return true
      },
      isWindowMaximized: async () => false,
      onWindowMaximizedChanged: (listener) => {
        listener(true)
        maximizeEvents.push(true)
        return () => {
          maximizeEvents.push(false)
        }
      },
    },
  } as ElectronBridgeWindow)

  await minimizeWindow()
  assert.equal(minimized, 1)
  assert.equal(await toggleMaximizeWindow(), true)
  assert.equal(await flashWindowOnce(), true)
  assert.equal(await isWindowMaximized(), false)
  const unsubscribe = onWindowMaximizedChanged((value) => {
    maximizeEvents.push(value)
  })
  await closeWindow()
  unsubscribe()

  assert.equal(closed, 1)
  assert.equal(flashed, 1)
  assert.deepEqual(maximizeEvents, [true, true, false])
})

test('flashWindowOnce becomes a no-op when the Electron bridge is unavailable', async () => {
  await assert.doesNotReject(() => flashWindowOnce())
  assert.equal(await flashWindowOnce(), false)
})
