#!/usr/bin/env node
// 一次性诊断脚本：按 Chill Vibe 主聊天路径（codex app-server + NDJSON JSON-RPC）
// 真跑一个最小回合，用来区分「应用 bug」和「上游中转站故障」。
import { spawn } from 'node:child_process'
import process from 'node:process'

const model = process.argv[2] || 'gpt-5.6-sol'
const effort = process.argv[3] || 'low'
const cwd = process.cwd()

const child = spawn(process.platform === 'win32' ? 'codex.cmd' : 'codex', ['app-server'], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
})

let nextId = 1
const pending = new Map()
const send = (method, params) => {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout: ${method}`))
      }
    }, 90_000)
  })
}
const notify = (method, params) =>
  child.stdin.write(`${JSON.stringify({ method, ...(params ? { params } : {}) })}\n`)

let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (!line) continue
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      console.log('[raw]', line.slice(0, 400))
      continue
    }
    // 只有「不会再重试」的 error 才算终态：codex 对 5xx 会自动重连 5 次，中间每次都发一条
    // willRetry:true 的 error 通知，把它当终态会在回合还活着时就判死（本仓库旧实现的 bug）。
    const isRetryingError = payload.method === 'error' && payload.params?.willRetry === true
    if (
      typeof payload.method === 'string' &&
      /turn\/(completed|failed|aborted)|^error$/i.test(payload.method) &&
      !isRetryingError
    ) {
      console.log('[TERMINAL]', JSON.stringify(payload).slice(0, 1500))
      setTimeout(() => { child.kill(); process.exit(0) }, 300)
    }
    if (payload.id !== undefined && (payload.result !== undefined || payload.error !== undefined)) {
      const entry = pending.get(payload.id)
      pending.delete(payload.id)
      if (!entry) continue
      if (payload.error) entry.reject(new Error(JSON.stringify(payload.error)))
      else entry.resolve(payload.result)
      continue
    }
    console.log('[event]', JSON.stringify(payload).slice(0, 500))
  }
})
child.stderr.on('data', (chunk) => process.stderr.write(`[stderr] ${chunk}`))

const main = async () => {
  await send('initialize', {
    clientInfo: { name: 'chill-vibe-probe', title: 'Probe', version: '0.1.0' },
    capabilities: null,
  })
  notify('initialized')
  const thread = await send('thread/start', {
    model,
    cwd,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    baseInstructions: 'You are a probe. Answer with a single word.',
  })
  const threadId = thread?.thread?.id
  console.log('[probe] threadId', threadId)
  await send('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Reply with exactly: ok', text_elements: [] }],
    cwd,
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    model,
    effort,
  })
  console.log('[probe] turn/start OK')
}

main()
  .then(() => setTimeout(() => { console.log('[probe] no terminal event in 120s'); child.kill(); process.exit(2) }, 120_000))
  .catch((error) => {
    console.error('[probe] FAILED:', error.message)
    child.kill()
    process.exit(1)
  })
