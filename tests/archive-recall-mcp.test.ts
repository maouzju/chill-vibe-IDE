import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

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
})
