import { expect, test, type Page } from '@playwright/test'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'

const installMockApis = async (page: Page, theme: ThemeName) => {
  await installMockElectronBridge(page)

  const initialState = createPlaywrightState({
    version: 1,
    settings: {
      language: 'zh-CN',
      theme,
      fontScale: 1,
      lineHeightScale: 1,
      requestModels: {
        codex: 'gpt-5.5',
        claude: 'claude-opus-4-7',
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Input Test',
        provider: 'codex',
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        cards: [
          {
            id: 'card-1',
            title: 'Feature Chat',
            status: 'idle',
            size: 560,
            provider: 'codex',
            model: 'gpt-5.5',
            reasoningEffort: 'medium',
            messages: [],
          },
        ],
      },
    ],
  })

  await page.addInitScript(({ initialState }) => {
    const appState = structuredClone(initialState)

    const responseJson = (payload: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
        ...init,
      })

    const readUrl = (input: RequestInfo | URL) => {
      if (typeof input === 'string') {
        return input
      }

      if (input instanceof Request) {
        return input.url
      }

      return input.toString()
    }

    const originalFetch = window.fetch.bind(window)
    const imeWindow = window as Window & {
      __chatImeSendCount?: number
      __chatImeSentPrompts?: string[]
    }
    imeWindow.__chatImeSendCount = 0
    imeWindow.__chatImeSentPrompts = []

    window.fetch = async (input, init) => {
      const url = new URL(readUrl(input), window.location.origin)
      const method =
        init?.method ??
        (input instanceof Request ? input.method : undefined) ??
        'GET'

      if (url.pathname === '/api/state') {
        if (method === 'GET') {
          return responseJson(appState)
        }

        if (method === 'PUT') {
          const rawBody =
            init?.body ??
            (input instanceof Request ? await input.clone().text() : undefined) ??
            '{}'
          const bodyText =
            typeof rawBody === 'string'
              ? rawBody
              : rawBody instanceof Blob
                ? await rawBody.text()
                : '{}'

          Object.assign(appState, JSON.parse(bodyText))
          return responseJson(appState)
        }
      }

      if (url.pathname === '/api/state/snapshot') {
        return new Response(null, { status: 204 })
      }

      if (url.pathname === '/api/providers') {
        return responseJson([
          { provider: 'codex', available: true, command: 'codex' },
          { provider: 'claude', available: true, command: 'claude' },
        ])
      }

      if (url.pathname === '/api/slash-commands') {
        return responseJson([])
      }

      if (url.pathname === '/api/chat/message') {
        imeWindow.__chatImeSendCount = (imeWindow.__chatImeSendCount ?? 0) + 1
        const rawBody =
          init?.body ??
          (input instanceof Request ? await input.clone().text() : undefined) ??
          '{}'
        const bodyText =
          typeof rawBody === 'string'
            ? rawBody
            : rawBody instanceof Blob
              ? await rawBody.text()
              : '{}'
        const body = JSON.parse(bodyText)
        imeWindow.__chatImeSentPrompts = [
          ...(imeWindow.__chatImeSentPrompts ?? []),
          typeof body.prompt === 'string' ? body.prompt : '',
        ]

        return responseJson(
          { message: 'blocked by IME regression test' },
          { status: 500 },
        )
      }

      return originalFetch(input, init)
    }

    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      value: () => true,
    })
  }, { initialState })
}

const readSendCount = (page: Page) =>
  page.evaluate(() => {
    const imeWindow = window as Window & { __chatImeSendCount?: number }
    return imeWindow.__chatImeSendCount ?? 0
  })

const readSentPrompts = (page: Page) =>
  page.evaluate(() => {
    const imeWindow = window as Window & { __chatImeSentPrompts?: string[] }
    return imeWindow.__chatImeSentPrompts ?? []
  })

const dispatchImeConfirmationEnter = async (page: Page) => {
  await page.locator('.textarea').first().evaluate(
    (node) => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'ni' }))
      node.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '\u4f60' }),
      )

      const confirmationEnter = new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Enter',
        code: 'Enter',
      })

      Object.defineProperty(confirmationEnter, 'isComposing', {
        configurable: true,
        value: true,
      })
      Object.defineProperty(confirmationEnter, 'keyCode', {
        configurable: true,
        value: 229,
      })

      node.dispatchEvent(confirmationEnter)
    },
  )
}

for (const theme of ['dark', 'light'] as const) {
  test(`chat composer ignores IME confirmation Enter in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.goto('http://localhost:5173')

    const textarea = page.locator('.textarea').first()
    await textarea.waitFor()
    await textarea.fill('\u4f60\u597d')
    await expect(textarea).toHaveValue('\u4f60\u597d')
    await textarea.focus()

    await dispatchImeConfirmationEnter(page)

    await page.waitForTimeout(50)
    await expect.poll(() => readSendCount(page)).toBe(0)
    await expect(textarea).toHaveValue('\u4f60\u597d')
  })

  test(`chat composer ignores a clean Enter that lands in the same tick as composition end in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme)
    await page.goto('http://localhost:5173')

    const textarea = page.locator('.textarea').first()
    await textarea.waitFor()
    await textarea.focus()

    await textarea.evaluate((node) => {
      const setNativeValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set

      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'ni' }))
      setNativeValue?.call(node, 'ni')
      node.dispatchEvent(new Event('input', { bubbles: true }))
      node.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '\u4f60' }),
      )
      node.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          key: 'Enter',
          code: 'Enter',
        }),
      )
    })

    await page.waitForTimeout(50)
    await expect.poll(() => readSendCount(page)).toBe(0)
    await expect.poll(() => readSentPrompts(page)).toEqual([])
  })

  test(`chat composer submits on a quick clean Enter right after composition commit in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme)
    await page.goto('http://localhost:5173')

    const textarea = page.locator('.textarea').first()
    await textarea.waitFor()
    await textarea.fill('\u4f60\u597d')
    await expect(textarea).toHaveValue('\u4f60\u597d')
    await textarea.focus()

    await textarea.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'ni' }))
      node.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '\u4f60' }),
      )
      window.setTimeout(() => {
        node.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'Enter',
            code: 'Enter',
          }),
        )
      }, 0)
    })
    await page.waitForTimeout(50)

    await expect.poll(() => readSendCount(page)).toBe(1)
    await expect.poll(() => readSentPrompts(page)).toEqual(['\u4f60\u597d'])
    await expect(textarea).toHaveValue('')
  })

  test(`chat composer keeps accepting input after numeric text is followed by IME composition in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme)
    await page.goto('http://localhost:5173')

    const textarea = page.locator('.textarea').first()
    await textarea.waitFor()
    await textarea.fill('1231232123')
    await expect(textarea).toHaveValue('1231232123')
    await textarea.focus()

    await textarea.evaluate((node) => {
      const setNativeValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set

      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'ni' }))
      setNativeValue?.call(node, '1231232123ni')
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Let the queued draft persistence flush while IME composition is active.
    await page.waitForTimeout(450)

    await textarea.evaluate((node) => {
      const setNativeValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set

      setNativeValue?.call(node, '1231232123你')
      node.dispatchEvent(new Event('input', { bubbles: true }))
      node.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '\u4f60' }),
      )
    })

    await page.waitForTimeout(50)
    await expect(textarea).toHaveValue('1231232123你')

    await textarea.type('a')
    await expect(textarea).toHaveValue('1231232123你a')
  })

  test(`chat composer submits on the first clean Enter after composition has settled in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme)
    await page.goto('http://localhost:5173')

    const textarea = page.locator('.textarea').first()
    await textarea.waitFor()
    await textarea.fill('\u4f60\u597d')
    await expect(textarea).toHaveValue('\u4f60\u597d')
    await textarea.focus()

    await textarea.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'ni' }))
      node.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '\u4f60' }),
      )
    })
    await page.waitForTimeout(50)
    await textarea.press('Enter')

    await expect.poll(() => readSendCount(page)).toBe(1)
    await expect(textarea).toHaveValue('')
  })
}
