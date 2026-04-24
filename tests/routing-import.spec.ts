import { expect, test, type Page } from '@playwright/test'
import { installMockElectronBridge } from './electron-bridge.ts'

const routingTabPattern = /\u8def\u7531|\u63a5\u53e3|Routing/
const settingsTabPattern = /\u8bbe\u7f6e|Settings/
const routingProvidersTabPattern = /\u670d\u52a1\u5546|\u63a5\u53e3\u914d\u7f6e|Providers/
const routingProxyTabPattern = /\u81ea\u52a8\u7eed\u4f20|\u65ad\u7ebf\u7eed\u4f20|Auto-retry/
const importDefaultPattern = /\u5bfc\u5165\u9ed8\u8ba4\u6570\u636e\u5e93|Import default db/
const importTooLargePattern =
  /\u6240\u9009 cc-switch \u5bfc\u51fa\u6587\u4ef6\u592a\u5927|That cc-switch export is too large to upload\./
const lightThemePattern = /\u6d45\u8272|Light/
const installMissingToolsPattern = /\u4e00\u952e\u5b89\u88c5\u7f3a\u5931\u73af\u5883|\u5b89\u88c5\u7f3a\u5931\u5de5\u5177|Install missing tools/

const createOnboardingStatus = (
  availability: Partial<Record<'git' | 'node' | 'claude' | 'codex', boolean>> = {},
) => {
  const checks = [
    { id: 'git' as const, label: 'Git', available: availability.git ?? true },
    { id: 'node' as const, label: 'Node.js', available: availability.node ?? true },
    { id: 'claude' as const, label: 'Claude CLI', available: availability.claude ?? true },
    { id: 'codex' as const, label: 'Codex CLI', available: availability.codex ?? true },
  ]

  return {
    environment: {
      ready: checks.every((check) => check.available),
      checks,
    },
    ccSwitch: {
      available: false,
    },
  }
}

const createState = () => ({
  version: 1 as const,
  settings: {
    language: 'zh-CN' as const,
    theme: 'dark' as const,
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
  updatedAt: new Date().toISOString(),
  columns: [],
})

const mockBaseApis = async (page: Page, initialState = createState()) => {
  await installMockElectronBridge(page)

  let state = initialState

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
    await route.fulfill({
      json: {
        state: 'idle',
        logs: [],
      },
    })
  })
}

const openRoutingPanel = async (page: Page) => {
  await page.goto('http://localhost:5173')
  await page.getByRole('tab', { name: routingTabPattern }).click()
  await expect(page.locator('#app-panel-routing')).toBeVisible()
}

const readProviderSectionRect = async (page: Page, index: number) => {
  const rect = await page.locator('.switch-provider-section').nth(index).boundingBox()

  if (!rect) {
    throw new Error(`Provider section ${index} is not visible`)
  }

  return rect
}

const readRgb = (value: string) => {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  const srgbMatch = value.match(/color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/)

  if (match) {
    return match.slice(1, 4).map(Number)
  }

  if (srgbMatch) {
    return srgbMatch.slice(1, 4).map((channel) => Math.round(Number(channel) * 255))
  }

  throw new Error(`Could not parse RGB value: ${value}`)
}

const readComputedValue = async (page: Page, selector: string, property: string) =>
  page.locator(selector).first().evaluate((node, cssProperty) => getComputedStyle(node).getPropertyValue(cssProperty), property)

const readComputedRgb = async (page: Page, selector: string, property: string) =>
  readRgb(await readComputedValue(page, selector, property))

const maxChannel = (value: number[]) => Math.max(...value)
const isBlueTint = ([red, green, blue]: number[]) => blue > red && blue > green

const createStateWithProfiles = () => {
  const state = createState()

  state.settings.providerProfiles.claude = {
    activeProfileId: 'claude-profile-1',
    profiles: [
      {
        id: 'claude-profile-1',
        name: 'Claude Proxy',
        apiKey: 'sk-claude',
        baseUrl: 'https://api.anthropic.example',
      },
    ],
  }

  state.settings.providerProfiles.codex = {
    activeProfileId: 'codex-profile-1',
    profiles: [
      {
        id: 'codex-profile-1',
        name: 'Codex Proxy',
        apiKey: 'sk-codex',
        baseUrl: 'https://api.openai.example/v1',
      },
    ],
  }

  return state
}

test('keeps Claude and Codex in two columns on desktop and one column on narrow screens', async ({
  page,
}) => {
  await mockBaseApis(page)

  await page.setViewportSize({ width: 1280, height: 900 })
  await openRoutingPanel(page)

  await expect(page.locator('.switch-provider-section')).toHaveCount(2)

  const desktopClaudeRect = await readProviderSectionRect(page, 0)
  const desktopCodexRect = await readProviderSectionRect(page, 1)

  expect(Math.abs(desktopClaudeRect.y - desktopCodexRect.y)).toBeLessThan(12)
  expect(Math.abs(desktopClaudeRect.x - desktopCodexRect.x)).toBeGreaterThan(160)

  await page.setViewportSize({ width: 640, height: 900 })

  const mobileClaudeRect = await readProviderSectionRect(page, 0)
  const mobileCodexRect = await readProviderSectionRect(page, 1)

  expect(Math.abs(mobileClaudeRect.x - mobileCodexRect.x)).toBeLessThan(12)
  expect(mobileCodexRect.y).toBeGreaterThan(mobileClaudeRect.y + mobileClaudeRect.height + 8)
})

test('keeps routing surfaces readable in dark and light themes', async ({ page }) => {
  await mockBaseApis(page)
  await page.setViewportSize({ width: 1280, height: 900 })

  await openRoutingPanel(page)
  const routingSubTabs = page.locator('#app-panel-routing .routing-sub-tab')
  const providersSubTab = routingSubTabs.first()
  const proxySubTab = routingSubTabs.nth(1)

  const darkEmptyBackground = await readComputedRgb(page, '.provider-profile-empty', 'background-color')
  const draftAddButtons = page.locator('.provider-profile-card.is-draft .btn-primary')

  await expect(draftAddButtons).toHaveCount(2)
  await expect(draftAddButtons.first()).toBeDisabled()
  await expect(draftAddButtons.nth(1)).toBeDisabled()

  await proxySubTab.click()
  const darkActiveToggleBackground = await readComputedRgb(
    page,
    '.proxy-stats-filter .theme-chip.is-active',
    'background-color',
  )

  expect(maxChannel(darkEmptyBackground)).toBeLessThan(80)
  expect(isBlueTint(darkActiveToggleBackground)).toBeTruthy()

  await page.getByRole('tab', { name: settingsTabPattern }).click()
  await page.getByRole('button', { name: lightThemePattern }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.getByRole('tab', { name: routingTabPattern }).click()
  await expect(page.locator('#app-panel-routing')).toBeVisible()
  await expect(routingSubTabs).toHaveCount(2)
  await providersSubTab.click()

  const lightEmptyBackground = await readComputedRgb(page, '.provider-profile-empty', 'background-color')

  await proxySubTab.click()
  const lightActiveToggleBackground = await readComputedRgb(
    page,
    '.proxy-stats-filter .theme-chip.is-active',
    'background-color',
  )

  expect(maxChannel(lightEmptyBackground)).toBeGreaterThan(180)
  expect(isBlueTint(lightActiveToggleBackground)).toBeTruthy()

  await providersSubTab.click()
  await expect(draftAddButtons.first()).toBeDisabled()
  await expect(draftAddButtons.nth(1)).toBeDisabled()
})

test('keeps provider profile name fields inline on desktop and stacked on narrow screens in both themes', async ({
  page,
}) => {
  await mockBaseApis(page, createStateWithProfiles())
  await page.setViewportSize({ width: 1280, height: 900 })

  await openRoutingPanel(page)

  const nameField = page.locator('.switch-provider-section').first().locator('.provider-profile-card').first().locator('.settings-field').first()
  const nameLabel = nameField.locator('span').first()
  const nameInput = nameField.locator('input')

  const expectInline = async () => {
    const [labelBox, inputBox] = await Promise.all([nameLabel.boundingBox(), nameInput.boundingBox()])

    if (!labelBox || !inputBox) {
      throw new Error('Expected the profile name field to be visible')
    }

    expect(inputBox.x).toBeGreaterThan(labelBox.x + labelBox.width + 16)
    expect(Math.abs(inputBox.y + inputBox.height / 2 - (labelBox.y + labelBox.height / 2))).toBeLessThan(18)
    expect(inputBox.width).toBeGreaterThan(labelBox.width * 2)
  }

  const expectStacked = async () => {
    const [labelBox, inputBox] = await Promise.all([nameLabel.boundingBox(), nameInput.boundingBox()])

    if (!labelBox || !inputBox) {
      throw new Error('Expected the profile name field to be visible')
    }

    expect(inputBox.y).toBeGreaterThan(labelBox.y + labelBox.height + 8)
    expect(Math.abs(inputBox.x - labelBox.x)).toBeLessThan(8)
  }

  await expectInline()

  await page.getByRole('tab', { name: settingsTabPattern }).click()
  await page.getByRole('button', { name: lightThemePattern }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.getByRole('tab', { name: routingTabPattern }).click()
  await expect(page.locator('#app-panel-routing')).toBeVisible()
  await expectInline()

  await page.setViewportSize({ width: 640, height: 900 })
  await expectStacked()
})

test('shows localized routing copy when the app language is zh-CN', async ({ page }) => {
  await mockBaseApis(page)

  await openRoutingPanel(page)

  const routingPanel = page.locator('#app-panel-routing')

  await expect(routingPanel).toContainText(/\u670d\u52a1\u5546|\u63a5\u53e3\u914d\u7f6e/)
  await expect(routingPanel).toContainText(/\u4ece cc-switch \u5bfc\u5165/)
  await expect(routingPanel).toContainText(/\u81ea\u52a8\u7eed\u4f20|\u65ad\u7ebf\u7eed\u4f20/)
  await expect(routingPanel).toContainText(/\u542f\u7528|\u0043\u004c\u0049 \u8def\u7531/)
})

test('hides the setup panel in settings when the environment is already ready', async ({ page }) => {
  await mockBaseApis(page)

  let onboardingStatusRequests = 0

  await page.route('**/api/onboarding/status', async (route) => {
    onboardingStatusRequests += 1
    await route.fulfill({
      json: createOnboardingStatus(),
    })
  })

  await page.goto('http://localhost:5173')
  await page.getByRole('tab', { name: settingsTabPattern }).click()
  await expect(page.locator('#app-panel-settings')).toBeVisible()
  await expect.poll(() => onboardingStatusRequests).toBeGreaterThan(0)
  await expect(page.locator('.setup-missing-list')).toHaveCount(0)
  await expect(page.locator('#app-panel-settings').getByRole('button', { name: installMissingToolsPattern })).toHaveCount(0)
})

test('waits for onboarding detection before showing the setup panel', async ({ page }) => {
  await mockBaseApis(page)

  let releaseOnboardingStatus: (() => void) | null = null
  const onboardingStatusReady = new Promise<void>((resolve) => {
    releaseOnboardingStatus = resolve
  })

  await page.route('**/api/onboarding/status', async (route) => {
    await onboardingStatusReady
    await route.fulfill({
      json: createOnboardingStatus({
        git: false,
        codex: false,
      }),
    })
  })

  await page.goto('http://localhost:5173')
  await page.getByRole('tab', { name: settingsTabPattern }).click()
  await expect(page.locator('#app-panel-settings')).toBeVisible()
  await expect(page.locator('.setup-missing-list')).toHaveCount(0)

  releaseOnboardingStatus?.()

  await expect(page.locator('.setup-missing-list')).toHaveCount(1)
})

test('lists only missing tools in the setup panel and keeps a single install button', async ({ page }) => {
  await mockBaseApis(page)

  await page.route('**/api/onboarding/status', async (route) => {
    await route.fulfill({
      json: createOnboardingStatus({
        git: false,
        codex: false,
      }),
    })
  })

  await page.goto('http://localhost:5173')
  await page.getByRole('tab', { name: settingsTabPattern }).click()

  const settingsPanel = page.locator('#app-panel-settings')
  const missingList = settingsPanel.locator('.setup-missing-list')

  await expect(missingList).toHaveCount(1)
  await expect(missingList).toContainText('Git')
  await expect(missingList).toContainText('Codex CLI')
  await expect(missingList).not.toContainText('Node.js')
  await expect(missingList).not.toContainText('Claude CLI')
  await expect(settingsPanel.getByRole('button', { name: installMissingToolsPattern })).toHaveCount(1)
})

test('imports cc-switch profiles and shows a summary notice', async ({ page }) => {
  await mockBaseApis(page)
  await page.route('**/api/routing/import/cc-switch', async (route) => {
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

  await openRoutingPanel(page)
  await page.getByRole('button', { name: importDefaultPattern }).click()

  await expect(page.locator('.panel-alert')).toContainText('~/.cc-switch/cc-switch.db')
  await expect(page.locator('input[value="Claude Proxy"]')).toBeVisible()
  await expect(page.locator('input[value="Codex Proxy"]')).toBeVisible()
})

test('shows a readable message when an uploaded cc-switch export is too large', async ({ page }) => {
  await mockBaseApis(page)
  await page.route('**/api/routing/import/cc-switch', async (route) => {
    await route.fulfill({
      status: 413,
      contentType: 'text/plain',
      body: 'request entity too large',
    })
  })

  await openRoutingPanel(page)
  await page.locator('input[type="file"]').setInputFiles({
    name: 'cc-switch.db',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('not-a-real-db'),
  })

  await expect(page.locator('.panel-alert')).toContainText(importTooLargePattern)
})

test('shows the auto-retry controls on routing instead of settings', async ({ page }) => {
  await mockBaseApis(page)

  await page.goto('http://localhost:5173')

  await page.getByRole('tab', { name: settingsTabPattern }).click()
  await expect(page.locator('#app-panel-settings')).toBeVisible()
  await expect(page.locator('#app-panel-settings').getByRole('button', { name: routingProxyTabPattern })).toHaveCount(0)

  await page.getByRole('tab', { name: routingTabPattern }).click()
  await expect(page.locator('#app-panel-routing')).toBeVisible()
  await expect(page.locator('#app-panel-routing').getByRole('button', { name: routingProvidersTabPattern })).toBeVisible()
  await expect(page.locator('#app-panel-routing').getByRole('button', { name: routingProxyTabPattern })).toBeVisible()
  await page.getByRole('button', { name: routingProxyTabPattern }).click()
  await expect(page.locator('#app-panel-routing')).toContainText(/\u542f\u7528|Status/)
  await expect(page.locator('#app-panel-routing')).toContainText(/\u672c\u6b21\u542f\u52a8|This launch/)
})
