// 实证：后台子代理（Agent run_in_background）能不能活过"根回合结束 → 下一条 user 消息"的边界？
//
// 为什么需要这个脚本：probe-claude-subagent-interrupt.mjs 只回答了"打断会不会杀子代理"（会）。
// 用户报「输入消息就会导致子 agent UI 消失」，IDE 里流式中左键发送 = 先软打断再发，
// 右键发送 = 等回合结束再发。要给用户一个可靠的操作建议，必须实证第二条路径：
// 根回合已 end_turn、子代理仍在后台跑，此时**不打断**直接写下一条 user 消息，
// 子代理派生的真实进程是否还在，CLI 是否还继续广播 task_* 事件。
//
// 用法：node scripts/probe-claude-subagent-next-turn.mjs
// 判据只取"命令行带 MARKER 的活进程数"，不信事件文本。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MARKER = 'SUBAGENT_NEXTTURN_PROBE_5b2c'
const MODEL = process.env.PROBE_MODEL || 'claude-haiku-4-5-20251001'
const SLEEP_SECONDS = 150

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-subagent-nextturn-'))
const eventsPath = path.join(workDir, 'events.jsonl')

const t0 = Date.now()
const note = (line) => console.log(`[${String(Date.now() - t0).padStart(6, ' ')}ms] ${line}`)

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

const child = spawn('claude',
  ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    '--model', MODEL, '--dangerously-skip-permissions'],
  { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], shell: true })

const taskEventsByTurn = { turn1: [], turn2: [], afterTurn2: [] }
let phase = 'turn1'
let resultCount = 0
let finished = false
let interruptSent = false
const procSamples = []

const sample = (label) => {
  const n = countMarkerProcesses()
  procSamples.push({ t: Date.now() - t0, phase, label, n })
  note(`marker procs = ${n}  (${label})`)
  return n
}

const finish = (why) => {
  if (finished) return
  finished = true
  sample(`FINAL / ${why}`)
  note(`task events per phase: turn1=${taskEventsByTurn.turn1.length} turn2=${taskEventsByTurn.turn2.length} afterTurn2=${taskEventsByTurn.afterTurn2.length}`)
  note(`task status values: ${JSON.stringify({
    turn1: taskEventsByTurn.turn1, turn2: taskEventsByTurn.turn2, afterTurn2: taskEventsByTurn.afterTurn2,
  })}`)
  note(`proc samples: ${JSON.stringify(procSamples)}`)
  note(`raw events: ${eventsPath}`)
  try { child.kill() } catch { /* already gone */ }
  setTimeout(() => process.exit(0), 800)
}

const writeUser = (text) => {
  child.stdin.write(JSON.stringify({
    type: 'user', message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n')
}

const sendInterrupt = () => {
  if (interruptSent) return
  interruptSent = true
  sample('BEFORE interrupt (same session, after turn2)')
  child.stdin.write(JSON.stringify({
    type: 'control_request', request_id: 'probe-int-1', request: { subtype: 'interrupt' },
  }) + '\n')
  note('>>> interrupt control_request written')
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
    sample(`t+${ticks * 5}s after interrupt`)
    if (ticks >= 4) { clearInterval(timer); finish('interrupt phase complete') }
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
      const bucket = phase === 'turn1' ? 'turn1' : phase === 'turn2' ? 'turn2' : 'afterTurn2'
      taskEventsByTurn[bucket].push(`${subtype}${status ? `:${status}` : ''}`)
      note(`EVENT[${phase}] ${subtype}${status ? ` status=${status}` : ''} ${JSON.stringify(evt).slice(0, 160)}`)
    } else if (evt.type === 'result') {
      resultCount += 1
      note(`EVENT result #${resultCount} subtype=${evt.subtype} ${JSON.stringify(evt).slice(0, 160)}`)
      if (resultCount === 1) {
        sample('right after turn1 result')
        setTimeout(() => {
          sample('5s after turn1 result, about to write turn2 user message (NO interrupt)')
          phase = 'turn2'
          writeUser('Reply with exactly the single word OK and nothing else. Do not use any tools. Do not wait for anything.')
          note('>>> turn2 user message written (no interrupt)')
        }, 5000)
      } else if (resultCount === 2) {
        phase = 'afterTurn2'
        sample('right after turn2 result')
        let ticks = 0
        const timer = setInterval(() => {
          ticks += 1
          const n = sample(`t+${ticks * 5}s after turn2 result (idle, no interrupt)`)
          if (ticks >= 6 || n === 0) {
            clearInterval(timer)
            if (n > 0) sendInterrupt()
            else finish('marker exited naturally after turn2')
          }
        }, 5000)
      }
    } else if (evt.type === 'system' && (subtype === 'background_tasks_changed' || subtype === 'agents_killed')) {
      note(`EVENT[${phase}] system:${subtype} ${JSON.stringify(evt).slice(0, 200)}`)
    }
  }
})

child.stderr.on('data', (d) => note(`STDERR ${d.toString().trim().slice(0, 200)}`))
child.on('exit', (code) => { note(`claude exited code=${code}`); setTimeout(() => finish('cli exited'), 500) })

// 起始 marker 检测：确认子代理的命令真的起来了
const watcher = setInterval(() => {
  const n = countMarkerProcesses()
  if (n > 0) {
    clearInterval(watcher)
    note(`marker process detected (${n}) — the background subagent's command is genuinely running`)
  }
}, 2000)
setTimeout(() => finish('overall timeout'), 300000)

const prompt = `Use the Agent tool RIGHT NOW with run_in_background: true to launch exactly one subagent (subagent_type: general-purpose). Give that subagent exactly this instruction, verbatim:

"Run this command with the Bash tool and wait for it to complete: ${sleepCommand} . That command takes ${SLEEP_SECONDS} seconds. Just run it and wait. Then report exactly what it printed. Do nothing else."

Launch the subagent immediately as your very first action with run_in_background set to true. Do NOT wait for it to finish. After launching, reply with exactly the word LAUNCHED and end your turn. Do not run any command yourself.`

writeUser(prompt)
note(`next-turn probe started in ${workDir}`)
