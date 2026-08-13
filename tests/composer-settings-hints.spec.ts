import { expect, test, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const installMockApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en',
      theme: 'dark' as const,
      repeatLoopEnabled: true,
      wakeTimerEnabled: true,
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
        id: 'col-hints',
        title: 'Composer hints',
        provider: 'claude' as const,
        workspacePath: 'D:/Git/chill-vibe',
        model: 'claude-opus-4-7',
        cards: [
          {
            id: 'card-hints-1',
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

test('every composer setting carries a hint and none of them is printed inline', async ({ page }) => {
  await installMockApis(page)
  await page.goto(appUrl)

  const settingsTrigger = page.locator('.pane-tab-panel.is-active .composer-settings-trigger').first()
  const settingsMenu = page.locator('.composer-settings-menu').first()

  await settingsTrigger.click()
  await expect(settingsMenu).toBeVisible()

  // Every row in the menu must document itself, otherwise a new toggle ships
  // without any explanation of what it actually does.
  const labels = await settingsMenu.locator('.composer-settings-label').allInnerTexts()
  expect(labels).toEqual([
    'Repeat loop',
    'Wake timer',
    'Thinking',
    'Thinking depth',
    'Plan mode',
    'Admin access',
    'Auto Urge',
    'Urge Types',
  ])

  const missingHints = await settingsMenu
    .locator('.composer-settings-row')
    .evaluateAll((rows) =>
      rows
        .filter((row) => (row.getAttribute('data-hint') ?? '').trim().length === 0)
        .map((row) => row.textContent?.trim() ?? ''),
    )
  expect(missingHints).toEqual([])

  // Idle chrome must recede: the explanations live behind hover, not as
  // permanent paragraphs pushing the menu taller than the card.
  await expect(settingsMenu).not.toContainText('inspect and act on the other sessions in this workspace')
  await expect(page.locator('.composer-settings-hint')).toHaveCount(0)
})

test('hovering a composer setting reveals its hint and leaving hides it again', async ({ page }) => {
  await installMockApis(page)
  await page.goto(appUrl)

  const settingsTrigger = page.locator('.pane-tab-panel.is-active .composer-settings-trigger').first()
  const settingsMenu = page.locator('.composer-settings-menu').first()

  await settingsTrigger.click()
  await expect(settingsMenu).toBeVisible()

  const adminRow = settingsMenu.locator('.composer-admin-access-row')
  const hint = page.locator('.composer-settings-hint')

  await adminRow.hover()
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('inspect and act on the other sessions in this workspace')

  const [menuBox, hintBox] = await Promise.all([settingsMenu.boundingBox(), hint.boundingBox()])
  expect(menuBox).not.toBeNull()
  expect(hintBox).not.toBeNull()
  // The hint floats outside the scroll container; a hint clipped by the menu
  // would be worse than the inline paragraph it replaces.
  expect(hintBox!.width).toBeGreaterThan(0)
  expect(hintBox!.x + hintBox!.width).toBeLessThanOrEqual(menuBox!.x + 1)

  await settingsTrigger.hover()
  await expect(hint).toHaveCount(0)
})
