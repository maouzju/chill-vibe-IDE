// Diagnostic repro for forensic dump 2026-07-08T06-22-00: on a pane with a
// streaming tab, the user clicks "+" to add a tab; the new composer textarea
// receives focusin and is kicked out 5-10ms later by a programmatic focusout
// (no user gesture), repeatedly, with every self-heal counter at zero.
// This spec instruments blur()/focus() call stacks and attribute mutations to
// name whoever kicks the focus.
import { expect, test, type Page } from '@playwright/test'

import { createPane } from '../shared/default-state.ts'
import type { AppState, ChatMessage } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

type FocusForensics = {
  ledger: Array<{ t: number; kind: string; path: string }>
  blurCalls: Array<{ t: number; el: string; stack: string }>
  focusCalls: Array<{ t: number; el: string; landed: boolean; stack: string }>
  mutations: Array<{ t: number; el: string; attr: string; value: string | null }>
}

declare global {
  interface Window {
    __focusForensics?: FocusForensics
    __paneTabRuntimeTest?: {
      emit: (streamId: string, eventName: string, payload: unknown) => void
    }
  }
}

const createHistoryMessage = (cardId: string, index: number): ChatMessage => ({
  id: `${cardId}-message-${index + 1}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `${cardId} message ${index + 1}: ${'detail '.repeat(48)}`,
  createdAt: new Date(Date.UTC(2026, 3, 12, 1, Math.floor(index / 60), index % 60)).toISOString(),
  meta: index % 2 === 0 ? undefined : { provider: 'codex' },
})

const createChatCard = (
  id: string,
  title: string,
  options: {
    messageCount?: number
    status?: 'idle' | 'streaming'
    streamId?: string
    sessionId?: string
  } = {},
) => ({
  id,
  title,
  status: options.status ?? 'idle',
  size: 560,
  provider: 'codex' as const,
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  draft: '',
  streamId: options.streamId,
  sessionId: options.sessionId,
  messages: Array.from({ length: options.messageCount ?? 0 }, (_, index) =>
    createHistoryMessage(id, index),
  ),
})

const createState = (): AppState => {
  const cards = [
    createChatCard('card-1', 'Streaming Session', {
      messageCount: 60,
      status: 'streaming',
      streamId: 'live-stream-1',
      sessionId: 'live-session-1',
    }),
    createChatCard('card-2', 'History 1', { messageCount: 60 }),
  ]

  return createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en',
      theme: 'dark',
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
    updatedAt: new Date('2026-04-12T01:30:00.000Z').toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Focus Repro',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        cards,
        layout: createPane(cards.map((card) => card.id), 'card-1', 'pane-1'),
      },
    ],
  })
}

const installFocusForensics = async (page: Page) => {
  await page.addInitScript(() => {
    const describe = (node: unknown): string => {
      if (!(node instanceof Element)) {
        return String(node)
      }
      const parts: string[] = []
      let current: Element | null = node
      while (current && parts.length < 4) {
        const cls = current.className && typeof current.className === 'string'
          ? `.${current.className.trim().split(/\s+/u).slice(0, 3).join('.')}`
          : ''
        parts.push(`${current.tagName.toLowerCase()}${cls}`)
        current = current.parentElement
      }
      return parts.join(' > ')
    }

    const forensics = {
      ledger: [] as Array<{ t: number; kind: string; path: string }>,
      blurCalls: [] as Array<{ t: number; el: string; stack: string }>,
      focusCalls: [] as Array<{ t: number; el: string; landed: boolean; stack: string }>,
      mutations: [] as Array<{ t: number; el: string; attr: string; value: string | null }>,
    }
    window.__focusForensics = forensics

    document.addEventListener(
      'focusin',
      (event) => {
        forensics.ledger.push({ t: performance.now(), kind: 'focusin', path: describe(event.target) })
      },
      true,
    )
    document.addEventListener(
      'focusout',
      (event) => {
        forensics.ledger.push({ t: performance.now(), kind: 'focusout', path: describe(event.target) })
      },
      true,
    )

    const originalBlur = HTMLElement.prototype.blur
    HTMLElement.prototype.blur = function blurWithForensics(this: HTMLElement) {
      forensics.blurCalls.push({
        t: performance.now(),
        el: describe(this),
        stack: new Error('blur-trace').stack ?? '',
      })
      return originalBlur.call(this)
    }

    const originalFocus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function focusWithForensics(
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      originalFocus.call(this, options)
      forensics.focusCalls.push({
        t: performance.now(),
        el: describe(this),
        landed: document.activeElement === this,
        stack: new Error('focus-trace').stack ?? '',
      })
    }

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== 'attributes') {
          continue
        }
        const target = record.target
        if (!(target instanceof Element)) {
          continue
        }
        const isComposerRelated =
          target.tagName === 'TEXTAREA' ||
          target.closest('.composer') !== null ||
          target.classList.contains('pane-tab-panel')
        if (!isComposerRelated) {
          continue
        }
        forensics.mutations.push({
          t: performance.now(),
          el: describe(target),
          attr: record.attributeName ?? '',
          value: target.getAttribute(record.attributeName ?? ''),
        })
      }
    })
    window.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'hidden', 'inert', 'style', 'class', 'readonly'],
      })
    })
  })
}

const installMockApis = async (page: Page) => {
  await page.addInitScript(() => {
    const sourcesByUrl = new Map<string, Set<MockEventSource>>()

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

    Object.defineProperty(window, '__paneTabRuntimeTest', {
      configurable: true,
      writable: true,
      value: {
        emit(streamId: string, eventName: string, payload: unknown) {
          const url = `/api/chat/stream/${encodeURIComponent(streamId)}`
          const sources = sourcesByUrl.get(url)
          if (!sources) {
            return 0
          }

          for (const source of sources) {
            source.emit(eventName, payload)
          }

          return sources.size
        },
      },
    })
  })

  let state = createState()

  await installMockElectronBridge(page)

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
    await route.fulfill({ json: { stopped: true } })
  })

  return {
    readState: () => state,
  }
}

test('new tab composer keeps focus while a sibling tab streams', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
  })

  await installFocusForensics(page)
  await installMockApis(page)

  await page.setViewportSize({ width: 1440, height: 940 })
  await page.goto(appUrl)

  await expect(page.locator('.pane-tab.is-active .pane-tab-label')).toHaveText('Streaming Session')

  // Keep streaming deltas flowing to the active tab, like the dump scenario.
  await page.evaluate(() => {
    let sequence = 0
    const timer = window.setInterval(() => {
      sequence += 1
      window.__paneTabRuntimeTest?.emit('live-stream-1', 'delta', {
        content: `streaming delta ${sequence} ${'chunk '.repeat(64)}`,
      })
    }, 80)
    window.setTimeout(() => window.clearInterval(timer), 15_000)
  })

  await page.waitForTimeout(500)

  // The user gesture from the dump: click "+" to open a fresh tab.
  await page.locator('.pane-add-tab').click()
  await expect(page.locator('.pane-tab')).toHaveCount(3)
  await page.waitForTimeout(900)

  const activePanel = page.locator('.pane-tab-panel.is-active')
  const textarea = activePanel.locator('.composer textarea')
  await expect(textarea).toBeVisible()

  // Click the textarea repeatedly like the user did (three presses ~500ms apart).
  for (let press = 0; press < 3; press += 1) {
    await textarea.click()
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(2000)

  const forensics = await page.evaluate(() => {
    const data = window.__focusForensics
    return {
      ledger: data?.ledger ?? [],
      blurCalls: (data?.blurCalls ?? []).map((call) => ({
        ...call,
        stack: call.stack.split('\n').slice(0, 8).join('\n'),
      })),
      focusCalls: (data?.focusCalls ?? []).map((call) => ({
        ...call,
        stack: call.stack.split('\n').slice(0, 8).join('\n'),
      })),
      mutations: data?.mutations ?? [],
      activeElement: document.activeElement
        ? `${document.activeElement.tagName.toLowerCase()}.${(document.activeElement as HTMLElement).className}`
        : 'null',
    }
  })

  console.log('=== activeElement at end ===')
  console.log(forensics.activeElement)
  console.log('=== focus ledger ===')
  for (const entry of forensics.ledger) {
    console.log(`${entry.t.toFixed(1)}  ${entry.kind.padEnd(9)} ${entry.path}`)
  }
  console.log('=== blur() calls ===')
  for (const call of forensics.blurCalls) {
    console.log(`${call.t.toFixed(1)}  ${call.el}\n${call.stack}\n`)
  }
  console.log('=== focus() calls (landed?) ===')
  for (const call of forensics.focusCalls) {
    console.log(`${call.t.toFixed(1)}  landed=${call.landed}  ${call.el}\n${call.stack}\n`)
  }
  console.log('=== composer-related attribute mutations ===')
  for (const mutation of forensics.mutations.slice(-60)) {
    console.log(`${mutation.t.toFixed(1)}  ${mutation.attr}=${mutation.value}  ${mutation.el}`)
  }

  expect(pageErrors).toEqual([])

  // The dump signature: focusin on the textarea followed within 50ms by a
  // focusout with no matching user press, ending with vacant focus.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const active = document.activeElement
        return active instanceof HTMLTextAreaElement
      }),
    )
    .toBe(true)
})
