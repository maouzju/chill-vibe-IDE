import { expect, test, type Page } from '@playwright/test'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createDefaultState } from '../shared/default-state.ts'
import { createPlaywrightState } from './playwright-state.ts'

const settingsTabPattern = /设置|Settings/
const localModelsPattern = /本地模型|Local models/
const harnessFieldPattern = /驱动方式|Driven by/
const modelFieldPattern = /模型名|Model name/

const mockBaseApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createDefaultState('D:/workspace')

  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }
    if (route.request().method() === 'PUT') {
      state = JSON.parse(route.request().postData() ?? '{}')
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

  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({ json: { state: 'idle', logs: [] } })
  })

  // 没装 Ollama 的机器：探测失败。本地模型区必须照常出现，模型名照样能手输。
  await page.route('**/api/ollama/**', async (route) => {
    await route.fulfill({ status: 500, json: { error: 'ollama not installed' } })
  })
}

// 这块 UI 最初放在「接口」页（跟 provider profile 做邻居），但用户连着三次都在
// 「设置」里找它 —— 位置对不对不由代码结构说了算，由用户的直觉说了算。这条测试把
// 它钉在设置页，防止以后有人又按"它跟 API 配置是一类"的理由挪回去。
test('local model section lives in the settings panel, even without Ollama', async ({ page }) => {
  await mockBaseApis(page)
  await page.goto('http://localhost:5173')

  await page.getByRole('tab', { name: settingsTabPattern }).click()
  const panel = page.locator('#app-panel-settings')
  await expect(panel).toBeVisible()

  // 收窄到「本地模型」那个分组内再断言字段，否则 /模型名/ 会先撞上设置页其它分组里
  // 同名的隐藏文案（.first() 抓到的不一定是这块）。
  const group = panel.locator('.settings-group', { hasText: localModelsPattern }).first()
  await expect(group).toBeVisible()
  await group.scrollIntoViewIfNeeded()

  // 两个必填项都在
  await expect(group.getByText(harnessFieldPattern).first()).toBeVisible()
  await expect(group.getByText(modelFieldPattern).first()).toBeVisible()

  // 地址与密钥收在折叠区里，默认不占版面
  await expect(group.getByText(/高级|Advanced/).first()).toBeVisible()

  // 「接口」页不该再有一份
  await expect(page.locator('#app-panel-routing')).toBeHidden()
})

const localModelLabel = 'qwen3-coder-65k:latest'

const localModelEntry = {
  id: 'local-qwen',
  label: localModelLabel,
  harness: 'claude' as const,
  // 地址与密钥留空是本功能的正常用法，后端会补齐 —— 选择器里能不能看见它与这两项无关。
  baseUrl: '',
  apiKey: '',
  model: localModelLabel,
}

const createSeededState = () =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme: 'dark',
      localModelEntries: [localModelEntry],
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Local model',
        provider: 'claude' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'claude-opus-4-7',
        cards: [
          {
            id: 'card-1',
            title: '本地模型卡',
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

const mockSeededApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createSeededState()

  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }
    if (route.request().method() === 'PUT') {
      state = createPlaywrightState(JSON.parse(route.request().postData() ?? '{}'))
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

  await page.route('**/api/ollama/**', async (route) => {
    await route.fulfill({ status: 500, json: { error: 'ollama not installed' } })
  })
}

// 存进设置只是第一步 —— 条目要真能用，必须一路走到卡片的模型选择器里。这条测试钉住
// App → WorkspaceColumn → LayoutRenderer → PaneView → ChatCard 这条转发链：ChatCard 的
// localModelEntries 是**可选** prop 且带 `= []` 默认值，链上任何一层漏传都不会有类型
// 错误，只会让选择器里静默少掉这一项（2026-08-29 实测 PaneView 就漏了这一层，用户在
// 设置里明明存住了，卡上却永远选不到）。
test('a saved local model entry reaches the card model picker', async ({ page }) => {
  await mockSeededApis(page)
  await page.goto('http://localhost:5173')

  const modelSelect = page.locator('.model-select').first()
  await expect(modelSelect).toBeVisible()
  await modelSelect.click()

  const menu = page.locator('.model-dropdown-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('option', { name: localModelLabel })).toBeVisible()
})
