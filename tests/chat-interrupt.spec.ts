import { expect, test, type Page } from '@playwright/test'

import { createPlaywrightState } from './playwright-state.ts'

type MockCardState = {
  status: 'idle' | 'streaming'
  streamId?: string
  sessionId?: string
  provider?: 'codex' | 'claude'
  model?: string
  messages: Array<{
    id: string
    role: 'assistant' | 'user' | 'system'
    content: string
    createdAt: string
    meta?: Record<string, string>
  }>
}

const getActiveComposerTextarea = (page: Page) =>
  page.locator('.pane-tab-panel.is-active .composer textarea')

const emitStreamEvent = async (
  page: Page,
  streamId: string,
  eventName: string,
  data: unknown,
  options: { waitForSubscriber?: boolean } = {},
) => {
  if (options.waitForSubscriber ?? true) {
    await expect
      .poll(async () =>
        page.evaluate((targetStreamId) => {
          const bridge = window as typeof window & {
            __getMockChatStreamSubscriberCount: (streamId: string) => number
          }

          return bridge.__getMockChatStreamSubscriberCount(targetStreamId)
        }, streamId),
      )
      .toBeGreaterThan(0)
  }

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

const askUserActivity = {
  itemId: 'ask-user-item-1',
  kind: 'ask-user',
  status: 'completed',
  header: 'Need a choice',
  question: 'Which path should I take?',
  multiSelect: false,
  options: [
    { label: 'Fast', description: 'Ship the smallest safe fix' },
    { label: 'Deep', description: 'Investigate the whole area first' },
  ],
} as const

const followUpAskUserActivity = {
  itemId: 'ask-user-item-2',
  kind: 'ask-user',
  status: 'completed',
  header: 'Need another choice',
  question: 'How should I handle the popup question tool?',
  multiSelect: false,
  options: [
    { label: 'Continue', description: 'Keep testing the current flow' },
    { label: 'Stop', description: 'End the popup feature test' },
  ],
} as const

const createAskUserMessage = (createdAt: string) => ({
  id: 'codex:stream-1:item:ask-user:question',
  role: 'assistant' as const,
  content: '',
  createdAt,
  meta: {
    provider: 'codex',
    kind: 'ask-user',
    itemId: askUserActivity.itemId,
    structuredData: JSON.stringify(askUserActivity),
  },
})

const createFollowUpAskUserMessage = (createdAt: string) => ({
  id: 'codex:stream-1:item:ask-user:question-2',
  role: 'assistant' as const,
  content: '',
  createdAt,
  meta: {
    provider: 'codex',
    kind: 'ask-user',
    itemId: followUpAskUserActivity.itemId,
    structuredData: JSON.stringify(followUpAskUserActivity),
  },
})

const installMockApis = async (
  page: Page,
  options: {
    initialCard?: MockCardState
    autoEmitDoneOnStop?: boolean
    holdChatMessageResponse?: boolean
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

    Object.defineProperty(window, '__getMockChatStreamSubscriberCount', {
      configurable: true,
      writable: true,
      value: (streamId: string) => {
        const url = `/api/chat/stream/${encodeURIComponent(streamId)}`
        return sourcesByUrl.get(url)?.size ?? 0
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
      runEnvironmentSetup: async (request) =>
        jsonRequest('/api/setup/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request ?? {}),
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
      requestChat: async (request) => {
        const response = await jsonRequest('/api/chat/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })

        if (response && typeof response === 'object' && 'streamId' in response && typeof response.streamId === 'string') {
          return response
        }

        return { streamId: request.streamId }
      },
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
      provider: 'codex' as const,
      model: 'gpt-5.5',
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
    holdChatMessageResponse: initialHoldChatMessageResponse = false,
  } = options
  const initialProvider = initialCard.provider ?? 'codex'
  const initialModel = initialCard.model ?? (initialProvider === 'claude' ? 'claude-opus-4-7' : 'gpt-5.5')
  let nextStreamNumber = 2
  const chatRequests: Array<{ prompt: string; sessionId?: string; provider?: string; streamId?: string }> = []
  let holdChatMessageResponse = initialHoldChatMessageResponse
  const heldChatMessageResponseResolvers: Array<() => void> = []
  const waitForHeldChatMessageResponse = () => {
    if (!holdChatMessageResponse) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      heldChatMessageResponseResolvers.push(resolve)
    })
  }
  const releaseHeldChatMessageResponses = () => {
    holdChatMessageResponse = false
    while (heldChatMessageResponseResolvers.length > 0) {
      heldChatMessageResponseResolvers.shift()?.()
    }
  }

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en' as const,
      theme: 'dark' as const,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: 'gpt-5.5',
        claude: 'claude-opus-4-7',
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
        model: 'gpt-5.5',
        cards: [
          {
            id: 'card-1',
            title: 'Feature Chat',
            status: initialCard.status,
            size: 560,
            provider: initialProvider,
            model: initialModel,
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
      await emitStreamEvent(page, streamId, 'done', { stopped: true }, { waitForSubscriber: false })
    }
  })

  await page.route('**/api/chat/message', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    const streamId = `stream-${nextStreamNumber++}`
    requests.push(`message:${body.prompt}`)
    chatRequests.push({
      prompt: body.prompt,
      sessionId: body.sessionId,
      provider: body.provider,
      streamId: body.streamId,
    })
    await waitForHeldChatMessageResponse()
    await route.fulfill({
      json: {
        streamId,
      },
    })
    state = createPlaywrightState({
      ...state,
      columns: state.columns.map((column) =>
        {
          if (column.id === 'col-1') {
            const messages = column.cards['card-1']!.messages
            const prompt = typeof body.prompt === 'string' ? body.prompt : ''
            const nextMessages =
              prompt.trim().length > 0 &&
              messages.findLast((message) => message.role === 'user')?.content !== prompt
                ? [
                    ...messages,
                    {
                      id: `user-${streamId}`,
                      role: 'user' as const,
                      content: prompt,
                      createdAt: new Date().toISOString(),
                    },
                  ]
                : messages

            return {
              ...column,
              cards: {
                ...column.cards,
                'card-1': {
                  ...column.cards['card-1']!,
                  status: 'streaming',
                  streamId,
                  messages: nextMessages,
                },
              },
            }
          }

          return column
        },
      ),
    })
  })

  return {
    readRequests: () => requests.slice(),
    readChatRequests: () => chatRequests.slice(),
    readState: () => state,
    releaseHeldChatMessageResponses,
  }
}

test('idle Claude send clears and refocuses the composer before slow request startup finishes', async ({
  page,
}) => {
  const mock = await installMockApis(page, {
    holdChatMessageResponse: true,
    initialCard: {
      status: 'idle',
      sessionId: 'session-claude-1',
      provider: 'claude',
      model: 'claude-opus-4-7',
      messages: [],
    },
  })
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })

  try {
    await expect(textarea).toBeVisible()
    await textarea.fill('Ask Claude and keep composing')
    await expect(sendButton).toBeEnabled()

    await sendButton.click()

    await expect.poll(() => mock.readRequests()).toEqual(['message:Ask Claude and keep composing'])
    await expect(textarea).toHaveValue('')
    await expect
      .poll(() => textarea.evaluate((node) => document.activeElement === node))
      .toBe(true)

    await textarea.type('Next prompt starts immediately')
    await expect(textarea).toHaveValue('Next prompt starts immediately')
  } finally {
    mock.releaseHeldChatMessageResponses()
  }
})

test('left-clicking send while a card is running interrupts and sends immediately', async ({ page }) => {
  const mock = await installMockApis(page)
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })

  await expect(textarea).toBeVisible()
  await textarea.fill('Send this follow-up now')
  await expect(sendButton).toBeEnabled()
  await expect(sendButton).toHaveAttribute('title', /Right-click sends later/)

  await sendButton.click()

  await expect(textarea).toHaveValue('')
  await expect(page.locator('.composer-queued-send')).toHaveCount(0)
  await expect.poll(() => mock.readRequests()).toEqual([
    'stop:stream-1',
    'message:Send this follow-up now',
  ])
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.status).toBe('streaming')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.messages[1]?.meta?.stopReason).toBe('user-interrupt')
})

test('right-clicking send while a card is running queues the composer message', async ({ page }) => {
  const mock = await installMockApis(page)
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })

  await expect(textarea).toBeVisible()
  await textarea.fill('Right-click queue item')
  await sendButton.click({ button: 'right' })

  await expect(textarea).toHaveValue('')
  await expect(page.locator('.composer-queued-send')).toContainText('Right-click queue item')
  await expect.poll(() => mock.readRequests()).toEqual([])
})

test('queued messages can be cancelled before they are sent', async ({ page }) => {
  const mock = await installMockApis(page)
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })

  await textarea.fill('Cancel this queued prompt')
  await sendButton.click({ button: 'right' })
  await expect(page.locator('.composer-queued-send')).toBeVisible()

  await page.getByRole('button', { name: 'Cancel' }).click()

  await expect(page.locator('.composer-queued-send')).toHaveCount(0)
  await emitStreamEvent(page, 'stream-1', 'done', {})
  await expect.poll(() => mock.readRequests()).toEqual([])
})

test('queued messages can be sent now by intentionally interrupting the running card', async ({ page }) => {
  const mock = await installMockApis(page)
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })

  await textarea.fill('Send this queued prompt now')
  await sendButton.click({ button: 'right' })
  await expect(page.locator('.composer-queued-send')).toBeVisible()

  await page.getByRole('button', { name: 'Send now' }).click()

  await expect.poll(() => mock.readRequests()).toEqual([
    'stop:stream-1',
    'message:Send this queued prompt now',
  ])
  await expect(page.locator('.composer-queued-send')).toHaveCount(0)
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.messages[1]?.meta?.stopReason).toBe('user-interrupt')
})

test('sending a queued running Claude chat now does not keep the interrupted session id for the follow-up', async ({ page }) => {
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'streaming',
      streamId: 'stream-1',
      sessionId: 'claude-session-1',
      provider: 'claude',
      model: 'claude-opus-4-7',
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Still answering from Claude',
          createdAt: new Date().toISOString(),
        },
      ],
    },
  })
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })

  await expect(textarea).toBeVisible()
  await textarea.fill('Use this replacement instruction')
  await sendButton.click({ button: 'right' })
  await page.getByRole('button', { name: 'Send now' }).click()

  await expect.poll(() => mock.readRequests()[0]).toBe('stop:stream-1')
  await expect.poll(() => mock.readChatRequests()[0]?.prompt).toContain('Use this replacement instruction')
  await expect.poll(() => mock.readChatRequests()[0]?.sessionId).toBeUndefined()
  await expect(page.locator('.message-entry-user').filter({ hasText: 'Use this replacement instruction' })).toBeVisible()
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.messages[1]?.meta?.stopReason).toBe('user-interrupt')
  await expect(page.locator('.streaming-indicator')).toContainText('Writing')
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
  const runningSendButton = page.getByRole('button', { name: 'Send message' })
  await expect(runningSendButton).toBeVisible()
  await runningSendButton.click()

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

test('answering a live ask-user activity preserves the prior prose and then sends the answer', async ({ page }) => {
  const mock = await installMockApis(page, { autoEmitDoneOnStop: true })
  await page.goto('http://localhost:5173')

  await expect(getActiveComposerTextarea(page)).toBeVisible()

  await emitStreamEvent(page, 'stream-1', 'assistant_message', {
    itemId: 'assistant-item-1',
    content: 'I reviewed the previous work and found the risky path.',
  })
  await emitStreamEvent(page, 'stream-1', 'activity', askUserActivity)

  await expect(page.locator('article.message.message-assistant').filter({ hasText: 'I reviewed the previous work and found the risky path.' })).toBeVisible()
  await expect(page.locator('.ask-user-card')).toBeVisible()
  await page.locator('.ask-user-option').filter({ hasText: 'Fast' }).click()
  await page.locator('.ask-user-submit').click()

  await expect.poll(() => mock.readRequests()).toEqual([
    'stop:stream-1',
    'message:Fast',
  ])
  await expect
    .poll(() => mock.readState().columns[0]?.cards['card-1']?.messages.map((message) => message.role))
    .toEqual(['assistant', 'assistant', 'assistant', 'user'])
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')
})

test('answering a live ask-user activity stops the waiting stream and immediately sends the answer', async ({ page }) => {
  const mock = await installMockApis(page, { autoEmitDoneOnStop: true })
  await page.goto('http://localhost:5173')

  await expect(getActiveComposerTextarea(page)).toBeVisible()

  await emitStreamEvent(page, 'stream-1', 'activity', askUserActivity)

  await expect(page.locator('.ask-user-card')).toBeVisible()
  await page.locator('.ask-user-option').filter({ hasText: 'Fast' }).click()
  await page.locator('.ask-user-submit').click()

  await expect.poll(() => mock.readRequests()).toEqual([
    'stop:stream-1',
    'message:Fast',
  ])
  await expect
    .poll(() => mock.readState().columns[0]?.cards['card-1']?.messages.map((message) => message.role))
    .toEqual(['assistant', 'assistant', 'user'])
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')
})

test('answering a restored ask-user card stops the recovered stream and immediately sends the answer', async ({ page }) => {
  const now = new Date().toISOString()
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'streaming',
      streamId: 'stream-1',
      sessionId: 'session-1',
      messages: [createAskUserMessage(now)],
    },
    autoEmitDoneOnStop: true,
  })
  await page.goto('http://localhost:5173')

  await expect(getActiveComposerTextarea(page)).toBeVisible()
  await expect(page.locator('.ask-user-card')).toBeVisible()

  await page.locator('.ask-user-option').filter({ hasText: 'Fast' }).click()
  await page.locator('.ask-user-submit').click()

  await expect.poll(() => mock.readRequests()).toEqual([
    'stop:stream-1',
    'message:Fast',
  ])
  await expect
    .poll(() => mock.readState().columns[0]?.cards['card-1']?.messages.map((message) => message.role))
    .toEqual(['assistant', 'user'])
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')
})

test('restored answered ask-user cards stay locked and keep the composer at the pane bottom', async ({
  page,
}) => {
  const now = new Date().toISOString()
  await installMockApis(page, {
    initialCard: {
      status: 'idle',
      sessionId: 'session-1',
      messages: [
        createAskUserMessage(now),
        {
          id: 'user-answer-1',
          role: 'user',
          content: 'Fast',
          createdAt: now,
        },
        {
          id: 'assistant-after-answer-1',
          role: 'assistant',
          content: 'Continuing after your answer.',
          createdAt: now,
        },
      ],
    },
  })
  await page.goto('http://localhost:5173')

  const askUserCard = page.locator('.ask-user-card').first()
  await expect(askUserCard).toBeVisible()
  await expect(askUserCard).toHaveClass(/is-answered/)
  await expect(askUserCard.locator('.ask-user-submit')).toBeDisabled()
  await expect(askUserCard.locator('.ask-user-submit')).toContainText('Submitted')

  const paneContent = page.locator('.pane-content').first()
  const cardFooter = page.locator('.pane-tab-panel.is-active .card-footer').first()
  const [paneBox, footerBox] = await Promise.all([
    paneContent.boundingBox(),
    cardFooter.boundingBox(),
  ])

  expect(paneBox).not.toBeNull()
  expect(footerBox).not.toBeNull()
  expect(Math.abs((paneBox!.y + paneBox!.height) - (footerBox!.y + footerBox!.height))).toBeLessThanOrEqual(2)
})

test('restored answered merged ask-user cards stay locked after consecutive questions', async ({ page }) => {
  const now = new Date().toISOString()
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'idle',
      sessionId: 'session-1',
      messages: [
        createAskUserMessage(now),
        createFollowUpAskUserMessage(now),
        {
          id: 'user-answer-1',
          role: 'user',
          content: '[1] Which path should I take? -> Fast\n[2] How should I handle the popup question tool? -> Continue',
          createdAt: now,
        },
        {
          id: 'assistant-after-answer-1',
          role: 'assistant',
          content: 'Continuing after your answers.',
          createdAt: now,
        },
      ],
    },
  })
  await page.goto('http://localhost:5173')

  const askUserCard = page.locator('.ask-user-card').first()
  await expect(askUserCard).toBeVisible()
  await expect(askUserCard).toHaveClass(/is-answered/)
  await expect(askUserCard.locator('.ask-user-counter')).toContainText('1 / 2')
  await expect(askUserCard.locator('.ask-user-submit')).toBeDisabled()
  await expect(askUserCard.locator('.ask-user-submit')).toContainText('Submitted')
  await expect.poll(() => mock.readRequests()).toEqual([])
})

test('answered merged ask-user cards stay locked after an actual page reload', async ({ page }) => {
  const now = new Date().toISOString()
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'idle',
      sessionId: 'session-1',
      messages: [
        createAskUserMessage(now),
        createFollowUpAskUserMessage(now),
      ],
    },
  })
  await page.goto('http://localhost:5173')

  const askUserCard = page.locator('.ask-user-card').first()
  await expect(askUserCard).toBeVisible()
  await expect(askUserCard.locator('.ask-user-counter')).toContainText('1 / 2')

  await askUserCard.locator('.ask-user-option').filter({ hasText: 'Fast' }).click()
  await askUserCard.getByRole('button', { name: 'Next' }).click()
  await askUserCard.locator('.ask-user-option').filter({ hasText: 'Continue' }).click()
  await expect(askUserCard.locator('.ask-user-submit')).toBeEnabled()
  await askUserCard.locator('.ask-user-submit').click()

  await expect.poll(() => mock.readRequests().length).toBe(1)
  await expect
    .poll(() => mock.readState().columns[0]?.cards['card-1']?.messages.map((message) => message.role))
    .toEqual(['assistant', 'assistant', 'user'])

  await page.reload()

  const reloadedAskUserCard = page.locator('.ask-user-card').first()
  await expect(reloadedAskUserCard).toBeVisible()
  await expect(reloadedAskUserCard).toHaveClass(/is-answered/)
  await expect(reloadedAskUserCard.locator('.ask-user-counter')).toContainText('1 / 2')
  await expect(reloadedAskUserCard.locator('.ask-user-submit')).toBeDisabled()
  await expect(reloadedAskUserCard.locator('.ask-user-submit')).toContainText('Submitted')
  await expect.poll(() => mock.readRequests().length).toBe(1)
})

test('choosing ask-user Other keeps the composer anchored to the pane bottom before submit', async ({
  page,
}) => {
  const now = new Date().toISOString()
  await installMockApis(page, {
    initialCard: {
      status: 'idle',
      sessionId: 'session-1',
      messages: [createAskUserMessage(now)],
    },
  })
  await page.goto('http://localhost:5173')

  const askUserCard = page.locator('.ask-user-card').first()
  await expect(askUserCard).toBeVisible()
  await askUserCard.locator('.ask-user-option').filter({ hasText: 'Other' }).click()
  await expect(askUserCard.locator('.ask-user-other-input')).toBeVisible()

  const paneContent = page.locator('.pane-content').first()
  const cardFooter = page.locator('.pane-tab-panel.is-active .card-footer').first()
  const [paneBox, footerBox] = await Promise.all([
    paneContent.boundingBox(),
    cardFooter.boundingBox(),
  ])

  expect(paneBox).not.toBeNull()
  expect(footerBox).not.toBeNull()
  expect(Math.abs((paneBox!.y + paneBox!.height) - (footerBox!.y + footerBox!.height))).toBeLessThanOrEqual(2)
})

test('answering a live ask-user activity still sends if stop does not emit done', async ({ page }) => {
  const mock = await installMockApis(page, { autoEmitDoneOnStop: false })
  await page.goto('http://localhost:5173')

  await expect(getActiveComposerTextarea(page)).toBeVisible()
  await emitStreamEvent(page, 'stream-1', 'activity', askUserActivity)

  await expect(page.locator('.ask-user-card')).toBeVisible()
  await page.locator('.ask-user-option').filter({ hasText: 'Fast' }).click()
  await page.locator('.ask-user-submit').click()

  await expect.poll(() => mock.readRequests()[0]).toBe('stop:stream-1')
  await expect.poll(() => mock.readRequests().filter((entry) => entry === 'stop:stream-1').length).toBe(1)
  await expect.poll(() => mock.readRequests()).toContain('message:Fast')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')
})

test('old answered ask-user cards allow ordinary queued send-now interrupts', async ({ page }) => {
  const now = new Date().toISOString()
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'streaming',
      streamId: 'stream-1',
      sessionId: 'session-1',
      messages: [
        createAskUserMessage(now),
        {
          id: 'user-answer-1',
          role: 'user',
          content: 'Fast',
          createdAt: now,
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          content: 'Working after your answer',
          createdAt: now,
        },
      ],
    },
    autoEmitDoneOnStop: true,
  })
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })

  await expect(textarea).toBeVisible()
  await textarea.fill('Interrupt the new work')
  await sendButton.click({ button: 'right' })
  await page.getByRole('button', { name: 'Send now' }).click()

  await expect.poll(() => mock.readRequests()).toEqual([
    'stop:stream-1',
    'message:Interrupt the new work',
  ])
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')
})

test('reused ask-user itemId does not inherit an earlier answered state', async ({ page }) => {
  const now = new Date().toISOString()
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'idle',
      sessionId: 'session-1',
      messages: [createAskUserMessage(now)],
    },
    autoEmitDoneOnStop: true,
  })
  await page.goto('http://localhost:5173')

  const firstCard = page.locator('.ask-user-card').first()
  await expect(firstCard).toBeVisible()

  await firstCard.locator('.ask-user-option').filter({ hasText: 'Fast' }).click()
  await firstCard.locator('.ask-user-submit').click()

  await expect.poll(() => mock.readRequests()).toEqual(['message:Fast'])
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')

  await emitStreamEvent(page, 'stream-2', 'activity', askUserActivity)

  const latestCard = page.locator('.ask-user-card').last()
  await expect(latestCard).toBeVisible()
  await expect(latestCard).not.toHaveClass(/is-answered/)
  await expect(latestCard.locator('.ask-user-option.is-selected')).toHaveCount(0)
  await expect(latestCard.locator('.ask-user-submit')).toBeDisabled()
  await expect.poll(() => mock.readRequests()).toEqual(['message:Fast'])

  await latestCard.locator('.ask-user-option').filter({ hasText: 'Deep' }).click()
  await expect(latestCard.locator('.ask-user-submit')).toBeEnabled()
  await latestCard.locator('.ask-user-submit').click()

  await expect.poll(() => mock.readRequests()).toEqual([
    'message:Fast',
    'stop:stream-2',
    'message:Deep',
  ])
})

test('reused ask-user itemId does not inherit an unsubmitted draft selection', async ({ page }) => {
  const now = new Date().toISOString()
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'idle',
      sessionId: 'session-1',
      messages: [createAskUserMessage(now)],
    },
    autoEmitDoneOnStop: true,
  })
  await page.goto('http://localhost:5173')

  const firstCard = page.locator('.ask-user-card').first()
  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })

  await expect(firstCard).toBeVisible()
  await firstCard.locator('.ask-user-option').filter({ hasText: 'Fast' }).click()
  await expect(firstCard.locator('.ask-user-submit')).toBeEnabled()

  await textarea.fill('Start a new run')
  await sendButton.click()

  await expect.poll(() => mock.readRequests()).toEqual(['message:Start a new run'])
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')

  await emitStreamEvent(page, 'stream-2', 'activity', askUserActivity)

  const latestCard = page.locator('.ask-user-card').last()
  await expect(latestCard).toBeVisible()
  await expect(latestCard).not.toHaveClass(/is-answered/)
  await expect(latestCard.locator('.ask-user-option.is-selected')).toHaveCount(0)
  await expect(latestCard.locator('.ask-user-submit')).toBeDisabled()
  await expect.poll(() => mock.readRequests()).toEqual(['message:Start a new run'])
})

test('updating an existing ask-user card to a later question resets stale local selection state', async ({ page }) => {
  const mock = await installMockApis(page, { autoEmitDoneOnStop: true })
  await page.goto('http://localhost:5173')

  await expect(getActiveComposerTextarea(page)).toBeVisible()
  await emitStreamEvent(page, 'stream-1', 'activity', askUserActivity)

  const card = page.locator('.ask-user-card').last()
  await expect(card).toBeVisible()
  await expect(card.locator('.ask-user-question')).toHaveText('Which path should I take?')
  await card.locator('.ask-user-option').filter({ hasText: 'Fast' }).click()
  await expect(card.locator('.ask-user-option.is-selected')).toContainText('Fast')
  await expect(card.locator('.ask-user-submit')).toBeEnabled()

  await emitStreamEvent(page, 'stream-1', 'activity', followUpAskUserActivity)

  const updatedCard = page.locator('.ask-user-card').last()
  await expect(updatedCard).toBeVisible()
  await expect(updatedCard.locator('.ask-user-question')).toHaveText('How should I handle the popup question tool?')
  await expect(updatedCard).not.toHaveClass(/is-answered/)
  await expect(updatedCard.locator('.ask-user-option.is-selected')).toHaveCount(0)
  await expect(updatedCard.locator('.ask-user-submit')).toBeDisabled()
  await expect.poll(() => mock.readRequests()).toEqual([])
})

test('merged consecutive ask-user questions require answering the later question before submit', async ({ page }) => {
  const now = new Date().toISOString()
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'idle',
      sessionId: 'session-1',
      messages: [
        createAskUserMessage(now),
        createFollowUpAskUserMessage(now),
      ],
    },
    autoEmitDoneOnStop: true,
  })
  await page.goto('http://localhost:5173')

  const card = page.locator('.ask-user-card').last()
  await expect(card).toBeVisible()
  await expect(card.locator('.ask-user-counter')).toContainText('1 / 2')
  await card.locator('.ask-user-option').filter({ hasText: 'Fast' }).click()
  await expect(card.locator('.ask-user-submit')).toBeDisabled()

  await card.getByRole('button', { name: 'Next' }).click()
  await expect(card.locator('.ask-user-counter')).toContainText('2 / 2')
  await expect(card.locator('.ask-user-question')).toHaveText('How should I handle the popup question tool?')
  await expect(card.locator('.ask-user-option.is-selected')).toHaveCount(0)
  await expect(card.locator('.ask-user-submit')).toBeDisabled()
  await expect.poll(() => mock.readRequests()).toEqual([])

  await card.locator('.ask-user-option').filter({ hasText: 'Continue' }).click()
  await expect(card.locator('.ask-user-submit')).toBeEnabled()
})
