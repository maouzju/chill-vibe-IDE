import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { createDefaultState } from '../shared/default-state.ts'
import { getImageAttachmentUrl } from '../shared/chat-attachments.ts'
import {
  closeWindow,
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntry,
  fetchGitStatusPreview,
  fetchSlashCommands,
  fetchState,
  flashWindowOnce,
  isWindowMaximized,
  loadCompactedCardHistory,
  loadClosedWorkspaceSnapshot,
  listInternalSessionHistory,
  minimizeWindow,
  moveWorkspaceEntry,
  onWindowMaximizedChanged,
  openChatStream,
  queueStateSave,
  renameWorkspaceEntry,
  saveClosedWorkspaceSnapshot,
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
    loadCompactedCardHistory?: (request: { cardId: string }) => Promise<unknown>
    saveClosedWorkspaceSnapshot?: (snapshot: unknown) => Promise<unknown>
    loadClosedWorkspaceSnapshot?: (request: { workspacePath: string }) => Promise<unknown>
    listInternalSessionHistory?: (request: { workspacePath: string; query: string }) => Promise<unknown>
    fetchGitStatusPreview?: (workspacePath: string) => Promise<unknown>
    fetchSlashCommands?: (request: {
      provider: 'codex' | 'claude'
      workspacePath: string
      language: 'en' | 'zh-CN'
      crossProviderSkillReuseEnabled: boolean
    }) => Promise<Array<{ name: string; description?: string; source?: 'app' | 'native' | 'skill' }>>
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

test('loadCompactedCardHistory uses the Electron bridge and validates the archived snapshot', async () => {
  const requests: Array<{ cardId: string }> = []
  setWindow({
    electronAPI: {
      loadCompactedCardHistory: async (request) => {
        requests.push(request)
        return {
          snapshot: {
            hiddenReason: 'compact',
            hiddenMessageCount: 1,
            messages: [{
              id: 'archived-message',
              role: 'user',
              content: 'earlier compacted question',
              createdAt: '2026-08-06T00:00:00.000Z',
            }],
          },
        }
      },
    },
  } as ElectronBridgeWindow)

  const response = await loadCompactedCardHistory({ cardId: 'card-1' })

  assert.deepEqual(requests, [{ cardId: 'card-1' }])
  assert.equal(response.snapshot?.messages[0]?.id, 'archived-message')
})

test('listInternalSessionHistory uses the bounded Electron maintenance bridge', async () => {
  const requests: Array<{ workspacePath: string; query: string }> = []
  setWindow({
    electronAPI: {
      listInternalSessionHistory: async (request) => {
        requests.push(request)
        return {
          entries: [{
            id: 'orphan-history-entry',
            title: 'Recovered orphan history',
            provider: 'codex',
            model: 'gpt-5.6-sol',
            workspacePath: 'D:/workspace',
            messages: [],
            messageCount: 42,
            messagesPreview: true,
            archivedAt: '2026-07-19T00:00:00.000Z',
          }],
          total: 1,
          maintenance: {
            phase: 'running',
            processed: 128,
            skipped: 0,
            total: 7000,
          },
        }
      },
    },
  } as ElectronBridgeWindow)

  const response = await listInternalSessionHistory({
    workspacePath: 'D:/workspace',
    query: '',
  })

  assert.deepEqual(requests, [{ workspacePath: 'D:/workspace', query: '' }])
  assert.equal(response.entries[0]?.messageCount, 42)
  assert.equal(response.maintenance.phase, 'running')
})

test('closed workspace snapshots round-trip through the Electron bridge', async () => {
  const state = createDefaultState('D:/workspace/reopen')
  const snapshot = {
    closeId: 'workspace-close-1',
    closedAt: '2026-07-25T10:00:00.000Z',
    column: state.columns[0]!,
  }
  const savedSnapshots: unknown[] = []
  const loadRequests: Array<{ workspacePath: string }> = []

  setWindow({
    electronAPI: {
      saveClosedWorkspaceSnapshot: async (value) => {
        savedSnapshots.push(value)
        return value
      },
      loadClosedWorkspaceSnapshot: async (request) => {
        loadRequests.push(request)
        return { snapshot, legacyEntryIds: [] }
      },
    },
  } as ElectronBridgeWindow)

  const saved = await saveClosedWorkspaceSnapshot(snapshot)
  const loaded = await loadClosedWorkspaceSnapshot({ workspacePath: 'D:/workspace/reopen' })

  assert.deepEqual(savedSnapshots, [snapshot])
  assert.equal(saved.closeId, 'workspace-close-1')
  assert.deepEqual(loadRequests, [{ workspacePath: 'D:/workspace/reopen' }])
  assert.equal(loaded.snapshot?.column.workspacePath, 'D:/workspace/reopen')
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
    crossProviderSkillReuseEnabled: true,
  })
  const chinese = await fetchSlashCommands({
    provider: 'claude',
    workspacePath: 'D:/workspace/slash-cache-en',
    language: 'zh-CN',
    crossProviderSkillReuseEnabled: true,
  })

  assert.deepEqual(requests, ['en', 'zh-CN'])
  assert.equal(english[0]?.description, 'Help')
  assert.equal(chinese[0]?.description, '帮助')
})

test('fetchSlashCommands caches separately when cross-provider skill reuse changes', async () => {
  const requests: boolean[] = []

  setWindow({
    electronAPI: {
      fetchSlashCommands: async (request) => {
        requests.push(request.crossProviderSkillReuseEnabled)
        return [
          {
            name: request.crossProviderSkillReuseEnabled ? 'agent-reach' : 'check-all',
            description: 'Skill',
            source: 'skill',
          },
        ]
      },
    },
  } as ElectronBridgeWindow)

  const enabled = await fetchSlashCommands({
    provider: 'claude',
    workspacePath: 'D:/workspace/slash-cache-setting',
    language: 'en',
    crossProviderSkillReuseEnabled: true,
  })
  const disabled = await fetchSlashCommands({
    provider: 'claude',
    workspacePath: 'D:/workspace/slash-cache-setting',
    language: 'en',
    crossProviderSkillReuseEnabled: false,
  })

  assert.deepEqual(requests, [true, false])
  assert.equal(enabled[0]?.name, 'agent-reach')
  assert.equal(disabled[0]?.name, 'check-all')
})

test('fetchSlashCommands keeps warm entries for multiple chat workspaces', async () => {
  const requests: string[] = []

  setWindow({
    electronAPI: {
      fetchSlashCommands: async (request) => {
        requests.push(request.workspacePath)
        return [
          {
            name: request.workspacePath.endsWith('one') ? 'workspace-one' : 'workspace-two',
            description: 'Skill',
            source: 'skill',
          },
        ]
      },
    },
  } as ElectronBridgeWindow)

  const request = (workspacePath: string) => fetchSlashCommands({
    provider: 'claude',
    workspacePath,
    language: 'en',
    crossProviderSkillReuseEnabled: true,
  })

  await request('D:/workspace/slash-cache-multi-one')
  await request('D:/workspace/slash-cache-multi-two')
  const firstWorkspaceAgain = await request('D:/workspace/slash-cache-multi-one')

  assert.deepEqual(requests, [
    'D:/workspace/slash-cache-multi-one',
    'D:/workspace/slash-cache-multi-two',
  ])
  assert.equal(firstWorkspaceAgain[0]?.name, 'workspace-one')
})

test('fetchGitStatusPreview reads lightweight Git metadata through the Electron bridge', async () => {
  const requests: string[] = []

  setWindow({
    electronAPI: {
      fetchGitStatusPreview: async (workspacePath) => {
        requests.push(workspacePath)
        return {
          workspacePath,
          isRepository: true,
          repoRoot: workspacePath,
          branch: 'main',
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          hasConflicts: false,
          clean: false,
          summary: {
            staged: 0,
            unstaged: 1,
            untracked: 0,
            conflicted: 0,
          },
          changes: [
            {
              path: 'src/components/GitToolCard.tsx',
              kind: 'modified',
              stagedStatus: ' ',
              workingTreeStatus: 'M',
              staged: false,
              conflicted: false,
            },
          ],
          description: '',
        }
      },
    },
  } as ElectronBridgeWindow)

  const status = await fetchGitStatusPreview('D:/workspace/repo')

  assert.deepEqual(requests, ['D:/workspace/repo'])
  assert.equal(status.changes.length, 1)
  assert.equal(status.changes[0]?.patch, undefined)
  assert.equal(status.lastCommit, undefined)
})

test('fetchSlashCommands refreshes shortly so newly-created skills can appear without restarting', async () => {
  const originalDateNow = Date.now
  let now = 1_000
  const requests: number[] = []

  Date.now = () => now

  setWindow({
    electronAPI: {
      fetchSlashCommands: async () => {
        const callNumber = requests.length + 1
        requests.push(callNumber)
        return [
          {
            name: callNumber === 1 ? 'before-skill' : 'after-skill',
            description: 'Skill',
            source: 'skill',
          },
        ]
      },
    },
  } as unknown as ElectronBridgeWindow)

  try {
    const first = await fetchSlashCommands({
      provider: 'codex',
      workspacePath: 'D:/workspace/slash-cache-ttl',
      language: 'en',
      crossProviderSkillReuseEnabled: true,
    })
    const cached = await fetchSlashCommands({
      provider: 'codex',
      workspacePath: 'D:/workspace/slash-cache-ttl',
      language: 'en',
      crossProviderSkillReuseEnabled: true,
    })

    now += 5_001

    const refreshed = await fetchSlashCommands({
      provider: 'codex',
      workspacePath: 'D:/workspace/slash-cache-ttl',
      language: 'en',
      crossProviderSkillReuseEnabled: true,
    })

    assert.deepEqual(requests, [1, 2])
    assert.equal(first[0]?.name, 'before-skill')
    assert.equal(cached[0]?.name, 'before-skill')
    assert.equal(refreshed[0]?.name, 'after-skill')
  } finally {
    Date.now = originalDateNow
  }
})

// 症状：并发多路流式输出时整个窗口卡死 1~19 秒，主进程 CPU 为 0 却在 IPC 管道上读写 3.8/5.9MB。
// 根因：2026-08-10 实测，每次 openChatStream 都往 window 上挂一条自己的桥接监听器，
//       preload 把每条 chat:stream-event 广播给全部 N 条监听器，再由各自按 subscriptionId
//       丢弃；5 路 streaming 时每条事件被分发处理 5 次（卡顿瞬间 renderer 侧 3.5-5.1MB / 500+ ops）。
// 被否决：在回调体内提前 return —— 那正是现状。浪费发生在事件分发本身而不在回调体里，
//       必须让 window 分发只发生一次，再按订阅 ID 精确路由到目标 handler。
test('openChatStream routes concurrent streams through a single shared bridge listener', () => {
  const eventTarget = new EventTarget() as ElectronBridgeWindow
  let listenerAdds = 0
  let listenerRemoves = 0
  const nativeAdd = EventTarget.prototype.addEventListener.bind(eventTarget)
  const nativeRemove = EventTarget.prototype.removeEventListener.bind(eventTarget)

  eventTarget.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: unknown,
  ) => {
    if (type === 'chill-vibe:chat-stream') {
      listenerAdds += 1
    }
    nativeAdd(type, listener, options as never)
  }) as EventTarget['addEventListener']

  eventTarget.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: unknown,
  ) => {
    if (type === 'chill-vibe:chat-stream') {
      listenerRemoves += 1
    }
    nativeRemove(type, listener, options as never)
  }) as EventTarget['removeEventListener']

  const subscriptionIds: string[] = []
  eventTarget.electronAPI = {
    subscribeChatStream: async (_streamId, subscriptionId) => {
      subscriptionIds.push(subscriptionId)
    },
    unsubscribeChatStream: async () => undefined,
  }

  setWindow(eventTarget)

  const errorCounts = [0, 0, 0, 0, 0]
  const sources = errorCounts.map((_unused, index) =>
    openChatStream(`stream-${index}`, {
      onError: () => {
        errorCounts[index] += 1
      },
    }),
  )

  assert.equal(subscriptionIds.length, 5)
  assert.equal(listenerAdds, 1, '并发订阅只应共用一条桥接监听器，而不是每路各挂一条')

  eventTarget.dispatchEvent(
    new CustomEvent('chill-vibe:chat-stream', {
      detail: {
        subscriptionId: subscriptionIds[2],
        event: 'error',
        data: { message: 'Targeted delivery.', recoverable: false },
      },
    }),
  )

  assert.deepEqual(errorCounts, [0, 0, 1, 0, 0], '事件只应投递给目标订阅的 handler')

  sources.slice(0, 4).forEach((source) => source.close())
  assert.equal(listenerRemoves, 0, '仍有订阅存活时不能摘掉共享监听器')

  eventTarget.dispatchEvent(
    new CustomEvent('chill-vibe:chat-stream', {
      detail: {
        subscriptionId: subscriptionIds[4],
        event: 'error',
        data: { message: 'Still alive.', recoverable: false },
      },
    }),
  )
  assert.deepEqual(errorCounts, [0, 0, 1, 0, 1], '关闭其它订阅不应影响存活订阅的投递')

  sources[4].close()
  assert.equal(listenerRemoves, 1, '最后一个订阅关闭后应摘掉共享监听器，避免泄漏')
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
  const capturedErrors: Array<{ message: string; recoverable?: boolean; recoveryMode?: string; sessionId?: string }> = []
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
          sessionId: 'session-1',
        },
      },
    }),
  )

  assert.deepEqual(capturedErrors, [
    {
      message: 'Temporary disconnect.',
      recoverable: true,
      recoveryMode: 'resume-session',
      sessionId: 'session-1',
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
