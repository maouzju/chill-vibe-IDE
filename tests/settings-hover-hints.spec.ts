import { expect, test, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const installMockApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme: 'dark' as const,
      repeatLoopEnabled: true,
      wakeTimerEnabled: true,
      autoUrgeEnabled: true,
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
        id: 'col-settings-hints',
        title: 'Settings hints',
        provider: 'claude' as const,
        workspacePath: 'D:/Git/chill-vibe',
        model: 'claude-opus-4-7',
        cards: [
          {
            id: 'card-settings-hints-1',
            title: '',
            status: 'idle' as const,
            size: 560,
            provider: 'claude' as const,
            model: 'claude-opus-4-7',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
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
}

const openSettings = async (page: Page) => {
  // 这两条用例常常是某次改动后第一个跑的 spec，要等 Vite 冷编译整个 App.tsx，
  // 默认超时不够，红的是编译不是断言。
  test.slow()
  await installMockApis(page)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(appUrl)
  await page.locator('.card-shell').first().waitFor()
  await page.locator('#app-tab-settings').click()

  const settingsPanel = page.locator('#app-panel-settings')
  await expect(settingsPanel).toBeVisible()
  return settingsPanel
}

// 这些开关的说明曾经全部常驻在开关下方，把设置面板撑成一屏长文
// （见 docs/ui-principles.md 第 3 条：解释性文案也是 idle chrome）。
const hoverDocumentedToggles = [
  'accessibility-support-toggle',
  'repeat-loop-feature-toggle',
  'wake-timer-feature-toggle',
  'auto-urge-toggle',
  'global-urge-control-toggle',
  'close-behavior-select',
  'cross-provider-skill-reuse-toggle',
]

test('settings explanations stay behind hover instead of padding the panel', async ({ page }) => {
  const settingsPanel = await openSettings(page)

  for (const toggleId of hoverDocumentedToggles) {
    const toggle = settingsPanel.locator(`#${toggleId}`)
    await expect(toggle, `${toggleId} should exist in the settings panel`).toHaveCount(1)

    // 每个开关都要自我说明，而且说明必须挂在悬停壳里，不能印在面板上。
    const describedBy = await toggle.getAttribute('aria-describedby')
    expect(describedBy, `${toggleId} should point at its hint`).toBeTruthy()

    const hint = settingsPanel.locator(`#${describedBy}`)
    await expect(hint, `${toggleId} hint should use the hover note class`).toHaveClass(
      /settings-hover-note/,
    )
    await expect(hint, `${toggleId} hint should be hidden at rest`).toBeHidden()
  }
})

test('hovering an accessibility setting reveals its hint and leaving hides it again', async ({
  page,
}) => {
  const settingsPanel = await openSettings(page)

  const accessibilityRow = settingsPanel
    .locator('.settings-hover-detail')
    .filter({ has: page.locator('#accessibility-support-toggle') })
  const hint = settingsPanel.locator('#accessibility-support-note')

  await expect(hint).toBeHidden()
  await accessibilityRow.hover()
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('读屏软件')

  // 气泡不能被面板裁掉——被裁的气泡比它替换掉的常驻段落更糟。
  const hintBox = await hint.boundingBox()
  expect(hintBox).not.toBeNull()
  expect(hintBox!.width).toBeGreaterThan(0)
  expect(hintBox!.height).toBeGreaterThan(0)

  await settingsPanel.locator('.settings-group-title').first().hover()
  await expect(hint).toBeHidden()
})
