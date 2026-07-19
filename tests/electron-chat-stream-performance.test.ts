import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { _electron as electron, type Page } from '@playwright/test'

import type { AppState } from '../shared/schema.ts'
import {
  chatStreamStressCardCount,
  chatStreamStressHeartbeatIntervalMs,
  chatStreamStressInteractionIntervalMs,
  createChatStreamStressState,
  getPercentile,
} from './chat-stream-performance-fixture.ts'
import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const durationMs = Math.max(
  10_000,
  Number.parseInt(process.env.CHILL_VIBE_CHAT_STRESS_DURATION_MS ?? '300000', 10),
)
const keepStressArtifacts = process.env.CHILL_VIBE_KEEP_CHAT_STRESS_ARTIFACTS === '1'
const tempRoots: string[] = []

type StressMetrics = {
  startupMs: number
  heartbeatMaxGapMs: number
  heartbeatP95GapMs: number
  frameMaxGapMs: number
  frameP95GapMs: number
  inputP95Ms: number
  focusP95Ms: number
  tabSwitchP95Ms: number
  inputSampleCount: number
  focusSampleCount: number
  tabSwitchSampleCount: number
  mountedStructuredItemCount: number
  maxMountedItemsPerGroup: number
  interactionError: string | null
  unresponsiveCount: number
  responsiveCount: number
  rendererGoneCount: number
  mainWorkingSetKb: number
}

const createFakeCodexBin = async () => {
  const fakeBin = await mkdtemp(path.join(tmpdir(), 'chill-vibe-chat-stress-bin-'))
  tempRoots.push(fakeBin)

  await copyFile(
    path.join(testDir, 'fixtures', 'fake-codex-chat-stress.cjs'),
    path.join(fakeBin, 'fake-codex-chat-stress.cjs'),
  )
  await writeFile(
    path.join(fakeBin, 'codex.cmd'),
    '@ECHO off\r\nnode "%dp0%\\fake-codex-chat-stress.cjs" %*\r\n',
    'utf8',
  )

  return fakeBin
}

const createStressDataDir = async (workspacePath: string) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-chat-stress-state-'))
  tempRoots.push(dataDir)
  const runtimeProfileRoot = path.join(dataDir, 'runtime-profile')

  const initialState = createChatStreamStressState(workspacePath)
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'state.json'), `${JSON.stringify(initialState, null, 2)}\n`, 'utf8')

  return { dataDir, initialState, runtimeProfileRoot }
}

const countLogMatches = (body: string, text: string) => body.split(text).length - 1

const waitForBoardReady = async (page: Page) => {
  await page.waitForFunction(
    (expectedColumnCount) => {
      const root = document.getElementById('root')
      return (
        typeof window.electronAPI !== 'undefined' &&
        (root?.childElementCount ?? 0) > 0 &&
        document.querySelectorAll('.workspace-column').length === expectedColumnCount &&
        document.querySelectorAll('.pane-tab-panel.is-active textarea.control.textarea').length === expectedColumnCount
      )
    },
    chatStreamStressCardCount,
    { timeout: 90_000 },
  )
}

const installHeartbeatProbe = async (page: Page) => {
  await page.evaluate((intervalMs) => {
    const target = window as typeof window & {
      __chillVibeChatStressProbe?: {
        gaps: number[]
        lastAt: number
        maxGapMs: number
        frameGaps: number[]
        lastFrameAt: number
        maxFrameGapMs: number
        maxMountedStructuredItemCount: number
        maxMountedItemsPerGroup: number
      }
    }
    const now = performance.now()
    target.__chillVibeChatStressProbe = {
      gaps: [],
      lastAt: now,
      maxGapMs: 0,
      frameGaps: [],
      lastFrameAt: now,
      maxFrameGapMs: 0,
      maxMountedStructuredItemCount: 0,
      maxMountedItemsPerGroup: 0,
    }

    target.__chillVibeChatStressProbe.maxMountedStructuredItemCount =
      document.querySelectorAll('.structured-command-inline-row').length
    target.__chillVibeChatStressProbe.maxMountedItemsPerGroup = Math.max(
      0,
      ...Array.from(document.querySelectorAll('.structured-command-group')).map(
        (group) => group.querySelectorAll('.structured-command-inline-row').length,
      ),
    )

    window.setInterval(() => {
      const probe = target.__chillVibeChatStressProbe
      if (!probe) return

      const groupCounts = Array.from(document.querySelectorAll('.structured-command-group')).map(
        (group) => group.querySelectorAll('.structured-command-inline-row').length,
      )
      probe.maxMountedStructuredItemCount = Math.max(
        probe.maxMountedStructuredItemCount,
        document.querySelectorAll('.structured-command-inline-row').length,
      )
      probe.maxMountedItemsPerGroup = Math.max(
        probe.maxMountedItemsPerGroup,
        ...groupCounts,
      )
    }, 250)

    window.setInterval(() => {
      const probe = target.__chillVibeChatStressProbe
      if (!probe) return

      const tickAt = performance.now()
      const gap = tickAt - probe.lastAt
      probe.lastAt = tickAt
      probe.maxGapMs = Math.max(probe.maxGapMs, gap)
      probe.gaps.push(gap)
      if (probe.gaps.length > 20_000) {
        probe.gaps.splice(0, probe.gaps.length - 20_000)
      }
    }, intervalMs)

    window.setInterval(() => {
      requestAnimationFrame((frameAt) => {
        const probe = target.__chillVibeChatStressProbe
        if (!probe || frameAt <= probe.lastFrameAt) return

        const gap = frameAt - probe.lastFrameAt
        probe.lastFrameAt = frameAt
        probe.maxFrameGapMs = Math.max(probe.maxFrameGapMs, gap)
        probe.frameGaps.push(gap)
        if (probe.frameGaps.length > 20_000) {
          probe.frameGaps.splice(0, probe.frameGaps.length - 20_000)
        }
      })
    }, intervalMs)
  }, chatStreamStressHeartbeatIntervalMs)
}

const startAllStreams = async (page: Page) => {
  const columns = page.locator('.workspace-column')

  for (let index = 0; index < chatStreamStressCardCount; index += 1) {
    const textarea = columns
      .nth(index)
      .locator('.pane-tab-panel.is-active textarea.control.textarea')
    await textarea.fill(`Start deterministic stress stream ${index + 1}.`)
    await textarea.press('Enter')
  }

  await page.waitForFunction(
    (expectedCount) => document.querySelectorAll('.card-shell.is-streaming').length === expectedCount,
    chatStreamStressCardCount,
    { timeout: 60_000 },
  )
}

const runInteractions = async (page: Page) => {
  const inputDurations: number[] = []
  const focusDurations: number[] = []
  const tabSwitchDurations: number[] = []
  const columns = page.locator('.workspace-column')
  const deadline = Date.now() + durationMs
  let cycle = 0
  let revealedOlderActivity = false

  while (Date.now() < deadline) {
    const columnIndex = cycle % chatStreamStressCardCount
    const column = columns.nth(columnIndex)

    const focusResult = await page.evaluate(async (targetColumnIndex) => {
      const startedAt = performance.now()
      const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
      const textarea = targetColumn?.querySelector<HTMLTextAreaElement>(
        '.pane-tab-panel.is-active textarea.control.textarea',
      )
      textarea?.focus()
      textarea?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      return {
        focused: Boolean(textarea && document.activeElement === textarea),
        durationMs: performance.now() - startedAt,
      }
    }, columnIndex)
    assert.equal(focusResult.focused, true)
    focusDurations.push(focusResult.durationMs)

    const nextDraft = `性能交互 ${cycle + 1}：中文输入保持可用`
    const inputResult = await page.evaluate(async ({ targetColumnIndex, value }) => {
      const startedAt = performance.now()
      const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
      const textarea = targetColumn?.querySelector<HTMLTextAreaElement>(
        '.pane-tab-panel.is-active textarea.control.textarea',
      )
      if (!textarea) return null

      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set
      valueSetter?.call(textarea, value)
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: value,
        inputType: 'insertText',
      }))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      return {
        value: textarea.value,
        durationMs: performance.now() - startedAt,
      }
    }, { targetColumnIndex: columnIndex, value: nextDraft })
    assert.equal(inputResult?.value, nextDraft)
    inputDurations.push(inputResult?.durationMs ?? Number.POSITIVE_INFINITY)

    const messageList = column.locator('.pane-tab-panel.is-active .message-list').first()
    if (await messageList.isVisible()) {
      await messageList.evaluate((node) => {
        node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 240)
        node.dispatchEvent(new Event('scroll', { bubbles: true }))
      })
    }

    if (cycle % 3 === 0) {
      const toggled = await page.evaluate((targetColumnIndex) => {
        const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
        const toggle = targetColumn?.querySelector<HTMLElement>(
          '.pane-tab-panel.is-active .structured-group-summary-row',
        )
        toggle?.click()
        return Boolean(toggle)
      }, columnIndex)
      if (toggled) {
        await page.waitForTimeout(30)
        await page.evaluate((targetColumnIndex) => {
          const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
          targetColumn
            ?.querySelector<HTMLElement>('.pane-tab-panel.is-active .structured-group-summary-row')
            ?.click()
        }, columnIndex)
      }
    }

    if (!revealedOlderActivity) {
      revealedOlderActivity = await page.evaluate((targetColumnIndex) => {
        const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
        const revealButton = targetColumn?.querySelector<HTMLButtonElement>(
          '.pane-tab-panel.is-active .structured-group-reveal-button',
        )
        revealButton?.click()
        return Boolean(revealButton)
      }, columnIndex)
    }

    if (cycle % 4 === 0) {
      const standbyTitle = `Standby ${columnIndex + 1}`
      const streamTitle = `Stream ${columnIndex + 1}`
      const tabSwitchStartedAt = Date.now()
      const clickedStandby = await page.evaluate(({ targetColumnIndex, title }) => {
        const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
        if (!targetColumn) return false

        const tabs = targetColumn.querySelectorAll<HTMLButtonElement>('.pane-tab')
        for (let tabIndex = 0; tabIndex < tabs.length; tabIndex += 1) {
          const tab = tabs.item(tabIndex)
          if (tab.textContent?.trim() === title) {
            tab.click()
            return true
          }
        }
        return false
      }, { targetColumnIndex: columnIndex, title: standbyTitle })
      assert.equal(clickedStandby, true)
      await page.waitForFunction(
        ({ targetColumnIndex, title }) =>
          document.querySelectorAll('.workspace-column').item(targetColumnIndex)
            ?.querySelector('.pane-tab.is-active')?.textContent?.trim() === title,
        { targetColumnIndex: columnIndex, title: standbyTitle },
        { timeout: 5_000 },
      )
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

      const clickedStream = await page.evaluate(({ targetColumnIndex, title }) => {
        const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
        if (!targetColumn) return false

        const tabs = targetColumn.querySelectorAll<HTMLButtonElement>('.pane-tab')
        for (let tabIndex = 0; tabIndex < tabs.length; tabIndex += 1) {
          const tab = tabs.item(tabIndex)
          if (tab.textContent?.trim() === title) {
            tab.click()
            return true
          }
        }
        return false
      }, { targetColumnIndex: columnIndex, title: streamTitle })
      assert.equal(clickedStream, true)
      await page.waitForFunction(
        ({ targetColumnIndex, title }) =>
          document.querySelectorAll('.workspace-column').item(targetColumnIndex)
            ?.querySelector('.pane-tab.is-active')?.textContent?.trim() === title,
        { targetColumnIndex: columnIndex, title: streamTitle },
        { timeout: 5_000 },
      )
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      tabSwitchDurations.push(Date.now() - tabSwitchStartedAt)
    }

    cycle += 1
    const remainingMs = deadline - Date.now()
    if (remainingMs > 0) {
      await page.waitForTimeout(Math.min(chatStreamStressInteractionIntervalMs, remainingMs))
    }
  }

  return { focusDurations, inputDurations, tabSwitchDurations }
}

const assertPersistedMessagesRemainComplete = (
  initialState: AppState,
  persistedState: AppState,
) => {
  for (let index = 0; index < chatStreamStressCardCount; index += 1) {
    const cardId = `card-chat-stress-${index + 1}`
    const initialCard = initialState.columns[index]?.cards[cardId]
    const persistedCard = persistedState.columns[index]?.cards[cardId]

    assert.ok(initialCard, `missing initial stress card ${cardId}`)
    assert.ok(persistedCard, `missing persisted stress card ${cardId}`)

    // Startup normalization deliberately pre-trims oversized live-card arrays
    // to 300 messages before schema validation. The gate proves that every
    // message which entered the renderer survives this optimization slice; it
    // does not redefine that older persistence policy.
    const initialIds = initialCard.messages.slice(-300).map((message) => message.id)
    const persistedIds = persistedCard.messages.map((message) => message.id)
    const duplicateIds = persistedIds.filter(
      (messageId, messageIndex) => persistedIds.indexOf(messageId) !== messageIndex,
    )
    assert.deepEqual(
      duplicateIds,
      [],
      `${cardId} persisted duplicate message ids: ${JSON.stringify(duplicateIds)}`,
    )
    assert.ok(
      persistedIds.length > initialIds.length,
      `${cardId} did not persist newly streamed messages`,
    )

    let lastIndex = -1
    for (const messageId of initialIds) {
      const persistedIndex = persistedIds.indexOf(messageId)
      assert.ok(persistedIndex > lastIndex, `${cardId} lost or reordered ${messageId}`)
      lastIndex = persistedIndex
    }
  }
}

after(async () => {
  if (keepStressArtifacts) {
    console.log(`CHAT_STREAM_STRESS_ARTIFACTS ${JSON.stringify(tempRoots)}`)
    return
  }

  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

test('six simultaneous Electron chat streams stay responsive and persist complete ordered data', async () => {
  await ensureElectronRuntimeBuild()

  const workspacePath = process.cwd()
  const fakeBin = await createFakeCodexBin()
  const { dataDir, initialState, runtimeProfileRoot } = await createStressDataDir(workspacePath)
  const startupStartedAt = Date.now()
  const env = createHeadlessElectronRuntimeEnv({
    VITE_DEV_SERVER_URL: getElectronTestRendererUrl(),
    CHILL_VIBE_OFFSCREEN_RUNTIME_TESTS: '1',
    CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
    CHILL_VIBE_ALLOW_SHARED_DATA_DIR: '1',
    CHILL_VIBE_DATA_DIR: dataDir,
    CHILL_VIBE_RUNTIME_PROFILE_ROOT: runtimeProfileRoot,
    CHILL_VIBE_DEFAULT_WORKSPACE: workspacePath,
    CHILL_VIBE_CHAT_STRESS_DURATION_MS: String(durationMs),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
  })
  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env,
  })

  let startupMs = 0
  let interactionError: string | null = null
  let interactionMetrics = {
    focusDurations: [] as number[],
    inputDurations: [] as number[],
    tabSwitchDurations: [] as number[],
  }
  let rendererMetrics = {
    heartbeatMaxGapMs: Number.POSITIVE_INFINITY,
    heartbeatGaps: [] as number[],
    frameMaxGapMs: Number.POSITIVE_INFINITY,
    frameGaps: [] as number[],
    mountedStructuredItemCount: Number.POSITIVE_INFINITY,
    maxMountedItemsPerGroup: Number.POSITIVE_INFINITY,
  }
  let mainWorkingSetKb = 0

  try {
    const page = await app.firstWindow()
    await waitForBoardReady(page)
    startupMs = Date.now() - startupStartedAt
    await installHeartbeatProbe(page)
    await startAllStreams(page)

    try {
      interactionMetrics = await runInteractions(page)
    } catch (error) {
      interactionError = error instanceof Error ? error.stack ?? error.message : String(error)
    }

    rendererMetrics = await page.evaluate(() => {
      const probe = (window as typeof window & {
        __chillVibeChatStressProbe?: {
          gaps: number[]
          maxGapMs: number
          frameGaps: number[]
          maxFrameGapMs: number
          maxMountedStructuredItemCount: number
          maxMountedItemsPerGroup: number
        }
      }).__chillVibeChatStressProbe

      return {
        heartbeatMaxGapMs: probe?.maxGapMs ?? Number.POSITIVE_INFINITY,
        heartbeatGaps: probe?.gaps ?? [],
        frameMaxGapMs: probe?.maxFrameGapMs ?? Number.POSITIVE_INFINITY,
        frameGaps: probe?.frameGaps ?? [],
        mountedStructuredItemCount:
          probe?.maxMountedStructuredItemCount ?? Number.POSITIVE_INFINITY,
        maxMountedItemsPerGroup:
          probe?.maxMountedItemsPerGroup ?? Number.POSITIVE_INFINITY,
      }
    })
    mainWorkingSetKb = await app.evaluate(async () => {
      const memory = await process.getProcessMemoryInfo()
      return memory.private
    })
  } finally {
    await app.close()
  }

  const persistedState = JSON.parse(
    await readFile(path.join(dataDir, 'state.json'), 'utf8'),
  ) as AppState
  const logBody = await readFile(path.join(dataDir, 'logs', 'main.log'), 'utf8').catch(() => '')
  const metrics: StressMetrics = {
    startupMs,
    heartbeatMaxGapMs: rendererMetrics.heartbeatMaxGapMs,
    heartbeatP95GapMs: getPercentile(rendererMetrics.heartbeatGaps, 0.95),
    frameMaxGapMs: rendererMetrics.frameMaxGapMs,
    frameP95GapMs: getPercentile(rendererMetrics.frameGaps, 0.95),
    inputP95Ms: getPercentile(interactionMetrics.inputDurations, 0.95),
    focusP95Ms: getPercentile(interactionMetrics.focusDurations, 0.95),
    tabSwitchP95Ms: getPercentile(interactionMetrics.tabSwitchDurations, 0.95),
    inputSampleCount: interactionMetrics.inputDurations.length,
    focusSampleCount: interactionMetrics.focusDurations.length,
    tabSwitchSampleCount: interactionMetrics.tabSwitchDurations.length,
    mountedStructuredItemCount: rendererMetrics.mountedStructuredItemCount,
    maxMountedItemsPerGroup: rendererMetrics.maxMountedItemsPerGroup,
    interactionError,
    unresponsiveCount: countLogMatches(logBody, 'BrowserWindow became unresponsive.'),
    responsiveCount: countLogMatches(logBody, 'BrowserWindow became responsive again.'),
    rendererGoneCount: countLogMatches(logBody, 'Renderer process gone.'),
    mainWorkingSetKb,
  }

  console.log(`CHAT_STREAM_STRESS_METRICS ${JSON.stringify(metrics)}`)

  assertPersistedMessagesRemainComplete(initialState, persistedState)
  assert.equal(metrics.interactionError, null, metrics.interactionError ?? undefined)
  assert.equal(metrics.unresponsiveCount, 0, `renderer became unresponsive: ${JSON.stringify(metrics)}`)
  assert.equal(metrics.rendererGoneCount, 0, `renderer process exited: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.inputSampleCount >= 2, `too few input samples: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.focusSampleCount >= 2, `too few focus samples: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.tabSwitchSampleCount >= 1, `too few tab switch samples: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.startupMs < 30_000, `startup exceeded 30s: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.heartbeatMaxGapMs < 2_000, `heartbeat stalled for 2s: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.heartbeatMaxGapMs < 500, `heartbeat missed the 500ms target: ${JSON.stringify(metrics)}`)
  // Offscreen validation consumes paint frames at 15 fps. Interaction metrics
  // above wait for the next frame so they cover visible feedback rather than
  // only synchronous DOM mutation.
  assert.ok(metrics.frameMaxGapMs < 2_000, `rendering stalled for 2s: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.inputP95Ms < 100, `input p95 exceeded 100ms: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.focusP95Ms < 150, `focus p95 exceeded 150ms: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.tabSwitchP95Ms < 500, `tab switch p95 exceeded 500ms: ${JSON.stringify(metrics)}`)
  assert.ok(
    metrics.maxMountedItemsPerGroup <= 120,
    `a structured group mounted an unbounded activity list: ${JSON.stringify(metrics)}`,
  )
})
