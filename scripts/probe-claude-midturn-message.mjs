// 实证：回合进行中（主 agent 正在跑自己的工具、后台子代理也在跑）**不打断**，直接往 stdin 写一条
// 新 user 消息，CLI 会怎么处理？
//   A. 当场插进本轮（下一个工具边界就让模型看到）——「立马发送且不杀子代理」可行；
//   B. 排到本轮 result 之后当新回合——等于延后发送；
//   C. 丢弃 / 报错。
// 同时全程数子代理命令行 marker 的活进程，判断子代理是否存活。
//
// 用法：node scripts/probe-claude-midturn-message.mjs   （PROBE_MODEL 可覆盖模型）
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MARKER = 'MIDTURN_PROBE_SUB_7c1e'
const MAIN_MARKER = 'MIDTURN_PROBE_MAIN_7c1e'
const CODEWORD = 'PINEAPPLE42'
const MODEL = process.env.PROBE_MODEL || 'claude-haiku-5-5'
const SUB_SLEEP = 120
const MAIN_SLEEP = 45

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-midturn-'))
const eventsPath = path.join(workDir, 'events.jsonl')
const t0 = Date.now()
const note = (line) => console.log(`[${String(Date.now() - t0).padStart(6, ' ')}ms] ${line}`)

const countProcs = (marker) => {
  const res = spawnSync('powershell', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.Name -ne 'powershell.exe' -or ($_.CommandLine -like '*Start-Sleep*${marker}*') } | Where-Object { $_.ProcessId -ne $PID }).Count`],
    { encoding: 'utf8' })
  const n = Number((res.stdout || '').trim())
  return Number.isFinite(n) ? n : -1
}
const sample = (label) => note(`procs sub=${countProcs(MARKER)} main=${countProcs(MAIN_MARKER)}  (${label})`)

const sleepCmd = (secs, marker) =>
  `powershell -NoProfile -Command \\"Start-Sleep -Seconds ${secs}; Write-Output ${marker}_DONE\\"`

const child = spawn('claude',
  ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    '--model', MODEL, '--dangerously-skip-permissions'],
  { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], shell: true })

const writeUser = (text) => child.stdin.write(JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'text', text }] },
}) + '\n')

let results = 0
let midSent = false
let midSentAt = 0
let codewordSeenAt = 0
let finished = false
const finish = (why) => {
  if (finished) return
  finished = true
  sample(`FINAL ${why}`)
  note(`mid message sent at ${midSentAt}ms; codeword first seen at ${codewordSeenAt || 'never'}ms; results=${results}`)
  note(`raw events: ${eventsPath}`)
  try { child.kill() } catch {}
  setTimeout(() => process.exit(0), 800)
}

let buf = ''
child.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    fs.appendFileSync(eventsPath, line + '\n')
    let evt
    try { evt = JSON.parse(line) } catch { continue }
    const sub = typeof evt.subtype === 'string' ? evt.subtype : ''
    if (line.includes(CODEWORD) && midSent && !codewordSeenAt && evt.type === 'assistant') {
      codewordSeenAt = Date.now() - t0
      note(`>>> CODEWORD in assistant output (results so far=${results}) ${line.slice(0, 200)}`)
    }
    if (evt.type === 'user' && line.includes(CODEWORD)) note(`EVENT user echo w/ codeword: ${line.slice(0, 300)}`)
    if (evt.type === 'assistant') {
      for (const c of evt.message?.content ?? []) {
        if (c.type === 'tool_use') note(`EVENT tool_use ${c.name} ${JSON.stringify(c.input).slice(0, 120)}`)
        if (c.type === 'text') note(`EVENT text ${c.text.slice(0, 120)}`)
      }
    }
    if (sub.startsWith('task') || sub === 'background_tasks_changed' || sub === 'agents_killed') {
      note(`EVENT ${sub} ${JSON.stringify(evt).slice(0, 160)}`)
    }
    if (evt.type === 'system' && !sub.startsWith('task') && sub !== 'init') note(`EVENT system:${sub} ${line.slice(0, 200)}`)
    if (evt.type === 'result') {
      results += 1
      note(`EVENT result #${results} ${evt.subtype} ${String(evt.result ?? '').slice(0, 120)}`)
      sample(`after result #${results}`)
      if (results >= 2 || (results === 1 && codewordSeenAt)) setTimeout(() => finish('done'), 8000)
    }
  }
})
child.stderr.on('data', (d) => note(`STDERR ${d.toString().trim().slice(0, 200)}`))
child.on('exit', (code) => { note(`exit ${code}`); setTimeout(() => finish('cli exited'), 500) })

// 主 agent 的 sleep 起来后再写中途消息
const watcher = setInterval(() => {
  if (midSent) return
  const main = countProcs(MAIN_MARKER)
  const subN = countProcs(MARKER)
  if (main > 0 && subN > 0) {
    midSent = true
    midSentAt = Date.now() - t0
    sample('before mid-turn message')
    writeUser(`NEW MESSAGE FROM USER: as soon as you see this, reply with the word ${CODEWORD}.`)
    note('>>> mid-turn user message written (NO interrupt)')
    let ticks = 0
    const t = setInterval(() => { ticks += 1; sample(`t+${ticks * 5}s after mid msg`); if (ticks >= 20 || finished) clearInterval(t) }, 5000)
  }
}, 1500)
setTimeout(() => finish('overall timeout'), 280000)

writeUser(`Do these two steps in order.
Step 1: Use the Agent tool with run_in_background: true to launch one general-purpose subagent with this exact instruction: "Run this with the Bash tool and wait for it: ${sleepCmd(SUB_SLEEP, MARKER)} . Then report what it printed."
Step 2: Right after launching, YOU run this yourself with the Bash tool (foreground, wait for it): ${sleepCmd(MAIN_SLEEP, MAIN_MARKER)}
After step 2 finishes, say DONE.`)
note(`probe started in ${workDir}`)
