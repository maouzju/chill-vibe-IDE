import { expect, test, type Page } from '@playwright/test'

import { createDefaultState } from '../shared/default-state.ts'
import type { AppState } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'

const onboardingStorageKey = 'chill-vibe:onboarding:v1'
const workspacePath = 'd:\\Git\\chill-vibe'

const createFirstOpenState = (theme: 'dark' | 'light' = 'dark'): AppState => {
  const state = createDefaultState(workspacePath, 'zh-CN')
  state.settings.theme = theme
  return state
}

const clearOnboarding = async (page: Page) => {
  await page.addInitScript((storageKey) => {
    window.localStorage.removeItem(storageKey)
  }, onboardingStorageKey)
}

test('first open wizard auto-runs setup, supports language flags, and can import cc-switch settings', async ({
  page,
}) => {
  await installMockElectronBridge(page)
  await clearOnboarding(page)

  let state = createFirstOpenState()
  let environmentReady = false
  let setupRuns = 0
  let importRuns = 0
  let setupState: 'idle' | 'running' | 'success' = 'idle'

  await page.route('**/api/state', async (route) => {
    const request = route.request()

    if (request.method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }

    if (request.method() === 'PUT') {
      state = JSON.parse(request.postData() ?? '{}')
      await route.fulfill({ json: state })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      json: [
        { provider: 'codex', available: environmentReady, command: environmentReady ? 'codex' : undefined },
        { provider: 'claude', available: environmentReady, command: environmentReady ? 'claude' : undefined },
      ],
    })
  })

  await page.route('**/api/onboarding/status', async (route) => {
    await route.fulfill({
      json: {
        environment: {
          ready: environmentReady,
          checks: [
            { id: 'git', label: 'Git', available: environmentReady },
            { id: 'node', label: 'Node.js', available: environmentReady },
            { id: 'claude', label: 'Claude CLI', available: environmentReady },
            { id: 'codex', label: 'Codex CLI', available: environmentReady },
          ],
        },
        ccSwitch: {
          available: true,
          source: '~/.cc-switch/cc-switch.db',
        },
      },
    })
  })

  await page.route('**/api/setup/status', async (route) => {
    if (setupState === 'running') {
      setupState = 'success'
      environmentReady = true
    }

    await route.fulfill({
      json: {
        state: setupState,
        message:
          setupState === 'success'
            ? 'Environment setup completed.'
            : setupState === 'running'
              ? 'Starting one-click environment setup...'
              : 'Not started yet.',
        logs:
          setupState === 'success'
            ? [{ createdAt: new Date().toISOString(), level: 'info', message: 'Finished.' }]
            : setupState === 'running'
              ? [{ createdAt: new Date().toISOString(), level: 'info', message: 'Starting one-click environment setup...' }]
              : [],
      },
    })
  })

  await page.route('**/api/setup/run', async (route) => {
    setupRuns += 1
    setupState = 'success'
    environmentReady = true
    await route.fulfill({
      status: 202,
      json: {
        state: 'success',
        message: 'Environment setup completed.',
        logs: [{ createdAt: new Date().toISOString(), level: 'info', message: 'Finished.' }],
      },
    })
  })

  await page.route('**/api/routing/import/cc-switch', async (route) => {
    importRuns += 1
    await route.fulfill({
      json: {
        source: '~/.cc-switch/cc-switch.db',
        importedProfiles: [
          {
            sourceId: 'claude-default',
            provider: 'claude',
            name: 'Claude Proxy',
            apiKey: 'sk-claude',
            baseUrl: 'https://claude.example',
            active: true,
          },
          {
            sourceId: 'codex-default',
            provider: 'codex',
            name: 'Codex Proxy',
            apiKey: 'sk-codex',
            baseUrl: 'https://codex.example/v1',
            active: true,
          },
        ],
      },
    })
  })

  await page.goto('http://localhost:5173')

  await expect(page.getByRole('dialog')).toBeVisible()
  await expect.poll(() => setupRuns).toBe(1)
  await expect(page.locator('#wizard-language-zh')).toContainText('🇨🇳')
  await expect(page.locator('#wizard-language-en')).toContainText('🇺🇸')
  await page.getByRole('button', { name: /English/ }).click()
  await expect(page.getByRole('dialog')).toContainText(/Quick start/)
  await expect(page.getByRole('dialog')).toContainText(/Environment setup completed\.|Environment ready\./, { timeout: 15000 })
  // 向导 2026-09-23 起是三步：装 CLI → 连账号（导入 cc-switch 或填 key）→ 选模型。
  await expect(page.getByRole('dialog')).toContainText(/Connect an account/)
  await page.getByRole('button', { name: /Import now/ }).click()
  await expect(page.getByRole('dialog')).toContainText(/Imported 2 profiles/)
  await expect(page.getByRole('dialog')).toContainText(/Pick a default model/)
  await expect(page.locator('#onboarding-model-claude')).toBeVisible()
  await page.getByRole('button', { name: /Use this/ }).click()
  await expect(page.getByRole('dialog')).toContainText(/You are ready to go/)
  await page.getByRole('button', { name: /Open workspace/ }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(setupRuns).toBe(1)
  expect(importRuns).toBe(1)
})

test('first open wizard skips setup, lets the account step be skipped, and confirms a model', async ({ page }) => {
  await installMockElectronBridge(page)
  await clearOnboarding(page)

  let state = createFirstOpenState('light')
  let setupRuns = 0
  let importRuns = 0

  await page.route('**/api/state', async (route) => {
    const request = route.request()

    if (request.method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }

    if (request.method() === 'PUT') {
      state = JSON.parse(request.postData() ?? '{}')
      await route.fulfill({ json: state })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      json: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    })
  })

  await page.route('**/api/onboarding/status', async (route) => {
    await route.fulfill({
      json: {
        environment: {
          ready: true,
          checks: [
            { id: 'git', label: 'Git', available: true },
            { id: 'node', label: 'Node.js', available: true },
            { id: 'claude', label: 'Claude CLI', available: true },
            { id: 'codex', label: 'Codex CLI', available: true },
          ],
        },
        ccSwitch: {
          available: false,
        },
      },
    })
  })

  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({
      json: {
        state: 'success',
        message: 'Environment setup completed.',
        logs: [],
      },
    })
  })

  await page.route('**/api/setup/run', async (route) => {
    setupRuns += 1
    await route.fulfill({
      status: 202,
      json: {
        state: 'success',
        message: 'Environment setup completed.',
        logs: [],
      },
    })
  })

  await page.route('**/api/routing/import/cc-switch', async (route) => {
    importRuns += 1
    await route.fulfill({ status: 500, json: { message: 'should not run' } })
  })

  await page.goto('http://localhost:5173')

  await expect(page.getByRole('dialog')).toBeVisible()
  // 环境就绪、没有 cc-switch：直接落在「连账号」，没 key 也能跳过，然后确认默认模型。
  await expect(page.getByRole('dialog')).toContainText(/No account connected yet|还没有连接账号/)
  await expect(page.getByRole('button', { name: /Import now|立即导入/ })).toHaveCount(0)
  await page.getByRole('button', { name: /Skip for now|暂时跳过/ }).click()
  await expect(page.getByRole('dialog')).toContainText(/Pick a default model|选择默认模型/)
  await page.getByRole('button', { name: /Use this|就用这个/ }).click()
  await expect(page.getByRole('dialog')).toContainText(/You are ready to go|已经可以开始使用了/)
  await page.getByRole('button', { name: /Open workspace|进入工作台/ }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(setupRuns).toBe(0)
  expect(importRuns).toBe(0)
})
