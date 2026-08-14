import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { _electron as electron } from '@playwright/test'

import { createDefaultState } from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.ts'
import type { AppState } from '../shared/schema.ts'
import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

/**
 * 用户报的症状：自动化看板"退出重进就清空了"。
 *
 * 为什么必须是运行时测试：Node 层的 saveState → loadState 往返测试是绿的，
 * 预置一份含看板的 state.json 再让打包版跑一圈也活得好好的 —— 也就是说
 * **存储层没问题**。会丢的只可能是"用户在界面上真的建了一个看板"这条路径，
 * 而它跨了 reducer → 队列持久化 → IPC → utilityProcess → 磁盘四层，
 * 任何纯函数单测都照不到（同 pitfall 283：被测的每一段都对，只是没人调用）。
 *
 * 所以这条用例走完整用户动线：空态点工具砖建看板 → 加一个待命需求 →
 * 关掉进程 → 重新启动 → 断言看板与需求都还在。
 */
const tempRoots: string[] = []

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

const createTempStateDir = async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), 'chill-vibe-board-restart-ws-'))
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-board-restart-state-'))
  tempRoots.push(workspacePath, dataDir)

  const state = createDefaultState(workspacePath, 'zh-CN')
  state.settings.language = 'zh-CN'
  state.settings.theme = 'light'
  // 看板自 v0.20.2 起是实验性卡牌、默认关闭，空态工具栅格里那块砖要用户先开开关才出现。
  // 这条用例盯的是"建好的看板能不能扛住重启"，不是开关本身，所以在种子状态里就把它打开；
  // 不这么做的话下面按中文名找砖会直接超时，看上去像持久化坏了。
  state.settings.automationBoardCardEnabled = true
  state.columns = [{ ...state.columns[0]!, workspacePath }]
  state.updatedAt = new Date().toISOString()

  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')

  return { dataDir, workspacePath }
}

const readPersistedState = async (dataDir: string): Promise<AppState> =>
  JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8')) as AppState

const launch = (dataDir: string, workspacePath: string) =>
  electron.launch({
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

const findBoardCard = (state: AppState) => {
  for (const column of state.columns) {
    for (const [cardId, card] of Object.entries(column.cards)) {
      if (card.model === AUTOMATIONBOARD_TOOL_MODEL) {
        return { columnId: column.id, cardId, card }
      }
    }
  }
  return null
}

test('a board built through the UI survives an app restart', async () => {
  await ensureElectronRuntimeBuild()

  const { dataDir, workspacePath } = await createTempStateDir()
  const requirement = '重启之后我必须还在'

  const first = await launch(dataDir, workspacePath)
  try {
    const page = await first.firstWindow()
    await page.waitForSelector('.chat-empty-tool-grid', { timeout: 30000 })

    // 1. 用户的真实入口：空态工具栅格里的那块砖。
    await page
      .locator('.chat-empty-tool-button')
      .filter({ hasText: '自动化看板' })
      .first()
      .click()
    await page.waitForSelector('.automation-board', { timeout: 20000 })

    // 2. 待命道的输入框里加一个需求（Enter 提交）。
    const compose = page.locator('.automation-board-lane-compose textarea').first()
    await compose.waitFor({ state: 'visible', timeout: 10000 })
    await compose.fill(requirement)
    await compose.press('Enter')

    await page
      .locator('.automation-board-item')
      .first()
      .waitFor({ state: 'visible', timeout: 20000 })

    // 3. 等队列持久化把这两步都刷进 state.json。
    const deadline = Date.now() + 25000
    for (;;) {
      const snapshot = await readPersistedState(dataDir)
      const board = findBoardCard(snapshot)
      const mirrored =
        snapshot.automationBoards[snapshot.columns[0]?.workspacePath ?? '']?.board?.items.length ?? 0
      if (board && (board.card.automationBoard?.items.length ?? 0) === 1 && mirrored === 1) {
        break
      }

      if (Date.now() > deadline) {
        assert.fail(
          `state.json never recorded the board: boardCard=${String(Boolean(board))} ` +
            `items=${String(board?.card.automationBoard?.items.length ?? 0)} ` +
            `mirroredItems=${mirrored} workspaceKeys=${JSON.stringify(Object.keys(snapshot.automationBoards))}`,
        )
      }

      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  } finally {
    await first.close()
  }

  // 4. 重进。
  const second = await launch(dataDir, workspacePath)
  try {
    const page = await second.firstWindow()
    await page.waitForSelector('.automation-board', { timeout: 30000 })

    const items = page.locator('.automation-board-item')
    await items.first().waitFor({ state: 'visible', timeout: 20000 })
    assert.equal(await items.count(), 1)
    assert.match(
      await page.locator('.automation-board-item-requirement, .automation-board-item-title').first().innerText(),
      /重启之后我必须还在/,
    )

    // 5. 待命输入框里写一半的需求也要活过 tab 切换（它过去只在组件 useState 里，
    //    而看板 tab 一切走整棵子树就卸载）。
    const halfTyped = '还没提交的半句需求'
    await page.locator('.automation-board-lane-compose textarea').first().fill(halfTyped)

    //    先双击 tab 栏开一张普通 tab：看板是这一列唯一的 tab，直接关掉会把整个
    //    pane 收掉，后面就没有空态工具栅格可以点了。切过去也顺带验证了草稿。
    await page.locator('.pane-tab-bar').first().dblclick()
    await page.waitForSelector('.chat-empty-tool-grid', { timeout: 20000 })

    await page.locator('.pane-tab').filter({ hasText: '自动化看板' }).first().click()
    await page.waitForSelector('.automation-board', { timeout: 20000 })
    assert.equal(
      await page.locator('.automation-board-lane-compose textarea').first().inputValue(),
      halfTyped,
      '切走再回来，写了一半的需求还在',
    )

    // 6. FR13：关掉看板 tab —— 这一步过去会零痕迹带走整块编排，把项卡变成
    //    看不见也删不掉的孤儿。现在编排要留在工作区上。
    await page.locator('.pane-tab').filter({ hasNotText: '自动化看板' }).first().click()
    await page.waitForSelector('.chat-empty-tool-grid', { timeout: 20000 })

    await page
      .locator('.pane-tab')
      .filter({ hasText: '自动化看板' })
      .first()
      .click({ button: 'middle' })
    await page.waitForSelector('.automation-board', { state: 'detached', timeout: 20000 })

    const closeDeadline = Date.now() + 25000
    for (;;) {
      const stored = await readPersistedState(dataDir)
      if (!findBoardCard(stored)) {
        // 卡没了，但编排必须留在工作区上 —— 这就是 FR13 的全部。
        // 键取磁盘上那一列自己的 workspacePath：Electron 侧可能对临时目录做过
        // 大小写 / 分隔符归一化，拿测试进程里的原字符串去查会假红。
        const key = stored.columns[0]!.workspacePath
        assert.equal(
          stored.automationBoards[key]?.board?.items.length,
          1,
          `workspace board missing for ${JSON.stringify(key)}; keys=${JSON.stringify(Object.keys(stored.automationBoards))}`,
        )
        break
      }

      if (Date.now() > closeDeadline) {
        assert.fail('state.json still carries the board card after its tab was closed')
      }

      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    // 6. 该工作区再开一张看板，上次的编排原样接回来。
    await page.waitForSelector('.chat-empty-tool-grid', { timeout: 30000 })
    await page
      .locator('.chat-empty-tool-button')
      .filter({ hasText: '自动化看板' })
      .first()
      .click()
    await page.waitForSelector('.automation-board', { timeout: 20000 })

    const reopened = page.locator('.automation-board-item')
    await reopened.first().waitFor({ state: 'visible', timeout: 20000 })
    assert.equal(await reopened.count(), 1)
    assert.match(
      await page
        .locator('.automation-board-item-requirement, .automation-board-item-title')
        .first()
        .innerText(),
      /重启之后我必须还在/,
    )
  } finally {
    await second.close()
  }
})
