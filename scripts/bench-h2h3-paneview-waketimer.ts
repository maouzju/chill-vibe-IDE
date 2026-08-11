/* Scratch benchmark for H2 (PaneView O(tabs x cards)) and H3 (App.tsx wakeTimer full sweep).
 * Not part of the product build. Run: npx tsx bench-h2h3.ts
 */
import { performance } from 'node:perf_hooks'
import { createCard, createColumn, createDefaultState, createId, createPane } from '../shared/default-state'
import { MODEL_PICKER_HIDDEN_TOOL_MODELS } from '../shared/models'
import { ideReducer } from '../src/state'
import { arePaneViewPropsEqual, areWorkspaceColumnPropsEqual } from '../src/components/layout-memoization'

type Any = any

const MESSAGE_CHARS = 900

const buildCard = (title: string, messageCount: number): Any => {
  const card: Any = createCard(title, undefined, 'claude', 'claude-sonnet-4-5')
  card.messages = new Array(messageCount)
  for (let i = 0; i < messageCount; i += 1) {
    card.messages[i] = {
      id: createId(),
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(MESSAGE_CHARS),
      createdAt: new Date().toISOString(),
    }
  }
  return card
}

const buildColumn = (title: string, tabCount: number, messagesPerCard: number): Any => {
  const cards: Any = {}
  const tabs: string[] = []
  for (let i = 0; i < tabCount; i += 1) {
    const card = buildCard(`${title} tab ${i}`, messagesPerCard)
    cards[card.id] = card
    tabs.push(card.id)
  }
  const column: Any = createColumn({ title, provider: 'claude', workspacePath: 'D:/Git/chill-vibe' })
  column.cards = cards
  column.layout = createPane(tabs, tabs[0])
  return column
}

const buildState = (columnCount: number, tabCount: number, messagesPerCard: number): Any => {
  const state: Any = createDefaultState('D:/Git/chill-vibe', 'zh')
  state.columns = []
  for (let c = 0; c < columnCount; c += 1) {
    state.columns.push(buildColumn(`col-${c}`, tabCount, messagesPerCard))
  }
  return state
}

// ---------------------------------------------------------------- H2 ------
// Verbatim copy of the per-tab work inside PaneView.tsx pane.tabs.map
// (lines 1403-1417): indexOf -> O(tabs^2), Object.values().filter() -> O(tabs x cards).
const h2PaneRenderLoop = (column: Any, pane: Any) => {
  let sink = 0
  for (const tabId of pane.tabs) {
    const card = column.cards[tabId]
    if (!card) continue
    const tabIndex = pane.tabs.indexOf(tabId)
    const leftTabId = tabIndex > 0 ? pane.tabs[tabIndex - 1] : undefined
    const leftCard = leftTabId ? column.cards[leftTabId] : undefined
    const leftWakeTimerTarget =
      leftCard && !MODEL_PICKER_HIDDEN_TOOL_MODELS.has(leftCard.model)
        ? { id: leftCard.id, title: leftCard.title }
        : null
    const workspaceWakeTimerAgentCount = Object.values(column.cards).filter(
      (entry: Any) => entry.id !== card.id && !MODEL_PICKER_HIDDEN_TOOL_MODELS.has(entry.model),
    ).length
    sink += workspaceWakeTimerAgentCount + (leftWakeTimerTarget ? 1 : 0)
  }
  return sink
}

// ---------------------------------------------------------------- H3 ------
// Verbatim copy of App.tsx:3005-3019 and 3024-3042.
const h3TopologySignature = (columns: Any[]) =>
  columns
    .map((column: Any) =>
      [
        column.id,
        Object.keys(column.cards).sort().join(','),
        ...Object.values(column.cards)
          .filter((card: Any) => (card.wakeTimerQueuedSends?.length ?? 0) > 0)
          .map((card: Any) =>
            [
              card.id,
              card.wakeTimerMode ?? 'workspace-agents',
              card.wakeTimerQueuedSends?.length ?? 0,
              (card.wakeTimerPendingTargetIds ?? []).join(','),
            ].join(':'),
          ),
      ].join('|'),
    )
    .join('||')

const h3NextWakeTimerTimestamp = (columns: Any[]) => {
  let nextTimestamp: number | null = null
  for (const column of columns) {
    for (const card of Object.values(column.cards) as Any[]) {
      if (
        card.wakeTimerMode !== 'duration' ||
        (card.wakeTimerQueuedSends?.length ?? 0) === 0 ||
        !card.wakeTimerWakeAt
      ) {
        continue
      }
      const timestamp = Date.parse(card.wakeTimerWakeAt)
      if (Number.isFinite(timestamp) && (nextTimestamp === null || timestamp < nextTimestamp)) {
        nextTimestamp = timestamp
      }
    }
  }
  return nextTimestamp
}

// ------------------------------------------------------------- timing -----
const bench = (label: string, fn: () => unknown, iterations = 400) => {
  for (let i = 0; i < Math.min(80, iterations); i += 1) fn() // warm
  const samples: number[] = []
  for (let r = 0; r < 7; r += 1) {
    const start = performance.now()
    for (let i = 0; i < iterations; i += 1) fn()
    samples.push((performance.now() - start) / iterations)
  }
  samples.sort((a, b) => a - b)
  return { label, medianMs: samples[3], maxMs: samples[6] }
}

const fmt = (ms: number) => (ms >= 1 ? `${ms.toFixed(3)}ms` : `${(ms * 1000).toFixed(1)}us`)

console.log('=== H2: PaneView per-render tab loop (1 pane) ===')
for (const tabCount of [6, 10, 16, 24, 40]) {
  for (const messages of [300, 2000]) {
    const column = buildColumn('c', tabCount, messages)
    const pane = column.layout
    const r = bench(`tabs=${tabCount} msgs/card=${messages}`, () => h2PaneRenderLoop(column, pane))
    console.log(`  ${r.label.padEnd(28)} median ${fmt(r.medianMs)}  max ${fmt(r.maxMs)}`)
  }
}

console.log('\n=== H2 variant: board column (cards >> tabs, automation-board items hidden from tabs) ===')
for (const [tabCount, extraCards] of [[10, 40], [10, 200], [24, 400]] as Array<[number, number]>) {
  const column = buildColumn('c', tabCount, 300)
  for (let i = 0; i < extraCards; i += 1) {
    const card = buildCard(`hidden ${i}`, 60)
    column.cards[card.id] = card
  }
  const r = bench(`tabs=${tabCount} cards=${tabCount + extraCards}`, () =>
    h2PaneRenderLoop(column, column.layout),
  )
  console.log(`  ${r.label.padEnd(28)} median ${fmt(r.medianMs)}  max ${fmt(r.maxMs)}`)
}

console.log('\n=== H3: wakeTimer memos over ALL columns ===')
for (const columnCount of [3, 6]) {
  for (const tabCount of [6, 10, 16, 24, 40]) {
    const state = buildState(columnCount, tabCount, 300)
    const sig = bench(`cols=${columnCount} tabs=${tabCount} signature`, () =>
      h3TopologySignature(state.columns),
    )
    const ts = bench(`cols=${columnCount} tabs=${tabCount} nextTs`, () =>
      h3NextWakeTimerTimestamp(state.columns),
    )
    console.log(
      `  cols=${columnCount} tabs/col=${tabCount} (cards=${columnCount * tabCount})  signature ${fmt(
        sig.medianMs,
      )}  nextTimestamp ${fmt(ts.medianMs)}  sum ${fmt(sig.medianMs + ts.medianMs)}`,
    )
  }
}

// ----------------------------------------------------- memo invalidation --
const makeCommonProps = () => ({
  providers: {},
  language: 'zh',
  systemPrompt: '',
  modelPromptRules: undefined,
  codexChatSettings: undefined,
  crossProviderSkillReuseEnabled: false,
  musicAlbumCoverEnabled: false,
  weatherCity: '',
  gitAgentModel: '',
  brainstormRequestModel: '',
  availableQuickToolModels: [],
  autoUrgeEnabled: false,
  autoUrgeProfiles: undefined,
  autoUrgeMessage: '',
  autoUrgeSuccessKeyword: '',
  globalUrgeActive: false,
  globalUrgeProfileId: '',
  repeatLoopEnabled: false,
  wakeTimerEnabled: false,
  cardRecoveryStatuses: undefined,
  queuedSendSummaries: undefined,
})

const collectPanes = (node: Any, out: Any[] = []): Any[] => {
  if (node.type === 'pane') out.push(node)
  else for (const child of node.children) collectPanes(child, out)
  return out
}

const countRerenders = (before: Any, after: Any, common: Any) => {
  let columnsRerendered = 0
  let panesRerendered = 0
  let totalPanes = 0
  let paneCompareMs = 0
  let columnCompareMs = 0

  for (let i = 0; i < before.columns.length; i += 1) {
    const prevColumn = before.columns[i]
    const nextColumn = after.columns[i]

    const t0 = performance.now()
    const columnEqual = areWorkspaceColumnPropsEqual(
      { ...common, column: prevColumn, recentWorkspaces: before.settings.recentWorkspaces ?? [], sessionHistory: before.sessionHistory } as Any,
      { ...common, column: nextColumn, recentWorkspaces: after.settings.recentWorkspaces ?? [], sessionHistory: after.sessionHistory } as Any,
    )
    columnCompareMs += performance.now() - t0
    if (!columnEqual) columnsRerendered += 1

    const prevPanes = collectPanes(prevColumn.layout)
    const nextPanes = collectPanes(nextColumn.layout)
    for (let p = 0; p < nextPanes.length; p += 1) {
      totalPanes += 1
      const t1 = performance.now()
      const paneEqual = arePaneViewPropsEqual(
        { ...common, column: prevColumn, pane: prevPanes[p] } as Any,
        { ...common, column: nextColumn, pane: nextPanes[p] } as Any,
      )
      paneCompareMs += performance.now() - t1
      // React only re-runs the pane memo when its parent column re-rendered.
      if (!columnEqual && !paneEqual) panesRerendered += 1
    }
  }

  return { columnsRerendered, panesRerendered, totalPanes, paneCompareMs, columnCompareMs }
}

console.log('\n=== memo invalidation: addTab vs setActiveTab ===')
for (const [columnCount, tabCount] of [[3, 10], [3, 24], [6, 24]] as Array<[number, number]>) {
  const state = buildState(columnCount, tabCount, 800)
  const common = makeCommonProps()
  const targetColumn = state.columns[0]
  const targetPane = targetColumn.layout

  const afterAdd = ideReducer(state, {
    type: 'addTab',
    columnId: targetColumn.id,
    paneId: targetPane.id,
  } as Any)
  const afterActivate = ideReducer(state, {
    type: 'setActiveTab',
    columnId: targetColumn.id,
    paneId: targetPane.id,
    tabId: targetPane.tabs[targetPane.tabs.length - 1],
  } as Any)

  const addStats = countRerenders(state, afterAdd, common)
  const actStats = countRerenders(state, afterActivate, common)

  const identity = {
    addTabCardsObjectChanged: state.columns[0].cards !== afterAdd.columns[0].cards,
    addTabIndividualCardRefsPreserved: targetPane.tabs.every(
      (id: string) => state.columns[0].cards[id] === afterAdd.columns[0].cards[id],
    ),
    setActiveTabCardsObjectChanged: state.columns[0].cards !== afterActivate.columns[0].cards,
  }

  console.log(
    `  cols=${columnCount} tabs/col=${tabCount} panes=${addStats.totalPanes}\n` +
      `    addTab       -> columns rerender ${addStats.columnsRerendered}/${columnCount}, panes rerender ${addStats.panesRerendered}/${addStats.totalPanes}, memo-compare cost ${fmt(addStats.columnCompareMs + addStats.paneCompareMs)}\n` +
      `    setActiveTab -> columns rerender ${actStats.columnsRerendered}/${columnCount}, panes rerender ${actStats.panesRerendered}/${actStats.totalPanes}, memo-compare cost ${fmt(actStats.columnCompareMs + actStats.paneCompareMs)}\n` +
      `    identity: ${JSON.stringify(identity)}`,
  )

  const reduceAdd = bench(
    'reducer addTab',
    () => ideReducer(state, { type: 'addTab', columnId: targetColumn.id, paneId: targetPane.id } as Any),
    60,
  )
  const reduceAct = bench(
    'reducer setActiveTab',
    () =>
      ideReducer(state, {
        type: 'setActiveTab',
        columnId: targetColumn.id,
        paneId: targetPane.id,
        tabId: targetPane.tabs[(Math.random() * targetPane.tabs.length) | 0],
      } as Any),
    60,
  )
  console.log(
    `    reducer itself: addTab ${fmt(reduceAdd.medianMs)}  setActiveTab ${fmt(reduceAct.medianMs)}`,
  )
}

// -------------------------------------- document capture listener fan-out --
console.log('\n=== document capture listeners (PaneView:478 pointerdown, :524 wheel) ===')
for (const paneCount of [3, 6, 12, 24]) {
  // Cost model: every wheel event runs paneCount handlers; each does
  // getBoundingClientRect + 3 layout reads, and elementFromPoint only when the
  // geometry test passes (i.e. at most for the pane under the cursor).
  console.log(
    `  panes=${paneCount}: ${paneCount} pointerdown handlers + ${paneCount} non-passive wheel handlers per event`,
  )
}
