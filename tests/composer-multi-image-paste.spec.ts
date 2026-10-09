import { expect, test, type Page } from '@playwright/test'

import { createPlaywrightState } from './playwright-state.ts'
import { installMockElectronBridge } from './electron-bridge.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const IMAGE_COUNT = 8
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const createState = () =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN' as const,
      theme: 'dark' as const,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: { codex: 'gpt-5.5', claude: 'claude-opus-5' },
      modelReasoningEfforts: { codex: {}, claude: {} },
      providerProfiles: {
        codex: { activeProfileId: '', profiles: [] },
        claude: { activeProfileId: '', profiles: [] },
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Multi Image Paste',
        provider: 'claude' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'claude-opus-5',
        cards: [
          {
            id: 'card-1',
            title: 'Feature Chat',
            status: 'idle' as const,
            size: 560,
            provider: 'claude' as const,
            model: 'claude-opus-5',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
        ],
      },
    ],
  })

const installMockApis = async (page: Page, releaseAfter = IMAGE_COUNT) => {
  await installMockElectronBridge(page)
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      value: () => false,
    })
  })

  let state = createState()
  let uploadCounter = 0

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
    await route.fulfill({ status: 204, body: '' })
  })
  // 攒齐一整批再同时放行：真实环境里 8 张图是在同一秒内落盘完成的。
  const heldUploads: Array<() => Promise<void>> = []
  await page.route('**/api/attachments', async (route) => {
    uploadCounter += 1
    const id = uploadCounter
    heldUploads.push(() =>
      route.fulfill({
        json: {
          id: `att-${id}`,
          fileName: `shot-${id}.png`,
          mimeType: 'image/png',
          sizeBytes: tinyPng.length,
        },
      }),
    )
    if (heldUploads.length === releaseAfter) {
      const batch = heldUploads.splice(0)
      await Promise.all(batch.map((release) => release()))
    }
  })
  await page.route('**/api/attachments/*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng })
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

// 症状：从飞书复制带多张图的表格再粘贴，缩略图里一部分只剩「粘贴图片 N」的裂图 alt 文字。
// 根因：多张图的上传几乎同时完成，promote 回调连续改 pendingAttachmentsRef；
// 紧跟 state 的 ref 回写 effect 会把 ref 刷回旧快照，已换成服务端地址的条目被还原成
// 已 revoke 的 blob: 地址。
test('pasting several images at once leaves every composer thumbnail loadable', async ({ page }) => {
  await installMockApis(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(appUrl)

  const textarea = page.locator('.textarea').first()
  await textarea.waitFor()

  await textarea.evaluate(
    (element, { count, pngBase64 }) => {
      const bytes = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0))
      const transfer = new DataTransfer()
      for (let index = 0; index < count; index += 1) {
        transfer.items.add(new File([bytes], `table-${index + 1}.png`, { type: 'image/png' }))
      }
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      )
    },
    { count: IMAGE_COUNT, pngBase64: tinyPng.toString('base64') },
  )

  const thumbnails = page.locator('.composer-attachment-image')
  await expect(thumbnails).toHaveCount(IMAGE_COUNT)

  // 等所有上传都落地：全部换成服务端地址后，不应再残留任何 blob: 预览。
  await expect
    .poll(
      () => thumbnails.evaluateAll((images) => images.filter((image) => (image as HTMLImageElement).src.startsWith('blob:')).length),
      { timeout: 10_000 },
    )
    .toBe(0)

  const broken = await thumbnails.evaluateAll((images) =>
    images.filter((image) => {
      const element = image as HTMLImageElement
      return element.complete && element.naturalWidth === 0
    }).length,
  )
  expect(broken).toBe(0)
})

// 症状：浏览器里右键「复制图片」再粘进聊天框，出现两张一样的缩略图。
// 根因：剪贴板里同一张图既有原生 image File 又有 <img src>，HTML 通道和原生通道各消费一次。
test('pasting an image that is on the clipboard as both a file and an <img> adds only one attachment', async ({ page }) => {
  await installMockApis(page, 1)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(appUrl)

  const textarea = page.locator('.textarea').first()
  await textarea.waitFor()

  await textarea.evaluate(
    (element, { pngBase64 }) => {
      const bytes = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'copied.png', { type: 'image/png' }))
      transfer.setData('text/html', `<img src="data:image/png;base64,${pngBase64}">`)
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      )
    },
    { pngBase64: tinyPng.toString('base64') },
  )

  const thumbnails = page.locator('.composer-attachment-image')
  await expect(thumbnails).toHaveCount(1)
  // 抓取 HTML 图片是异步的：等一小段，确认没有第二张迟到的重复图。
  await page.waitForTimeout(800)
  await expect(thumbnails).toHaveCount(1)
})

// 症状：便签里点「复制图片」再粘进聊天框，输入框里多出一行图片文件名。
// 根因：便签把 text/plain 写成文件名只是给外部应用兜底，内部附件分支却把它当正文插入。
test('pasting a sticky-note image keeps the attachment but does not insert its file name', async ({ page }) => {
  await installMockApis(page, 1)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(appUrl)

  const textarea = page.locator('.textarea').first()
  await textarea.waitFor()

  await textarea.evaluate((element) => {
    const attachment = { id: 'sticky-att-1', fileName: 'sticky-shot.png', mimeType: 'image/png', sizeBytes: 68 }
    const transfer = new DataTransfer()
    transfer.setData(
      'text/html',
      `<img src="/api/attachments/sticky-att-1" alt="sticky-shot.png" data-chill-vibe-image-attachment="${encodeURIComponent(JSON.stringify(attachment))}">`,
    )
    transfer.setData('text/plain', 'sticky-shot.png')
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    )
  })

  await expect(page.locator('.composer-attachment-image')).toHaveCount(1)
  await expect(textarea).toHaveValue('')
})
