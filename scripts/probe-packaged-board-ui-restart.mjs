/**
 * 一次性取证探针（不进测试清单）：拿用户手上的**打包版**跑完整用户动线 ——
 * 空态点工具砖建看板 → 加一个待命需求 → 关掉 → 重开 → 看还在不在。
 *
 * 仓库代码上同一条动线已经绿了（tests/electron-automation-board-restart-runtime.test.ts），
 * 所以这个探针回答的是另一个问题：用户装的那个版本到底有没有这个 bug。
 *
 * 用法：node scripts/probe-packaged-board-ui-restart.mjs "<Chill Vibe.exe 的路径>"
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from '@playwright/test'

const exe = process.argv[2]
// close = 正常关窗（有 flush 机会）；kill = 直接杀进程（模拟这台机器常见的闪退/被收尸）
const mode = process.argv[3] ?? 'close'
// 加完项等多久再收尾：0 = 立刻，模拟"刚加完就没了"
const settleMs = Number(process.argv[4] ?? '0')
if (!exe) {
  console.error('usage: node scripts/probe-packaged-board-ui-restart.mjs "<exe path>" [close|kill] [settleMs]')
  process.exit(2)
}
console.log('mode:', mode, '| settleMs:', settleMs)

const AUTOMATIONBOARD_TOOL_MODEL = '__automationboard_tool__'
const requirement = '重启之后我必须还在'

const workspacePath = await mkdtemp(path.join(tmpdir(), 'cv-pkg-board-ws-'))
const dataDir = await mkdtemp(path.join(tmpdir(), 'cv-pkg-board-state-'))
await mkdir(dataDir, { recursive: true })

const env = {
  ...process.env,
  CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
  CHILL_VIBE_ALLOW_SHARED_DATA_DIR: '1',
  CHILL_VIBE_DATA_DIR: dataDir,
  CHILL_VIBE_RUNTIME_PROFILE_ROOT: path.join(dataDir, 'runtime-profile'),
  CHILL_VIBE_DEFAULT_WORKSPACE: workspacePath,
  CHILL_VIBE_DISABLE_CRASH_RECOVERY: '1',
}
delete env.ELECTRON_RUN_AS_NODE

const readState = async () => {
  try {
    return JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'))
  } catch {
    return null
  }
}

const findBoard = (state) => {
  for (const column of state?.columns ?? []) {
    for (const [cardId, card] of Object.entries(column.cards ?? {})) {
      if (card.model === AUTOMATIONBOARD_TOOL_MODEL) return { cardId, card }
    }
  }
  return null
}

const launch = () => electron.launch({ executablePath: exe, env })

console.log('data dir:', dataDir)

const first = await launch()
try {
  const page = await first.firstWindow()
  await page.waitForSelector('.chat-empty-tool-grid', { timeout: 60000 })

  const brick = page.locator('.chat-empty-tool-button').filter({ hasText: '自动化看板' }).first()
  const brickCount = await page.locator('.chat-empty-tool-button').count()
  console.log('quick tool bricks:', brickCount)
  await brick.click()
  await page.waitForSelector('.automation-board', { timeout: 30000 })
  console.log('board card created in UI')

  const compose = page.locator('.automation-board-lane-compose textarea').first()
  await compose.waitFor({ state: 'visible', timeout: 20000 })
  await compose.fill(requirement)
  await compose.press('Enter')
  await page.locator('.automation-board-item').first().waitFor({ state: 'visible', timeout: 30000 })
  console.log('item added in UI')

  if (settleMs > 0) {
    const deadline = Date.now() + settleMs
    for (;;) {
      const board = findBoard(await readState())
      const items = board?.card.automationBoard?.items?.length ?? 0
      if (board && items === 1) {
        console.log('state.json caught up: board card + 1 item')
        break
      }
      if (Date.now() > deadline) {
        console.log(`!! state.json never caught up: boardCard=${Boolean(board)} items=${items}`)
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  } else {
    const board = findBoard(await readState())
    console.log('no settle wait; disk right now -> board:', Boolean(board), '| items:', board?.card.automationBoard?.items?.length ?? 0)
  }
} finally {
  if (mode === 'kill') {
    // 模拟被 Windows 收尸 / 强杀：不给渲染层任何 flush 机会。
    const pid = first.process().pid
    process.kill(pid, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 3000))
  } else {
    await first.close()
  }
}

await new Promise((r) => setTimeout(r, 2000))

const afterClose = findBoard(await readState())
console.log('after close  -> board card on disk:', Boolean(afterClose), '| items:', afterClose?.card.automationBoard?.items?.length ?? 0)

const second = await launch()
try {
  const page = await second.firstWindow()
  const board = await page.locator('.automation-board').first()
  let visible = false
  try {
    await board.waitFor({ state: 'visible', timeout: 30000 })
    visible = true
  } catch {
    visible = false
  }
  const itemCount = visible ? await page.locator('.automation-board-item').count() : 0
  console.log('after restart -> board visible:', visible, '| items visible:', itemCount)
  console.log(visible && itemCount === 1 ? 'RESULT: SURVIVED' : 'RESULT: WIPED')
} finally {
  await second.close()
}
