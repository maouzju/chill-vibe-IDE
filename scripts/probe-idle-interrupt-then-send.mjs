// 实证：CLI「空闲」（没有活动 turn）时收到 interrupt control_request，这条中断会不会
// 潜伏下来、把**下一条** user 消息的 turn 秒杀掉（原生转录里表现为发出后几十毫秒到几秒就
// 出现 `[Request interrupted by user]`，用户视角 = 「点继续，1 秒后又停了，得再点一次」）。
//
// 背景：09-30 扫 ~/.claude/projects 原生转录，"Please continue." 后 5 秒内被中断的案例
// 最短 28ms（人手不可能），且每例都紧跟 queue-operation。pool.interruptTurn 只看进程当前
// 是不是 turn-active，不看这条中断属于哪一轮，所以"迟到的 stop"有机会命中新一轮。
//
// 场景：
//   control        对照：两轮正常对话，无任何 interrupt
//   idle-300       turn1 结束后补一条迟到 interrupt，隔 300ms 发 turn2
//   idle-b2b       turn1 结束后补一条迟到 interrupt，紧接着（同一 tick）写 turn2
//   double-active  turn1 进行中连发两条 interrupt（间隔 50ms），结束后隔 1.5s 发 turn2
//
// 判据：turn2 的 result 是 is_error / 非 success / 文本不含 OK2 = 被秒杀。
// 用法：node scripts/probe-idle-interrupt-then-send.mjs [场景名...]   （默认全跑）
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MODEL = process.env.PROBE_MODEL || 'claude-haiku-4-5-20251001'
const LONG_PROMPT = '请写一篇 800 字的文章介绍长城，分六段，每段都要详细，不要省略。'

const scenarios = {
  control: (h) => {
    h.user('只回复 OK1')
    h.onResult(1, () => setTimeout(() => h.user('只回复 OK2'), 300))
    h.onResult(2, () => h.done())
  },
  'idle-300': (h) => {
    h.user('只回复 OK1')
    h.onResult(1, () => {
      h.interrupt('late-idle')
      setTimeout(() => h.user('只回复 OK2'), 300)
    })
    h.onResult(2, () => h.done())
  },
  'idle-b2b': (h) => {
    h.user('只回复 OK1')
    h.onResult(1, () => {
      h.interrupt('late-idle')
      h.user('只回复 OK2')
    })
    h.onResult(2, () => h.done())
  },
  'double-active': (h) => {
    h.user('请写一篇 600 字的文章介绍长城，分五段。')
    setTimeout(() => {
      h.interrupt('#1')
      setTimeout(() => h.interrupt('#2'), 50)
    }, 1500)
    h.onResult(1, () => setTimeout(() => h.user('只回复 OK2'), 1500))
    h.onResult(2, () => h.done())
  },
  // 真实链路：X 进行中被中断 → 收到 X 的 aborted result → pool 立刻（endTurn 后同一 tick）
  // 复用同一进程写下一条 user。这才是「点停止再点继续」在 CLI 侧的真实形状。
  'x-then-p1-0': (h) => {
    h.user(LONG_PROMPT)
    setTimeout(() => h.interrupt('X'), 1500)
    h.onResult(1, () => h.user('只回复 OK2'))
    h.onResult(2, () => h.done())
  },
  'x-then-p1-150': (h) => {
    h.user(LONG_PROMPT)
    setTimeout(() => h.interrupt('X'), 1500)
    h.onResult(1, () => setTimeout(() => h.user('只回复 OK2'), 150))
    h.onResult(2, () => h.done())
  },
  'x-then-p1-600': (h) => {
    h.user(LONG_PROMPT)
    setTimeout(() => h.interrupt('X'), 1500)
    h.onResult(1, () => setTimeout(() => h.user('只回复 OK2'), 600))
    h.onResult(2, () => h.done())
  },
  // 对照：中断刚发出、X 的收尾还没回来就写下一条（pool 靠 interruptDrainWaiters 避免这个形状）。
  'x-then-p1-during': (h) => {
    h.user(LONG_PROMPT)
    setTimeout(() => {
      h.interrupt('X')
      h.user('只回复 OK2')
    }, 1500)
    h.onResult(2, () => h.done())
  },
}

const runScenario = (name) =>
  new Promise((resolve) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-idle-int-'))
    const t0 = Date.now()
    const note = (s) => console.log(`${name.padEnd(13)} [${String(Date.now() - t0).padStart(6)}ms] ${s}`)
    const child = spawn(
      'claude',
      ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
        '--model', MODEL, '--max-turns', '3', '--disallowedTools', 'Bash,Edit,Write,Read,Agent,Workflow'],
      { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], shell: true },
    )

    const results = []
    const resultWaiters = new Map()
    const interrupts = new Map()
    let finished = false
    let userSentAt = 0

    const finish = (why) => {
      if (finished) return
      finished = true
      try { child.stdin.end() } catch { /* gone */ }
      setTimeout(() => {
        try { child.kill() } catch { /* gone */ }
        const r2 = results[1]
        const killed = r2 ? (r2.is_error || r2.subtype !== 'success' || !String(r2.result ?? '').includes('OK2')) : null
        note(`VERDICT ${name}: turn2 ${r2 ? (killed ? 'KILLED/ABNORMAL' : 'ok') : 'NO-RESULT'} (${why})`)
        resolve({ name, results, killed, workDir })
      }, 800)
    }

    const h = {
      user: (text) => {
        userSentAt = Date.now()
        note(`>>> user: ${text.slice(0, 40)}`)
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
      },
      interrupt: (tag) => {
        const id = `probe-${tag}-${randomUUID().slice(0, 6)}`
        interrupts.set(id, { tag, at: Date.now() })
        note(`>>> interrupt ${tag}`)
        child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } }) + '\n')
      },
      onResult: (n, fn) => resultWaiters.set(n, fn),
      done: () => finish('scenario done'),
    }

    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let o
        try { o = JSON.parse(line) } catch { continue }
        if (o.type === 'control_response') {
          const id = o.response?.request_id
          const it = interrupts.get(id)
          note(`<<< control_response ${it?.tag ?? id} subtype=${o.response?.subtype} (+${it ? Date.now() - it.at : '?'}ms)`)
        } else if (o.type === 'assistant') {
          const t = (o.message?.content ?? []).map((b) => b.text ?? `[${b.type}]`).join('').slice(0, 50)
          note(`<<< assistant "${t}"`)
        } else if (o.type === 'result') {
          results.push(o)
          note(`<<< RESULT#${results.length} subtype=${o.subtype} is_error=${o.is_error} terminal=${o.terminal_reason ?? '-'} stop=${o.stop_reason ?? '-'} `
            + `since-user=${userSentAt ? Date.now() - userSentAt : '?'}ms text="${String(o.result ?? '').slice(0, 50)}"`)
          resultWaiters.get(results.length)?.()
        }
      }
    })
    child.stderr.on('data', (d) => process.stderr.write(d))
    child.on('close', () => finish('process closed'))

    setTimeout(() => finish('TIMEOUT'), 100_000).unref()
    scenarios[name](h)
  })

const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : Object.keys(scenarios)
const summary = []
for (const name of names) {
  summary.push(await runScenario(name))
}
console.log('\n===== SUMMARY =====')
for (const s of summary) {
  console.log(`${s.name.padEnd(13)} ${s.killed === null ? 'NO-RESULT' : s.killed ? 'turn2 KILLED/ABNORMAL' : 'turn2 ok'}`)
}
process.exit(0)
