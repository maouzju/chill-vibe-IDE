import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { callArchiveRecallTool, searchArchiveMessages } from '../server/archive-recall-mcp.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-recall-mcp-'))
const attachmentsDir = path.join(tempRoot, 'attachments')

const snapshot = {
  hiddenReason: 'compact',
  hiddenMessageCount: 2,
  messages: [
    {
      id: 'hidden-user',
      role: 'user',
      content: 'Earlier CI screenshot is attached here.',
      createdAt: '2026-04-18T01:09:00.000Z',
      meta: {
        imageAttachments: JSON.stringify([
          {
            id: 'ci-red.png',
            fileName: 'ci-red.png',
            mimeType: 'image/png',
            sizeBytes: 68,
          },
        ]),
      },
    },
    {
      id: 'hidden-assistant',
      role: 'assistant',
      content: 'CI failed because the quality check step stayed red.',
      createdAt: '2026-04-18T01:10:00.000Z',
      meta: {
        kind: 'command',
        structuredData: '{"command":"pnpm test:quality","output":"1 failing check"}',
      },
    },
  ],
}

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('archive recall MCP tools', () => {
  it('searches archived messages and prioritizes image-bearing history for generic image queries', () => {
    const results = searchArchiveMessages(snapshot, 'earlier screenshot', 5)

    assert.equal(results.length, 1)
    assert.equal(results[0]?.itemId, 'hidden-user')
    assert.match(results[0]?.excerpt ?? '', /screenshot/i)
  })

  it('reads an archived message and inlines attached images as MCP image blocks', async () => {
    fs.mkdirSync(attachmentsDir, { recursive: true })
    const imageBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sZRx6QAAAAASUVORK5CYII=',
      'base64',
    )
    fs.writeFileSync(path.join(attachmentsDir, 'ci-red.png'), imageBytes)

    const result = await callArchiveRecallTool('read_compacted_history', { itemId: 'hidden-user' }, snapshot, {
      attachmentsDir,
    })

    assert.equal(result.isError, false)
    assert.equal(Array.isArray(result.content), true)
    assert.equal(result.content[0]?.type, 'text')
    assert.equal(result.content[1]?.type, 'image')
    assert.equal(result.content[1]?.mimeType, 'image/png')
    assert.match(result.content[1]?.data ?? '', /^[A-Za-z0-9+/=]+$/)
  })

  // Codex 用换行分帧（NDJSON）跟 MCP stdio 服务端握手；服务端只认 Content-Length 时一个字节都不回。
  it('answers initialize, tools/list and tools/call over newline-delimited stdio', async () => {
    const snapshotPath = path.join(tempRoot, 'snapshot.json')
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot))
    const scriptPath = fileURLToPath(new URL('../server/archive-recall-mcp.js', import.meta.url))
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CHILL_VIBE_ARCHIVE_RECALL_FILE: snapshotPath },
    })
    try {
      const messages: Array<Record<string, unknown>> = []
      let pending = ''
      const waiters: Array<() => void> = []
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        pending += chunk
        const parts = pending.split('\n')
        pending = parts.pop() ?? ''
        for (const part of parts) {
          if (part.trim()) messages.push(JSON.parse(part))
        }
        for (const wake of waiters.splice(0)) wake()
      })
      const waitForId = (id: number) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timed out waiting for id ${id}`)), 5000)
          const check = () => {
            const found = messages.find((message) => message.id === id)
            if (found) {
              clearTimeout(timer)
              resolve(found)
            } else {
              waiters.push(check)
            }
          }
          check()
        })

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`)
      const init = await waitForId(1)
      assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, 'chill-vibe-archive-recall')

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
      const list = await waitForId(2)
      assert.deepEqual(
        (list.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort(),
        ['read_compacted_history', 'search_compacted_history'],
      )

      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_compacted_history', arguments: { query: 'quality check' } } })}\n`,
      )
      const call = await waitForId(3)
      assert.match(JSON.stringify(call.result), /hidden-assistant/)
    } finally {
      child.kill()
    }
  })
})
