// 实证：会话里挂着后台子代理时整棵进程树被杀（= 关 IDE），新进程 `--resume` 后再写一条 user 消息，
// CLI 的 stdout 上会先出现什么？
//
// 背景（2026-11-27 用户报「重启恢复会话多开一个循环重复的窗口 / 恢复的窗口一两秒又停下」）：
// 用户真实 state.json 里，带被打断子代理的 3 张卡在续跑后 ~1s 各多了一条用量全 0 的 run-duration，
// 原生转录同一秒 CLI 自己入队了一条 `<task-notification> … didn't finish before the previous session ended`。
// 怀疑：CLI 把这条自产通知当成一轮先收尾（发一个零用量 result），我们写进去的续跑提示才是第二轮。
//
// 阶段 1：新进程让模型派一个后台子代理（长 sleep），回 LAUNCHED 收尾后，taskkill /T /F 整棵树。
// 阶段 2：`--resume <sid>` 新进程，spawn 后立刻写续跑提示（与应用一致），逐条打印顶层事件和每个 result。
// 判据：阶段 2 出现 ≥2 个 result，且第一个 result 早于任何 message_start = 假完成被实证。
// 用法：node scripts/probe-claude-resume-killed-agents.mjs
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MODEL = process.env.PROBE_MODEL || 'claude-haiku-5-5'
const SLEEP_SECONDS = 240
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-resume-killed-agents-'))
const t00 = Date.now()
const note = (line) => console.log(`[${String(Date.now() - t00).padStart(6, ' ')}ms] ${line}`)

const baseArgs = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
  '--include-partial-messages', '--model', MODEL, '--dangerously-skip-permissions']
const userLine = (text) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'

const startCli = (extraArgs, tag, rawPath) => {
  const child = spawn('claude', [...baseArgs, ...extraArgs], { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], shell: true })
  const t0 = Date.now()
  const events = []
  let sessionId = null
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      fs.appendFileSync(rawPath, line + '\n')
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (o.session_id) sessionId = o.session_id
      const at = Date.now() - t0
      events.push({ at, o })
      if (o.parent_tool_use_id) continue
      if (o.type === 'result') {
        note(`${tag} <<< [${at}ms] RESULT subtype=${o.subtype} is_error=${o.is_error} terminal=${o.terminal_reason ?? '-'} stop=${o.stop_reason ?? '-'} `
          + `numTurns=${o.num_turns} cost=${o.total_cost_usd} out=${o.usage?.output_tokens} text=${JSON.stringify(String(o.result ?? '').slice(0, 80))}`)
      } else if (o.type === 'stream_event') {
        if (o.event?.type === 'message_start') note(`${tag} <<< [${at}ms] stream_event/message_start`)
      } else if (o.type === 'assistant' || o.type === 'user') {
        const c = o.message?.content
        const t = typeof c === 'string' ? c : (c ?? []).map((b) => b.text ?? `[${b.type}]`).join('')
        note(`${tag} <<< [${at}ms] ${o.type}${o.isSynthetic ? '(synthetic)' : ''}${o.isReplay ? '(replay)' : ''} ${JSON.stringify(t.slice(0, 90))}`)
      } else {
        note(`${tag} <<< [${at}ms] ${o.type}/${o.subtype ?? ''} ${o.status ? `status=${o.status}` : ''}`)
      }
    }
  })
  child.stderr.on('data', (d) => note(`${tag} STDERR ${d.toString().trim().slice(0, 200)}`))
  return { child, events, sessionId: () => sessionId, write: (line) => child.stdin.write(line) }
}

const waitFor = async (cli, pred, ms) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const hit = cli.events.find((e) => pred(e.o))
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

const killTree = (pid) => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'])
  else try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
}

const sleepCommand = process.platform === 'win32'
  ? `powershell -NoProfile -Command \\"Start-Sleep -Seconds ${SLEEP_SECONDS}\\"`
  : `sleep ${SLEEP_SECONDS}`

note(`probe dir ${workDir}, model ${MODEL}`)
const first = startCli([], 'P1', path.join(workDir, 'phase1.jsonl'))
first.write(userLine(`Use the Agent tool RIGHT NOW with run_in_background: true to launch exactly one subagent (subagent_type: general-purpose). Give it exactly this instruction: "Run this command with the Bash tool and wait for it to complete: ${sleepCommand} . Then reply DONE." Do NOT wait for it. After launching, reply with exactly the word LAUNCHED and end your turn. Do not run any command yourself.`))
const firstResult = await waitFor(first, (o) => o.type === 'result' && !o.parent_tool_use_id, 120_000)
const sid = first.sessionId()
note(`P1 result seen=${Boolean(firstResult)} session=${sid}`)
await new Promise((r) => setTimeout(r, 4000))
note('P1 >>> kill whole process tree (simulates closing the IDE)')
killTree(first.child.pid)
await new Promise((r) => setTimeout(r, 2000))

if (!sid) {
  note('no session id; abort')
  process.exit(1)
}

const second = startCli(['--resume', sid], 'P2', path.join(workDir, 'phase2.jsonl'))
note('P2 >>> write resume prompt immediately after spawn')
second.write(userLine('The IDE was closed while this turn was running and has just been reopened. Do not relaunch anything. Reply with exactly the single word RESUMED and end your turn.'))

const firstP2 = await waitFor(second, (o) => o.type === 'result' && !o.parent_tool_use_id, 120_000)
if (firstP2) await new Promise((r) => setTimeout(r, 30_000))
const results = second.events.filter((e) => e.o.type === 'result' && !e.o.parent_tool_use_id)
const firstMessageStart = second.events.find((e) => e.o.type === 'stream_event' && e.o.event?.type === 'message_start' && !e.o.parent_tool_use_id)
note(`P2 VERDICT results=${results.length} firstResultAt=${results[0]?.at}ms firstMessageStartAt=${firstMessageStart?.at ?? 'none'}ms`)
results.forEach((r, i) => note(`P2 result#${i + 1} at=${r.at}ms raw=${JSON.stringify(r.o).slice(0, 700)}`))
killTree(second.child.pid)
note(`raw events: ${workDir}`)
setTimeout(() => process.exit(0), 500)
