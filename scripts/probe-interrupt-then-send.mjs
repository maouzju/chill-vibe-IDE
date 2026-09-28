// 探针：同一个常驻 claude 进程里 发消息 → 立刻 interrupt → 再发消息，
// 看第二轮是否 400 "system content must contain at least one block"。
// 用法：node scripts/probe-interrupt-then-send.mjs [interruptDelayMs]
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const delay = Number(process.argv[2] ?? 1500)
const child = spawn('claude', [
  '-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json',
  '--max-turns', '3', '--disallowedTools', 'Bash,Edit,Write,Read,Agent,Workflow',
], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })

const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
const user = (text) => send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
let results = 0
let buf = ''
child.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let o; try { o = JSON.parse(line) } catch { continue }
    if (o.type === 'system' && o.subtype === 'init') console.log('session', o.session_id)
    if (o.type === 'result') {
      results++
      console.log(`RESULT#${results}`, o.subtype, o.is_error, String(o.result ?? '').slice(0, 200))
      if (results === 1) setTimeout(() => user('只回复 OK 两个字母'), 300)
      else { child.stdin.end(); setTimeout(() => process.exit(0), 1000) }
    }
  }
})
child.stderr.on('data', (d) => process.stderr.write(d))
user('请写一篇 800 字的文章介绍长城。')
setTimeout(() => send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }), delay)
setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 120000)
