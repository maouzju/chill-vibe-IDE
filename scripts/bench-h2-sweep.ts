import { performance } from 'node:perf_hooks'
import { createCard, createColumn, createId, createPane } from '../shared/default-state'
import { MODEL_PICKER_HIDDEN_TOOL_MODELS } from '../shared/models'
type Any = any
const buildCard = (t: string, n: number): Any => {
  const c: Any = createCard(t, undefined, 'claude', 'claude-sonnet-4-5')
  c.messages = Array.from({ length: n }, (_, i) => ({ id: createId(), role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(900), createdAt: new Date().toISOString() }))
  return c
}
const buildColumn = (tabCount: number, msgs: number): Any => {
  const cards: Any = {}; const tabs: string[] = []
  for (let i = 0; i < tabCount; i++) { const c = buildCard(`t${i}`, msgs); cards[c.id] = c; tabs.push(c.id) }
  const col: Any = createColumn({ provider: 'claude', workspacePath: 'D:/x' })
  col.cards = cards; col.layout = createPane(tabs, tabs[0]); return col
}
const loop = (column: Any, pane: Any) => {
  let sink = 0
  for (const tabId of pane.tabs) {
    const card = column.cards[tabId]; if (!card) continue
    const tabIndex = pane.tabs.indexOf(tabId)
    const leftTabId = tabIndex > 0 ? pane.tabs[tabIndex - 1] : undefined
    const leftCard = leftTabId ? column.cards[leftTabId] : undefined
    const l = leftCard && !MODEL_PICKER_HIDDEN_TOOL_MODELS.has(leftCard.model) ? { id: leftCard.id, title: leftCard.title } : null
    sink += Object.values(column.cards).filter((e: Any) => e.id !== card.id && !MODEL_PICKER_HIDDEN_TOOL_MODELS.has(e.model)).length + (l ? 1 : 0)
  }
  return sink
}
const bench = (fn: () => unknown, it = 2000) => {
  for (let i = 0; i < 300; i++) fn()
  const s: number[] = []
  for (let r = 0; r < 9; r++) { const t = performance.now(); for (let i = 0; i < it; i++) fn(); s.push((performance.now() - t) / it) }
  s.sort((a, b) => a - b); return s[4]
}
const fmt = (ms: number) => ms >= 1 ? `${ms.toFixed(3)}ms` : `${(ms * 1000).toFixed(1)}us`
console.log('finer sweep, msgs/card=800, isolated V8 state per size:')
for (const n of [3, 6, 8, 12, 16, 20, 24, 28, 32, 40, 60, 80]) {
  const col = buildColumn(n, 800)
  console.log(`  tabs=${String(n).padStart(3)} cards=${String(n).padStart(3)}  ${fmt(bench(() => loop(col, col.layout)))}`)
}
console.log("\nreal archive shape (3 columns / 8 cards total, worst column ~4 tabs):")
const real = buildColumn(4, 313)
console.log(`  tabs=4 cards=4  ${fmt(bench(() => loop(real, real.layout)))}`)
