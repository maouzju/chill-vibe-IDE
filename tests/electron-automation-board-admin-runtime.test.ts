import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { _electron as electron } from '@playwright/test'

import { createDefaultState, createPane } from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.ts'
import type { AppState } from '../shared/schema.ts'
import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

/**
 * v2 验收的真实运行时证明：模板配置面板与卡片级超管权限都要**落盘**。
 *
 * 症状（要防的）：SSR 渲染测试能证明控件画出来了，但证明不了勾一下之后
 *   reducer → 队列持久化 → state.json 这条链是通的；v2 把触发器从工作区级
 *   搬进模板、把权限搬上卡片，正好全是新的持久化路径（AGENTS.md pitfall 5）。
 * 被否决：只断言 DOM 变化 —— 那对"UI 变了但没存下来"完全无感，而这恰恰是
 *   本次改动最可能出错的形态。所以断言的是磁盘上的 state.json。
 */
const tempRoots: string[] = []

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

const createTempStateDir = async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), 'chill-vibe-admin-ws-'))
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-admin-state-'))
  tempRoots.push(workspacePath, dataDir)

  const state = createDefaultState(workspacePath, 'zh-CN')
  state.settings.language = 'zh-CN'
  state.settings.theme = 'light'

  const baseCard = Object.values(state.columns[0]!.cards)[0]!
  state.columns = [
    {
      ...state.columns[0]!,
      id: 'col-1',
      title: 'Admin Smoke',
      provider: 'codex',
      workspacePath,
      model: 'gpt-5.5',
      width: 900,
      layout: createPane(['board-1', 'chat-1'], 'board-1', 'pane-admin'),
      cards: {
        'board-1': {
          ...baseCard,
          id: 'board-1',
          title: '自动化看板',
          model: AUTOMATIONBOARD_TOOL_MODEL,
          draft: '',
          messages: [],
          status: 'idle',
          automationBoard: { items: [] },
        },
        'chat-1': {
          ...baseCard,
          id: 'chat-1',
          title: '普通会话',
          provider: 'codex',
          model: 'gpt-5.5',
          draft: '',
          messages: [],
          status: 'idle',
        },
      },
    },
  ]
  state.updatedAt = new Date().toISOString()

  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')

  return { dataDir, workspacePath }
}

const readPersistedState = async (dataDir: string): Promise<AppState> =>
  JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8')) as AppState

test('Electron runtime persists template triggers and card-level admin access', async () => {
  await ensureElectronRuntimeBuild()

  const { dataDir, workspacePath } = await createTempStateDir()

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: createHeadlessElectronRuntimeEnv({
      VITE_DEV_SERVER_URL: getElectronTestRendererUrl(),
      CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
      CHILL_VIBE_ALLOW_SHARED_DATA_DIR: '1',
      CHILL_VIBE_DATA_DIR: dataDir,
      CHILL_VIBE_RUNTIME_PROFILE_ROOT: path.join(dataDir, 'runtime-profile'),
      CHILL_VIBE_DEFAULT_WORKSPACE: workspacePath,
    }),
  })

  try {
    const page = await app.firstWindow()
    await page.waitForSelector('.automation-board', { timeout: 30000 })

    // 验收 9 前半：新工作区的模板条默认就有内置监工模板，且它自带超管盾牌。
    const template = page.locator('.automation-board-template').first()
    await template.waitFor({ state: 'visible', timeout: 20000 })
    assert.equal(
      await template.locator('.automation-board-template-name').innerText(),
      '看板监工',
    )
    assert.equal(await template.locator('.automation-board-template-badge.is-admin').count(), 1)
    // 触发器默认关闭 —— 自动起 agent 有真实成本，不该因为新建工作区就默默开跑。
    assert.equal(await template.locator('.automation-board-template-badge.is-trigger').count(), 0)

    // 验收 9 后半：展开配置面板 → 改需求 → 开触发器，全部要落盘。
    await template.locator('.automation-board-template-configure').click()
    const config = page.locator('.automation-board-template-config')
    await config.waitFor({ state: 'visible', timeout: 10000 })

    const requirement = config.locator('textarea')
    await requirement.fill('只检查还没交付的需求，别打扰在跑的。')

    const triggerToggle = config
      .locator('.automation-board-template-trigger input[type="checkbox"]')
      .first()
    await triggerToggle.check()

    // 开了触发器，胶囊上的闪电角标要立刻出现。
    await template
      .locator('.automation-board-template-badge.is-trigger')
      .waitFor({ state: 'visible', timeout: 10000 })

    // 验收 12：普通聊天 tab 的 composer 设置菜单里能开超管权限。
    await page.locator('.pane-tab', { hasText: '普通会话' }).first().click()
    await page.waitForSelector('.pane-tab-panel.is-active .composer textarea', { timeout: 20000 })
    await page.locator('.pane-tab-panel.is-active .composer-settings-trigger').first().click()

    // 设置菜单走 portal 挂在 pane 外部，所以要从页面级定位（pitfall 254）。
    const adminRow = page.locator('.composer-settings-menu .composer-admin-access-row')
    await adminRow.waitFor({ state: 'visible', timeout: 10000 })
    await adminRow.locator('input[type="checkbox"]').check()

    // 开着超管的卡片必须有可见标识 —— 它能改别的会话。
    await page
      .locator('.pane-tab-panel.is-active .card-admin-access-badge')
      .first()
      .waitFor({ state: 'visible', timeout: 10000 })

    // 落盘是异步队列，等 state.json 追上这三处改动。
    await page.waitForFunction(() => true)
    const deadline = Date.now() + 20000
    let persisted: AppState | null = null
    for (;;) {
      const snapshot = await readPersistedState(dataDir)
      const workspace = snapshot.automationBoards?.[workspacePath]
      const builtIn = workspace?.templates.find((entry) => entry.builtIn)
      const chatCard = snapshot.columns[0]?.cards['chat-1']

      if (
        builtIn?.trigger.enabled === true &&
        builtIn.requirement.includes('只检查还没交付的需求') &&
        chatCard?.adminAccess === true
      ) {
        persisted = snapshot
        break
      }

      if (Date.now() > deadline) {
        assert.fail(
          `state.json never caught up: trigger=${String(builtIn?.trigger.enabled)} ` +
            `requirement=${JSON.stringify(builtIn?.requirement.slice(0, 24))} ` +
            `adminAccess=${String(chatCard?.adminAccess)}`,
        )
      }

      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    const builtIn = persisted.automationBoards[workspacePath]!.templates.find(
      (entry) => entry.builtIn,
    )!
    // 内置模板自带的超管权限不能被"改需求"这类无关编辑顺手抹掉。
    assert.equal(builtIn.adminAccess, true)
    assert.equal(builtIn.trigger.lane, 'running')

    // v1 的工作区级 autoTrigger 必须已经不存在了 —— 触发器只属于模板。
    assert.equal(
      Object.hasOwn(persisted.automationBoards[workspacePath] as object, 'autoTrigger'),
      false,
    )
  } finally {
    await app.close()
  }
})
