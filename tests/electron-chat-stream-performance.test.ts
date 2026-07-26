import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { _electron as electron, type Page } from '@playwright/test'

import type { AppState } from '../shared/schema.ts'
import {
  chatStreamStressColumnCount,
  chatStreamStressConcurrentStreamCount,
  chatStreamStressHeartbeatIntervalMs,
  chatStreamStressInteractionIntervalMs,
  chatStreamStressNewTabIterationCount,
  chatStreamStressStreamsPerColumn,
  chatStreamStressTabsPerPane,
  chatStreamStressVisibleStreamColumnCount,
  createChatStreamStressState,
  getChatStreamStressBackgroundTitle,
  getChatStreamStressForegroundTitle,
  getChatStreamStressRunningCardIds,
  getChatStreamStressRunningTitles,
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
const newTabIterationCount = Math.max(
  1,
  Number.parseInt(
    process.env.CHILL_VIBE_CHAT_STRESS_NEW_TAB_ITERATIONS ??
      String(chatStreamStressNewTabIterationCount),
    10,
  ),
)
const tempRoots: string[] = []

type StressMetrics = {
  startupMs: number
  heartbeatMaxGapMs: number
  heartbeatP95GapMs: number
  frameMaxGapMs: number
  frameP95GapMs: number
  inputP95Ms: number
  focusP95Ms: number
  queuedSendP95Ms: number
  tabSwitchP95Ms: number
  inputSampleCount: number
  focusSampleCount: number
  queuedSendSampleCount: number
  tabSwitchSampleCount: number
  newTabReadyP95Ms: number
  newTabReadyMaxMs: number
  newTabFirstInputP95Ms: number
  newTabFirstInputMaxMs: number
  newTabSampleCount: number
  newTabStallOver2sCount: number
  newTabFocusFailureCount: number
  newTabDraftRoundTripFailureCount: number
  mountedStructuredItemCount: number
  maxMountedItemsPerGroup: number
  mountedTabCount: number
  mountedPanelCount: number
  streamingTabCount: number
  activeStreamingCardCount: number
  interactionError: string | null
  unresponsiveCount: number
  responsiveCount: number
  rendererGoneCount: number
  mainWorkingSetKb: number
}

type NewTabInteractionSample = {
  cardId: string
  draft: string
  readyMs: number
  inputMs: number
  focusFailed: boolean
  draftRoundTripFailed: boolean
  focusFailureDiagnostics: string | null
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
    ({ expectedColumnCount, expectedTabCount }) => {
      const root = document.getElementById('root')
      return (
        typeof window.electronAPI !== 'undefined' &&
        (root?.childElementCount ?? 0) > 0 &&
        document.querySelectorAll('.workspace-column').length === expectedColumnCount &&
        document.querySelectorAll('.pane-tab').length === expectedTabCount &&
        document.querySelectorAll('.pane-tab-panel').length === expectedTabCount &&
        document.querySelectorAll('.pane-tab-panel.is-active textarea.control.textarea').length === expectedColumnCount &&
        document.querySelectorAll('.card-shell').length === expectedColumnCount
      )
    },
    {
      expectedColumnCount: chatStreamStressColumnCount,
      expectedTabCount: chatStreamStressColumnCount * chatStreamStressTabsPerPane,
    },
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

const activatePaneTab = async (page: Page, columnIndex: number, title: string) => {
  const activated = await page.evaluate(({ targetColumnIndex, targetTitle }) => {
    const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
    const tabs = targetColumn?.querySelectorAll<HTMLButtonElement>('.pane-tab') ?? []
    for (const tab of tabs) {
      if (tab.textContent?.trim() === targetTitle) {
        tab.click()
        return true
      }
    }
    return false
  }, { targetColumnIndex: columnIndex, targetTitle: title })
  assert.equal(activated, true, `missing pane tab ${title} in column ${columnIndex + 1}`)

  try {
    await page.waitForFunction(
      ({ targetColumnIndex, targetTitle }) => {
        const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
        return (
          targetColumn?.querySelector('.pane-tab.is-active')?.textContent?.trim() === targetTitle &&
          targetColumn.querySelector('.pane-tab-panel.is-active textarea.control.textarea') !== null
        )
      },
      { targetColumnIndex: columnIndex, targetTitle: title },
      { timeout: 10_000 },
    )
  } catch (error) {
    const diagnostics = await page.evaluate((targetColumnIndex) => {
      const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
      const probe = (window as typeof window & {
        __chillVibeChatStressProbe?: { maxGapMs: number; maxFrameGapMs: number }
      }).__chillVibeChatStressProbe
      return {
        activeTitle: targetColumn?.querySelector('.pane-tab.is-active')?.textContent?.trim() ?? null,
        activeTabId:
          targetColumn?.querySelector('.pane-tab.is-active')?.getAttribute('data-pane-tab-id') ?? null,
        activePanelCount: targetColumn?.querySelectorAll('.pane-tab-panel.is-active').length ?? 0,
        activeTextareaCount:
          targetColumn?.querySelectorAll(
            '.pane-tab-panel.is-active textarea.control.textarea',
          ).length ?? 0,
        tabCount: targetColumn?.querySelectorAll('.pane-tab').length ?? 0,
        streamingTabCount: document.querySelectorAll('.pane-tab.is-streaming').length,
        heartbeatMaxGapMs: probe?.maxGapMs ?? null,
        frameMaxGapMs: probe?.maxFrameGapMs ?? null,
      }
    }, columnIndex).catch(() => null)
    throw new Error(
      `pane tab activation timed out for column ${columnIndex + 1}, title ${title}: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    )
  }
}

const sendActiveStreamPrompt = async (page: Page, columnIndex: number, prompt: string) => {
  const columns = page.locator('.workspace-column')
  const textarea = columns
    .nth(columnIndex)
    .locator('.pane-tab-panel.is-active textarea.control.textarea')
  await textarea.fill(prompt)
  await textarea.press('Enter')
  try {
    await page.waitForFunction(
      (targetColumnIndex) => {
        const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
        return (
          targetColumn?.querySelector('.pane-tab.is-active')?.classList.contains('is-streaming') === true &&
          targetColumn.querySelector<HTMLTextAreaElement>(
            '.pane-tab-panel.is-active textarea.control.textarea',
          )?.value === ''
        )
      },
      columnIndex,
      { timeout: 30_000 },
    )
  } catch (error) {
    const diagnostics = await page.evaluate((targetColumnIndex) => {
      const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
      const activePanel = targetColumn?.querySelector('.pane-tab-panel.is-active')
      const probe = (window as typeof window & {
        __chillVibeChatStressProbe?: { maxGapMs: number; maxFrameGapMs: number }
      }).__chillVibeChatStressProbe
      return {
        activeTitle: targetColumn?.querySelector('.pane-tab.is-active')?.textContent?.trim() ?? null,
        activeTabId:
          targetColumn?.querySelector('.pane-tab.is-active')?.getAttribute('data-pane-tab-id') ?? null,
        activeTabClass: targetColumn?.querySelector('.pane-tab.is-active')?.className ?? null,
        textareaValue:
          activePanel?.querySelector<HTMLTextAreaElement>('textarea.control.textarea')?.value ?? null,
        textareaFocused:
          document.activeElement ===
          activePanel?.querySelector<HTMLTextAreaElement>('textarea.control.textarea'),
        messageCount: activePanel?.querySelectorAll('.message').length ?? 0,
        composerError: activePanel?.querySelector('.composer-attachment-note')?.textContent?.trim() ?? null,
        streamingTabCount: document.querySelectorAll('.pane-tab.is-streaming').length,
        heartbeatMaxGapMs: probe?.maxGapMs ?? null,
        frameMaxGapMs: probe?.maxFrameGapMs ?? null,
      }
    }, columnIndex).catch(() => null)
    throw new Error(
      `sending stress prompt timed out for column ${columnIndex + 1}: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    )
  }
}

const waitForActiveLiveStressOutput = async (page: Page, columnIndex: number) => {
  await page.waitForFunction(
    (targetColumnIndex) => {
      const activePanel = document
        .querySelectorAll('.workspace-column')
        .item(targetColumnIndex)
        ?.querySelector('.pane-tab-panel.is-active')
      const text = activePanel?.textContent ?? ''
      return text.includes('live stress') || text.includes('stream-')
    },
    columnIndex,
    { timeout: 60_000 },
  )
}

const startAllStreams = async (page: Page) => {
  const maxStreamsPerColumn = Math.max(...chatStreamStressStreamsPerColumn)
  for (let streamIndex = 0; streamIndex < maxStreamsPerColumn; streamIndex += 1) {
    const launchedColumnIndexes: number[] = []

    for (let columnIndex = 0; columnIndex < chatStreamStressColumnCount; columnIndex += 1) {
      const cardIndex = columnIndex + 1
      const runningTitle = getChatStreamStressRunningTitles(cardIndex)[streamIndex]
      if (!runningTitle) continue

      await activatePaneTab(page, columnIndex, runningTitle)
      await sendActiveStreamPrompt(
        page,
        columnIndex,
        `Start stress agent ${cardIndex}.${streamIndex + 1}.`,
      )
      launchedColumnIndexes.push(columnIndex)
    }

    await Promise.all(
      launchedColumnIndexes.map((columnIndex) => waitForActiveLiveStressOutput(page, columnIndex)),
    )
  }

  for (let index = 0; index < chatStreamStressColumnCount; index += 1) {
    const cardIndex = index + 1
    await activatePaneTab(page, index, getChatStreamStressForegroundTitle(cardIndex))
  }

  await page.waitForFunction(
    ({ expectedCount, expectedActiveCount }) =>
      document.querySelectorAll('.pane-tab.is-streaming').length === expectedCount &&
      document.querySelectorAll('.card-shell.is-streaming').length === expectedActiveCount,
    {
      expectedCount: chatStreamStressConcurrentStreamCount,
      expectedActiveCount: chatStreamStressVisibleStreamColumnCount,
    },
    { timeout: 60_000 },
  )

  // Starting the last background tab arms the normal composer focus guards.
  // Let those bounded guards expire before measuring steady-state cross-column
  // focus, otherwise setup cleanup can be mistaken for a streaming stall.
  await page.waitForTimeout(2_000)
}

const runInteractions = async (page: Page) => {
  const inputDurations: number[] = []
  const focusDurations: number[] = []
  const queuedSendDurations: number[] = []
  const tabSwitchDurations: number[] = []
  const columns = page.locator('.workspace-column')
  const deadline = Date.now() + durationMs
  let cycle = 0
  let revealedOlderActivity = false
  const queuedColumns = new Set<number>()

  while (Date.now() < deadline) {
    const columnIndex = cycle % chatStreamStressColumnCount
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

    if (!queuedColumns.has(columnIndex)) {
      const queuedSendResult = await page.evaluate(async ({ targetColumnIndex, expectedStreamCount }) => {
        const startedAt = performance.now()
        const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
        const activePanel = targetColumn?.querySelector('.pane-tab-panel.is-active')
        const textarea = activePanel?.querySelector<HTMLTextAreaElement>('textarea.control.textarea')
        const sendButton = activePanel?.querySelector<HTMLButtonElement>(
          'button[aria-label="Send message"]',
        )
        if (!activePanel || !textarea || !sendButton) {
          return {
            queued: false,
            durationMs: Number.POSITIVE_INFINITY,
            streamingTabCount: document.querySelectorAll('.pane-tab.is-streaming').length,
          }
        }

        sendButton.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
        }))

        const deadline = performance.now() + 5_000
        while (performance.now() < deadline) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const queued = activePanel.querySelector('.composer-queued-send') !== null
          const streamingTabCount = document.querySelectorAll('.pane-tab.is-streaming').length
          if (queued && textarea.value === '' && streamingTabCount === expectedStreamCount) {
            return {
              queued: true,
              durationMs: performance.now() - startedAt,
              streamingTabCount,
            }
          }
        }

        return {
          queued: false,
          durationMs: Number.POSITIVE_INFINITY,
          streamingTabCount: document.querySelectorAll('.pane-tab.is-streaming').length,
        }
      }, {
        targetColumnIndex: columnIndex,
        expectedStreamCount: chatStreamStressConcurrentStreamCount,
      })
      assert.equal(queuedSendResult.queued, true)
      assert.equal(queuedSendResult.streamingTabCount, chatStreamStressConcurrentStreamCount)
      queuedSendDurations.push(queuedSendResult.durationMs)
      queuedColumns.add(columnIndex)
    }

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

    {
      const backgroundTitle = getChatStreamStressBackgroundTitle(columnIndex + 1)
      const returnTitle = getChatStreamStressForegroundTitle(columnIndex + 1)
      const tabSwitchResult = await page.evaluate(async ({
        targetColumnIndex,
        backgroundTitle: targetBackgroundTitle,
        returnTitle: targetReturnTitle,
      }) => {
        const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
        if (!targetColumn) {
          return { durationMs: Number.POSITIVE_INFINITY, backgroundOutputVisible: false }
        }

        const startedAt = performance.now()
        let backgroundTab: HTMLButtonElement | null = null
        const backgroundTabs = targetColumn.querySelectorAll<HTMLButtonElement>('.pane-tab')
        for (let tabIndex = 0; tabIndex < backgroundTabs.length; tabIndex += 1) {
          const tab = backgroundTabs.item(tabIndex)
          if (tab.textContent?.trim() === targetBackgroundTitle) {
            backgroundTab = tab
            break
          }
        }
        if (!backgroundTab) {
          return { durationMs: Number.POSITIVE_INFINITY, backgroundOutputVisible: false }
        }
        backgroundTab.click()
        const backgroundDeadline = performance.now() + 5_000
        let backgroundOutputVisible = false
        while (performance.now() < backgroundDeadline) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const activePanel = targetColumn.querySelector('.pane-tab-panel.is-active')
          const hasLiveDelta = activePanel?.querySelector('.message-list')?.textContent?.includes('stream-') === true
          const hasLiveActivity = activePanel?.querySelector('.structured-command-inline-row') !== null
          if (
            targetColumn.querySelector('.pane-tab.is-active')?.textContent?.trim() ===
              targetBackgroundTitle &&
            (hasLiveDelta || hasLiveActivity)
          ) {
            backgroundOutputVisible = true
            break
          }
        }
        if (!backgroundOutputVisible) {
          return { durationMs: Number.POSITIVE_INFINITY, backgroundOutputVisible: false }
        }

        let returnTab: HTMLButtonElement | null = null
        const returnTabs = targetColumn.querySelectorAll<HTMLButtonElement>('.pane-tab')
        for (let tabIndex = 0; tabIndex < returnTabs.length; tabIndex += 1) {
          const tab = returnTabs.item(tabIndex)
          if (tab.textContent?.trim() === targetReturnTitle) {
            returnTab = tab
            break
          }
        }
        if (!returnTab) {
          return { durationMs: Number.POSITIVE_INFINITY, backgroundOutputVisible }
        }
        returnTab.click()
        const returnDeadline = performance.now() + 5_000
        let returnPainted = false
        while (performance.now() < returnDeadline) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          if (
            targetColumn.querySelector('.pane-tab.is-active')?.textContent?.trim() ===
            targetReturnTitle
          ) {
            returnPainted = true
            break
          }
        }
        if (!returnPainted) {
          return { durationMs: Number.POSITIVE_INFINITY, backgroundOutputVisible }
        }
        return {
          durationMs: performance.now() - startedAt,
          backgroundOutputVisible,
        }
      }, {
        targetColumnIndex: columnIndex,
        backgroundTitle,
        returnTitle,
      })
      assert.equal(tabSwitchResult.backgroundOutputVisible, true)
      assert.equal(Number.isFinite(tabSwitchResult.durationMs), true)
      tabSwitchDurations.push(tabSwitchResult.durationMs)
    }

    cycle += 1
    const remainingMs = deadline - Date.now()
    if (remainingMs > 0) {
      await page.waitForTimeout(Math.min(chatStreamStressInteractionIntervalMs, remainingMs))
    }
  }

  return { focusDurations, inputDurations, queuedSendDurations, tabSwitchDurations }
}

const runNewTabFirstInputInteractions = async (page: Page) => {
  const samples: NewTabInteractionSample[] = []

  for (let iteration = 0; iteration < newTabIterationCount; iteration += 1) {
    const columnIndex = iteration % chatStreamStressColumnCount
    const column = page.locator('.workspace-column').nth(columnIndex)
    const baselineTabCount = await column.locator('.pane-tab').count()
    assert.equal(
      baselineTabCount,
      chatStreamStressTabsPerPane,
      `new-tab probe ${iteration + 1} did not start from the stable tab baseline`,
    )
    const expectedTabCount = baselineTabCount + 1

    await page.evaluate((targetColumnIndex) => {
      const target = window as typeof window & { __chillVibeNewTabClickAt?: number }
      target.__chillVibeNewTabClickAt = 0
      const addButton = document
        .querySelectorAll('.workspace-column')
        .item(targetColumnIndex)
        ?.querySelector<HTMLButtonElement>('.pane-add-tab')
      addButton?.addEventListener('click', () => {
        target.__chillVibeNewTabClickAt = performance.now()
      }, { capture: true, once: true })
    }, columnIndex)

    await column.locator('.pane-add-tab').click({ timeout: 10_000 })

    let focusFailed = false
    let focusFailureDiagnostics: string | null = null
    let readyMs = 5_000
    try {
      const readyHandle = await page.waitForFunction(
        ({ targetColumnIndex, targetTabCount }) => {
          const target = window as typeof window & { __chillVibeNewTabClickAt?: number }
          const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
          const textarea = targetColumn?.querySelector<HTMLTextAreaElement>(
            '.pane-tab-panel.is-active textarea.control.textarea',
          )
          const ready = (
            targetColumn?.querySelectorAll('.pane-tab').length === targetTabCount &&
            textarea !== null &&
            document.activeElement === textarea
          )
          return ready && (target.__chillVibeNewTabClickAt ?? 0) > 0
            ? performance.now() - target.__chillVibeNewTabClickAt!
            : false
        },
        { targetColumnIndex: columnIndex, targetTabCount: expectedTabCount },
        { timeout: 5_000 },
      )
      readyMs = Number(await readyHandle.jsonValue())
      await readyHandle.dispose()
    } catch {
      focusFailed = true
      focusFailureDiagnostics = await page.evaluate((targetColumnIndex) => {
        const target = window as typeof window & { __chillVibeNewTabClickAt?: number }
        const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
        const textarea = targetColumn?.querySelector<HTMLTextAreaElement>(
          '.pane-tab-panel.is-active textarea.control.textarea',
        )
        const activeElement = document.activeElement
        return JSON.stringify({
          clickAt: target.__chillVibeNewTabClickAt ?? null,
          activeElement:
            activeElement instanceof HTMLElement
              ? `${activeElement.tagName.toLowerCase()}.${activeElement.className}`
              : null,
          activeTabId:
            targetColumn?.querySelector('.pane-tab.is-active')?.getAttribute('data-pane-tab-id') ??
            null,
          tabCount: targetColumn?.querySelectorAll('.pane-tab').length ?? 0,
          textareaPresent: textarea !== null,
          textareaDisabled: textarea?.disabled ?? null,
          focusExhaustedCount:
            textarea?.closest<HTMLElement>('.card-shell')?.dataset.composerFocusExhaustedCount ??
            null,
        })
      }, columnIndex)
    }

    const textarea = column.locator('.pane-tab-panel.is-active textarea.control.textarea')
    if (focusFailed) {
      await textarea.click({ timeout: 5_000 })
    }

    const draft = `新建会话首次输入 ${iteration + 1}：复杂面板保持响应`
    await page.evaluate((targetColumnIndex) => {
      const target = window as typeof window & {
        __chillVibeNewTabInputStartedAt?: number
        __chillVibeNewTabInputDurationMs?: number
      }
      target.__chillVibeNewTabInputStartedAt = performance.now()
      target.__chillVibeNewTabInputDurationMs = 0
      const textarea = document
        .querySelectorAll('.workspace-column')
        .item(targetColumnIndex)
        ?.querySelector<HTMLTextAreaElement>('.pane-tab-panel.is-active textarea.control.textarea')
      textarea?.addEventListener('input', () => {
        target.__chillVibeNewTabInputDurationMs =
          performance.now() - target.__chillVibeNewTabInputStartedAt!
      }, { capture: true, once: true })
    }, columnIndex)
    await page.keyboard.insertText(draft)
    const inputHandle = await page.waitForFunction(
      ({ targetColumnIndex, expectedDraft }) => {
        const target = window as typeof window & { __chillVibeNewTabInputDurationMs?: number }
        const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
        const valueMatches = targetColumn?.querySelector<HTMLTextAreaElement>(
          '.pane-tab-panel.is-active textarea.control.textarea',
        )?.value === expectedDraft
        return valueMatches && (target.__chillVibeNewTabInputDurationMs ?? 0) > 0
          ? target.__chillVibeNewTabInputDurationMs!
          : false
      },
      { targetColumnIndex: columnIndex, expectedDraft: draft },
      { timeout: 5_000 },
    )
    const inputMs = Number(await inputHandle.jsonValue())
    await inputHandle.dispose()
    const cardId = await column.locator('.pane-tab.is-active').getAttribute('data-pane-tab-id')
    assert.ok(cardId, `new tab ${iteration + 1} did not expose its card id`)

    await activatePaneTab(
      page,
      columnIndex,
      getChatStreamStressForegroundTitle(columnIndex + 1),
    )
    const reactivated = await page.evaluate(({ targetColumnIndex, targetCardId }) => {
      const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
      const tab = targetColumn?.querySelector<HTMLButtonElement>(
        `.pane-tab[data-pane-tab-id="${targetCardId}"]`,
      )
      tab?.click()
      return Boolean(tab)
    }, { targetColumnIndex: columnIndex, targetCardId: cardId })
    assert.equal(reactivated, true, `new tab ${cardId} could not be reactivated`)

    let draftRoundTripFailed = false
    try {
      await page.waitForFunction(
        ({ targetColumnIndex, targetCardId, expectedDraft }) => {
          const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
          return (
            targetColumn?.querySelector('.pane-tab.is-active')?.getAttribute('data-pane-tab-id') ===
              targetCardId &&
            targetColumn.querySelector<HTMLTextAreaElement>(
              '.pane-tab-panel.is-active textarea.control.textarea',
            )?.value === expectedDraft
          )
        },
        { targetColumnIndex: columnIndex, targetCardId: cardId, expectedDraft: draft },
        { timeout: 5_000 },
      )
    } catch {
      draftRoundTripFailed = true
    }

    samples.push({
      cardId,
      draft,
      readyMs,
      inputMs,
      focusFailed,
      draftRoundTripFailed,
      focusFailureDiagnostics,
    })

    await closeNewTabProbe(page, columnIndex, cardId, baselineTabCount)
    await activatePaneTab(page, columnIndex, getChatStreamStressForegroundTitle(columnIndex + 1))
    await page.waitForFunction(
      (expectedStreamCount) =>
        document.querySelectorAll('.pane-tab.is-streaming').length === expectedStreamCount,
      chatStreamStressConcurrentStreamCount,
      { timeout: 5_000 },
    )
  }

  return samples
}

const closeNewTabProbe = async (
  page: Page,
  columnIndex: number,
  cardId: string,
  expectedTabCount: number,
) => {
  const column = page.locator('.workspace-column').nth(columnIndex)
  const textarea = column.locator('.pane-tab-panel.is-active textarea.control.textarea')
  await textarea.fill('')
  await page.waitForFunction(
    (targetColumnIndex) =>
      document.querySelectorAll('.workspace-column').item(targetColumnIndex)
        ?.querySelector<HTMLTextAreaElement>('.pane-tab-panel.is-active textarea.control.textarea')
        ?.value === '',
    columnIndex,
    { timeout: 5_000 },
  )
  await column
    .locator(`.pane-tab[data-pane-tab-id="${cardId}"] .pane-tab-close`)
    .click({ timeout: 5_000 })
  await page.waitForFunction(
    ({ targetColumnIndex, targetCardId, targetTabCount }) => {
      const targetColumn = document.querySelectorAll('.workspace-column').item(targetColumnIndex)
      return (
        targetColumn?.querySelectorAll('.pane-tab').length === targetTabCount &&
        targetColumn.querySelector(`.pane-tab[data-pane-tab-id="${targetCardId}"]`) === null
      )
    },
    { targetColumnIndex: columnIndex, targetCardId: cardId, targetTabCount: expectedTabCount },
    { timeout: 5_000 },
  )
}

const assertPersistedMessagesRemainComplete = (
  initialState: AppState,
  persistedState: AppState,
) => {
  for (let index = 0; index < chatStreamStressColumnCount; index += 1) {
    const cardIndex = index + 1
    const streamedCardIds = getChatStreamStressRunningCardIds(cardIndex)

    for (const cardId of streamedCardIds) {
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
}

after(async () => {
  if (keepStressArtifacts) {
    console.log(`CHAT_STREAM_STRESS_ARTIFACTS ${JSON.stringify(tempRoots)}`)
    return
  }

  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

test('twenty simultaneous Electron agent tabs stay responsive while typing, queueing messages, and switching tabs', async () => {
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
    queuedSendDurations: [] as number[],
    tabSwitchDurations: [] as number[],
  }
  let newTabInteractionSamples: NewTabInteractionSample[] = []
  let rendererMetrics = {
    heartbeatMaxGapMs: Number.POSITIVE_INFINITY,
    heartbeatGaps: [] as number[],
    frameMaxGapMs: Number.POSITIVE_INFINITY,
    frameGaps: [] as number[],
    mountedStructuredItemCount: Number.POSITIVE_INFINITY,
    maxMountedItemsPerGroup: Number.POSITIVE_INFINITY,
    mountedTabCount: 0,
    mountedPanelCount: 0,
    streamingTabCount: 0,
    activeStreamingCardCount: 0,
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
      newTabInteractionSamples = await runNewTabFirstInputInteractions(page)
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
        mountedTabCount: document.querySelectorAll('.pane-tab').length,
        mountedPanelCount: document.querySelectorAll('.pane-tab-panel').length,
        streamingTabCount: document.querySelectorAll('.pane-tab.is-streaming').length,
        activeStreamingCardCount: document.querySelectorAll('.card-shell.is-streaming').length,
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
    queuedSendP95Ms: getPercentile(interactionMetrics.queuedSendDurations, 0.95),
    tabSwitchP95Ms: getPercentile(interactionMetrics.tabSwitchDurations, 0.95),
    inputSampleCount: interactionMetrics.inputDurations.length,
    focusSampleCount: interactionMetrics.focusDurations.length,
    queuedSendSampleCount: interactionMetrics.queuedSendDurations.length,
    tabSwitchSampleCount: interactionMetrics.tabSwitchDurations.length,
    newTabReadyP95Ms: getPercentile(
      newTabInteractionSamples.map((sample) => sample.readyMs),
      0.95,
    ),
    newTabReadyMaxMs: Math.max(0, ...newTabInteractionSamples.map((sample) => sample.readyMs)),
    newTabFirstInputP95Ms: getPercentile(
      newTabInteractionSamples.map((sample) => sample.inputMs),
      0.95,
    ),
    newTabFirstInputMaxMs: Math.max(
      0,
      ...newTabInteractionSamples.map((sample) => sample.inputMs),
    ),
    newTabSampleCount: newTabInteractionSamples.length,
    newTabStallOver2sCount: newTabInteractionSamples.filter(
      (sample) => sample.readyMs >= 2_000 || sample.inputMs >= 2_000,
    ).length,
    newTabFocusFailureCount: newTabInteractionSamples.filter((sample) => sample.focusFailed).length,
    newTabDraftRoundTripFailureCount: newTabInteractionSamples.filter(
      (sample) => sample.draftRoundTripFailed,
    ).length,
    mountedStructuredItemCount: rendererMetrics.mountedStructuredItemCount,
    maxMountedItemsPerGroup: rendererMetrics.maxMountedItemsPerGroup,
    mountedTabCount: rendererMetrics.mountedTabCount,
    mountedPanelCount: rendererMetrics.mountedPanelCount,
    streamingTabCount: rendererMetrics.streamingTabCount,
    activeStreamingCardCount: rendererMetrics.activeStreamingCardCount,
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
  assert.equal(
    metrics.queuedSendSampleCount,
    chatStreamStressColumnCount,
    `each visible running agent should accept one deferred message: ${JSON.stringify(metrics)}`,
  )
  assert.ok(metrics.tabSwitchSampleCount >= 1, `too few tab switch samples: ${JSON.stringify(metrics)}`)
  assert.equal(
    metrics.newTabSampleCount,
    newTabIterationCount,
    `new-tab stress did not complete every sample: ${JSON.stringify(metrics)}`,
  )
  assert.equal(
    metrics.newTabFocusFailureCount,
    0,
    `a newly created composer failed to focus automatically: ${JSON.stringify({
      ...metrics,
      firstFocusFailureDiagnostics: newTabInteractionSamples.find((sample) => sample.focusFailed)
        ?.focusFailureDiagnostics ?? null,
    })}`,
  )
  assert.equal(
    metrics.newTabDraftRoundTripFailureCount,
    0,
    `a new-tab draft was lost after switching away and back: ${JSON.stringify(metrics)}`,
  )
  assert.equal(
    metrics.newTabStallOver2sCount,
    0,
    `new-tab creation or first input stalled for at least 2s: ${JSON.stringify(metrics)}`,
  )
  assert.equal(
    metrics.mountedTabCount,
    chatStreamStressColumnCount * chatStreamStressTabsPerPane,
    `new-tab probes did not return to the stable heavy-use tab baseline: ${JSON.stringify(metrics)}`,
  )
  assert.equal(
    metrics.mountedPanelCount,
    chatStreamStressColumnCount * chatStreamStressTabsPerPane,
    `new-tab probes did not clean up stable pane panels: ${JSON.stringify(metrics)}`,
  )
  assert.equal(
    metrics.streamingTabCount,
    chatStreamStressConcurrentStreamCount,
    `not all foreground and background agents remained live: ${JSON.stringify(metrics)}`,
  )
  assert.equal(
    metrics.activeStreamingCardCount,
    chatStreamStressVisibleStreamColumnCount,
    `each workspace must keep one running agent visible during interaction: ${JSON.stringify(metrics)}`,
  )
  assert.ok(metrics.startupMs < 30_000, `startup exceeded 30s: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.heartbeatMaxGapMs < 2_000, `heartbeat stalled for 2s: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.heartbeatMaxGapMs < 500, `heartbeat missed the 500ms target: ${JSON.stringify(metrics)}`)
  // Offscreen validation consumes paint frames at 15 fps. Interaction metrics
  // above wait for the next frame so they cover visible feedback rather than
  // only synchronous DOM mutation.
  assert.ok(metrics.frameMaxGapMs < 500, `rendering missed the 500ms target: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.inputP95Ms < 100, `input p95 exceeded 100ms: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.focusP95Ms < 150, `focus p95 exceeded 150ms: ${JSON.stringify(metrics)}`)
  assert.ok(
    metrics.queuedSendP95Ms < 500,
    `deferred send feedback p95 exceeded 500ms: ${JSON.stringify(metrics)}`,
  )
  assert.ok(metrics.tabSwitchP95Ms < 500, `tab switch p95 exceeded 500ms: ${JSON.stringify(metrics)}`)
  assert.ok(
    metrics.newTabReadyP95Ms < 500,
    `new-tab ready p95 exceeded 500ms: ${JSON.stringify(metrics)}`,
  )
  assert.ok(
    metrics.newTabReadyMaxMs < 500,
    `new-tab ready max exceeded 500ms: ${JSON.stringify(metrics)}`,
  )
  assert.ok(
    metrics.newTabFirstInputP95Ms < 250,
    `new-tab first input p95 exceeded 250ms: ${JSON.stringify(metrics)}`,
  )
  assert.ok(
    metrics.newTabFirstInputMaxMs < 500,
    `new-tab first input max exceeded 500ms: ${JSON.stringify(metrics)}`,
  )
  assert.ok(
    metrics.maxMountedItemsPerGroup <= 120,
    `a structured group mounted an unbounded activity list: ${JSON.stringify(metrics)}`,
  )
})
