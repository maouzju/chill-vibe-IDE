#!/usr/bin/env node
// 实证：Codex app-server 回合进行中用 turn/steer 插话（不 interrupt），模型能否在同一回合看到。
// 用法：node scripts/probe-codex-midturn-steer.mjs [model] [effort]
import { spawn } from 'node:child_process'
import process from 'node:process'

const model = process.argv[2] || 'gpt-6.2-sol'
const effort = process.argv[3] || 'low'
const cwd = process.cwd()

const child = spawn(process.platform === 'win32' ? 'codex.cmd' : 'codex', ['app-server'], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
})

let nextId = 1
let turnId = null
let steered = false
let codewordSeen = false
let terminals = 0
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
      console.log('[TERMINAL]', JSON.stringify(payload).slice(0, 600))
      terminals += 1
      setTimeout(() => { console.log(`[probe] codeword seen=${codewordSeen} terminals=${terminals}`); child.kill(); process.exit(0) }, 8000)
    }
    if (payload.id !== undefined && (payload.result !== undefined || payload.error !== undefined)) {
      const entry = pending.get(payload.id)
      pending.delete(payload.id)
      if (!entry) continue
      if (payload.error) entry.reject(new Error(JSON.stringify(payload.error)))
      else entry.resolve(payload.result)
      continue
    }
    const text = JSON.stringify(payload)
    if (payload.method === 'turn/started') { turnId = payload.params?.turn?.id; console.log('[probe] turn started', turnId) }
    if (text.includes('KIWI55') && payload.method !== 'item/started' && steered && !codewordSeen && /agentMessage|delta/i.test(text)) { codewordSeen = true; console.log('[probe] CODEWORD in output, terminals so far', terminals, text.slice(0, 200)) }
    if (/item\/(started|completed)/.test(payload.method ?? '')) console.log('[event]', text.slice(0, 220))
  }
})
child.stderr.on('data', (chunk) => process.stderr.write(`[stderr] ${chunk}`))

const main = async () => {
  await send('initialize', { clientInfo: { name: 'chill-vibe-probe', title: 'Probe', version: '0.1.0' }, capabilities: null })
  notify('initialized')
  const thread = await send('thread/start', { model, cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' })
  const threadId = thread?.thread?.id
  await send('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Run this shell command and wait for it: powershell -NoProfile -Command "Start-Sleep -Seconds 25; Write-Output SLEPT". Then say DONE.', text_elements: [] }],
    cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, model, effort,
  })
  const startedAt = Date.now()
  while (!turnId && Date.now() - startedAt < 60_000) await new Promise((r) => setTimeout(r, 200))
  await new Promise((r) => setTimeout(r, 8000))
  try {
    const res = await send('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: 'NEW USER MESSAGE: also reply with the word KIWI55.', text_elements: [] }] })
    steered = true
    console.log('[probe] turn/steer OK', JSON.stringify(res))
  } catch (e) { console.log('[probe] turn/steer FAILED', e.message) }
}

main()
  .then(() => setTimeout(() => { console.log('[probe] timeout'); child.kill(); process.exit(2) }, 150_000))
  .catch((error) => { console.error('[probe] FAILED:', error.message); child.kill(); process.exit(1) })
