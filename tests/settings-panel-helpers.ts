import { expect, type Locator, type Page } from '@playwright/test'

import { getSettingsItemMeta } from '../src/components/settings/settings-model.ts'

// 设置面板 2026-09-23 起一次只渲染一个分类（docs/specs/settings-beginner-redesign），
// 落地页是「基础」四项。要断言别的项，先把它所在的分类切出来、把「高级设置」展开。
export const revealSettingsItem = async (page: Page, itemId: string): Promise<Locator> => {
  const meta = getSettingsItemMeta(itemId)
  if (!meta) {
    throw new Error(`Unknown settings item: ${itemId}`)
  }

  const panel = page.locator('#app-panel-settings')
  const item = panel.locator(`#settings-item-${itemId}`)
  if ((await item.count()) > 0 && (await item.isVisible())) {
    return item
  }

  await panel.locator(`#settings-nav-${meta.category}`).click()
  if (meta.tier === 'advanced') {
    const details = panel.locator('details.settings-advanced')
    await expect(details).toBeVisible()
    const open = await details.evaluate((node) => (node as HTMLDetailsElement).open)
    if (!open) {
      await details.locator('summary.settings-advanced-summary').click()
    }
  }
  await expect(item).toBeVisible()
  return item
}

// 主题开关只在「基础」/「外观」里。从别的分类切主题时先过去点、再回到原分类
// （每个分类的「高级设置」展开状态在内存里各自记着，回来时仍是展开的）。
export const switchSettingsTheme = async (page: Page, theme: 'light' | 'dark') => {
  const panel = page.locator('#app-panel-settings')
  const previousNavId = await panel.locator('.settings-nav-item.is-active').first().getAttribute('id')
  const toggle = panel.locator('.theme-toggle').first()
  if (!(await toggle.isVisible())) {
    await revealSettingsItem(page, 'language-theme')
  }
  await panel
    .locator('.theme-toggle')
    .first()
    .locator('.theme-chip')
    .nth(theme === 'light' ? 0 : 1)
    .click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  if (previousNavId) {
    await panel.locator(`#${previousNavId}`).click()
  }
}
