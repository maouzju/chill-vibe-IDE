import { expect, test, type Page } from '@playwright/test'

import type { AppState, ChatMessage } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'
type ScrollMetrics = {
  scrollTop: number
  maxScrollTop: number
  source: '.app-shell' | 'document.scrollingElement'
}

type MessageListMetrics = {
  scrollTop: number
  maxScrollTop: number
}

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const createHistoryMessage = (index: number): ChatMessage => ({
  id: `message-${index + 1}`,
  role: index % 2 === 0 ? 'assistant' : 'user',
  content: `${index % 2 === 0 ? 'Assistant' : 'User'} message ${index + 1}: ${'detail '.repeat(36)}`,
  createdAt: new Date(Date.UTC(2026, 3, 5, 12, 0, index)).toISOString(),
  meta: index % 2 === 0 ? { provider: 'codex' } : undefined,
})

const createState = (theme: ThemeName): AppState => createPlaywrightState({
  version: 1,
  settings: {
    language: 'en',
    theme,
    activeTopTab: 'ambience',
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
        activeProfileId: 'codex-profile-1',
        profiles: [
          {
            id: 'codex-profile-1',
            name: 'Codex Proxy',
            apiKey: 'sk-codex',
            baseUrl: 'https://api.openai.example/v1',
          },
        ],
      },
      claude: {
        activeProfileId: 'claude-profile-1',
        profiles: [
          {
            id: 'claude-profile-1',
            name: 'Claude Proxy',
            apiKey: 'sk-claude',
            baseUrl: 'https://api.anthropic.example',
          },
        ],
      },
    },
  },
  updatedAt: new Date('2026-04-05T12:10:00.000Z').toISOString(),
  columns: [
    {
      id: 'col-1',
      title: 'Workspace 1',
      provider: 'codex',
      workspacePath: 'd:\\Git\\chill-vibe',
      model: 'gpt-5.4',
      cards: [
        {
          id: 'card-1',
          title: 'Card 1',
          status: 'idle',
          size: 560,
          provider: 'codex',
          model: 'gpt-5.4',
          reasoningEffort: 'medium',
          draft: '',
          messages: Array.from({ length: 28 }, (_, index) => createHistoryMessage(index)),
        },
      ],
    },
  ],
})

const installMockApis = async (page: Page, theme: ThemeName) => {
  await installMockElectronBridge(page)

  let state = createState(theme)

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
}

const getAppScrollMetrics = (page: Page) =>
  page.evaluate<[], ScrollMetrics>(() => {
    const shell = document.querySelector('.app-shell') as HTMLElement | null
    const scrollingElement = document.scrollingElement as HTMLElement | null
    const target =
      shell && /auto|scroll|overlay/.test(getComputedStyle(shell).overflowY) && shell.scrollHeight > shell.clientHeight + 1
        ? shell
        : scrollingElement

    return {
      scrollTop: target?.scrollTop ?? window.scrollY,
      maxScrollTop: Math.max((target?.scrollHeight ?? 0) - (target?.clientHeight ?? window.innerHeight), 0),
      source: target === shell ? '.app-shell' : 'document.scrollingElement',
    }
  })

const getMessageListMetrics = (page: Page, index: number) =>
  page.locator('.message-list').nth(index).evaluate<MessageListMetrics, void>((node) => ({
    scrollTop: node.scrollTop,
    maxScrollTop: Math.max(node.scrollHeight - node.clientHeight, 0),
  }))

for (const theme of ['dark', 'light'] as const) {
  test(`page does not scroll farther up when a chat area is already at the top in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme)
    await page.setViewportSize({ width: 1280, height: 1200 })

    await page.goto(appUrl)
    await page.locator('.workspace-column').first().waitFor()

    const initialMetrics = await getAppScrollMetrics(page)
    expect(initialMetrics.maxScrollTop).toBeLessThanOrEqual(1)

    const headerBox = await page.locator('.workspace-column .column-header').first().boundingBox()
    expect(headerBox).not.toBeNull()
    if (!headerBox) {
      return
    }

    const gutterPointer = {
      x: Math.round(headerBox.x + Math.min(headerBox.width - 24, 48)),
      y: Math.round(headerBox.y + headerBox.height / 2),
    }

    const gutterHitTarget = await page.evaluate(
      ({ x, y }) => {
        const element = document.elementFromPoint(x, y)
        return {
          insideMessageList: Boolean(element?.closest('.message-list')),
          className: element instanceof HTMLElement ? element.className : '',
        }
      },
      gutterPointer,
    )
    expect(gutterHitTarget.insideMessageList).toBe(false)

    const beforeGutterWheel = await getAppScrollMetrics(page)
    await page.mouse.move(gutterPointer.x, gutterPointer.y)
    await page.mouse.wheel(0, -1200)
    await page.waitForTimeout(200)

    const afterBoardGutterWheel = await getAppScrollMetrics(page)
    expect(Math.abs(afterBoardGutterWheel.scrollTop - beforeGutterWheel.scrollTop)).toBeLessThanOrEqual(1)

    const targetMessageListIndex = 0
    const targetMessageList = page.locator('.message-list').nth(targetMessageListIndex)
    await targetMessageList.evaluate((node) => {
      node.scrollTop = 0
    })

    const box = await targetMessageList.boundingBox()
    expect(box).not.toBeNull()
    if (!box) {
      return
    }

    const pointerX = Math.round(box.x + box.width / 2)
    const pointerY = Math.round(box.y + Math.min(60, Math.max(box.height / 3, 24)))

    const hitTarget = await page.evaluate(
      ({ x, y }) => {
        const element = document.elementFromPoint(x, y)
        return {
          insideMessageList: Boolean(element?.closest('.message-list')),
          className: element instanceof HTMLElement ? element.className : '',
        }
      },
      { x: pointerX, y: pointerY },
    )
    expect(hitTarget.insideMessageList).toBe(true)

    const beforeMetrics = await getAppScrollMetrics(page)
    const beforeMessageListMetrics = await getMessageListMetrics(page, targetMessageListIndex)
    expect(beforeMessageListMetrics.maxScrollTop).toBeGreaterThan(200)
    expect(beforeMessageListMetrics.scrollTop).toBeLessThanOrEqual(1)

    await page.mouse.move(pointerX, pointerY)
    await page.mouse.wheel(0, -1200)
    await page.mouse.wheel(0, -1200)
    await page.waitForTimeout(200)

    const afterMessageListTopWheel = await getAppScrollMetrics(page)
    const afterMessageListMetrics = await getMessageListMetrics(page, targetMessageListIndex)
    expect(afterMessageListMetrics.scrollTop).toBeLessThanOrEqual(1)
    expect(Math.abs(afterMessageListTopWheel.scrollTop - beforeMetrics.scrollTop)).toBeLessThanOrEqual(1)
  })

  test(`page does not scroll farther down when a chat area is already at the bottom in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme)
    await page.setViewportSize({ width: 1280, height: 1200 })

    await page.goto(appUrl)
    await page.locator('.workspace-column').first().waitFor()

    const initialMetrics = await getAppScrollMetrics(page)
    expect(initialMetrics.maxScrollTop).toBeLessThanOrEqual(1)

    const targetMessageListIndex = 0
    const targetMessageList = page.locator('.message-list').nth(targetMessageListIndex)
    await targetMessageList.evaluate((node) => {
      node.scrollTop = node.scrollHeight
    })

    const box = await targetMessageList.boundingBox()
    expect(box).not.toBeNull()
    if (!box) {
      return
    }

    const pointerX = Math.round(box.x + box.width / 2)
    const pointerY = Math.round(box.y + Math.min(60, Math.max(box.height / 3, 24)))

    const hitTarget = await page.evaluate(
      ({ x, y }) => {
        const element = document.elementFromPoint(x, y)
        return {
          insideMessageList: Boolean(element?.closest('.message-list')),
          className: element instanceof HTMLElement ? element.className : '',
        }
      },
      { x: pointerX, y: pointerY },
    )
    expect(hitTarget.insideMessageList).toBe(true)

    const beforeMetrics = await getAppScrollMetrics(page)
    const beforeMessageListMetrics = await getMessageListMetrics(page, targetMessageListIndex)
    expect(beforeMessageListMetrics.maxScrollTop).toBeGreaterThan(200)
    expect(beforeMessageListMetrics.scrollTop).toBeGreaterThan(0)

    await page.mouse.move(pointerX, pointerY)
    await page.mouse.wheel(0, 1200)
    await page.mouse.wheel(0, 1200)
    await page.waitForTimeout(200)

    const afterMetrics = await getAppScrollMetrics(page)
    const afterMessageListMetrics = await getMessageListMetrics(page, targetMessageListIndex)
    expect(afterMessageListMetrics.maxScrollTop - afterMessageListMetrics.scrollTop).toBeLessThanOrEqual(1)
    expect(Math.abs(afterMetrics.scrollTop - beforeMetrics.scrollTop)).toBeLessThanOrEqual(1)
  })
}
