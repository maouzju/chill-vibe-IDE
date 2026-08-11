/* Scratch: does addTab (new column.cards object) fan out to sibling panes /
 * other columns, the way setActiveTab (same cards object) does not?
 * Uses the REAL reducer and the REAL memo comparators.
 * Run: npx tsx bench-memo-fanout.ts
 */
import { performance } from 'node:perf_hooks'
import {
  createCard,
  createColumn,
  createDefaultState,
  createId,
  createPane,
  createSplit,
} from '../shared/default-state'
import { ideReducer } from '../src/state'
import { arePaneViewPropsEqual, areWorkspaceColumnPropsEqual } from '../src/components/layout-memoization'

type Any = any

const buildCard = (title: string, messageCount: number): Any => {
  const card: Any = createCard(title, undefined, 'claude', 'claude-sonnet-4-5')
  card.messages = Array.from({ length: messageCount }, (_, i) => ({
    id: createId(),
    role: i % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(900),
    createdAt: new Date().toISOString(),
  }))
  return card
}

/** One column, `panesPerColumn` panes side by side, `tabsPerPane` tabs each. */
const buildColumn = (title: string, panesPerColumn: number, tabsPerPane: number, msgs: number): Any => {
  const cards: Any = {}
  const panes: Any[] = []
  for (let p = 0; p < panesPerColumn; p += 1) {
    const tabs: string[] = []
    for (let t = 0; t < tabsPerPane; t += 1) {
      const card = buildCard(`${title}-p${p}-t${t}`, msgs)
      cards[card.id] = card
      tabs.push(card.id)
    }
    panes.push(createPane(tabs, tabs[0]))
  }
  const column: Any = createColumn({ title, provider: 'claude', workspacePath: 'D:/Git/chill-vibe' })
  column.cards = cards
  column.layout = panes.length === 1 ? panes[0] : createSplit('horizontal', panes)
  return column
}

const common: Any = {
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
  recentWorkspaces: [],
  sessionHistory: [],
}

const collectPanes = (node: Any, out: Any[] = []): Any[] => {
  if (node.type === 'pane') out.push(node)
  else for (const child of node.children) collectPanes(child, out)
  return out
}

const analyse = (before: Any, after: Any, label: string, targetColumnId: string, targetPaneId: string) => {
  let columnsRerendered = 0
  let panesRerendered = 0
  let siblingPanesInTargetColumn = 0
  let siblingPanesRerendered = 0
  let totalPanes = 0
  const t0 = performance.now()

  for (let i = 0; i < before.columns.length; i += 1) {
    const prevColumn = before.columns[i]
    const nextColumn = after.columns[i]
    const columnEqual = areWorkspaceColumnPropsEqual(
      { ...common, column: prevColumn },
      { ...common, column: nextColumn },
    )
    if (!columnEqual) columnsRerendered += 1

    const prevPanes = collectPanes(prevColumn.layout)
    const nextPanes = collectPanes(nextColumn.layout)
    for (let p = 0; p < nextPanes.length; p += 1) {
      totalPanes += 1
      const isTarget = nextColumn.id === targetColumnId && nextPanes[p].id === targetPaneId
      if (nextColumn.id === targetColumnId && !isTarget) siblingPanesInTargetColumn += 1
      const paneEqual = arePaneViewPropsEqual(
        { ...common, column: prevColumn, pane: prevPanes[p] },
        { ...common, column: nextColumn, pane: nextPanes[p] },
      )
      // A pane's memo only gets consulted when its parent column re-rendered.
      if (!columnEqual && !paneEqual) {
        panesRerendered += 1
        if (!isTarget) siblingPanesRerendered += 1
      }
    }
  }

  const ms = performance.now() - t0
  console.log(
    `    ${label.padEnd(13)} columns ${columnsRerendered}/${before.columns.length}, ` +
      `panes ${panesRerendered}/${totalPanes}` +
      ` (siblings inside the touched column that ALSO re-render: ${siblingPanesRerendered}/${siblingPanesInTargetColumn})` +
      `  full memo sweep ${(ms * 1000).toFixed(1)}us`,
  )
}

for (const [columnCount, panesPerColumn, tabsPerPane, msgs] of [
  [3, 2, 5, 800],
  [3, 3, 8, 800],
  [6, 3, 8, 2000],
] as Array<[number, number, number, number]>) {
  const state: Any = createDefaultState('D:/Git/chill-vibe', 'zh')
  state.columns = Array.from({ length: columnCount }, (_, c) =>
    buildColumn(`col-${c}`, panesPerColumn, tabsPerPane, msgs),
  )
  const targetColumn = state.columns[0]
  const targetPane = collectPanes(targetColumn.layout)[0]

  console.log(
    `\ncolumns=${columnCount} panes/col=${panesPerColumn} tabs/pane=${tabsPerPane} msgs/card=${msgs} ` +
      `(cards/col=${panesPerColumn * tabsPerPane}, total panes=${columnCount * panesPerColumn})`,
  )

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
  const afterDraft = ideReducer(state, {
    type: 'setCardDraft',
    columnId: targetColumn.id,
    cardId: targetPane.tabs[0],
    draft: 'hello world',
  } as Any)

  analyse(state, afterAdd, 'addTab', targetColumn.id, targetPane.id)
  analyse(state, afterActivate, 'setActiveTab', targetColumn.id, targetPane.id)
  analyse(state, afterDraft, 'setCardDraft', targetColumn.id, targetPane.id)

  console.log(
    `    identity: cards object new? addTab=${
      state.columns[0].cards !== afterAdd.columns[0].cards
    } setActiveTab=${state.columns[0].cards !== afterActivate.columns[0].cards} setCardDraft=${
      state.columns[0].cards !== afterDraft.columns[0].cards
    }; per-card refs preserved by addTab=${targetPane.tabs.every(
      (id: string) => state.columns[0].cards[id] === afterAdd.columns[0].cards[id],
    )}`,
  )
}
