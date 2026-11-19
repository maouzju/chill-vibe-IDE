// README 主界面截图的生成器，不是回归用例：只有 README_SHOT=1 时才跑，平时整份跳过。
// 用法（PowerShell）：$env:README_SHOT='1'; pnpm exec playwright test tests/readme-screenshot.spec.ts
// 产物写到 docs/images/board-<语言>.png。全部是演示数据，不读真实 state。
import path from 'node:path'

import { test, type Page } from '@playwright/test'

import { createPane, createSplit } from '../shared/default-state.ts'
import type { AppState } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { appUrl } from './playwright-app-url.ts'
import { createPlaywrightState } from './playwright-state.ts'

type Lang = 'en' | 'zh-CN'

const t = (lang: Lang, en: string, zh: string) => (lang === 'en' ? en : zh)

const structured = (
  id: string,
  provider: 'codex' | 'claude' | 'gemini',
  kind: string,
  data: unknown,
  minute: number,
) => ({
  id,
  role: 'assistant' as const,
  content: '',
  createdAt: `2026-11-19T09:${String(minute).padStart(2, '0')}:00.000Z`,
  meta: { provider, kind, structuredData: JSON.stringify(data) },
})

const text = (id: string, role: 'user' | 'assistant', content: string, minute: number) => ({
  id,
  role,
  content,
  createdAt: `2026-11-19T09:${String(minute).padStart(2, '0')}:00.000Z`,
})

const createDemoState = (lang: Lang): AppState => {
  const card = (
    id: string,
    title: string,
    provider: 'codex' | 'claude' | 'gemini',
    model: string,
    status: 'idle' | 'streaming',
    messages: unknown[],
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    title,
    status,
    size: 560,
    provider,
    model,
    reasoningEffort: 'high',
    draft: '',
    ...(status === 'streaming' ? { streamId: `stream-${id}`, sessionId: `session-${id}` } : {}),
    messages,
    ...extra,
  })

  const shopRoot = 'D:\\Projects\\storefront-web'
  const apiRoot = 'D:\\Projects\\orders-api'
  const docsRoot = 'D:\\Projects\\docs-site'

  return createPlaywrightState({
    version: 1,
    settings: {
      language: lang,
      theme: 'dark',
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: { codex: 'gpt-6.2-sol', claude: 'claude-fable-5-2', gemini: 'gemini-4-carbon' },
    },
    updatedAt: '2026-11-19T09:30:00.000Z',
    columns: [
      {
        id: 'col-shop',
        title: 'storefront-web',
        provider: 'claude',
        workspacePath: shopRoot,
        model: 'claude-fable-5-2',
        width: 620,
        cards: [
          card(
            'shop-cart',
            t(lang, 'Cart totals bug', '购物车金额错误'),
            'claude',
            'claude-fable-5-2',
            'streaming',
            [
              text(
                'shop-u1',
                'user',
                t(
                  lang,
                  'Cart total is off by a cent when a coupon and tax both apply. Find the cause, fix it, and add a test.',
                  '优惠券和税同时生效时，购物车总价会差一分钱。找出原因修掉，并补一个测试。',
                ),
                1,
              ),
              structured(
                'shop-cmd1',
                'claude',
                'command',
                {
                  itemId: 'shop_cmd_1',
                  status: 'completed',
                  command: 'pnpm vitest run src/cart/totals.test.ts',
                  output: ' FAIL  src/cart/totals.test.ts > applies coupon before tax\n   expected 107.99, received 108.00',
                  exitCode: 1,
                },
                2,
              ),
              structured(
                'shop-todo',
                'claude',
                'todo',
                {
                  itemId: 'shop_todo',
                  status: 'completed',
                  items: [
                    {
                      id: 't1',
                      content: t(lang, 'Reproduce the rounding error with a failing test', '用失败测试复现舍入误差'),
                      status: 'completed',
                    },
                    {
                      id: 't2',
                      content: t(lang, 'Round once, after tax, in integer cents', '改成税后用整数分只舍入一次'),
                      activeForm: t(lang, 'Rounding once, after tax, in integer cents', '正在改成税后用整数分只舍入一次'),
                      status: 'in_progress',
                    },
                    {
                      id: 't3',
                      content: t(lang, 'Run the full cart suite', '跑完整的购物车测试'),
                      status: 'pending',
                    },
                  ],
                },
                3,
              ),
              structured(
                'shop-edits',
                'claude',
                'edits',
                {
                  itemId: 'shop_edits',
                  status: 'completed',
                  files: [
                    {
                      path: `${shopRoot}\\src\\cart\\totals.ts`,
                      kind: 'modified',
                      addedLines: 3,
                      removedLines: 2,
                      patch:
                        'diff --git a/src/cart/totals.ts b/src/cart/totals.ts\nindex 4be21aa..9c03f1d 100644\n--- a/src/cart/totals.ts\n+++ b/src/cart/totals.ts\n@@ -41,4 +41,5 @@\n-  const discounted = round2(subtotal - coupon)\n-  return round2(discounted * (1 + taxRate))\n+  const cents = Math.round(subtotal * 100) - Math.round(coupon * 100)\n+  const taxed = Math.round(cents * (1 + taxRate))\n+  return taxed / 100',
                    },
                  ],
                },
                4,
              ),
              structured(
                'shop-agents',
                'claude',
                'agents',
                {
                  itemId: 'agent-status:root',
                  kind: 'agents',
                  status: 'completed',
                  view: 'status',
                  agents: [
                    {
                      threadId: 'thread-tests',
                      path: '/root/test-runner',
                      status: 'running',
                      model: 'claude-sonnet-5-5',
                      activity: [t(lang, 'Running the full cart suite (148 tests).', '正在跑完整的购物车测试（148 个）。')],
                    },
                    {
                      threadId: 'thread-sweep',
                      path: '/root/rounding-sweep',
                      status: 'running',
                      model: 'claude-haiku-5-5',
                      activity: [
                        t(lang, 'Scanning checkout and refunds for the same round2 pattern.', '正在扫结算和退款里同样的 round2 写法。'),
                      ],
                    },
                  ],
                },
                5,
              ),
            ],
          ),
          card('shop-review', t(lang, 'Review PR #214', '评审 PR #214'), 'codex', 'gpt-6.2-sol', 'idle', []),
        ],
      },
      {
        id: 'col-api',
        title: 'orders-api',
        provider: 'codex',
        workspacePath: apiRoot,
        model: 'gpt-6.2-sol',
        width: 560,
        cards: [
          card(
            'api-migrate',
            t(lang, 'Add order status index', '给订单状态加索引'),
            'codex',
            'gpt-6.2-sol',
            'idle',
            [
              text(
                'api-u1',
                'user',
                t(
                  lang,
                  'The orders list endpoint is slow when filtering by status. Add the right index and prove it helps.',
                  '订单列表接口按状态筛选很慢。加上合适的索引，并证明确实变快了。',
                ),
                10,
              ),
              structured(
                'api-cmd1',
                'codex',
                'command',
                {
                  itemId: 'api_cmd_1',
                  status: 'completed',
                  command: 'pnpm prisma migrate dev --name order_status_created_idx',
                  output: 'Applying migration `20261119_order_status_created_idx`\nYour database is now in sync with your schema.',
                  exitCode: 0,
                },
                11,
              ),
              structured(
                'api-cmd2',
                'codex',
                'command',
                {
                  itemId: 'api_cmd_2',
                  status: 'completed',
                  command: 'pnpm bench orders:list --status=shipped',
                  output: 'before  p95 412 ms\nafter   p95  38 ms',
                  exitCode: 0,
                },
                12,
              ),
              text(
                'api-a1',
                'assistant',
                t(
                  lang,
                  'Added a composite index on `(status, created_at DESC)`. The list query now uses an index scan instead of a full table scan: p95 went from **412 ms to 38 ms** on the 2M-row fixture. The migration is additive and safe to roll back.',
                  '加了 `(status, created_at DESC)` 复合索引。列表查询从全表扫描变成索引扫描：在 200 万行的测试数据上，p95 从 **412 ms 降到 38 ms**。这次迁移只新增不改动，可以安全回滚。',
                ),
                13,
              ),
              structured(
                'api-summary',
                'codex',
                'changes-summary',
                [
                  { path: `${apiRoot}\\prisma\\schema.prisma`, addedLines: 1, removedLines: 0 },
                  {
                    path: `${apiRoot}\\prisma\\migrations\\20261119_order_status_created_idx\\migration.sql`,
                    addedLines: 2,
                    removedLines: 0,
                  },
                  { path: `${apiRoot}\\bench\\orders-list.bench.ts`, addedLines: 24, removedLines: 3 },
                ],
                14,
              ),
              {
                id: 'api-duration',
                role: 'system' as const,
                content: '',
                createdAt: '2026-11-19T09:15:00.000Z',
                meta: { kind: 'run-duration', durationMs: '287000' },
              },
            ],
          ),
        ],
      },
      {
        id: 'col-docs',
        title: 'docs-site',
        provider: 'gemini',
        workspacePath: docsRoot,
        model: 'gemini-4-carbon',
        width: 520,
        cards: {
          'docs-translate': card(
            'docs-translate',
            t(lang, 'Translate the API guide', '翻译 API 指南'),
            'gemini',
            'gemini-4-carbon',
            'streaming',
            [
              text(
                'docs-u1',
                'user',
                t(
                  lang,
                  'Translate docs/api/*.md to Japanese. Keep code blocks and anchors untouched.',
                  '把 docs/api/*.md 翻译成日文，代码块和锚点保持原样。',
                ),
                20,
              ),
              structured(
                'docs-cmd1',
                'gemini',
                'command',
                {
                  itemId: 'docs_cmd_1',
                  status: 'completed',
                  command: 'ls docs/api',
                  output: 'authentication.md\norders.md\npagination.md\nwebhooks.md',
                  exitCode: 0,
                },
                21,
              ),
              text(
                'docs-a1',
                'assistant',
                t(
                  lang,
                  'Four files to translate. `authentication.md` and `orders.md` are done; working on `pagination.md` now.',
                  '一共 4 个文件，`authentication.md` 和 `orders.md` 已完成，现在翻译 `pagination.md`',
                ),
                22,
              ),
            ],
          ),
          'docs-links': card(
            'docs-links',
            t(lang, 'Fix broken links', '修复失效链接'),
            'claude',
            'claude-sonnet-5-5',
            'idle',
            [
              text(
                'links-u1',
                'user',
                t(lang, 'Check every internal link in the docs and fix the broken ones.', '检查文档里所有站内链接，把失效的修好。'),
                25,
              ),
              text(
                'links-a1',
                'assistant',
                t(
                  lang,
                  'Checked 312 internal links. 7 were broken, all pointing at pages renamed in the v3 restructure. Fixed in place; the link checker now passes.',
                  '检查了 312 个站内链接，其中 7 个失效，都指向 v3 重构时改名的页面。已就地修好，链接检查现在通过。',
                ),
                26,
              ),
            ],
          ),
        } as never,
        layout: createSplit(
          'vertical',
          [
            createPane(['docs-translate'], 'docs-translate', 'docs-pane-top'),
            createPane(['docs-links'], 'docs-links', 'docs-pane-bottom'),
          ],
          [0.56, 0.44],
          'docs-split',
        ),
      },
    ],
  } as never)
}

const installMockApis = async (page: Page, state: AppState) => {
  await installMockElectronBridge(page)
  await page.addInitScript(() => {
    if (!window.electronAPI) {
      return
    }

    window.electronAPI.subscribeChatStream = async () => undefined
    window.electronAPI.unsubscribeChatStream = async () => undefined
  })

  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }

    await route.fulfill({ json: JSON.parse(route.request().postData() ?? '{}') })
  })
  await page.route('**/api/state/snapshot', async (route) => {
    await route.fulfill({ status: 204 })
  })
  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      json: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
        { provider: 'gemini', available: true, command: 'gemini' },
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

test.describe('README screenshots', () => {
  test.skip(process.env.README_SHOT !== '1', 'screenshot generator; set README_SHOT=1 to run')
  test.use({ viewport: { width: 1760, height: 990 }, deviceScaleFactor: 1.5 })

  for (const lang of ['en', 'zh-CN'] as const) {
    test(`board ${lang}`, async ({ page }) => {
      await installMockApis(page, createDemoState(lang))
      await page.goto(appUrl)
      await page.locator('.workspace-column').nth(2).waitFor()
      await page.waitForTimeout(1500)
      await page.screenshot({
        path: path.join(process.cwd(), 'docs', 'images', `board-${lang === 'en' ? 'en' : 'zh-CN'}.png`),
      })
    })
  }
})
