// 实证：Claude CLI 收到 interrupt 时，正在运行的子代理会怎样？
//
// 为什么需要这个脚本：这个问题不能靠读事件文本回答 —— CLI 发的 task_* 事件根本不落盘
// （只走 stream-json 广播），历史转录里查不到；而"面板空了"既可能是被杀，也可能只是
// 终态 agent 退出了面板。**唯一硬判据是子代理派生的那个真实进程还在不在。**
//
// 用法（Windows PowerShell / bash 均可）：
//   node scripts/probe-claude-subagent-interrupt.mjs           # 打断实验
//   node scripts/probe-claude-subagent-interrupt.mjs --normal  # 不打断的对照实验
//
// 2026-08-16 对 claude 2.1.206 的实测结果（AGENTS.md pitfall #320）：
//   打断组：marker 进程 4 → 0（打断后 45 秒恒为 0）；CLI 在 9ms 内发
//           task_updated {"status":"killed"} + task_notification {"status":"stopped"}
//   对照组：全程发 task_updated / task_notification {"status":"completed"}
//   → 结论：打断确实当场掐死在跑的子代理；且 killed/stopped 是当前版本真实会发的值，
//     不是"未来可能新增的未知终态"，所以 mapTerminalStatus 必须显式接住它们。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NORMAL_RUN = process.argv.includes('--normal')
const MARKER = 'SUBAGENT_PROBE_7f3a91'
const MODEL = process.env.PROBE_MODEL || 'claude-haiku-4-5-20251001'
const SLEEP_SECONDS = NORMAL_RUN ? 5 : 150

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-subagent-probe-'))
const eventsPath = path.join(workDir, 'events.jsonl')

const t0 = Date.now()
const note = (line) => console.log(`[${String(Date.now() - t0).padStart(6, ' ')}ms] ${line}`)

// 数命令行里带 MARKER 的活进程 —— 子代理是否还在真干活的物理证据。
// 非 Windows 上退化成 pgrep，拿不到就返回 -1（表示本平台无法取证，而不是谎报 0）。
const countMarkerProcesses = () => {
  if (process.platform === 'win32') {
    const res = spawnSync('powershell', ['-NoProfile', '-Command',
      `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${MARKER}*' -and $_.ProcessId -ne $PID }).Count`],
      { encoding: 'utf8' })
    const n = Number((res.stdout || '').trim())
    return Number.isFinite(n) ? n : -1
  }
  const res = spawnSync('pgrep', ['-fc', MARKER], { encoding: 'utf8' })
  const n = Number((res.stdout || '').trim())
  return Number.isFinite(n) ? n : 0
}

const sleepCommand = process.platform === 'win32'
  ? `powershell -NoProfile -Command \\"Start-Sleep -Seconds ${SLEEP_SECONDS}; Write-Output ${MARKER}_DONE\\"`
  : `sh -c 'sleep ${SLEEP_SECONDS}; echo ${MARKER}_DONE'`

// Windows 上 claude 是 .cmd shim，Node 20+ 拒绝直接 spawn，必须 shell:true（pitfall #283 同源）
const child = spawn('claude',
  ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    '--model', MODEL, '--dangerously-skip-permissions'],
  { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], shell: true })

const statusSeen = []
let interruptSent = false
let finished = false

const finish = (why) => {
  if (finished) return
  finished = true
  note(`FINAL marker procs = ${countMarkerProcesses()}  (${why})`)
  note(`task status values seen: ${JSON.stringify(statusSeen)}`)
  note(`raw events: ${eventsPath}`)
  try { child.kill() } catch { /* already gone */ }
  setTimeout(() => process.exit(0), 800)
}

const sendInterrupt = (why) => {
  if (interruptSent) return
  interruptSent = true
  note(`>>> marker procs BEFORE interrupt = ${countMarkerProcesses()}  (trigger: ${why})`)
  child.stdin.write(JSON.stringify({
    type: 'control_request', request_id: 'probe-int-1', request: { subtype: 'interrupt' },
  }) + '\n')
  note('>>> interrupt control_request written to stdin')
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
    note(`    t+${ticks * 5}s after interrupt: marker procs = ${countMarkerProcesses()}`)
    if (ticks >= 9) { clearInterval(timer); finish('interrupt run complete') }
  }, 5000)
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
    const subtype = typeof evt.subtype === 'string' ? evt.subtype : ''
    if (subtype.startsWith('task')) {
      const status = evt.status ?? evt.patch?.status
      note(`EVENT ${subtype}${status ? ` status=${status}` : ''} ${JSON.stringify(evt).slice(0, 200)}`)
      if (status) statusSeen.push(`${subtype}:${status}`)
    } else if (evt.type === 'control_response' || evt.type === 'result') {
      note(`EVENT ${evt.type} ${JSON.stringify(evt).slice(0, 200)}`)
      // 注意：主 agent 的 result 不代表子代理跑完了 —— 它派发完就回话，子代理还在后台跑。
      // 对照组必须等 marker 进程自己归零（命令真跑完）再收，否则一个终态事件都抓不到。
      if (evt.type === 'result' && interruptSent) setTimeout(() => finish('result received'), 12000)
    }
  }
})

child.stderr.on('data', (d) => note(`STDERR ${d.toString().trim().slice(0, 200)}`))
child.on('exit', (code) => { note(`claude exited code=${code}`); setTimeout(() => finish('cli exited'), 500) })

if (!NORMAL_RUN) {
  // 只要那个真实进程起来了就打断 —— 不依赖模型是否规规矩矩发事件
  const watcher = setInterval(() => {
    if (interruptSent) { clearInterval(watcher); return }
    const n = countMarkerProcesses()
    if (n > 0) {
      clearInterval(watcher)
      note(`marker process detected (${n}) — the subagent's command is genuinely running`)
      setTimeout(() => sendInterrupt('marker process alive'), 3000)
    }
  }, 2000)
  setTimeout(() => { if (!interruptSent) sendInterrupt('timeout waiting for marker') }, 120000)
} else {
  // 对照组：等子代理的命令自然跑完（marker 归零），再留 6 秒收 CLI 的终态事件
  let sawMarker = false
  const watcher = setInterval(() => {
    const n = countMarkerProcesses()
    if (n > 0) { sawMarker = true; return }
    if (!sawMarker) return
    clearInterval(watcher)
    note('marker process exited on its own — subagent finished naturally')
    setTimeout(() => finish('control run complete'), 6000)
  }, 2000)
}
setTimeout(() => finish('overall timeout'), 240000)

const prompt = `Use the Task tool RIGHT NOW to launch exactly one subagent (subagent_type: general-purpose). Give that subagent exactly this instruction, verbatim:

"Run this command with the Bash tool and wait for it to complete: ${sleepCommand} . That command takes ${SLEEP_SECONDS} seconds. Just run it and wait. Then report exactly what it printed. Do nothing else."

Launch the subagent immediately as your very first action. Do not run any command yourself.`

child.stdin.write(JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] },
}) + '\n')
note(`${NORMAL_RUN ? 'control (no interrupt)' : 'interrupt'} run started in ${workDir}`)
