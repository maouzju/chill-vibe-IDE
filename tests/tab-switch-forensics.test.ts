import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  assembleForensicsSnapshot,
  drainTabSwitchLedgerForTest,
  isSlowTabSwitch,
  measureTabSwitchForForensics,
  pushTabSwitchEntry,
  slowTabSwitchBlockThresholdMs,
  slowTabSwitchExcessThresholdMs,
  tabSwitchCapacity,
  type TabSwitchEntry,
} from '../src/diagnostics/stuck-pane-forensics.ts'

// 用户报"新 tab 输入点东西再切走会卡好几秒"，但在同一份真实档案 + 真实窗口
// 下自动化实测只有 120ms（打字与否无差别），差的是用户运行时才有的负载。
// 所以把每次 tab 切换留证到取证 dump 里，下次复现直接有铁证。
//
// 关键教训（2026-08-11 实测）：不能拿"切换后两帧画完"当卡顿判据。
// 这个应用空闲时 rAF 中位间隔实测就有 1007ms（后台窗口被降到 1fps），
// 两帧天然接近 2 秒，照那么判会把每一次切换都报成"卡了 1.8 秒"。
// 所以每条记录都自带同一时刻的空闲帧耗时做基线，只有超出基线的那部分算数。

const makeEntry = (overrides: Partial<TabSwitchEntry> = {}): TabSwitchEntry => ({
  atMs: 0,
  source: 'activate',
  fromTabId: 'tab-0',
  toTabId: 'tab-1',
  elapsedMs: 40,
  idleFrameMs: 32,
  longestBlockMs: 0,
  fromDraftLength: 0,
  streamingCardCount: 0,
  ...overrides,
})

// measureTabSwitchForForensics 只在浏览器里跑，但它对宿主的要求很小：
// 一个能排帧的 requestAnimationFrame 加一个 dispatchEvent。刻意把每帧拖慢，
// 好让"切换耗时"和"同刻空闲基线"两个读数都非零 —— 基线是 0 的话，
// 「新路径也走了同一套自校准」这条断言就等于没测。
const fakeFrameDelayMs = 12

const withFakeWindow = async (run: () => Promise<void>): Promise<void> => {
  const host = globalThis as { window?: unknown }
  const previous = host.window
  let handle = 0
  host.window = {
    requestAnimationFrame: (callback: (time: number) => void) => {
      const timer = setTimeout(() => callback(fakeFrameDelayMs), fakeFrameDelayMs)
      timer.unref?.()
      handle += 1
      return handle
    },
    dispatchEvent: () => true,
  }
  drainTabSwitchLedgerForTest()
  try {
    await run()
  } finally {
    drainTabSwitchLedgerForTest()
    host.window = previous
  }
}

const waitForTabSwitchEntry = async (): Promise<TabSwitchEntry> => {
  // 探针要等 4 帧（2 帧测切换 + 2 帧测同刻空闲基线）才落账。
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const drained = drainTabSwitchLedgerForTest()
    if (drained.length > 0) {
      return drained[drained.length - 1]!
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, fakeFrameDelayMs)
      timer.unref?.()
    })
  }
  throw new Error('探针没有留下任何切换记录')
}

const readMeasureCallArguments = (source: string): string[] =>
  [...source.matchAll(/measureTabSwitchForForensics\(\{([\s\S]*?)\n\s*\}\)/g)].map(
    (match) => match[1] ?? '',
  )

test('切换记录是环形的，只留最近若干次', () => {
  let ledger: TabSwitchEntry[] = []
  for (let index = 0; index < tabSwitchCapacity + 5; index += 1) {
    ledger = pushTabSwitchEntry(ledger, makeEntry({ toTabId: `tab-${index}` }))
  }

  assert.equal(ledger.length, tabSwitchCapacity)
  assert.equal(ledger[ledger.length - 1]?.toTabId, `tab-${tabSwitchCapacity + 4}`)
})

test('帧本来就被节流到 1fps 时不许误报（实测空闲 rAF 就有 1007ms）', () => {
  const throttled = makeEntry({ elapsedMs: 1857, idleFrameMs: 1800, longestBlockMs: 0 })

  assert.equal(isSlowTabSwitch(throttled), false)
})

test('帧在正常跑却等了很久，才算真卡', () => {
  const stalled = makeEntry({
    elapsedMs: slowTabSwitchExcessThresholdMs + 40,
    idleFrameMs: 32,
    longestBlockMs: 0,
  })

  assert.equal(isSlowTabSwitch(stalled), true)
})

test('主线程被长时间占住就直接算慢，跟帧率无关', () => {
  const blocked = makeEntry({
    elapsedMs: 1857,
    idleFrameMs: 1800,
    longestBlockMs: slowTabSwitchBlockThresholdMs,
  })

  assert.equal(isSlowTabSwitch(blocked), true, '界面冻结靠的是主线程阻塞，这条必须能抓到')
})

test('实测的正常切换不会刷屏', () => {
  assert.equal(
    isSlowTabSwitch(makeEntry({ elapsedMs: 120, idleFrameMs: 32, longestBlockMs: 108 })),
    false,
    '真实档案实测就是 120ms / 108ms 这个量级，绝不能每次都留证',
  )
})

test('取证快照带得走切换记录', () => {
  const snapshot = assembleForensicsSnapshot({
    reason: 'slow-tab-switch',
    nowIso: new Date(0).toISOString(),
    activeElementPath: 'body',
    documentHasFocus: true,
    visibilityState: 'visible',
    windowSize: { width: 1920, height: 1080 },
    panes: [],
    hitGrid: [],
    pointerLedger: [],
    rafTimestampsMs: [],
    rescueEventTimesMs: [],
    tabSwitches: [makeEntry({ elapsedMs: 1840, idleFrameMs: 33, longestBlockMs: 900 })],
  })

  assert.equal(snapshot.tabSwitches?.[0]?.elapsedMs, 1840)
  assert.equal(snapshot.tabSwitches?.[0]?.idleFrameMs, 33)
})

test('新建 tab 也必须留证 —— 用户报的就是这条路径', async () => {
  await withFakeWindow(async () => {
    measureTabSwitchForForensics({
      source: 'create',
      fromTabId: 'tab-old',
      // 新卡的 id 由 reducer 现场生成，测量开始那一刻还不存在。
      toTabId: null,
      fromDraftLength: 12,
      streamingCardCount: 1,
    })

    const entry = await waitForTabSwitchEntry()

    assert.equal(entry.source, 'create', '拿到 dump 要能一眼看出用户卡在哪条路径')
    assert.equal(entry.fromTabId, 'tab-old')
    assert.equal(entry.toTabId, null)
    assert.equal(entry.fromDraftLength, 12, '用户强调"先输入点什么"才复现，草稿长度必须带上')
    assert.equal(entry.streamingCardCount, 1)
  })
})

test('新建 tab 这条路径也走同一套空闲帧自校准', async () => {
  await withFakeWindow(async () => {
    measureTabSwitchForForensics({
      source: 'create',
      fromTabId: 'tab-old',
      toTabId: null,
      fromDraftLength: 0,
      streamingCardCount: 0,
    })

    const entry = await waitForTabSwitchEntry()

    assert.ok(entry.elapsedMs > 0, '必须包住整个 dispatch→重绘，而不是只包 onAddTab 调用本身')
    assert.ok(
      entry.idleFrameMs > 0,
      '空闲 rAF 实测就有 1007ms，新路径不带同刻基线就会每次都误报"卡了 1.8 秒"',
    )
  })
})

test('Ctrl+Tab 也必须留证', async () => {
  await withFakeWindow(async () => {
    measureTabSwitchForForensics({
      source: 'keyboard',
      fromTabId: 'tab-0',
      toTabId: 'tab-1',
      fromDraftLength: 3,
      streamingCardCount: 0,
    })

    const entry = await waitForTabSwitchEntry()

    assert.equal(entry.source, 'keyboard')
    assert.equal(entry.toTabId, 'tab-1')
  })
})

// 更正一条 2026-08-11 之前写错的断言：activateTab **不是**所有切换路径的唯一收口。
// 新建 tab 走 PaneView.handleAddTab → onAddTab → reducer addTab，
// Ctrl+Tab 走 App.tsx 直接 applyAction({type:'setActiveTab'})，两条都绕开 activateTab。
// 用户报的恰恰是第一条 —— 按旧断言它「有探针」，实际一条记录都不会留。
test('三条切换路径都各自接了探针，不只是 activateTab', () => {
  const paneSource = readFileSync('src/components/PaneView.tsx', 'utf8')
  const appSource = readFileSync('src/App.tsx', 'utf8')

  const paneCalls = readMeasureCallArguments(paneSource)
  const appCalls = readMeasureCallArguments(appSource)

  assert.ok(
    paneCalls.some((args) => args.includes("source: 'activate'")),
    '点已有 tab（PaneView.activateTab）要留证',
  )
  assert.ok(
    paneCalls.some((args) => args.includes("source: 'create'")),
    '新建 tab（PaneView.handleAddTab / 双击新建）绕开 activateTab，必须自己留证',
  )
  assert.ok(
    appCalls.some((args) => args.includes("source: 'keyboard'")),
    'Ctrl+Tab（App.tsx 直接 applyAction setActiveTab）绕开 PaneView，必须自己留证',
  )
})

test('取证快照能区分切换来源', () => {
  const snapshot = assembleForensicsSnapshot({
    reason: 'slow-tab-switch',
    nowIso: new Date(0).toISOString(),
    activeElementPath: 'body',
    documentHasFocus: true,
    visibilityState: 'visible',
    windowSize: { width: 1920, height: 1080 },
    panes: [],
    hitGrid: [],
    pointerLedger: [],
    rafTimestampsMs: [],
    rescueEventTimesMs: [],
    tabSwitches: [
      makeEntry({ source: 'activate' }),
      makeEntry({ source: 'create', toTabId: null }),
      makeEntry({ source: 'keyboard' }),
    ],
  })

  assert.deepEqual(
    snapshot.tabSwitches?.map((entry) => entry.source),
    ['activate', 'create', 'keyboard'],
  )
})
