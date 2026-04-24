import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { _electron as electron, type Page } from '@playwright/test'

import { createDefaultState, createPane } from '../shared/default-state.ts'
import { GIT_TOOL_MODEL } from '../shared/models.ts'
import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

const tempRoots: string[] = []

const waitForGitToolCard = async (page: Page) => {
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    return typeof window.electronAPI !== 'undefined' && (root?.childElementCount ?? 0) > 0
  }, undefined, {
    timeout: 30000,
  })

  await page.locator('.git-tool-card').first().waitFor({
    state: 'visible',
    timeout: 45000,
  })
}

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

const createLargeChangedRepo = async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'chill-vibe-git-stage-perf-'))
  tempRoots.push(repoPath)

  await runGit(repoPath, ['init', '--initial-branch=main'])
  await runGit(repoPath, ['config', 'user.name', 'Chill Vibe Tests'])
  await runGit(repoPath, ['config', 'user.email', 'tests@example.com'])

  for (let index = 1; index <= 120; index += 1) {
    const fileName = `file-${String(index).padStart(3, '0')}.ts`
    const baseContent = Array.from({ length: 30 }, (_, lineIndex) => `export const value_${index}_${lineIndex} = ${lineIndex}`)
      .join('\n')
    await writeFile(path.join(repoPath, fileName), `${baseContent}\n`, 'utf8')
  }

  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-m', 'Initial commit'])

  for (let index = 1; index <= 120; index += 1) {
    const fileName = `file-${String(index).padStart(3, '0')}.ts`
    const updatedContent = Array.from(
      { length: 30 },
      (_, lineIndex) => `export const value_${index}_${lineIndex} = ${lineIndex} // changed ${index}`,
    ).join('\n')
    await writeFile(path.join(repoPath, fileName), `${updatedContent}\n`, 'utf8')
  }

  return repoPath
}

const createTempStateDir = async (workspacePath: string) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-git-stage-perf-state-'))
  tempRoots.push(dataDir)

  const state = createDefaultState(workspacePath, 'en')
  state.settings.language = 'en'
  state.settings.theme = 'dark'
  state.columns = [
    {
      ...state.columns[0]!,
      id: 'col-git-stage-perf',
      title: 'Git Stage Perf',
      provider: 'codex',
      workspacePath,
      model: 'gpt-5.5',
      width: 520,
      layout: createPane(['card-git-stage-perf'], 'card-git-stage-perf', 'pane-git-stage-perf'),
      cards: {
        'card-git-stage-perf': {
          ...Object.values(state.columns[0]!.cards)[0]!,
          id: 'card-git-stage-perf',
          title: 'Git Stage Perf',
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

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

test('Electron ancient Git checkbox toggles stay responsive while preserving the selected diff', async () => {
  await ensureElectronRuntimeBuild()

  const repoPath = await createLargeChangedRepo()
  const dataDir = await createTempStateDir(repoPath)

  const env = createHeadlessElectronRuntimeEnv({
    VITE_DEV_SERVER_URL: getElectronTestRendererUrl(),
    CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
    CHILL_VIBE_ALLOW_SHARED_DATA_DIR: '1',
    CHILL_VIBE_DATA_DIR: dataDir,
    CHILL_VIBE_DEFAULT_WORKSPACE: repoPath,
  })
  const maxToggleDurationMs = env.CHILL_VIBE_HEADLESS_RUNTIME_TESTS === '1' ? 2500 : 1000

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env,
  })

  try {
    const page = await app.firstWindow()

    await waitForGitToolCard(page)
    await page.waitForFunction(
      () => document.querySelectorAll('.git-dashboard-file-item').length >= 100,
      undefined,
      { timeout: 60000 },
    )

    await page.getByRole('button', { name: 'Full Git' }).click()

    const dialog = page.locator('.structured-preview-dialog.is-git-full')
    await dialog.waitFor({ state: 'visible', timeout: 20000 })
    await page.waitForFunction(
      () => {
        const dialog = document.querySelector('.structured-preview-dialog.is-git-full')
        const rowCount = dialog?.querySelectorAll('.git-change-row').length ?? 0
        const headerText = dialog?.querySelector('.git-change-list-header strong')?.textContent ?? ''
        return rowCount >= 4 && rowCount < 100 && headerText.includes('120')
      },
      undefined,
      { timeout: 60000 },
    )

    const targetNames = await dialog.locator('.git-change-path').evaluateAll((nodes) =>
      nodes.slice(0, 4).map((node) => node.textContent?.trim() ?? ''),
    )

    const selectedFileName = targetNames[0] ?? ''
    assert.ok(selectedFileName.length > 0)

    const selectedRow = dialog.locator('.git-change-row').filter({ hasText: selectedFileName }).first()

    await selectedRow.click()
    await page.waitForFunction(
      (fileName) =>
        document.querySelector('.git-tool-diff-title strong')?.textContent?.trim() === fileName,
      selectedFileName,
      { timeout: 20000 },
    )
    await page.waitForTimeout(1500)

    const toggleDurations: number[] = []

    for (const targetFileName of targetNames.slice(1)) {
      assert.ok(targetFileName.length > 0)

      const targetRow = dialog.locator('.git-change-row').filter({ hasText: targetFileName }).first()
      const checkbox = targetRow.locator('.git-change-checkbox')

      const startedAt = Date.now()
      await checkbox.click()
      await page.waitForFunction(
        ({ targetFileName: expectedChecked }) => {
          const targetRow = Array.from(document.querySelectorAll('.git-change-row')).find((row) =>
            row.querySelector('.git-change-path')?.textContent?.trim() === expectedChecked,
          )
          const checkbox = targetRow?.querySelector('.git-change-checkbox')

          return checkbox instanceof HTMLInputElement && checkbox.checked
        },
        { targetFileName },
        { timeout: 10000 },
      )
      toggleDurations.push(Date.now() - startedAt)

      await page.waitForFunction(
        ({ selectedFileName: expectedSelected, selectedDiffToken }) => {
          const selectedTitle = document.querySelector('.git-tool-diff-title strong')?.textContent?.trim()
          const hasSelectedDiff = Array.from(document.querySelectorAll('.git-tool-diff-code')).some((node) =>
            node.textContent?.includes(selectedDiffToken),
          )

          return selectedTitle === expectedSelected && hasSelectedDiff
        },
        { selectedFileName, selectedDiffToken: 'changed 1' },
        { timeout: 10000 },
      )
    }

    assert.equal(toggleDurations.length, 3)
    assert.ok(
      toggleDurations.every((duration) => duration < maxToggleDurationMs),
      `expected every checkbox toggle to finish within ${maxToggleDurationMs}ms, got ${toggleDurations.join(', ')}ms`,
    )
  } finally {
    await app.close()
  }
})
