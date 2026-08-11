import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  assembleForensicsSnapshot,
  isSlowTabSwitch,
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
  fromTabId: 'tab-0',
  toTabId: 'tab-1',
  elapsedMs: 40,
  idleFrameMs: 32,
  longestBlockMs: 0,
  fromDraftLength: 0,
  streamingCardCount: 0,
  ...overrides,
})

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

test('PaneView 真的在切换收口处接了探针', () => {
  const source = readFileSync('src/components/PaneView.tsx', 'utf8')

  assert.match(
    source,
    /measureTabSwitchForForensics\(/,
    'activateTab 是所有切换路径的唯一收口，探针必须挂在这里',
  )
})
