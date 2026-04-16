import { expect, test, type Page } from '@playwright/test'

import { createPlaywrightState } from './playwright-state.ts'

type MockCardState = {
  status: 'idle' | 'streaming'
  streamId?: string
  sessionId?: string
  messages: Array<{
    id: string
    role: 'assistant' | 'user' | 'system'
    content: string
    createdAt: string
  }>
}

const getActiveComposerTextarea = (page: Page) =>
  page.locator('.pane-tab-panel.is-active .composer textarea')

const emitStreamEvent = async (page: Page, streamId: string, eventName: string, data: unknown) => {
  await page.evaluate(
    ({ targetStreamId, targetEventName, payload }) => {
      const bridge = window as typeof window & {
        __emitMockChatStreamEvent: (streamId: string, eventName: string, data: unknown) => number
      }

      bridge.__emitMockChatStreamEvent(targetStreamId, targetEventName, payload)
    },
    {
      targetStreamId: streamId,
      targetEventName: eventName,
      payload: data,
    },
  )
}

const installMockApis = async (
  page: Page,
  options: {
    initialCard?: MockCardState
    autoEmitDoneOnStop?: boolean
  } = {},
) => {
  await page.addInitScript(() => {
    const sourcesByUrl = new Map<string, Set<MockEventSource>>()
    const streamSources = new Map<string, MockEventSource>()

    class MockEventSource {
      url: string
      withCredentials = false
      private listeners = new Map<string, Set<(event: MessageEvent) => void>>()

      constructor(url: string) {
        this.url = url
        const existing = sourcesByUrl.get(url)
        if (existing) {
          existing.add(this)
        } else {
          sourcesByUrl.set(url, new Set([this]))
        }
      }

      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        const listeners = this.listeners.get(type)
        if (listeners) {
          listeners.add(listener)
          return
        }

        this.listeners.set(type, new Set([listener]))
      }

      removeEventListener(type: string, listener: (event: MessageEvent) => void) {
        const listeners = this.listeners.get(type)
        if (!listeners) {
          return
        }

        listeners.delete(listener)
        if (listeners.size === 0) {
          this.listeners.delete(type)
        }
      }

      emit(type: string, data: unknown) {
        const listeners = this.listeners.get(type)
        if (!listeners || listeners.size === 0) {
          return
        }

        const event = new MessageEvent(type, { data: JSON.stringify(data) })
        for (const listener of listeners) {
          listener(event)
        }
      }

      close() {
        const sources = sourcesByUrl.get(this.url)
        if (!sources) {
          return
        }

        sources.delete(this)
        if (sources.size === 0) {
          sourcesByUrl.delete(this.url)
        }
      }
    }

    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      writable: true,
      value: MockEventSource,
    })

    Object.defineProperty(window, '__emitMockChatStreamEvent', {
      configurable: true,
      writable: true,
      value: (streamId: string, eventName: string, data: unknown) => {
        const url = `/api/chat/stream/${encodeURIComponent(streamId)}`
        const sources = sourcesByUrl.get(url)
        if (!sources) {
          return 0
        }

        for (const source of sources) {
          source.emit(eventName, data)
        }

        return sources.size
      },
    })

    const parseJson = async (response: Response) => {
      const raw = await response.text().catch(() => '')
      let payload: unknown = null

      if (raw.trim().length > 0) {
        try {
          payload = JSON.parse(raw)
        } catch {
          payload = raw
        }
      }

      if (!response.ok) {
        const message =
          payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
            ? payload.message
            : typeof payload === 'string' && payload.trim().length > 0
              ? payload
              : `Request failed (${response.status}).`

        throw new Error(message)
      }

      return payload
    }

    const jsonRequest = async (url: string, init?: RequestInit) => parseJson(await fetch(url, init))

    const dispatchStreamEvent = (subscriptionId: string, eventName: string, data: unknown) => {
      window.dispatchEvent(
        new CustomEvent('chill-vibe:chat-stream', {
          detail: {
            subscriptionId,
            event: eventName,
            data,
          },
        }),
      )
    }

    window.electronAPI = {
      minimizeWindow: async () => undefined,
      toggleMaximizeWindow: async () => false,
      closeWindow: async () => undefined,
      isWindowMaximized: async () => false,
      onWindowMaximizedChanged: () => () => undefined,
      openFolderDialog: async () => null,
      fetchState: async () => jsonRequest('/api/state'),
      saveState: async (state) =>
        jsonRequest('/api/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state),
        }),
      queueStateSave: (state) => {
        void fetch('/api/state/snapshot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state),
          keepalive: true,
        })
      },
      resetState: async () =>
        jsonRequest('/api/state/reset', {
          method: 'POST',
        }),
      clearUserData: async () => undefined,
      fetchProviders: async () => jsonRequest('/api/providers'),
      importCcSwitchRouting: async (request) =>
        jsonRequest('/api/routing/import/cc-switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      fetchSetupStatus: async () => jsonRequest('/api/setup/status'),
      runEnvironmentSetup: async () =>
        jsonRequest('/api/setup/run', {
          method: 'POST',
        }),
      fetchOnboardingStatus: async () => jsonRequest('/api/onboarding/status'),
      fetchGitStatus: async (workspacePath) =>
        jsonRequest(`/api/git/status?workspacePath=${encodeURIComponent(workspacePath)}`),
      setGitStage: async (request) =>
        jsonRequest('/api/git/stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      commitGitChanges: async (request) =>
        jsonRequest('/api/git/commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      pullGitChanges: async (request) =>
        jsonRequest('/api/git/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      fetchSlashCommands: async (request) =>
        jsonRequest('/api/slash-commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      requestChat: async (request) =>
        jsonRequest('/api/chat/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      uploadImageAttachment: async (request) =>
        jsonRequest('/api/attachments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      stopChat: async (streamId) =>
        jsonRequest(`/api/chat/stop/${encodeURIComponent(streamId)}`, {
          method: 'POST',
        }),
      subscribeChatStream: async (streamId, subscriptionId) => {
        const source = new EventSource(`/api/chat/stream/${encodeURIComponent(streamId)}`)
        const eventNames = ['session', 'delta', 'log', 'assistant_message', 'activity', 'done', 'error']

        for (const eventName of eventNames) {
          source.addEventListener(eventName, (event) => {
            if (!(event instanceof MessageEvent)) {
              return
            }

            dispatchStreamEvent(subscriptionId, eventName, JSON.parse(event.data))
          })
        }

        source.onerror = () => {
          dispatchStreamEvent(subscriptionId, 'error', {
            message: 'The desktop stream could not be opened.',
          })
        }

        streamSources.set(subscriptionId, source)
      },
      unsubscribeChatStream: async (subscriptionId) => {
        streamSources.get(subscriptionId)?.close()
        streamSources.delete(subscriptionId)
      },
      getAttachmentUrl: (attachmentId) => `/api/attachments/${encodeURIComponent(attachmentId)}`,
    }
  })

  const now = new Date().toISOString()
  const requests: string[] = []
  const {
    initialCard = {
      status: 'streaming',
      streamId: 'stream-1',
      sessionId: 'session-1',
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Still answering',
          createdAt: now,
        },
      ],
    },
    autoEmitDoneOnStop = true,
  } = options
  let nextStreamNumber = 2

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en' as const,
      theme: 'dark' as const,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: 'gpt-5.4',
        claude: 'claude-opus-4-6',
      },
      modelReasoningEfforts: {
        codex: {},
        claude: {},
      },
      providerProfiles: {
        codex: {
          activeProfileId: '',
          profiles: [],
        },
        claude: {
          activeProfileId: '',
          profiles: [],
        },
      },
    },
    updatedAt: now,
    columns: [
      {
        id: 'col-1',
        title: 'Interrupt Test',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Feature Chat',
            status: initialCard.status,
            size: 560,
            provider: 'codex' as const,
            model: 'gpt-5.4',
            reasoningEffort: 'medium',
            draft: '',
            streamId: initialCard.streamId,
            sessionId: initialCard.sessionId,
            messages: initialCard.messages,
          },
        ],
      },
    ],
  })

  await page.route('**/api/state', async (route) => {
    const request = route.request()

    if (request.method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }

    if (request.method() === 'PUT') {
      state = createPlaywrightState(JSON.parse(request.postData() ?? '{}'))
      await route.fulfill({ json: state })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/state/snapshot', async (route) => {
    state = createPlaywrightState(JSON.parse(route.request().postData() ?? '{}'))
    await route.fulfill({ status: 204 })
  })

  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      json: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    })
  })

  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({ json: { state: 'idle', logs: [] } })
  })

  await page.route('**/api/slash-commands', async (route) => {
    await route.fulfill({ json: [] })
  })

  await page.route('**/api/chat/stop/*', async (route) => {
    const streamId = decodeURIComponent(route.request().url().split('/').at(-1) ?? '')
    requests.push(`stop:${streamId}`)
    await route.fulfill({ status: 204 })
    if (autoEmitDoneOnStop) {
      await emitStreamEvent(page, streamId, 'done', { stopped: true })
    }
  })

  await page.route('**/api/chat/message', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    requests.push(`message:${body.prompt}`)
    await route.fulfill({
      json: {
        streamId: `stream-${nextStreamNumber++}`,
      },
    })
  })

  return {
    readRequests: () => requests.slice(),
    readState: () => state,
  }
}

test('sending during a running card stops the active stream and immediately starts the new request', async ({ page }) => {
  const mock = await installMockApis(page)
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })

  await expect(textarea).toBeVisible()
  await textarea.fill('Interrupt with a new instruction')
  await expect(sendButton).toBeEnabled()

  await sendButton.click()

  await expect(textarea).toHaveValue('')
  await expect.poll(() => mock.readRequests()).toEqual([
    'stop:stream-1',
    'message:Interrupt with a new instruction',
  ])

  await expect
    .poll(() => mock.readState().columns[0]?.cards['card-1']?.messages.map((message) => message.role))
    .toEqual(['assistant', 'system', 'user'])
  await expect
    .poll(() => mock.readState().columns[0]?.cards['card-1']?.messages[1]?.meta?.kind)
    .toBe('run-stopped')
  await expect
    .poll(() => mock.readState().columns[0]?.cards['card-1']?.messages[1]?.meta?.stopReason)
    .toBe('user-interrupt')
  await expect
    .poll(() => mock.readState().columns[0]?.cards['card-1']?.messages[1]?.content)
    .toBe('User interrupted')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.status).toBe('streaming')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')
})

test('sending during /compact still waits for the compaction stream to finish', async ({ page }) => {
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'idle',
      messages: [],
    },
    autoEmitDoneOnStop: true,
  })
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })

  await expect(textarea).toBeVisible()

  await textarea.fill('/compact')
  await sendButton.click()

  await expect.poll(() => mock.readRequests()).toEqual(['message:/compact'])
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.status).toBe('streaming')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')

  await textarea.fill('Follow-up after compact')
  await sendButton.click()

  await expect(textarea).toHaveValue('')
  await expect.poll(() => mock.readRequests()).toEqual(['message:/compact'])

  await emitStreamEvent(page, 'stream-2', 'done', {})

  await expect.poll(() => {
    const requests = mock.readRequests()
    return (
      requests.length === 2 &&
      requests[0] === 'message:/compact' &&
      requests[1]?.includes('Follow-up after compact')
    )
  }).toBe(true)
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.status).toBe('streaming')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-3')
})
