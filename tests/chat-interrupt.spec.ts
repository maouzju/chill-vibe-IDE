import { expect, test, type Page } from '@playwright/test'

import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

type MockCardState = {
  status: 'idle' | 'streaming'
  streamId?: string
  sessionId?: string
  sessionModel?: string
  provider?: 'codex' | 'claude'
  model?: string
  wakeTimerActive?: boolean
  wakeTimerMode?: 'workspace-agents' | 'left-tab' | 'duration'
  wakeTimerDurationMinutes?: number
  wakeTimerArmedAt?: string
  wakeTimerWakeAt?: string
  wakeTimerPendingTargetIds?: string[]
  wakeTimerQueuedSends?: Array<{
    id: string
    prompt: string
    attachments: Array<Record<string, unknown>>
    isContinuation?: true
  }>
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
    stopResponse?: 'ok' | 'not-found'
    nativeTurnCompletion?: 'completed' | 'incomplete' | 'unknown'
    wakeTimerEnabled?: boolean
    peerCard?: MockCardState & { id: string; title: string }
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
      sessionModel: 'gpt-5.5',
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
    stopResponse = 'ok',
    nativeTurnCompletion = 'unknown',
    wakeTimerEnabled = false,
    peerCard,
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
      wakeTimerEnabled,
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
            sessionModel: initialCard.sessionModel ?? (initialCard.sessionId ? initialModel : undefined),
            wakeTimerActive: initialCard.wakeTimerActive,
            wakeTimerMode: initialCard.wakeTimerMode,
            wakeTimerDurationMinutes: initialCard.wakeTimerDurationMinutes,
            wakeTimerArmedAt: initialCard.wakeTimerArmedAt,
            wakeTimerWakeAt: initialCard.wakeTimerWakeAt,
            wakeTimerPendingTargetIds: initialCard.wakeTimerPendingTargetIds,
            wakeTimerQueuedSends: initialCard.wakeTimerQueuedSends,
            messages: initialCard.messages,
          },
          ...(peerCard
            ? [{
                id: peerCard.id,
                title: peerCard.title,
                status: peerCard.status,
                size: 560,
                provider: peerCard.provider ?? 'codex',
                model: peerCard.model ?? 'gpt-5.5',
                reasoningEffort: 'medium',
                draft: '',
                streamId: peerCard.streamId,
                sessionId: peerCard.sessionId,
                sessionModel: peerCard.sessionModel,
                wakeTimerActive: peerCard.wakeTimerActive,
                wakeTimerMode: peerCard.wakeTimerMode,
                wakeTimerDurationMinutes: peerCard.wakeTimerDurationMinutes,
                wakeTimerArmedAt: peerCard.wakeTimerArmedAt,
                wakeTimerWakeAt: peerCard.wakeTimerWakeAt,
                wakeTimerPendingTargetIds: peerCard.wakeTimerPendingTargetIds,
                wakeTimerQueuedSends: peerCard.wakeTimerQueuedSends,
                messages: peerCard.messages,
              }]
            : []),
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
    if (stopResponse === 'not-found') {
      await route.fulfill({
        status: 404,
        json: { message: 'Stream not found or already finished.' },
      })
      return
    }

    await route.fulfill({ status: 204 })
    if (autoEmitDoneOnStop) {
      await emitStreamEvent(page, streamId, 'done', { stopped: true }, { waitForSubscriber: false })
    }
  })

  await page.route('**/api/chat/native-turn-completion', async (route) => {
    await route.fulfill({ json: { completion: nativeTurnCompletion } })
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

test('a completed agent run appends one persisted duration summary', async ({ page }) => {
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'idle',
      provider: 'codex',
      model: 'gpt-5.5',
      messages: [],
    },
  })
  await page.goto(appUrl)

  const textarea = getActiveComposerTextarea(page)
  await textarea.fill('Finish this task')
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect.poll(() => mock.readRequests()).toEqual(['message:Finish this task'])
  await emitStreamEvent(page, 'stream-2', 'delta', { content: 'Done.' })
  await expect(page.locator('.message-assistant')).toContainText('Done.')
  await emitStreamEvent(page, 'stream-2', 'done', {})

  const duration = page.locator('.message-run-duration')
  await expect(duration).toHaveCount(1)
  await expect(duration).toHaveText(/Ran for \d+s/)
  await expect.poll(() => {
    const messages = mock.readState().columns[0]?.cards['card-1']?.messages ?? []
    const marker = messages.find((message) => message.meta?.kind === 'run-duration')
    return marker
      ? {
          role: marker.role,
          count: messages.filter((message) => message.meta?.kind === 'run-duration').length,
          hasFiniteDuration: Number.isFinite(Number(marker.meta?.durationMs)),
        }
      : null
  }).toEqual({ role: 'system', count: 1, hasFiniteDuration: true })
})

test('wake timer holds multiple messages and releases them as one batch when requested', async ({ page }) => {
  const mock = await installMockApis(page, {
    wakeTimerEnabled: true,
    initialCard: {
      status: 'idle',
      provider: 'codex',
      model: 'gpt-5.5',
      wakeTimerActive: true,
      wakeTimerMode: 'duration',
      wakeTimerDurationMinutes: 60,
      messages: [],
    },
  })
  await page.goto(appUrl)

  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })
  await textarea.fill('First scheduled instruction')
  await sendButton.click()
  await textarea.fill('Second scheduled instruction')
  await sendButton.click()

  const timerStatus = page.locator('.message-list .composer-wake-timer-status')
  await expect(timerStatus).toContainText('2 messages')
  await expect(page.locator('.chat-empty-tool-grid')).toHaveCount(0)
  await expect(page.locator('.card-footer > .composer-wake-timer-status')).toHaveCount(0)
  await expect.poll(() => mock.readRequests()).toEqual([])
  await expect.poll(
    () => mock.readState().columns[0]?.cards['card-1']?.wakeTimerQueuedSends?.length,
  ).toBe(2)

  await timerStatus.getByRole('button', { name: 'Wake now' }).click()

  await expect.poll(() => mock.readChatRequests()).toHaveLength(1)
  await expect.poll(() => mock.readChatRequests()[0]?.prompt).toBe(
    'First scheduled instruction\n\nSecond scheduled instruction',
  )
  await expect(timerStatus).toHaveCount(0)
})

test('wake timer holds an empty continue-session action until wake', async ({ page }) => {
  const mock = await installMockApis(page, {
    wakeTimerEnabled: true,
    initialCard: {
      status: 'idle',
      sessionId: 'session-continue-later',
      sessionModel: 'gpt-5.5',
      provider: 'codex',
      model: 'gpt-5.5',
      wakeTimerActive: true,
      wakeTimerMode: 'duration',
      wakeTimerDurationMinutes: 60,
      messages: [{
        id: 'assistant-before-continue',
        role: 'assistant',
        content: 'I can continue from here.',
        createdAt: new Date().toISOString(),
      }],
    },
  })
  await page.goto(appUrl)

  const sendButton = page.getByRole('button', { name: 'Send message' })
  await expect(getActiveComposerTextarea(page)).toHaveValue('')
  await expect(sendButton).toBeEnabled()
  await sendButton.click()

  const timerStatus = page.locator('.pane-tab-panel.is-active .composer-wake-timer-status')
  await expect(timerStatus).toContainText('1 message')
  await expect.poll(() => mock.readChatRequests()).toEqual([])
  await expect.poll(() => {
    const queued = mock.readState().columns[0]?.cards['card-1']?.wakeTimerQueuedSends
    return queued?.map((entry) => ({
      prompt: entry.prompt,
      attachments: entry.attachments,
      isContinuation: entry.isContinuation,
    }))
  }).toEqual([{ prompt: '', attachments: [], isContinuation: true }])

  await timerStatus.getByRole('button', { name: 'Wake now' }).click()

  await expect.poll(() => mock.readChatRequests()).toHaveLength(1)
  await expect.poll(() => mock.readChatRequests()[0]).toMatchObject({
    prompt: '',
    sessionId: 'session-continue-later',
  })
  await expect(page.locator('.message-user')).toHaveCount(0)
})

test('canceling a wake timer restores the queued messages before the current draft', async ({ page }) => {
  const mock = await installMockApis(page, {
    wakeTimerEnabled: true,
    initialCard: {
      status: 'idle',
      provider: 'codex',
      model: 'gpt-5.5',
      wakeTimerActive: true,
      wakeTimerMode: 'duration',
      wakeTimerDurationMinutes: 60,
      wakeTimerArmedAt: '2026-07-27T00:00:00.000Z',
      wakeTimerQueuedSends: [
        { id: 'queued-one', prompt: 'First scheduled instruction', attachments: [] },
        { id: 'queued-two', prompt: 'Second scheduled instruction', attachments: [] },
      ],
      messages: [],
    },
  })
  await page.goto(appUrl)

  const textarea = getActiveComposerTextarea(page)
  await textarea.fill('Draft written while waiting')
  const timerStatus = page.locator('.composer-wake-timer-status')
  await timerStatus.getByRole('button', { name: 'Cancel' }).click()

  await expect(timerStatus).toHaveCount(0)
  await expect(textarea).toHaveValue(
    'First scheduled instruction\n\nSecond scheduled instruction\n\nDraft written while waiting',
  )
  await expect.poll(() => {
    const card = mock.readState().columns[0]?.cards['card-1']
    return {
      draft: card?.draft,
      queuedCount: card?.wakeTimerQueuedSends?.length,
    }
  }).toEqual({
    draft: 'First scheduled instruction\n\nSecond scheduled instruction\n\nDraft written while waiting',
    queuedCount: 0,
  })
  await expect.poll(() => mock.readRequests()).toEqual([])
})

test('workspace wake timer releases only after a running peer stays normally completed', async ({ page }) => {
  const mock = await installMockApis(page, {
    wakeTimerEnabled: true,
    initialCard: {
      status: 'idle',
      provider: 'codex',
      model: 'gpt-5.5',
      wakeTimerActive: true,
      wakeTimerMode: 'workspace-agents',
      messages: [],
    },
    peerCard: {
      id: 'card-2',
      title: 'Running peer',
      status: 'streaming',
      streamId: 'peer-stream-1',
      sessionId: 'peer-session-1',
      sessionModel: 'gpt-5.5',
      provider: 'codex',
      model: 'gpt-5.5',
      messages: [{
        id: 'peer-assistant-1',
        role: 'assistant',
        content: 'Still working',
        createdAt: new Date().toISOString(),
      }],
    },
  })
  await page.goto(appUrl)

  const textarea = getActiveComposerTextarea(page)
  await textarea.fill('Wake after the peer is really done')
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.locator('.composer-wake-timer-status')).toContainText('Waiting for 1 other agent')
  await expect.poll(() => mock.readRequests()).toEqual([])

  await emitStreamEvent(page, 'peer-stream-1', 'done', {})
  await page.waitForTimeout(900)
  await expect.poll(() => mock.readRequests()).toEqual([])
  await expect.poll(() => mock.readChatRequests(), { timeout: 3000 }).toHaveLength(1)
  await expect.poll(() => mock.readChatRequests()[0]?.prompt).toContain('Wake after the peer is really done')
})

test('workspace wake timer never releases a restored batch while another agent is still running', async ({ page }) => {
  const mock = await installMockApis(page, {
    wakeTimerEnabled: true,
    initialCard: {
      status: 'idle',
      provider: 'codex',
      model: 'gpt-5.5',
      wakeTimerActive: true,
      wakeTimerMode: 'workspace-agents',
      wakeTimerArmedAt: '2026-07-25T00:00:00.000Z',
      wakeTimerPendingTargetIds: [],
      wakeTimerQueuedSends: [{
        id: 'wake-restored-1',
        prompt: '/commit-pull-merge-push',
        attachments: [],
      }],
      messages: [],
    },
    peerCard: {
      id: 'card-2',
      title: 'Still running peer',
      status: 'streaming',
      streamId: 'peer-stream-restored',
      sessionId: 'peer-session-restored',
      sessionModel: 'gpt-5.5',
      provider: 'codex',
      model: 'gpt-5.5',
      messages: [{
        id: 'peer-assistant-restored',
        role: 'assistant',
        content: 'Still working',
        createdAt: new Date().toISOString(),
      }],
    },
  })
  await page.goto(appUrl)

  await expect(page.locator('.composer-wake-timer-status')).toContainText('1 message')
  await page.waitForTimeout(1500)
  await expect.poll(() => mock.readRequests()).toEqual([])
  await expect.poll(
    () => mock.readState().columns[0]?.cards['card-1']?.wakeTimerQueuedSends?.length,
  ).toBe(1)
})

test('left-tab wake timer chains onto a left neighbour that is itself waiting to wake', async ({ page }) => {
  const mock = await installMockApis(page, {
    wakeTimerEnabled: true,
    initialCard: {
      status: 'idle',
      provider: 'codex',
      model: 'gpt-5.5',
      wakeTimerActive: true,
      wakeTimerMode: 'duration',
      wakeTimerDurationMinutes: 600,
      wakeTimerArmedAt: '2026-07-28T00:00:00.000Z',
      wakeTimerWakeAt: '2099-01-01T00:00:00.000Z',
      wakeTimerPendingTargetIds: [],
      wakeTimerQueuedSends: [{
        id: 'wake-left-1',
        prompt: 'Left tab runs first',
        attachments: [],
      }],
      messages: [],
    },
    peerCard: {
      id: 'card-2',
      title: 'Chained follow-up',
      status: 'idle',
      provider: 'codex',
      model: 'gpt-5.5',
      wakeTimerActive: true,
      wakeTimerMode: 'left-tab',
      messages: [],
    },
  })
  await page.goto(appUrl)

  await page.locator('.pane-tab', { hasText: 'Chained follow-up' }).click()
  await expect(page.locator('.pane-tab.is-active .pane-tab-label')).toHaveText('Chained follow-up')
  const textarea = getActiveComposerTextarea(page)
  await textarea.fill('Run only after the left tab really finishes')
  await page.getByRole('button', { name: 'Send message' }).click()

  // 左邻自己还压着批次（idle 但未完成），链式模式必须继续等，不能立刻发车。
  await expect(page.locator('.pane-tab-panel.is-active .composer-wake-timer-status'))
    .toContainText('Waiting for the left tab')
  await page.waitForTimeout(1500)
  await expect.poll(() => mock.readChatRequests()).toEqual([])
  await expect.poll(
    () => mock.readState().columns[0]?.cards['card-2']?.wakeTimerPendingTargetIds,
  ).toEqual(['card-1'])

  // 左邻的批次被取消后它永远不会自己开跑，下游必须解锁而不是永久卡死。
  await page.locator('.pane-tab', { hasText: 'Feature Chat' }).click()
  await expect(page.locator('.pane-tab.is-active .pane-tab-label')).toHaveText('Feature Chat')
  await page.locator('.pane-tab-panel.is-active .composer-wake-timer-status button', {
    hasText: 'Cancel',
  }).click()

  await expect.poll(() => mock.readChatRequests(), { timeout: 5000 }).toHaveLength(1)
  await expect.poll(() => mock.readChatRequests()[0]?.prompt)
    .toContain('Run only after the left tab really finishes')
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
  await expect.poll(() => mock.readRequests()).toHaveLength(2)
  await expect.poll(() => mock.readRequests()[0]).toBe('stop:stream-1')
  await expect.poll(() => mock.readRequests()[1]).toContain('Latest user message:\nSend this follow-up now')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.status).toBe('streaming')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.messages[1]?.meta?.stopReason).toBe('user-interrupt')
})

test('left-click send still dispatches when the stale stream never emits done after stop', async ({ page }) => {
  const mock = await installMockApis(page, {
    autoEmitDoneOnStop: false,
  })
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })

  await textarea.fill('Recover this stale running card')
  await sendButton.click()

  await expect.poll(() => mock.readRequests()[0]).toBe('stop:stream-1')
  await expect.poll(() => mock.readRequests()[1]).toContain(
    'Latest user message:\nRecover this stale running card',
  )
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.messages[1]?.meta?.stopReason).toBe('user-interrupt')
})

test('a completed native Codex turn finalizes locally instead of ghost-continuing after stream loss', async ({ page }) => {
  const mock = await installMockApis(page, {
    nativeTurnCompletion: 'completed',
  })
  await page.goto(appUrl)

  await emitStreamEvent(page, 'stream-1', 'error', {
    message: 'Stream not found.',
    recovery: {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
    sessionId: 'session-1',
  })

  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.status).toBe('idle')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBeUndefined()
  await expect.poll(() => mock.readRequests()).toEqual([])
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

test('queued messages survive a renderer reload without dispatching on startup', async ({ page }) => {
  const mock = await installMockApis(page)
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })
  await textarea.fill('Keep this queued across reload')
  await sendButton.click({ button: 'right' })

  await expect.poll(
    () => mock.readState().columns[0]?.cards['card-1']?.queuedSends?.[0]?.prompt,
  ).toBe('Keep this queued across reload')
  await page.reload()

  await expect(page.locator('.composer-queued-send')).toContainText('Keep this queued across reload')
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

  await expect.poll(() => mock.readRequests()).toHaveLength(2)
  await expect.poll(() => mock.readRequests()[0]).toBe('stop:stream-1')
  await expect.poll(() => mock.readRequests()[1]).toContain('Latest user message:\nSend this queued prompt now')
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

test('Send now escapes a stale compact boundary instead of requeueing forever', async ({ page }) => {
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'idle',
      messages: [],
    },
    autoEmitDoneOnStop: false,
  })
  await page.goto(appUrl)

  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })

  await textarea.fill('/compact')
  await sendButton.click()
  await expect.poll(() => mock.readRequests()).toEqual(['message:/compact'])

  await textarea.fill('Interrupt the stale compact run')
  await sendButton.click()
  await expect(page.locator('.composer-queued-send')).toContainText('Interrupt the stale compact run')

  await page.getByRole('button', { name: 'Send now' }).click()

  await expect.poll(() => mock.readRequests()[1]).toBe('stop:stream-2')
  await expect.poll(() => mock.readRequests()[2]).toContain(
    'Latest user message:\nInterrupt the stale compact run',
  )
  await expect(page.locator('.composer-queued-send')).toHaveCount(0)
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-3')
})

test('send now locally settles an impossible streaming card with no stream id', async ({ page }) => {
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'streaming',
      streamId: undefined,
      sessionId: 'stale-session-without-stream',
      messages: [{
        id: 'assistant-before-stale-state',
        role: 'assistant',
        content: 'The old run lost its stream ownership.',
        createdAt: new Date().toISOString(),
      }],
    },
  })
  await page.goto(appUrl)

  const textarea = getActiveComposerTextarea(page)
  await textarea.fill('Recover a card with no stream id')
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect.poll(() => mock.readRequests()[0]).toContain(
    'Latest user message:\nRecover a card with no stream id',
  )
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')
  await expect(page.locator('.composer-queued-send')).toHaveCount(0)
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
    .toEqual(['assistant', 'assistant', 'assistant', 'system', 'user'])
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
    .toEqual(['assistant', 'assistant', 'system', 'user'])
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
    .toEqual(['assistant', 'system', 'user'])
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')
})

test('answering a restored ask-user card still sends if stop does not emit done', async ({ page }) => {
  const now = new Date().toISOString()
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'streaming',
      streamId: 'stream-1',
      sessionId: 'session-1',
      messages: [createAskUserMessage(now)],
    },
    autoEmitDoneOnStop: false,
  })
  await page.goto('http://localhost:5173')

  await expect(getActiveComposerTextarea(page)).toBeVisible()
  await expect(page.locator('.ask-user-card')).toBeVisible()

  await page.locator('.ask-user-option').filter({ hasText: 'Fast' }).click()
  await page.locator('.ask-user-submit').click()

  await expect.poll(() => mock.readRequests()[0]).toBe('stop:stream-1')
  await expect.poll(() => mock.readRequests().filter((entry) => entry === 'stop:stream-1').length).toBe(1)
  await expect.poll(() => mock.readRequests()).toContain('message:Fast')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')
})

test('answering a restored ask-user card still sends if stop says the old stream is gone', async ({ page }) => {
  const now = new Date().toISOString()
  const mock = await installMockApis(page, {
    initialCard: {
      status: 'streaming',
      streamId: 'stream-1',
      sessionId: 'session-1',
      messages: [createAskUserMessage(now)],
    },
    stopResponse: 'not-found',
  })
  await page.goto('http://localhost:5173')

  await expect(getActiveComposerTextarea(page)).toBeVisible()
  await expect(page.locator('.ask-user-card')).toBeVisible()

  await page.locator('.ask-user-option').filter({ hasText: 'Fast' }).click()
  await page.locator('.ask-user-submit').click()

  await expect.poll(() => mock.readRequests()[0]).toBe('stop:stream-1')
  await expect.poll(() => mock.readRequests().filter((entry) => entry === 'stop:stream-1').length).toBe(1)
  await expect.poll(() => mock.readRequests()).toContain('message:Fast')
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

  await expect.poll(() => mock.readRequests()).toHaveLength(2)
  await expect.poll(() => mock.readRequests()[0]).toBe('stop:stream-1')
  await expect.poll(() => mock.readRequests()[1]).toContain('Latest user message:\nInterrupt the new work')
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
  await card.locator('.ask-user-submit').click()

  await expect.poll(() => mock.readRequests()).toContain(
    'message:[1] Which path should I take? → Fast\n[2] How should I handle the popup question tool? → Continue',
  )
})
