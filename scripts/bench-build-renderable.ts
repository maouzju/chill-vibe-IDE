// 一次性取证基准：用真实 session-history sidecar 数据测 buildRenderableMessages 成本
// 用法: node --import tsx scripts/bench-build-renderable.ts
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildRenderableMessages } from '../src/components/chat-card-parsing'

const dir = join(process.env.APPDATA ?? '', 'chill-vibe-ide', 'data', 'session-history')
const files = readdirSync(dir)
  .map((f) => ({ f, size: statSync(join(dir, f)).size }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 6)

type Msg = { role?: string; content?: string; meta?: unknown }
const load = (f: string) => {
  const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { messages?: Msg[]; title?: string }
  return { title: s.title ?? f.slice(0, 8), messages: s.messages ?? [] }
}

const timeOnce = (fn: () => void) => {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

console.log('== 单次 buildRenderableMessages 成本（真实会话，5 次取中位） ==')
for (const { f, size } of files) {
  const { title, messages } = load(f)
  if (!messages.length) continue
  const chars = messages.reduce((a, m) => a + (m.content?.length ?? 0), 0)
  const runs: number[] = []
  for (let i = 0; i < 5; i++) {
    const msgs = messages.map((m) => ({ ...m })) as Parameters<typeof buildRenderableMessages>[0]
    runs.push(timeOnce(() => buildRenderableMessages(msgs)))
  }
  console.log(
    `  [${title.slice(0, 20)}] msgs=${messages.length} chars=${chars} fileKB=${Math.round(size / 1024)} -> median ${median(runs).toFixed(1)}ms (max ${Math.max(...runs).toFixed(1)})`,
  )
}

// 模拟 streaming：最大会话，最长 assistant 消息作为流式尾部，每 4KB delta 全量重算
const biggest = load(files[0]!.f)
const tailIdx = biggest.messages.reduce(
  (best, m, i) => ((m.content?.length ?? 0) > (biggest.messages[best]?.content?.length ?? 0) ? i : best),
  0,
)
const fullTail = biggest.messages[tailIdx]!.content ?? ''
const baseMsgs = biggest.messages.slice(0, tailIdx)
console.log(
  `\n== 模拟 streaming（[${biggest.title?.slice(0, 20)}]，前 ${baseMsgs.length} 条为历史，尾消息流到 ${fullTail.length} 字符，每 4KB delta 重算） ==`,
)
const deltaSize = 4096
let cum = 0
let worst = 0
const samples: Array<{ chars: number; ms: number }> = []
for (let end = deltaSize; end <= fullTail.length + deltaSize - 1; end += deltaSize) {
  const cut = Math.min(end, fullTail.length)
  const msgs = [
    ...baseMsgs.map((m) => ({ ...m })),
    { ...biggest.messages[tailIdx]!, content: fullTail.slice(0, cut) },
  ] as Parameters<typeof buildRenderableMessages>[0]
  const ms = timeOnce(() => buildRenderableMessages(msgs))
  cum += ms
  worst = Math.max(worst, ms)
  samples.push({ chars: cut, ms })
}
const step = Math.max(1, Math.floor(samples.length / 12))
for (let i = 0; i < samples.length; i += step) {
  const p = samples[i]!
  console.log(`  tailChars=${p.chars} -> ${p.ms.toFixed(1)}ms`)
}
const last = samples[samples.length - 1]!
console.log(`  tailChars=${last.chars} -> ${last.ms.toFixed(1)}ms (final)`)
console.log(`  单卡整条流累计: ${cum.toFixed(0)}ms over ${samples.length} deltas, 单次最差 ${worst.toFixed(1)}ms`)
console.log(`  ×5 pane 粗估累计: ${(cum * 5).toFixed(0)}ms`)
