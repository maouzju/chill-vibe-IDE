#!/usr/bin/env node
// 一次性探针：Codex 线程换模型后能否原样续用（Chill Vibe 卡内换模型要不要清 sessionId）。
// 第 1 个 app-server 进程用模型 A 起线程、发一张图；进程退出后，第 2 个进程 thread/resume
// 同一线程并以模型 B 发纯文本追问图中细节。判据：B 不调工具就答出图里的暗号，且请求确以 B 运行。
//
// 用法：node scripts/probe-codex-model-switch-resume.mjs <modelA> <modelB> <imagePath> [effort]
import { spawn } from 'node:child_process'
import process from 'node:process'

const [modelA = 'gpt-5.5', modelB = 'gpt-5.6-sol', imagePath, effort = 'low'] = process.argv.slice(2)
if (!imagePath) {
  console.error('usage: probe-codex-model-switch-resume.mjs <modelA> <modelB> <imagePath> [effort]')
  process.exit(1)
}
const cwd = process.cwd()

const runAppServer = (label, drive) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'codex.cmd' : 'codex', ['app-server'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    let nextId = 1
    const pending = new Map()
    const items = []
    let agentText = ''
    let turnDone = null
    const turnFinished = new Promise((r) => { turnDone = r })

    const send = (method, params) => {
      const id = nextId++
      child.stdin.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`)
      return new Promise((res, rej) => {
        pending.set(id, { res, rej })
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            rej(new Error(`timeout: ${method}`))
          }
        }, 120_000)
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
        try { payload = JSON.parse(line) } catch { continue }
        if (payload.id !== undefined && (payload.result !== undefined || payload.error !== undefined)) {
          const entry = pending.get(payload.id)
          pending.delete(payload.id)
          if (!entry) continue
          if (payload.error) entry.rej(new Error(JSON.stringify(payload.error)))
          else entry.res(payload.result)
          continue
        }
        const method = payload.method
        if (method === 'item/completed') {
          const item = payload.params?.item
          items.push(item?.type)
          if (item?.type === 'agentMessage') agentText += item.text ?? ''
        }
        if (method === 'item/agentMessage/delta' && !agentText) {
          // 最终文本以 item/completed 为准，delta 只用于兜底观察
        }
        if (method === 'error' && payload.params?.willRetry !== true) {
          turnDone({ status: 'error', error: payload.params })
        }
        if (method === 'turn/completed') {
          turnDone({ status: payload.params?.turn?.status, error: payload.params?.turn?.error })
        }
      }
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

    const finish = (value, error) => {
      child.kill()
      if (error) reject(Object.assign(error, { stderr: stderr.slice(-2000) }))
      else resolve(value)
    }

    ;(async () => {
      await send('initialize', {
        clientInfo: { name: 'chill-vibe-probe', title: 'Probe', version: '0.1.0' },
        capabilities: null,
      })
      notify('initialized')
      const extra = await drive(send)
      const result = await Promise.race([
        turnFinished,
        new Promise((r) => setTimeout(() => r({ status: 'timeout' }), 180_000)),
      ])
      console.log(`[${label}]`, JSON.stringify({ ...extra, ...result, items, agentText }))
      finish({ ...extra, ...result, items, agentText })
    })().catch((error) => finish(null, error))
  })

const turnParams = (threadId, model, input) => ({
  threadId,
  input,
  cwd,
  approvalPolicy: 'never',
  sandboxPolicy: { type: 'readOnly', networkAccess: false },
  model,
  effort,
})

const first = await runAppServer('A', async (send) => {
  const thread = await send('thread/start', {
    model: modelA,
    cwd,
    approvalPolicy: 'never',
    sandbox: 'read-only',
  })
  const threadId = thread?.thread?.id
  await send('turn/start', turnParams(threadId, modelA, [
    { type: 'text', text: 'Look at this image. Reply with just "seen". Do not run any tools.', text_elements: [] },
    { type: 'localImage', path: imagePath },
  ]))
  return { threadId, threadModel: thread?.model }
})

const second = await runAppServer('B', async (send) => {
  const resumed = await send('thread/resume', {
    threadId: first.threadId,
    model: modelB,
    cwd,
    approvalPolicy: 'never',
    sandbox: 'read-only',
  })
  await send('turn/start', turnParams(first.threadId, modelB, [
    {
      type: 'text',
      text:
        'Without running any tools or opening any files: what code word and what colors were in the image I showed you earlier? Also state which model you are.',
      text_elements: [],
    },
  ]))
  return { resumedModel: resumed?.model }
})

const toolItems = second.items.filter((type) => type && !['userMessage', 'agentMessage', 'reasoning'].includes(type))
console.log('[verdict]', JSON.stringify({
  modelA,
  modelB,
  threadId: first.threadId,
  resumedModel: second.resumedModel,
  bStatus: second.status,
  bError: second.error ?? null,
  bToolItems: toolItems,
  bRecalledCodeWord: /KUMQUAT-?4826/i.test(second.agentText),
}))
