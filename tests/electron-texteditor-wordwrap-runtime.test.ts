import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { _electron as electron } from '@playwright/test'

import { createDefaultState, createPane } from '../shared/default-state.ts'
import { TEXTEDITOR_TOOL_MODEL } from '../shared/models.ts'
import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

const tempRoots: string[] = []

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

// Mixed CJK + ASCII + spaces mirrors real review notes. The spaces matter:
// under zh-CN Chromium the bare `monospace` family maps to a font whose space
// glyph is fullwidth, so Monaco's simple wrapping budget underestimated line
// width and wrapped lines overflowed the viewport sideways (ghost horizontal
// scrollbar). This spec pins the fixed behavior in a real Electron runtime.
const LONG_MIXED_LINES = Array.from({ length: 40 }, (_, index) =>
  `${index + 1}. **模块审查发现 ${index + 1}** — \`SomeSystem.cs:${100 + index}\` 的 Flush 在异常路径没有回滚，`
  + '错误返回时战利品已入包 pending 已清，同帧其余 systems 的 foreach 会被穿透，'
  + 'and the retry loop replays the same patch batch every frame until restart.',
).join('\n')

test('Electron zh-CN runtime: word wrap keeps long CJK markdown inside the viewport', async () => {
  await ensureElectronRuntimeBuild()

  const workspacePath = await mkdtemp(path.join(tmpdir(), 'chill-vibe-wrap-ws-'))
  tempRoots.push(workspacePath)
  await writeFile(path.join(workspacePath, 'review.md'), `${LONG_MIXED_LINES}\n`, 'utf8')

  const dataDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-wrap-state-'))
  tempRoots.push(dataDir)

  const state = createDefaultState(workspacePath, 'zh-CN')
  state.settings.language = 'zh-CN'
  state.settings.theme = 'dark'
  state.settings.editor = { fontSize: 13, wordWrap: true, minimap: false, tabSize: 2 }

  const baseCard = Object.values(state.columns[0]!.cards)[0]!
  const editorCard = {
    ...baseCard,
    id: 'card-editor',
    title: 'review.md',
    model: TEXTEDITOR_TOOL_MODEL,
    stickyNote: 'review.md',
    messages: [],
    status: 'idle' as const,
  }
  state.columns = [
    {
      ...state.columns[0]!,
      id: 'col-editor',
      title: 'Wrap Probe',
      workspacePath,
      width: 900,
      layout: createPane(['card-editor'], 'card-editor', 'pane-editor'),
      cards: { 'card-editor': editorCard },
    },
  ]
  state.updatedAt = new Date().toISOString()

  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: createHeadlessElectronRuntimeEnv({
      VITE_DEV_SERVER_URL: getElectronTestRendererUrl(),
      CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
      CHILL_VIBE_ALLOW_SHARED_DATA_DIR: '1',
      CHILL_VIBE_DATA_DIR: dataDir,
      CHILL_VIBE_DEFAULT_WORKSPACE: workspacePath,
    }),
  })

  try {
    const page = await app.firstWindow()
    await page.waitForSelector('.text-editor-card .monaco-editor .view-lines', { timeout: 30000 })
    // Let wrapping/layout settle after fonts load.
    await page.waitForTimeout(2000)

    const probe = await page.evaluate(() => {
      const surface = document.querySelector('.text-editor-surface .monaco-editor')
      if (!surface) {
        return null
      }
      const viewLines = surface.querySelector<HTMLElement>('.view-lines')
      const lineSpans = [...surface.querySelectorAll<HTMLElement>('.view-line > span')]
      const maxLineWidth = lineSpans.length
        ? Math.max(...lineSpans.map((s) => s.getBoundingClientRect().width))
        : 0
      const horizontalTrack = surface.querySelector<HTMLElement>('.scrollbar.horizontal')
      const horizontalSlider = surface.querySelector<HTMLElement>('.scrollbar.horizontal .slider')
      return {
        viewLinesClientWidth: viewLines?.clientWidth ?? 0,
        maxLineWidth,
        lineCountSampled: lineSpans.length,
        horizontalTrackWidth: horizontalTrack?.getBoundingClientRect().width ?? 0,
        horizontalSliderWidth: horizontalSlider?.getBoundingClientRect().width ?? 0,
      }
    })

    console.log('[electron-wrap-probe]', JSON.stringify(probe))
    assert.ok(probe, 'expected a mounted Monaco editor')
    assert.ok(probe.lineCountSampled > 0, 'expected rendered lines to sample')
    assert.ok(
      probe.maxLineWidth <= probe.viewLinesClientWidth + 1,
      `horizontal overflow: widest rendered line ${probe.maxLineWidth}px > visible content ${probe.viewLinesClientWidth}px`,
    )
    // No horizontal scroll range may exist: a slider narrower than its track
    // reads as "this can scroll sideways" even when every line is wrapped.
    assert.ok(
      probe.horizontalTrackWidth === 0 ||
        probe.horizontalSliderWidth === 0 ||
        probe.horizontalSliderWidth >= probe.horizontalTrackWidth - 1,
      `ghost horizontal scrollbar: slider ${probe.horizontalSliderWidth}px < track ${probe.horizontalTrackWidth}px`,
    )
  } finally {
    await app.close()
  }
})
