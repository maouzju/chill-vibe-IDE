import { expect, test, type Locator, type Page } from '@playwright/test'

import { createPane } from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const boardCardId = 'board-1'
const runningItemId = 'item-running'
const standbyItemId = 'item-standby'

const message = (id: string, index: number, content: string) => ({
  id,
  role: 'assistant' as const,
  content,
  createdAt: new Date(Date.parse('2026-08-11T00:00:00.000Z') + index * 1_000).toISOString(),
})

const itemCard = (id: string, title: string, messageCount: number) => ({
  id,
  title,
  status: 'idle' as const,
  size: 560,
  provider: 'codex' as const,
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  draft: '',
  messages: Array.from({ length: messageCount }, (_, index) =>
    message(`${id}-m${index}`, index, `agent line ${index} for ${title}`),
  ),
})

/**
 * A board item is an ordinary card in `column.cards` that is deliberately kept
 * out of `pane.tabs` — that is the only thing that makes it an item instead of
 * a tab, so the layout is pinned explicitly here rather than derived.
 */
const createState = () =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en',
      theme: 'dark',
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      automationBoardCardEnabled: true,
      wakeTimerEnabled: true,
      repeatLoopEnabled: true,
      requestModels: {
        codex: 'gpt-5.5',
        claude: 'claude-opus-5',
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
        id: 'col-board',
        title: 'Automation Workspace',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        layout: createPane([boardCardId], boardCardId, 'pane-board'),
        cards: [
          {
            id: boardCardId,
            title: 'Automation',
            status: 'idle' as const,
            size: 720,
            provider: 'codex' as const,
            model: AUTOMATIONBOARD_TOOL_MODEL,
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
            automationBoard: {
              items: [
                {
                  cardId: runningItemId,
                  lane: 'running' as const,
                  requirement: 'Backfill the checkout flow tests',
                },
                {
                  cardId: standbyItemId,
                  lane: 'standby' as const,
                  requirement: 'Repaint the login page in dark mode',
                },
              ],
            },
          },
          itemCard(runningItemId, 'Running item', 8),
          itemCard(standbyItemId, 'Standby item', 3),
        ],
      },
    ],
  })

const installMockApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createState()

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
}

const item = (page: Page, cardId: string) =>
  page.locator(`.automation-board-item[data-automation-board-item-id="${cardId}"]`)

const readBox = async (locator: Locator) => {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return box!
}

const readItemMetrics = (locator: Locator) =>
  locator.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    maxHeightPx: Number.parseFloat(getComputedStyle(node).maxHeight),
    transcriptHeight:
      node.querySelector('.automation-board-item-transcript')?.getBoundingClientRect().height ?? 0,
  }))

test('an item card keeps its secondary controls behind a collapsed disclosure', async ({ page }) => {
  await installMockApis(page)
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto(appUrl)

  const runningItem = item(page, runningItemId)
  await expect(runningItem).toBeVisible()
  await expect(page.locator('.automation-board-item')).toHaveCount(2)

  // The two seeded items really are lane members of the board, not pane tabs.
  await expect(
    page.locator('.automation-board-lane[data-lane="running"] .automation-board-item'),
  ).toHaveCount(1)
  await expect(
    page.locator('.automation-board-lane[data-lane="standby"] .automation-board-item'),
  ).toHaveCount(1)
  await expect(page.locator('.pane-tab')).toHaveCount(1)

  // Collapsed: nothing from the drawer exists in the DOM at all — hidden by
  // "not rendered", not merely by CSS.
  await expect(page.locator('.automation-board-item-drawer')).toHaveCount(0)
  await expect(runningItem.locator('textarea')).toHaveCount(0)
  await expect(runningItem.getByRole('button', { name: 'Pop out as a tab' })).toHaveCount(0)
  await expect(runningItem.getByRole('button', { name: 'Save as template' })).toHaveCount(0)

  const more = runningItem.locator('.automation-board-item-more')
  await expect(more).toBeVisible()
  await expect(more).toHaveAttribute('aria-expanded', 'false')

  // The primary row keeps only the disclosure and delete for a running item
  // (no play/stop while it is idle in the running lane).
  await expect(runningItem.locator('.automation-board-item-actions .icon-button')).toHaveCount(2)
  await expect(runningItem.locator('.automation-board-item-delete')).toBeVisible()

  const collapsedMetrics = await readItemMetrics(runningItem)

  await more.click()

  const drawer = runningItem.locator('.automation-board-item-drawer')
  await expect(drawer).toBeVisible()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await expect(runningItem).toHaveClass(/is-drawer-open/)
  await expect(drawer.locator('textarea')).toBeVisible()
  await expect(drawer.locator('textarea')).toHaveAttribute(
    'placeholder',
    'Message this requirement, press Enter to send…',
  )
  await expect(drawer.getByRole('button', { name: 'Pop out as a tab' })).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Save as template' })).toBeVisible()
  // 这里曾经硬编码 `toHaveCount(2)`：抽屉里原本是「上方需求」与「循环」两个裸复选框。
  // 「上方需求」已被 `WakeTimerSettingsPanel` 取代（唤醒是三选一，复选框只够得着其中
  // 一种），所以裸开关只剩循环那一个。计数改成 1 并不等价于放宽——真正要钉住的是「次要
  // 控件都在抽屉里」，所以顺带把接替者也断言进来；只改数字会让唤醒入口整块消失也照样绿。
  // 唤醒面板自身的行为由 tests/automation-board-item-drawer.spec.ts 覆盖。
  await expect(drawer.locator('.automation-board-item-toggle')).toHaveCount(1)
  await expect(drawer.locator('.composer-wake-timer-module')).toHaveCount(1)

  // The card has a `max-height` plus `overflow: hidden`; an expanded drawer
  // must land inside the card, not be cut off below its bottom edge.
  const articleBox = await readBox(runningItem)
  const drawerBox = await readBox(drawer)
  expect(drawerBox.y + drawerBox.height).toBeLessThanOrEqual(articleBox.y + articleBox.height + 1)

  /**
   * The containment check above cannot fail on its own: the transcript is the
   * one shrinkable child (`min-height: 0`), so a card that never grows just
   * squeezes the transcript to nothing and still "contains" the drawer. The
   * budget the open card is given is therefore asserted directly — this is
   * what actually breaks if `.automation-board-item.is-drawer-open` loses its
   * taller `max-height` and the drawer starts eating the transcript.
   */
  const openMetrics = await readItemMetrics(runningItem)
  expect(openMetrics.maxHeightPx).toBeGreaterThan(collapsedMetrics.maxHeightPx)
  expect(openMetrics.height).toBeGreaterThan(collapsedMetrics.height)
  expect(openMetrics.transcriptHeight).toBeGreaterThan(0)

  await more.click()

  await expect(runningItem.locator('.automation-board-item-drawer')).toHaveCount(0)
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await expect(runningItem).not.toHaveClass(/is-drawer-open/)
})

test('each item owns its own disclosure state', async ({ page }) => {
  await installMockApis(page)
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto(appUrl)

  const runningItem = item(page, runningItemId)
  const standbyItem = item(page, standbyItemId)
  await expect(runningItem).toBeVisible()
  await expect(standbyItem).toBeVisible()

  await runningItem.locator('.automation-board-item-more').click()

  await expect(runningItem.locator('.automation-board-item-drawer')).toBeVisible()
  await expect(standbyItem.locator('.automation-board-item-drawer')).toHaveCount(0)
  await expect(standbyItem.locator('.automation-board-item-more')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(page.locator('.automation-board-item-drawer')).toHaveCount(1)

  await standbyItem.locator('.automation-board-item-more').click()

  await expect(page.locator('.automation-board-item-drawer')).toHaveCount(2)
  await expect(runningItem.locator('.automation-board-item-more')).toHaveAttribute(
    'aria-expanded',
    'true',
  )

  await runningItem.locator('.automation-board-item-more').click()

  await expect(runningItem.locator('.automation-board-item-drawer')).toHaveCount(0)
  await expect(standbyItem.locator('.automation-board-item-drawer')).toBeVisible()
})
