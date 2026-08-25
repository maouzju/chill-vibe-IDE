// 打包版实证：启动真实 exe，点进「设置」页，确认「本地模型」区块真的渲染出来并截图。
//
// 为什么不能只靠单测/grep —— grep 只证明字符串打进了 asar，单测跑的是 dev server 上的
// mock 页面。用户看到的是打包版真实界面；这两者之间还隔着首次引导、分栏布局、
// 折叠状态等一堆能把区块藏起来的东西。要给用户结论，就得看这一张截图。
//
// 隔离三件套照抄 smoke-packaged-backend-isolation.ps1：单独设 CHILL_VIBE_DATA_DIR 是无效的，
// 会静默回落到用户真实数据目录（2026-08-12 的教训）。

import { _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exePath = process.argv[2]
if (!exePath) {
  console.error('用法: node scripts/verify-local-model-packaged.mjs "<Chill Vibe.exe 路径>"')
  process.exit(2)
}

const dataDir = mkdtempSync(join(tmpdir(), 'cv-verify-'))
const shotDir = join(process.cwd(), 'test-results')
mkdirSync(shotDir, { recursive: true })

console.log(`exe      : ${exePath}`)
console.log(`数据目录 : ${dataDir}`)

const app = await electron.launch({
  executablePath: exePath,
  args: [],
  env: {
    ...process.env,
    CHILL_VIBE_ALLOW_SHARED_DATA_DIR: '1',
    CHILL_VIBE_DATA_DIR: dataDir,
    CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
    CHILL_VIBE_DISABLE_CRASH_RECOVERY: '1',
  },
  timeout: 120_000,
})

let exitCode = 0
try {
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForLoadState('domcontentloaded')
  // 首屏要等 React 挂载完，否则 tab 还没渲染出来
  await page.waitForTimeout(8000)

  await page.screenshot({ path: join(shotDir, 'pkg-01-boot.png') })
  console.log('已截首屏: test-results/pkg-01-boot.png')

  // 全新数据目录必然弹「快速上手」引导，它的 backdrop 会吃掉所有点击。引导是多步的，
  // 逐步点掉每一屏的跳过/完成类按钮，直到 backdrop 从 DOM 里消失。
  const backdrop = page.locator('.onboarding-backdrop')
  const dismissPattern = /暂时跳过|跳过|稍后|完成|进入工作台|开始使用|关闭|知道了|Skip|Done|Finish|Close|Got it|Enter workspace/
  for (let step = 0; step < 8; step += 1) {
    if ((await backdrop.count()) === 0) break
    const buttons = page.locator('.onboarding-shell button')
    const labels = await buttons.allInnerTexts().catch(() => [])
    console.log(`引导第 ${step + 1} 屏按钮: ${JSON.stringify(labels)}`)
    const hit = page.locator('.onboarding-shell button').filter({ hasText: dismissPattern })
    if ((await hit.count()) === 0) {
      await page.keyboard.press('Escape')
    } else {
      await hit.last().click({ timeout: 5000, force: true }).catch(() => {})
    }
    await page.waitForTimeout(1200)
  }
  console.log(`引导已关闭: ${(await backdrop.count()) === 0}`)

  const settingsTab = page.getByRole('tab', { name: /设置|Settings/ })
  const tabCount = await settingsTab.count()
  console.log(`「设置」tab 数量: ${tabCount}`)
  if (tabCount === 0) {
    // 没有 tab 说明卡在引导页或空白，把 DOM 概况打出来定位
    const bodyText = await page.locator('body').innerText().catch(() => '(读不到)')
    console.log('--- 页面文本前 800 字 ---')
    console.log(bodyText.slice(0, 800))
    throw new Error('找不到「设置」tab')
  }

  await settingsTab.first().click()
  await page.waitForTimeout(1500)

  const panel = page.locator('#app-panel-settings')
  console.log(`设置面板可见: ${await panel.isVisible().catch(() => false)}`)

  const group = panel.locator('.settings-group', { hasText: /本地模型|Local models/ }).first()
  const groupCount = await group.count()
  console.log(`「本地模型」分组数量: ${groupCount}`)

  if (groupCount > 0) {
    await group.scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
    const visible = await group.isVisible()
    console.log(`「本地模型」分组可见: ${visible}`)
    await group.screenshot({ path: join(shotDir, 'pkg-03-local-model-group.png') }).catch(() => {})
    if (!visible) exitCode = 1
  } else {
    exitCode = 1
  }

  await page.screenshot({ path: join(shotDir, 'pkg-02-settings.png'), fullPage: false })
  console.log('已截设置页: test-results/pkg-02-settings.png')

  // 端到端守住「不用开 CLI 路由也能用本地模型」：去接口页把总开关关掉，回来看本地模型区块
  // 是否还在拦人。这条只有真跑打包版才能证明——单测只覆盖 resolveProviderRuntime。
  await page.getByRole('tab', { name: /接口|Routing|API/ }).first().click()
  await page.waitForTimeout(1200)

  const toggleRow = page
    .locator('#app-panel-routing .settings-toggle-row')
    .filter({ hasText: /^(启用|Enable|CLI routing)/ })
    .first()
  const toggle = toggleRow.locator('input[type="checkbox"]').first()
  if ((await toggle.count()) === 0) {
    console.log('⚠ 没找到 CLI 路由开关，跳过关路由验证')
  } else {
    if (await toggle.isChecked()) {
      // 真正的 <input> 被 CSS 藏在 .toggle-switch 里（零尺寸），点它会报 outside viewport。
      // 点可见的 label 才是用户实际做的动作。
      await toggleRow.scrollIntoViewIfNeeded()
      await toggleRow.locator('label.toggle-switch').first().click()
      await page.waitForTimeout(1200)
    }
    console.log(`CLI 路由已关闭: ${!(await toggle.isChecked())}`)

    await page.getByRole('tab', { name: /设置|Settings/ }).first().click()
    await page.waitForTimeout(1200)

    const groupOff = page
      .locator('#app-panel-settings .settings-group', { hasText: /本地模型|Local models/ })
      .first()
    await groupOff.scrollIntoViewIfNeeded()
    const offText = await groupOff.innerText()
    const blocked = /路由当前是关闭|routing is off/i.test(offText)
    console.log(`关掉路由后仍有拦截警告: ${blocked}`)
    await groupOff.screenshot({ path: join(shotDir, 'pkg-04-routing-off.png') }).catch(() => {})
    if (blocked) exitCode = 1
  }
} catch (error) {
  console.error(`验证失败: ${error.message}`)
  exitCode = 1
} finally {
  await app.close().catch(() => {})
}

console.log(exitCode === 0 ? '✅ 打包版实证通过' : '❌ 打包版实证失败')
process.exit(exitCode)
