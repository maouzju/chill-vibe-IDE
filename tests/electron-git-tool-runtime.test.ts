import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { _electron as electron, type Locator } from '@playwright/test'

import { createDefaultState, createPane } from '../shared/default-state.ts'
import { GIT_TOOL_MODEL } from '../shared/models.ts'

const tempRoots: string[] = []

const runGit = async (cwd: string, args: string[]) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(stderr.trim() || `git ${args.join(' ')} failed with code ${code}`))
    })
  })
}

const readRect = async (locator: Locator) =>
  locator.evaluate((node: Element) => {
    const rect = node.getBoundingClientRect()

    return {
      top: rect.top,
      bottom: rect.bottom,
    }
  })

const createTempRepo = async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'chill-vibe-electron-git-'))
  tempRoots.push(repoPath)

  await runGit(repoPath, ['init', '--initial-branch=main'])
  await runGit(repoPath, ['config', 'user.name', 'Chill Vibe Tests'])
  await runGit(repoPath, ['config', 'user.email', 'tests@example.com'])

  await writeFile(path.join(repoPath, 'AGENTS.md'), '# Initial\n')
  await writeFile(path.join(repoPath, 'package.json'), '{\n  "name": "git-runtime-smoke"\n}\n')
  await writeFile(path.join(repoPath, 'README.md'), '# Initial\n')
  await runGit(repoPath, ['add', 'AGENTS.md', 'package.json', 'README.md'])
  await runGit(repoPath, ['commit', '-m', 'Initial commit'])

  await writeFile(path.join(repoPath, 'AGENTS.md'), '# Updated\n')
  await writeFile(path.join(repoPath, 'package.json'), '{\n  "name": "git-runtime-smoke",\n  "private": true\n}\n')
  await writeFile(path.join(repoPath, 'README.md'), '# Updated\n')

  return repoPath
}

const createTempStateDir = async (workspacePath: string) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-electron-state-'))
  tempRoots.push(dataDir)

  const state = createDefaultState(workspacePath, 'zh-CN')
  state.settings.language = 'zh-CN'
  state.settings.theme = 'light'
  state.settings.fontScale = 1.35
  state.columns = [
    {
      ...state.columns[0]!,
      id: 'col-1',
      title: 'Git Smoke',
      provider: 'codex',
      workspacePath,
      model: 'gpt-5.4',
      width: 460,
      layout: createPane(['card-1'], 'card-1', 'pane-git'),
      cards: {
        'card-1': {
          ...Object.values(state.columns[0]!.cards)[0]!,
          id: 'card-1',
          title: 'Git Smoke',
          provider: 'codex',
          model: GIT_TOOL_MODEL,
          reasoningEffort: 'medium',
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

  return dataDir
}

const createHeavyPaneStateDir = async (workspacePath: string) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-electron-heavy-state-'))
  tempRoots.push(dataDir)

  const state = createDefaultState(workspacePath, 'zh-CN')
  state.settings.language = 'zh-CN'
  state.settings.theme = 'dark'

  const baseCard = Object.values(state.columns[0]!.cards)[0]!
  const createMessages = (cardId: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${cardId}-message-${index + 1}`,
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `heavy message ${index + 1} ${'x'.repeat(220)}`,
      createdAt: new Date(Date.UTC(2026, 3, 12, 0, 0, index)).toISOString(),
    }))

  const cards = [
    {
      ...baseCard,
      id: 'card-heavy-1',
      title: '闪退排查 1',
      status: 'streaming' as const,
      messages: createMessages('card-heavy-1', 435),
    },
    {
      ...baseCard,
      id: 'card-heavy-2',
      title: '闪退排查 2',
      status: 'idle' as const,
      messages: createMessages('card-heavy-2', 243),
    },
    {
      ...baseCard,
      id: 'card-heavy-3',
      title: '闪退排查 3',
      status: 'idle' as const,
      messages: createMessages('card-heavy-3', 71),
    },
    {
      ...baseCard,
      id: 'card-heavy-4',
      title: '闪退排查 4',
      status: 'idle' as const,
      messages: createMessages('card-heavy-4', 69),
    },
    {
      ...baseCard,
      id: 'card-heavy-5',
      title: '闪退排查 5',
      status: 'idle' as const,
      messages: createMessages('card-heavy-5', 46),
    },
    {
      ...baseCard,
      id: 'card-heavy-empty',
      title: '空白新会话',
      status: 'idle' as const,
      messages: [],
      draft: '',
    },
  ]

  state.columns = [
    {
      ...state.columns[0]!,
      id: 'col-heavy',
      title: 'Heavy Pane',
      provider: 'codex',
      workspacePath,
      model: 'gpt-5.4',
      layout: createPane(cards.map((card) => card.id), 'card-heavy-1', 'pane-heavy'),
      cards: Object.fromEntries(cards.map((card) => [card.id, card])),
    },
  ]
  state.updatedAt = new Date().toISOString()

  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')

  return dataDir
}

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

const createElectronRuntimeEnv = (dataDir: string, repoPath: string) => {
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      VITE_DEV_SERVER_URL: 'http://localhost:5173',
      CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
      CHILL_VIBE_ALLOW_SHARED_DATA_DIR: '1',
      CHILL_VIBE_DATA_DIR: dataDir,
      CHILL_VIBE_DEFAULT_WORKSPACE: repoPath,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )

  delete env.ELECTRON_RUN_AS_NODE

  return env
}

const filterIgnorableConsoleMessages = (messages: string[]) =>
  messages.filter(
    (message) =>
      !message.includes('Electron Security Warning (Insecure Content-Security-Policy)') &&
      !message.includes('Failed to load resource: the server responded with a status of 404'),
  )

test('Electron runtime honors explicit data dir overrides for a persisted Git tool card', async () => {
  const repoPath = await createTempRepo()
  const dataDir = await createTempStateDir(repoPath)

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: createElectronRuntimeEnv(dataDir, repoPath),
  })

  try {
    const page = await app.firstWindow()
    await page.waitForSelector('.git-tool-card', { timeout: 20000 })
    await page.getByRole('button', { name: /\u53e4\u6cd5 Git/ }).click()

    const fullDialog = page.locator('.structured-preview-dialog.is-git-full')
    await fullDialog.waitFor({ state: 'visible', timeout: 20000 })
    await page.waitForFunction(
      () => document.querySelectorAll('.structured-preview-dialog.is-git-full .git-change-path').length === 3,
      undefined,
      { timeout: 20000 },
    )

    const expectedRepoName = repoPath.split(/[\\/]/).filter(Boolean).at(-1)
    const dialogTitle = (await fullDialog.locator('.structured-preview-title').first().textContent())?.trim() ?? ''
    const changePaths = await fullDialog.locator('.git-change-path').allTextContents()
    const changeListRect = await readRect(fullDialog.locator('.git-change-list').first())
    const commitPanelRect = await readRect(fullDialog.locator('.git-commit-panel').first())

    assert.ok(expectedRepoName)
    assert.match(dialogTitle, new RegExp(expectedRepoName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.deepEqual(changePaths, ['AGENTS.md', 'package.json', 'README.md'])
    assert.ok(commitPanelRect.top >= changeListRect.bottom - 1)
  } finally {
    await app.close()
  }
})

test('Electron runtime opens the Git analysis panel without React render-phase warnings', async () => {
  const repoPath = await createTempRepo()
  const dataDir = await createTempStateDir(repoPath)

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: createElectronRuntimeEnv(dataDir, repoPath),
  })

  try {
    const page = await app.firstWindow()
    const consoleMessages: string[] = []

    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        consoleMessages.push(message.text())
      }
    })

    await page.waitForSelector('.git-tool-card', { timeout: 20000 })
    await page.locator('.git-dashboard-actions-inline .git-tool-button').nth(1).click()

    const agentPanel = page.locator('.git-agent-panel-shell')
    await agentPanel.waitFor({ state: 'visible', timeout: 20000 })
    await page.waitForTimeout(300)

    assert.deepEqual(
      filterIgnorableConsoleMessages(consoleMessages).filter((message) =>
        message.includes('Cannot update a component'),
      ),
      [],
    )
  } finally {
    await app.close()
  }
})

test('Electron runtime keeps heavy pane tab switches responsive without renderer errors', async () => {
  const repoPath = await createTempRepo()
  const dataDir = await createHeavyPaneStateDir(repoPath)

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: createElectronRuntimeEnv(dataDir, repoPath),
  })

  try {
    const page = await app.firstWindow()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => {
      pageErrors.push(error.message)
    })

    const titles = ['闪退排查 1', '闪退排查 2', '闪退排查 3', '闪退排查 4', '闪退排查 5', '空白新会话']

    for (const title of titles) {
      await page.getByRole('button', { name: title, exact: true }).click()
      await page.locator('.pane-tab.is-active').filter({ hasText: title }).waitFor({ timeout: 15000 })
      await page.waitForTimeout(150)
    }

    const textarea = page.locator('.pane-tab-panel.is-active .textarea')
    await textarea.waitFor({ timeout: 15000 })
    await textarea.fill('still responsive after heavy tab switching')
    assert.equal(await textarea.inputValue(), 'still responsive after heavy tab switching')
    assert.deepEqual(
      pageErrors.filter((message) =>
        message.includes('Maximum update depth exceeded') || message.includes('Minified React error #185'),
      ),
      [],
    )
  } finally {
    await app.close()
  }
})
