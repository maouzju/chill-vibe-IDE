import { expect, test, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'
import { appUrl } from './playwright-app-url.ts'

const installMockApis = async (
  page: Page,
  options: { card?: Record<string, unknown>; archivedMessages?: unknown[] } = {},
) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en',
      theme: 'dark' as const,
      repeatLoopEnabled: true,
      requestModels: {
        codex: 'gpt-5.5',
        claude: 'claude-opus-4-7',
      },
      modelReasoningEfforts: {
        codex: {},
        claude: {},
      },
      providerProfiles: {
        codex: { activeProfileId: '', profiles: [] },
        claude: { activeProfileId: '', profiles: [] },
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-repeat',
        title: 'Repeat Loop',
        provider: 'codex' as const,
        workspacePath: 'D:/Git/chill-vibe',
        model: 'gpt-5.5',
        cards: [
          {
            id: 'card-repeat-1',
            title: '',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: 'gpt-5.5',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
            ...options.card,
          },
        ],
      },
    ],
  })

  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }

    state = createPlaywrightState(JSON.parse(route.request().postData() ?? '{}'))
    await route.fulfill({ json: state })
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
  await page.route('**/api/compacted-card-history/**', async (route) => {
    await route.fulfill({
      json: {
        snapshot: options.archivedMessages
          ? {
              hiddenReason: 'compact',
              hiddenMessageCount: options.archivedMessages.length,
              messages: options.archivedMessages,
            }
          : null,
      },
    })
  })
}

const installMockChatBridge = async (page: Page) => {
  await page.evaluate(() => {
    const win = window as Window & {
      electronAPI: NonNullable<typeof window.electronAPI>
      __repeatLoopPrompts?: string[]
      __repeatLoopPendingCompletions?: Array<() => void>
    }

    const dispatchStreamEvent = (subscriptionId: string, eventName: string, data: unknown) => {
      window.dispatchEvent(
        new CustomEvent('chill-vibe:chat-stream', {
          detail: { subscriptionId, event: eventName, data },
        }),
      )
    }

    win.__repeatLoopPrompts = []
    win.__repeatLoopPendingCompletions = []
    win.electronAPI.requestChat = async (request) => {
      const prompts = [
        ...(win.__repeatLoopPrompts ?? []),
        typeof request.prompt === 'string' ? request.prompt : '',
      ]
      win.__repeatLoopPrompts = prompts
      return { streamId: `repeat-stream-${prompts.length}` }
    }
    win.electronAPI.stopChat = async () => undefined
    win.electronAPI.subscribeChatStream = async (streamId, subscriptionId) => {
      const iteration = Number(streamId.split('-').at(-1) ?? '1')
      const complete = () => {
        dispatchStreamEvent(subscriptionId, 'delta', {
          content: `Completed repeat iteration ${iteration}.`,
        })
        dispatchStreamEvent(subscriptionId, 'done', {})
      }
      // 症状：整套 Playwright 并发跑时本用例偶发失败，标签数涨到 11。
      // 根因：第 2 轮 900ms 后自动完成，负载下测试还没来得及取消勾选，循环就接着开了新标签。
      // 所以第 2 轮起不再靠定时器，改由测试在取消勾选后手动放行，与机器快慢无关。
      if (iteration === 1) {
        window.setTimeout(complete, 60)
      } else {
        win.__repeatLoopPendingCompletions = [...(win.__repeatLoopPendingCompletions ?? []), complete]
      }
    }
    win.electronAPI.unsubscribeChatStream = async () => undefined
  })
}

const readPrompts = (page: Page) =>
  page.evaluate(() => {
    const win = window as Window & { __repeatLoopPrompts?: string[] }
    return win.__repeatLoopPrompts ?? []
  })

test('a checked repeat loop opens a fresh tab, reruns the earliest prompt, and stops after unchecking', async ({ page }) => {
  await installMockApis(page)
  await page.goto(appUrl)
  await installMockChatBridge(page)

  const activePanel = page.locator('.pane-tab-panel.is-active')
  const settingsTrigger = activePanel.locator('.composer-settings-trigger').first()
  const settingsMenu = page.locator('.composer-settings-menu').first()
  const activeTextarea = activePanel.locator('.composer textarea')

  await settingsTrigger.click()
  await expect(settingsMenu).toBeVisible()
  const activeRepeatToggle = settingsMenu.getByLabel('Repeat loop')
  await expect(activeRepeatToggle).toBeVisible()
  await activeRepeatToggle.check()
  await settingsTrigger.click()
  await activeTextarea.fill('Run the same verification from scratch.')
  await activePanel.getByRole('button', { name: 'Send message' }).click()

  await expect.poll(() => readPrompts(page)).toEqual([
    'Run the same verification from scratch.',
    'Run the same verification from scratch.',
  ])
  await expect(page.locator('.pane-tab')).toHaveCount(2)
  await expect(activePanel.locator('.repeat-loop-status')).toBeVisible()

  // The loop intentionally creates its next run in a background tab so the
  // current composer is never stolen. Stop the chain from the running child,
  // which is the card whose completion would otherwise schedule another run.
  await page.locator('.pane-tab').nth(1).click()
  await expect(activePanel.locator('.repeat-loop-status')).toBeVisible()
  await settingsTrigger.click()
  await expect(settingsMenu).toBeVisible()
  await expect(activeRepeatToggle).toBeChecked()
  await expect(activePanel.locator('.composer textarea')).toHaveValue('')

  await activeRepeatToggle.uncheck()
  await expect(activeRepeatToggle).not.toBeChecked()
  await expect(activePanel.locator('.repeat-loop-status')).toBeHidden()
  await settingsTrigger.click()
  // 取消勾选已生效，现在才放行第 2 轮；它完成后不应再排出第 3 轮。
  await page.evaluate(() => {
    const win = window as Window & { __repeatLoopPendingCompletions?: Array<() => void> }
    const pending = win.__repeatLoopPendingCompletions ?? []
    win.__repeatLoopPendingCompletions = []
    pending.forEach((complete) => complete())
  })
  await page.waitForTimeout(1_100)

  await expect(page.locator('.pane-tab')).toHaveCount(2)
  await expect.poll(() => readPrompts(page)).toEqual([
    'Run the same verification from scratch.',
    'Run the same verification from scratch.',
  ])
})

// 2026-11-27 用户截图：343 条的长会话重启后首条提示被裁进归档，循环重复跑完一轮什么都没发生。
test('a long repeat-loop card whose first prompt was archived still reruns the true first prompt', async ({ page }) => {
  const createdAt = new Date().toISOString()
  await installMockApis(page, {
    card: {
      repeatLoopActive: true,
      repeatLoopRemaining: 6,
      messageCount: 343,
      sessionId: 'long-session',
      sessionModel: 'gpt-5.5',
      messages: [
        { id: 'tail-assistant', role: 'assistant', content: 'Previous round finished.', createdAt },
      ],
    },
    archivedMessages: [
      { id: 'first-user', role: 'user', content: 'Original first prompt', createdAt },
      { id: 'first-assistant', role: 'assistant', content: 'ok', createdAt },
    ],
  })
  await page.goto(appUrl)
  await installMockChatBridge(page)

  const activePanel = page.locator('.pane-tab-panel.is-active')
  await activePanel.locator('.composer textarea').fill('Later follow-up')
  await activePanel.getByRole('button', { name: 'Send message' }).click()

  await expect.poll(() => readPrompts(page)).toEqual(['Later follow-up', 'Original first prompt'])
  await expect(page.locator('.pane-tab')).toHaveCount(2)
})
