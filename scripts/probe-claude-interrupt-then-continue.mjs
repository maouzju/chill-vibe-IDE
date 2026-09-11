// 实证：软打断（control_request interrupt）之后，**同一个 CLI 进程、同一个 session** 还能不能
// 直接接着收下一条 user 消息并正常回复？上下文是否保留？`--resume` 同一 session 是否也可行？
//
// 为什么需要这个脚本：pitfall #118 要求"用户打断后一律开新 session"，其前提是旧实现硬 kill
// 进程导致原生 jsonl 没收尾、复用会 400。软打断上线后（2026-08-09）这个前提可能已不成立，
// 但 src/state.ts finishStoppedStream 仍在打断时清空 sessionId → 排队消息以 seeded 新会话发出、
// 旧进程被会话池 kill。拆那层补偿之前，必须先证明 CLI 层面"打断后继续"是干净的。
//
// 用法：node scripts/probe-claude-interrupt-then-continue.mjs
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MARKER = 'INTERRUPT_CONTINUE_PROBE_9e4d'
const MODEL = process.env.PROBE_MODEL || 'claude-haiku-4-5-20251001'
const SLEEP_SECONDS = 120

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-int-continue-'))
const eventsPath = path.join(workDir, 'events.jsonl')
const t0 = Date.now()
const note = (line) => console.log(`[${String(Date.now() - t0).padStart(6, ' ')}ms] ${line}`)

const countMarkerProcesses = () => {
  const res = spawnSync('powershell', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${MARKER}*' -and $_.ProcessId -ne $PID }).Count`],
    { encoding: 'utf8' })
  const n = Number((res.stdout || '').trim())
  return Number.isFinite(n) ? n : -1
}

const sleepCommand = `powershell -NoProfile -Command \\"Start-Sleep -Seconds ${SLEEP_SECONDS}; Write-Output ${MARKER}_DONE\\"`

const child = spawn('claude',
  ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    '--model', MODEL, '--dangerously-skip-permissions'],
  { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], shell: true })

let sessionId = null
let resultCount = 0
let interruptSent = false
let finished = false
const results = []

const writeUser = (text) => {
  child.stdin.write(JSON.stringify({
    type: 'user', message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n')
}

const finish = async (why) => {
  if (finished) return
  finished = true
  note(`marker procs at finish = ${countMarkerProcesses()} (${why})`)
  note(`results: ${JSON.stringify(results)}`)
  try { child.kill() } catch { /* gone */ }
  // 第二段：进程已死，用 --resume 同一 session 再发一条，模拟"会话池没有活进程但 sessionId 还在"
  if (sessionId) {
    await new Promise((r) => setTimeout(r, 1500))
    note(`>>> resuming session ${sessionId} in a NEW process via --resume`)
    const res = spawnSync('claude',
      ['-p', '--output-format', 'json', '--resume', sessionId, '--model', MODEL, '--dangerously-skip-permissions',
        '"In one line: what command did I ask you to run before I interrupted you? Do not run anything."'],
      { cwd: workDir, encoding: 'utf8', shell: true, timeout: 120000 })
    note(`resume exit=${res.status} stderr=${(res.stderr || '').trim().slice(0, 300)}`)
    try {
      const parsed = JSON.parse(res.stdout)
      note(`resume result: is_error=${parsed.is_error} subtype=${parsed.subtype} result=${JSON.stringify(parsed.result).slice(0, 300)}`)
    } catch {
      note(`resume raw stdout: ${(res.stdout || '').slice(0, 400)}`)
    }
  }
  note(`raw events: ${eventsPath}`)
  setTimeout(() => process.exit(0), 300)
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
    if (evt.session_id && !sessionId) sessionId = evt.session_id
    if (evt.type === 'control_response') {
      note(`EVENT control_response ${JSON.stringify(evt).slice(0, 200)}`)
    } else if (evt.type === 'result') {
      resultCount += 1
      const summary = {
        n: resultCount, subtype: evt.subtype, is_error: evt.is_error, stop_reason: evt.stop_reason,
        result: typeof evt.result === 'string' ? evt.result.slice(0, 200) : evt.result,
      }
      results.push(summary)
      note(`EVENT result #${resultCount} ${JSON.stringify(summary)}`)
      if (resultCount === 1) {
        note(`marker procs after interrupt result = ${countMarkerProcesses()}`)
        setTimeout(() => {
          note('>>> turn2 user message written on the SAME process/session (after interrupt)')
          writeUser('Reply with exactly the single word OK and nothing else. Do not use any tools.')
        }, 1500)
      } else if (resultCount === 2) {
        setTimeout(() => {
          note('>>> turn3 user message written (context check)')
          writeUser('In one line: what command did I ask you to run before I interrupted you? Do not run anything.')
        }, 500)
      } else if (resultCount === 3) {
        setTimeout(() => void finish('three turns done'), 500)
      }
    } else if (evt.type === 'assistant') {
      const text = (evt.message?.content ?? []).map((c) => c.type === 'text' ? c.text : c.type === 'tool_use' ? `[tool_use ${c.name}]` : '').join('')
      if (text) note(`ASSISTANT ${text.slice(0, 160)}`)
    }
  }
})
child.stderr.on('data', (d) => note(`STDERR ${d.toString().trim().slice(0, 200)}`))
child.on('exit', (code) => { note(`claude exited code=${code}`); if (!finished) setTimeout(() => void finish('cli exited'), 300) })

const watcher = setInterval(() => {
  if (interruptSent) { clearInterval(watcher); return }
  const n = countMarkerProcesses()
  if (n > 0) {
    clearInterval(watcher)
    note(`marker process detected (${n}) — the command is genuinely running`)
    setTimeout(() => {
      interruptSent = true
      note(`>>> sending soft interrupt (marker procs = ${countMarkerProcesses()})`)
      child.stdin.write(JSON.stringify({
        type: 'control_request', request_id: 'probe-int-1', request: { subtype: 'interrupt' },
      }) + '\n')
    }, 3000)
  }
}, 2000)
setTimeout(() => void finish('overall timeout'), 240000)

writeUser(`Run this command with the Bash tool RIGHT NOW and wait for it to complete: ${sleepCommand} . It takes ${SLEEP_SECONDS} seconds. Just run it and wait, then report exactly what it printed. Do nothing else first.`)
note(`interrupt-then-continue probe started in ${workDir}`)
