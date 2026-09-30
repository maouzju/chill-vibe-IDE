import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  collectJevItems,
  compactJevAnswer,
  jevMcpToolDefinitions,
  resolveJevEndpoint,
  runJevAsk,
} from '../server/jev-mcp.js'

// 精简格式照 JevMCP（MIT）：noul 只给 P(是)，不确定才标 "?"；choice/score 给 [值, 置信度]，
// 不确定再附 top-2 概率。目的是一次筛几百个文件时，返回给 agent 的上下文仍然很小。

test('compactJevAnswer keeps confident answers tiny and flags unsure ones', () => {
  assert.equal(compactJevAnswer({ type: 'noul', noul: 0.934 }, 0.6), 0.93)
  assert.deepEqual(compactJevAnswer({ type: 'noul', noul: 0.55 }, 0.6), [0.55, '?'])
  assert.deepEqual(
    compactJevAnswer({ type: 'choice', choice: 'billing', confidence: 0.971, probabilities: { billing: 0.97 } }, 0.6),
    ['billing', 0.97],
  )
  assert.deepEqual(
    compactJevAnswer(
      {
        type: 'score',
        score: 3,
        confidence: 0.41,
        probabilities: { '3': 0.52, '4': 0.38, '1': 0.1 },
      },
      0.6,
    ),
    [3, 0.41, { '3': 0.52, '4': 0.38 }],
  )
})

test('resolveJevEndpoint routes OpenRouter keys to the decisions endpoint and others to TypeSafe', () => {
  assert.deepEqual(resolveJevEndpoint('sk-or-v1-abc'), {
    provider: 'openrouter',
    url: 'https://openrouter.ai/api/alpha/decisions',
    model: 'typesafe/jev-1.13',
  })
  assert.deepEqual(resolveJevEndpoint('ts-abc'), {
    provider: 'typesafe',
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
  })
})

test('collectJevItems walks directories, skips vendored folders and filters by extension', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-collect-'))
  try {
    await mkdir(path.join(root, 'src', 'deep'), { recursive: true })
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1')
    await writeFile(path.join(root, 'src', 'deep', 'b.ts'), 'export const b = 2')
    await writeFile(path.join(root, 'src', 'notes.md'), '# notes')
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.ts'), 'vendored')

    const { items, skipped } = await collectJevItems(root, { paths: ['src', 'node_modules'], extensions: ['.ts'] })
    assert.deepEqual(items.map((item) => item.label).sort(), ['src/a.ts', 'src/deep/b.ts'])
    assert.equal(skipped.length, 0)

    const withTexts = await collectJevItems(root, { paths: ['src/a.ts'], texts: ['hello'] })
    assert.deepEqual(withTexts.items.map((item) => item.label), ['src/a.ts', 'text[0]'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runJevAsk sends one request per item and never leaks the key into the result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-run-'))
  try {
    await writeFile(path.join(root, 'a.ts'), 'fetch("/api")')
    await writeFile(path.join(root, 'b.ts'), 'const x = 1')
    const calls: Array<{ url: string; body: { model: string; state: string; questions: unknown }; auth: string }> = []
    const fetchImpl = async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const body = JSON.parse(init.body)
      calls.push({ url, body, auth: init.headers.Authorization })
      const yes = String(body.state).includes('fetch')
      return new Response(JSON.stringify({ answers: { net: { type: 'noul', noul: yes ? 0.97 : 0.02 } } }), { status: 200 })
    }

    const result = await runJevAsk(
      { paths: ['.'], questions: { net: { type: 'noul', instructions: 'Does this file make network calls?' } } },
      { apiKey: 'sk-or-secret', root, fetchImpl },
    )

    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.url, 'https://openrouter.ai/api/alpha/decisions')
    assert.equal(calls[0]?.auth, 'Bearer sk-or-secret')
    assert.deepEqual(result.results, { 'a.ts': { net: 0.97 }, 'b.ts': { net: 0.02 } })
    assert.deepEqual(result.unsure, [])
    assert.ok(!JSON.stringify(result).includes('sk-or-secret'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runJevAsk stops early with a readable error when the key is rejected', async () => {
  let callCount = 0
  const fetchImpl = async () => {
    callCount += 1
    return new Response('{"error":"invalid key sk-or-secret"}', { status: 401 })
  }

  await assert.rejects(
    runJevAsk(
      { texts: ['a', 'b', 'c'], questions: { q: { type: 'noul', instructions: 'x?' } } },
      { apiKey: 'sk-or-secret', root: os.tmpdir(), fetchImpl },
    ),
    (error: Error) => /key/i.test(error.message) && !error.message.includes('sk-or-secret'),
  )
  assert.ok(callCount <= 8, `401 must not be retried per item (got ${callCount} calls)`)
})

test('jev MCP exposes a single short tool', () => {
  assert.deepEqual(jevMcpToolDefinitions.map((tool: { name: string }) => tool.name), ['jev_ask'])
  const description = jevMcpToolDefinitions[0]?.description ?? ''
  assert.ok(description.length < 400, `tool description must stay short (got ${description.length})`)
})

test('jev MCP answers initialize and tools/list over newline-delimited stdio', async () => {
  const scriptPath = fileURLToPath(new URL('../server/jev-mcp.js', import.meta.url))
  const child = spawn(process.execPath, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    const lines: string[] = []
    let pending = ''
    const waitForId = (id: number) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for id ${id}`)), 5000)
        const check = () => {
          for (const line of lines) {
            const message = JSON.parse(line)
            if (message.id === id) {
              clearTimeout(timer)
              resolve(message)
              return true
            }
          }
          return false
        }
        if (!check()) {
          child.stdout.on('data', () => check())
        }
      })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      lines.push(...parts.filter((part) => part.trim()))
    })

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`)
    const init = await waitForId(1)
    assert.ok((init.result as { capabilities: unknown }).capabilities)

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    const list = await waitForId(2)
    assert.deepEqual(
      (list.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
      ['jev_ask'],
    )

    // 没有 key 文件时工具调用返回可读错误，而不是让 MCP 进程崩掉。
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'jev_ask', arguments: { texts: ['a'], questions: { q: { type: 'noul', instructions: 'x?' } } } } })}\n`,
    )
    const call = await waitForId(3)
    assert.equal((call.result as { isError: boolean }).isError, true)
  } finally {
    child.kill()
  }
})

test('collectJevItems refuses paths outside the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-boundary-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'jev-outside-'))
  try {
    await writeFile(path.join(outside, 'secret.ts'), 'TOP SECRET')
    const result = await collectJevItems(root, { paths: [path.join(outside, 'secret.ts')] })
    assert.deepEqual(result.items, [])
    const relativeResult = await collectJevItems(root, { paths: [path.relative(root, path.join(outside, 'secret.ts'))] })
    assert.deepEqual(relativeResult.items, [])
    await symlink(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir')
    const linked = await collectJevItems(root, { paths: ['outside-link/secret.ts', 'outside-link'] })
    assert.deepEqual(linked.items, [])
    let uploads = 0
    await assert.rejects(runJevAsk(
      { paths: ['outside-link/secret.ts'], questions: { q: { type: 'noul', instructions: 'x?' } } },
      { apiKey: 'test-key', root, fetchImpl: async () => { uploads += 1; return new Response('{}') } },
    ), /Nothing to judge/)
    assert.equal(uploads, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})