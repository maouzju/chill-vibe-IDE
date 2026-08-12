/* Benchmark H1: the [appState]-dependency effect in usePersistence.ts:133-158.
 * Imports the REAL implementations — no re-implementation. */
import { readFileSync } from 'node:fs'
import {
  getLiveChatContentChars,
  isBusyStreamingState,
  getQueuedStateSaveDelayMs,
  getPersistenceVersion,
  shouldResetQueuedStateSaveTimer,
  shouldPauseQueuedStateSave,
  hasStreamingCards,
  getStreamingCardCount,
  createQueuedPersistenceStateSnapshot,
} from '../src/hooks/persistence-queue'
import type { AppState } from '../shared/schema'

// 指向打包版的真实 state.json（体量才有代表性）。默认按当前用户的 APPDATA 推导，
// 第一个命令行参数可覆盖 —— 不要写死某台机器的绝对路径，这个仓库是公开的。
const STATE_PATH =
  process.argv[2] ??
  `${(process.env.APPDATA ?? '').replace(/\\/g, '/')}/chill-vibe-ide/data/state.json`
const real = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as AppState

// ---- helpers -------------------------------------------------------------
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}

const bench = (label: string, fn: () => unknown, iters = 50) => {
  for (let i = 0; i < 20; i++) fn() // warm up
  const samples: number[] = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    const v = fn()
    const t1 = performance.now()
    if (v === undefined) throw new Error('sink')
    samples.push(t1 - t0)
  }
  const med = median(samples)
  console.log(
    `${label.padEnd(46)} median=${med.toFixed(4)}ms  p95=${p95(samples).toFixed(4)}ms  min=${Math.min(...samples).toFixed(4)}ms`,
  )
  return med
}

// ---- content-length distribution sampled from the real archive -----------
const realContentLens: number[] = []
const realSdLens: number[] = []
for (const col of real.columns) {
  for (const card of Object.values(col.cards)) {
    for (const m of card.messages) {
      realContentLens.push(m.content.length)
      realSdLens.push(m.meta?.structuredData?.length ?? 0)
    }
  }
}
let seed = 12345
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}
const pick = (arr: number[]) => arr[Math.floor(rnd() * arr.length)]

const synthMessage = (i: number) => {
  const cLen = pick(realContentLens)
  const sLen = pick(realSdLens)
  return {
    id: `m-${i}-${Math.floor(rnd() * 1e9)}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(cLen),
    createdAt: new Date().toISOString(),
    ...(sLen > 0
      ? { meta: { kind: 'activity', structuredData: 'y'.repeat(sLen) } }
      : {}),
  }
}

const templateCard = (() => {
  for (const col of real.columns) {
    for (const card of Object.values(col.cards)) {
      if (card.messages.length > 100) return card
    }
  }
  return Object.values(real.columns[0].cards)[0]
})()

const buildState = (tabs: number, msgsPerTab: number, columns = 3): AppState => {
  let n = 0
  const cols = Array.from({ length: columns }, (_, ci) => {
    const cards: Record<string, unknown> = {}
    const per = Math.ceil(tabs / columns)
    for (let t = 0; t < per; t++) {
      const id = `card-${ci}-${t}`
      cards[id] = {
        ...templateCard,
        id,
        status: 'idle',
        messages: Array.from({ length: msgsPerTab }, () => synthMessage(n++)),
      }
    }
    return { ...real.columns[ci % real.columns.length], id: `col-${ci}`, cards }
  })
  return { ...real, columns: cols } as AppState
}

const sizeOf = (s: AppState) => {
  let msgs = 0
  let chars = 0
  for (const c of s.columns)
    for (const card of Object.values(c.cards)) {
      msgs += card.messages.length
      for (const m of card.messages)
        chars += m.content.length + (m.meta?.structuredData?.length ?? 0)
    }
  return { msgs, chars }
}

// ---- scenario 1: real archive -------------------------------------------
console.log('=== scenario 1: REAL archive ===')
console.log('size:', JSON.stringify(sizeOf(real)), 'streamingCards=', getStreamingCardCount(real))
bench('getPersistenceVersion(real)', () => getPersistenceVersion(real) || 'x')
bench('getLiveChatContentChars(real)', () => getLiveChatContentChars(real))
bench('getStreamingCardCount(real)', () => getStreamingCardCount(real))
bench('hasStreamingCards(real)', () => hasStreamingCards(real) || 'f')
bench('isBusyStreamingState(real) [as-is]', () => isBusyStreamingState(real) || 'f')
bench('getQueuedStateSaveDelayMs(real)', () => getQueuedStateSaveDelayMs(real))
bench('shouldResetQueuedStateSaveTimer(real)', () => shouldResetQueuedStateSaveTimer(real) || 'f')
bench('shouldPauseQueuedStateSave(real)', () => shouldPauseQueuedStateSave(real) || 'f')

// the archive has 2 streaming cards -> isBusyStreamingState short-circuits.
// Force the non-streaming (normal) path so the full traversal is measured.
const realIdle = {
  ...real,
  columns: real.columns.map((c) => ({
    ...c,
    cards: Object.fromEntries(
      Object.entries(c.cards).map(([k, v]) => [k, { ...v, status: 'idle' }]),
    ),
  })),
} as AppState
console.log('--- same archive, all cards forced idle (normal path) ---')
bench('getQueuedStateSaveDelayMs(realIdle)', () => getQueuedStateSaveDelayMs(realIdle))
const effectCostReal = bench('FULL effect body (realIdle)', () => {
  if (shouldPauseQueuedStateSave(realIdle)) return 1
  const v = getPersistenceVersion(realIdle)
  return (
    v.length +
    getQueuedStateSaveDelayMs(realIdle) +
    (shouldResetQueuedStateSaveTimer(realIdle) ? 1 : 0)
  )
})

// ---- scenario 2: amplified ----------------------------------------------
console.log('\n=== scenario 2: amplified (tabs x msgs), synthetic lengths sampled from real dist ===')
const results: Array<Record<string, unknown>> = []
for (const tabs of [6, 10, 16]) {
  for (const msgs of [300, 800, 2000]) {
    const st = buildState(tabs, msgs)
    const sz = sizeOf(st)
    const label = `${tabs}tab x ${msgs}msg`
    console.log(`--- ${label} : ${sz.msgs} msgs, ${(sz.chars / 1e6).toFixed(2)}M chars ---`)
    const chars = bench(`  getLiveChatContentChars ${label}`, () => getLiveChatContentChars(st))
    const full = bench(`  FULL effect body ${label}`, () => {
      if (shouldPauseQueuedStateSave(st)) return 1
      const v = getPersistenceVersion(st)
      return (
        v.length + getQueuedStateSaveDelayMs(st) + (shouldResetQueuedStateSaveTimer(st) ? 1 : 0)
      )
    })
    results.push({ label, msgs: sz.msgs, chars: sz.chars, getLiveChatContentChars: chars, fullEffect: full })
  }
}
console.table(results)

// ---- scenario 4: what the timer actually fires (for context) ------------
console.log('\n=== context: cost of the work the effect SCHEDULES (snapshot + stringify) ===')
bench('createQueuedPersistenceStateSnapshot(realIdle)', () =>
  createQueuedPersistenceStateSnapshot(realIdle),
)
bench('JSON.stringify(real)', () => JSON.stringify(real).length)
const big = buildState(16, 2000)
bench('createQueuedPersistenceStateSnapshot(16x2000)', () =>
  createQueuedPersistenceStateSnapshot(big),
)
bench('JSON.stringify(16x2000)', () => JSON.stringify(big).length, 10)
console.log('effectCostReal', effectCostReal)
