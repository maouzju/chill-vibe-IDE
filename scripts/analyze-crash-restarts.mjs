#!/usr/bin/env node
// 一次性取证脚本：从 main.log 心跳流里区分「正常退出重启」与「硬死闪退」。
// 判据：心跳 timer 固定 2min，进程启动时 initCrashLogger() 会立即补写一条。
// 因此相邻心跳间隔明显 < 120s ⇒ 后一条是新进程的首条心跳 ⇒ 该处发生过重启。
// 重启点前若无 `process exit` 日志 ⇒ 主进程没走 JS 退出钩子 ⇒ 原生层硬死（闪退）。
import fs from 'node:fs'
import path from 'node:path'

const dataDir = process.env.CHILL_VIBE_DATA_DIR
  ?? path.join(process.env.APPDATA ?? '', 'chill-vibe-ide', 'data')
const logsDir = path.join(dataDir, 'logs')
const files = ['main.old.log', 'main.log']
  .map((f) => path.join(logsDir, f))
  .filter((f) => fs.existsSync(f))

const TS = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.\d{3}\]/
const events = []

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = TS.exec(lines[i])
    if (!m) continue
    const t = new Date(`${m[1]}T${m[2]}`)
    if (lines[i].includes('Resource heartbeat')) {
      const blob = lines.slice(i + 1, i + 10).join('\n')
      const num = (key) => {
        const r = new RegExp(`${key}:\\s*(\\d+)`).exec(blob)
        return r ? Number(r[1]) : null
      }
      events.push({
        t, kind: 'HB',
        free: num('systemFreeMb'),
        procs: num('electronProcessCount'),
        priv: num('electronPrivateMb'),
        rss: num('mainRssMb'),
      })
    } else if (lines[i].includes('process exit')) {
      events.push({ t, kind: 'EXIT' })
    }
  }
}

events.sort((a, b) => a.t - b.t)
const hb = events.filter((e) => e.kind === 'HB')
const exits = events.filter((e) => e.kind === 'EXIT').map((e) => e.t)

const fmt = (d) => d.toISOString().slice(5, 19).replace('T', ' ')
console.log(`心跳 ${hb.length} 条 | 正常退出 ${exits.length} 次 | 范围 ${fmt(hb[0].t)} → ${fmt(hb.at(-1).t)}`)

const restarts = []
for (let i = 1; i < hb.length; i++) {
  const gapS = (hb[i].t - hb[i - 1].t) / 1000
  if (gapS >= 115) continue
  const paired = exits.some((x) => x >= hb[i - 1].t && x <= new Date(hb[i].t.getTime() + 5000))
  restarts.push({ prev: hb[i - 1], next: hb[i], gapS, paired })
}

console.log(`\n重启点 ${restarts.length} 个，其中硬死 ${restarts.filter((r) => !r.paired).length} 个\n`)
for (const r of restarts) {
  const tag = r.paired ? '正常退出' : '★ 硬死闪退'
  console.log(
    `${fmt(r.prev.t)} → ${fmt(r.next.t).slice(6)} 间隔${Math.round(r.gapS)}s  ` +
    `死前: free=${r.prev.free}MB procs=${r.prev.procs} priv=${r.prev.priv}MB rss=${r.prev.rss}MB  ${tag}`,
  )
}

// 长停顿：心跳间隔远超 2min = 主进程被挂起/卡住（不一定重启）
console.log('\n=== 主进程停摆（心跳间隔 > 5min）===')
for (let i = 1; i < hb.length; i++) {
  const gapS = (hb[i].t - hb[i - 1].t) / 1000
  if (gapS > 300) {
    console.log(`${fmt(hb[i - 1].t)} → ${fmt(hb[i].t).slice(6)} 停摆 ${Math.round(gapS / 60)} 分钟  free=${hb[i - 1].free}MB`)
  }
}
