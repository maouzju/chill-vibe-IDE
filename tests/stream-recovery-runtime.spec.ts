import { expect, test, type Page } from '@playwright/test'

import { createPlaywrightState } from './playwright-state.ts'

const emitDesktopStreamEvent = async (page: Page, streamId: string, eventName: string, data: unknown) => {
  await page.evaluate(
    ({ targetStreamId, targetEventName, payload }) => {
      const bridge = window as typeof window & {
        __emitMockDesktopStreamEvent: (streamId: string, eventName: string, data: unknown) => void
      }

      bridge.__emitMockDesktopStreamEvent(targetStreamId, targetEventName, payload)
    },
    {
      targetStreamId: streamId,
      targetEventName: eventName,
      payload: data,
    },
  )
}

const installMockDesktopBridge = async (page: Page) => {
  await page.addInitScript(() => {
    const subscriptionsByStream = new Map<string, Set<string>>()
    const streamBySubscription = new Map<string, string>()

    Object.defineProperty(window, '__emitMockDesktopStreamEvent', {
      configurable: true,
      writable: true,
      value: (streamId: string, eventName: string, data: unknown) => {
        const subscriptions = subscriptionsByStream.get(streamId)
        if (!subscriptions) {
          return
        }

        for (const subscriptionId of subscriptions) {
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
      importCcSwitchRouting: async () => ({ source: 'cc-switch', importedProfiles: [] }),
      fetchSetupStatus: async () => ({ state: 'idle', logs: [] }),
      runEnvironmentSetup: async () => ({ state: 'idle', logs: [] }),
      fetchOnboardingStatus: async () => ({ complete: true }),
      fetchGitStatus: async () => ({ files: [], branch: null }),
      setGitStage: async () => ({ files: [], branch: null }),
      commitGitChanges: async () => ({ ok: true }),
      pullGitChanges: async () => ({ ok: true }),
      fetchSlashCommands: async () => [],
      requestChat: async (request) =>
        jsonRequest('/api/chat/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      uploadImageAttachment: async () => ({ id: 'image-1', mimeType: 'image/png', size: 1 }),
      stopChat: async (streamId) =>
        jsonRequest(`/api/chat/stop/${encodeURIComponent(streamId)}`, {
          method: 'POST',
        }),
      subscribeChatStream: async (streamId, subscriptionId) => {
        const existing = subscriptionsByStream.get(streamId)
        if (existing) {
          existing.add(subscriptionId)
        } else {
          subscriptionsByStream.set(streamId, new Set([subscriptionId]))
        }
        streamBySubscription.set(subscriptionId, streamId)
      },
      unsubscribeChatStream: async (subscriptionId) => {
        const streamId = streamBySubscription.get(subscriptionId)
        if (!streamId) {
          return
        }

        const subscriptions = subscriptionsByStream.get(streamId)
        subscriptions?.delete(subscriptionId)
        if (subscriptions && subscriptions.size === 0) {
          subscriptionsByStream.delete(streamId)
        }
        streamBySubscription.delete(subscriptionId)
      },
      getAttachmentUrl: (attachmentId) => `/api/attachments/${encodeURIComponent(attachmentId)}`,
    }
  })

  const now = new Date().toISOString()
  const requests: Array<{ prompt: string; sessionId?: string; streamId: string }> = []
  let nextStreamNumber = 2

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      activeTopTab: 'ambience',
      language: 'en' as const,
      theme: 'dark' as const,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: 'gpt-5.4',
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
        title: 'Recovery Test',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Recoverable Chat',
            status: 'streaming',
            size: 560,
            provider: 'codex' as const,
            model: 'gpt-5.4',
            reasoningEffort: 'medium',
            draft: '',
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

  await page.route('**/api/chat/message', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    const streamId = `stream-${nextStreamNumber++}`
    requests.push({
      prompt: body.prompt,
      sessionId: body.sessionId,
      streamId,
    })
    await route.fulfill({
      json: { streamId },
    })
  })

  await page.route('**/api/chat/stop/*', async (route) => {
    await route.fulfill({ status: 204 })
  })

  return {
    readRequests: () => requests.slice(),
    readState: () => state,
  }
}

test('recoverable streaming errors resume the session instead of stopping immediately', async ({ page }) => {
  const mock = await installMockDesktopBridge(page)
  await page.goto('http://localhost:5173')

  await expect(page.locator('.pane-tab-panel.is-active .composer textarea').first()).toBeVisible()

  await emitDesktopStreamEvent(page, 'stream-1', 'error', {
    message: 'Codex ended without emitting a terminal completion event.',
    recoverable: true,
    recoveryMode: 'resume-session',
  })

  await expect
    .poll(() => mock.readRequests())
    .toEqual([
      {
        prompt: '',
        sessionId: 'session-1',
        streamId: 'stream-2',
      },
    ])

  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.status).toBe('streaming')
  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.streamId).toBe('stream-2')

  await emitDesktopStreamEvent(page, 'stream-2', 'done', {})

  await expect.poll(() => mock.readState().columns[0]?.cards['card-1']?.status).toBe('idle')
})
