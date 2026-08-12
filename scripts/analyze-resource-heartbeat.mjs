// 回答一个具体问题：用户报"用久了变卡、重启就好"，那到底是什么在随运行时长累积？
//
// main.log 里 `[main] Resource heartbeat.` 每条都带主进程 RSS / 堆 / 全 Electron 进程
// 私有内存。把它们按"距本次启动多久"排成序列，累积就藏不住了：单调爬升说明是进程内
// 泄漏（重启清零，与"重启就好"吻合），锯齿状说明是 GC 能收回的正常波动。
//
// 为什么不能只看最后几条 —— 绝对值高低取决于用户当时开了多少卡片，只有同一次启动内的
// 斜率才能把"泄漏"和"本来就开得多"区分开。

import { readFile } from 'node:fs/promises'
import path from 'node:path'

const logPath =
  process.argv[2] ??
  path.join(
    process.env.APPDATA ?? '',
    'chill-vibe-ide',
    'data',
    'logs',
    'main.log',
  )

const text = await readFile(logPath, 'utf8')
const lines = text.split(/\r?\n/)

const numberField = (block, key) => {
  const match = block.match(new RegExp(`${key}:\\s*(-?\\d+)`))
  return match ? Number(match[1]) : null
}

/** 启动标记：重启后计时归零，否则跨启动的曲线会被接成假的锯齿。 */
const bootPattern = /Resource heartbeat|app ready|\[main\] Starting|Electron app ready/i

const samples = []
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index]
  const stamp = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)
  if (!stamp || !line.includes('Resource heartbeat.')) {
    continue
  }

  const block = lines.slice(index, index + 16).join('\n')
  samples.push({
    at: new Date(stamp[1].replace(' ', 'T')),
    rss: numberField(block, 'mainRssMb'),
    heap: numberField(block, 'mainHeapUsedMb'),
    external: numberField(block, 'mainExternalMb'),
    privateMb: numberField(block, 'electronPrivateMb'),
    workingSet: numberField(block, 'electronWorkingSetMb'),
    processCount: numberField(block, 'electronProcessCount'),
  })
}

if (samples.length === 0) {
  console.log(`没有解析到心跳样本：${logPath}`)
  process.exit(0)
}

// 心跳间隔固定；间隔一旦远大于常态就说明中间重启过，从这里切一段新的运行。
const gapMinutesThatMeansRestart = 10
const runs = []
let current = null
for (const sample of samples) {
  const gapMinutes = current
    ? (sample.at - current.samples.at(-1).at) / 60000
    : Infinity
  if (gapMinutes > gapMinutesThatMeansRestart) {
    current = { samples: [] }
    runs.push(current)
  }
  current.samples.push(sample)
}

const format = (date) =>
  `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

console.log(`日志：${logPath}`)
console.log(`心跳样本 ${samples.length} 条，切出 ${runs.length} 段运行\n`)

const longest = [...runs].sort(
  (a, b) =>
    b.samples.at(-1).at - b.samples[0].at - (a.samples.at(-1).at - a.samples[0].at),
)

for (const run of longest.slice(0, 5)) {
  const first = run.samples[0]
  const last = run.samples.at(-1)
  const hours = (last.at - first.at) / 3600000
  if (hours < 0.5) {
    continue
  }

  console.log(
    `── 运行 ${format(first.at)} → ${format(last.at)}（${hours.toFixed(1)}h，${run.samples.length} 条）`,
  )

  for (const [label, key] of [
    ['主进程 RSS', 'rss'],
    ['主进程堆', 'heap'],
    ['主进程 external', 'external'],
    ['全进程私有内存', 'privateMb'],
    ['全进程工作集', 'workingSet'],
  ]) {
    const series = run.samples.map((sample) => sample[key]).filter((value) => value !== null)
    if (series.length === 0) {
      continue
    }
    const start = series[0]
    const end = series.at(-1)
    const peak = Math.max(...series)
    const growthPerHour = hours > 0 ? (end - start) / hours : 0
    console.log(
      `   ${label.padEnd(16)} 起 ${String(start).padStart(5)}MB → 终 ${String(end).padStart(5)}MB  峰 ${String(peak).padStart(5)}MB  斜率 ${growthPerHour >= 0 ? '+' : ''}${growthPerHour.toFixed(0)}MB/h`,
    )
  }

  const counts = [...new Set(run.samples.map((sample) => sample.processCount))]
  console.log(`   Electron 进程数   ${counts.join(' → ')}`)
  console.log()
}
