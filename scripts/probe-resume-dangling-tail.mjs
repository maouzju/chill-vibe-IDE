// 实证：会话末尾是「被中断的一轮」时，新起一个 `--resume` 进程再写 "Please continue."，
// CLI 自己会不会把这一轮当场 abort（terminal_reason=aborted_streaming）——没有任何外部 interrupt。
//
// 背景（09-30）：原生转录里「继续」后 0.03~2.4s 就出现 aborted_streaming 的案例，
// 大量落在「上一轮被中断 / 尾部悬空 / 进程空闲多分钟后被换新进程」之后，即 Chill Vibe
// 会 spawn 一个全新的 `--resume` 进程去承接。上一版探针（probe-idle-interrupt-then-send）
// 证明**同一存活进程**里「中断后立刻写下一条」不会被自杀；本探针测的是「新进程 + 悬空尾巴」。
//
// 阶段 1：新进程发一条长任务，1.5s 后写 interrupt，收到 aborted result 后关掉进程（尾巴 = 被中断）。
// 阶段 2：`--resume <sid>` 起新进程，按场景写 "Please continue."，看 result。
//   fresh-immediate  spawn 后立刻写（应用现状：spawn → writeUserMessage 同一 tick）
//   fresh-after-init 等到第一条 system/init 输出后再写
//   control-clean    对照：阶段 1 正常跑完一轮（不中断），再 resume 写 continue
// 判据：阶段 2 的 result 是 aborted_* / is_error = 被 CLI 自己吞掉；success = 正常。
// 用法：node scripts/probe-resume-dangling-tail.mjs [场景名...]   （默认全跑）
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MODEL = process.env.PROBE_MODEL || 'claude-haiku-4-5-20251001'
const LONG_PROMPT = '请写一篇 800 字的文章介绍长城，分六段，每段都要详细，不要省略。'
const REPEAT = Number.parseInt(process.env.PROBE_REPEAT || '1', 10)

const baseArgs = [
  '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
  '--model', MODEL, '--max-turns', '4', '--disallowedTools', 'Bash,Edit,Write,Read,Agent,Workflow',
]

const userLine = (text) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'

const startCli = (workDir, extraArgs, note) => {
  const child = spawn('claude', [...baseArgs, ...extraArgs], { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], shell: true })
  const t0 = Date.now()
  const events = []
  const waiters = []
  let sessionId = null
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (o.session_id) sessionId = o.session_id
      const at = Date.now() - t0
      events.push({ at, o })
      const tag = o.type === 'system' ? `system/${o.subtype}` : o.type
      if (o.type === 'result') {
        note(`  <<< [${String(at).padStart(5)}ms] RESULT subtype=${o.subtype} is_error=${o.is_error} terminal=${o.terminal_reason ?? '-'} `
          + `stop=${o.stop_reason ?? '-'} numTurns=${o.num_turns} text="${String(o.result ?? '').slice(0, 40)}"`)
      } else if (o.type === 'assistant') {
        const t = (o.message?.content ?? []).map((b) => b.text ?? `[${b.type}]`).join('').slice(0, 40)
        note(`  <<< [${String(at).padStart(5)}ms] assistant "${t}"`)
      } else if (o.type === 'user') {
        const c = o.message?.content
        const t = typeof c === 'string' ? c : (c ?? []).map((b) => b.text ?? `[${b.type}]`).join('')
        note(`  <<< [${String(at).padStart(5)}ms] user${o.isMeta ? '(meta)' : ''}${o.isSynthetic ? '(synthetic)' : ''} "${t.slice(0, 60)}"`)
      } else if (o.type !== 'stream_event') {
        note(`  <<< [${String(at).padStart(5)}ms] ${tag}`)
      }
      for (const w of [...waiters]) if (w.pred(o)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(o) }
    }
  })
  child.stderr.on('data', (d) => process.stderr.write(d))
  const closed = new Promise((resolve) => child.on('close', resolve))
  return {
    child, events, closed,
    sessionId: () => sessionId,
    write: (line) => child.stdin.write(line),
    waitFor: (pred, ms = 60_000) => new Promise((resolve, reject) => {
      const hit = events.find((e) => pred(e.o))
      if (hit) return resolve(hit.o)
      const timer = setTimeout(() => reject(new Error('timeout waiting for event')), ms)
      waiters.push({ pred, resolve: (o) => { clearTimeout(timer); resolve(o) } })
    }),
    stop: async () => {
      try { child.stdin.end() } catch { /* gone */ }
      const t = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, 3000)
      await closed
      clearTimeout(t)
    },
  }
}

const runScenario = async (name, round) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-resume-tail-'))
  const note = (s) => console.log(`${name}#${round} ${s}`)
  // 阶段 1
  const first = startCli(workDir, [], note)
  first.write(userLine(name === 'control-clean' ? '只回复 OK1' : LONG_PROMPT))
  if (name !== 'control-clean') {
    await new Promise((r) => setTimeout(r, 1500))
    note('>>> phase1 interrupt')
    first.write(JSON.stringify({
      type: 'control_request', request_id: `probe-${randomUUID().slice(0, 6)}`, request: { subtype: 'interrupt' },
    }) + '\n')
  }
  await first.waitFor((o) => o.type === 'result')
  const sid = first.sessionId()
  note(`phase1 done, session=${sid?.slice(0, 8)}`)
  await first.stop()
  await new Promise((r) => setTimeout(r, 500))

  // 阶段 2
  note('--- phase2: --resume in a NEW process')
  const second = startCli(workDir, ['--resume', sid], note)
  if (name === 'fresh-after-init') {
    await second.waitFor((o) => o.type === 'system' && o.subtype === 'init', 30_000).catch(() => undefined)
  }
  note('>>> write "Please continue."')
  second.write(userLine('Please continue.'))
  const results = []
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    const got = second.events.filter((e) => e.o.type === 'result')
    if (got.length >= 1) {
      // 再多等 4s：看看被吞之后有没有第二个 result（= 写进去的 continue 被排队后单独跑了一轮）。
      await new Promise((r) => setTimeout(r, 4000))
      results.push(...second.events.filter((e) => e.o.type === 'result'))
      break
    }
  }
  await second.stop()
  const r = results[0]?.o
  const verdict = !r ? 'NO-RESULT'
    : (r.is_error || String(r.terminal_reason ?? '').startsWith('aborted')) ? `SWALLOWED(${r.terminal_reason ?? r.subtype})` : 'ok'
  note(`VERDICT phase2: ${verdict}; results=${results.length}; firstResultAt=${results[0]?.at}ms`)
  return { name, round, verdict, results: results.length }
}

const scenarioNames = ['fresh-immediate', 'fresh-after-init', 'control-clean']
const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : scenarioNames
const summary = []
for (const name of names) {
  for (let round = 1; round <= REPEAT; round += 1) {
    try {
      summary.push(await runScenario(name, round))
    } catch (error) {
      console.log(`${name}#${round} ERROR ${error?.message ?? error}`)
      summary.push({ name, round, verdict: `ERROR(${error?.message ?? error})`, results: 0 })
    }
  }
}
console.log('\n===== SUMMARY =====')
for (const s of summary) console.log(`${s.name}#${s.round}  ${s.verdict}  results=${s.results}`)
process.exit(0)
