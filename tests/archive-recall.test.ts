import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { attachImagesToMessageMeta } from '../shared/chat-attachments.ts'
import type { ChatMessage, ChatRequest, ImageAttachment } from '../shared/schema.ts'
import { buildArchiveRecallSnapshot } from '../src/archive-recall.ts'
import { createArchiveRecallRuntimeOverrides } from '../server/archive-recall.ts'

const timestamp = '2026-04-18T01:09:00.000Z'

const createMessage = (
  id: string,
  role: ChatMessage['role'],
  content: string,
  meta?: ChatMessage['meta'],
): ChatMessage => ({
  id,
  role,
  content,
  createdAt: timestamp,
  meta,
})

const imageAttachment: ImageAttachment = {
  id: 'compact-image.png',
  fileName: 'compact-image.png',
  mimeType: 'image/png',
  sizeBytes: 512,
}

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-recall-runtime-'))

after(() => {
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

describe('archive recall snapshot', () => {
  it('captures only the hidden compacted segment before the latest compact boundary', () => {
    const snapshot = buildArchiveRecallSnapshot({
      provider: 'codex',
      status: 'idle',
      messages: [
        createMessage(
          'hidden-user',
          'user',
          'Look at the earlier screenshot.',
          attachImagesToMessageMeta([imageAttachment]),
        ),
        createMessage('hidden-assistant', 'assistant', 'The CI screenshot shows a red build.'),
        createMessage('compact-boundary', 'user', '/compact', {
          provider: 'codex',
          compactBoundary: 'true',
        }),
        createMessage('visible-assistant', 'assistant', 'Compacted summary is now visible.'),
      ],
    })

    assert.ok(snapshot)
    assert.equal(snapshot?.hiddenReason, 'compact')
    assert.equal(snapshot?.hiddenMessageCount, 2)
    assert.deepEqual(snapshot?.messages.map((message) => message.id), ['hidden-user', 'hidden-assistant'])
  })

  it('does not create archive recall state for performance-only windowing', () => {
    const snapshot = buildArchiveRecallSnapshot({
      provider: 'codex',
      status: 'idle',
      messages: Array.from({ length: 260 }, (_, index) =>
        createMessage(
          `message-${index + 1}`,
          index % 2 === 0 ? 'user' : 'assistant',
          `Message ${index + 1}`,
        ),
      ),
    })

    assert.equal(snapshot, undefined)
  })
})

describe('archive recall runtime overrides', () => {
  it('writes an ephemeral snapshot file and returns Codex MCP config overrides', async () => {
    process.env.CHILL_VIBE_DATA_DIR = tempDataDir

    const request: ChatRequest = {
      provider: 'codex',
      workspacePath: 'D:\\Git\\chill-vibe',
      model: 'gpt-5.4',
      reasoningEffort: 'max',
      thinkingEnabled: true,
      planMode: false,
      language: 'zh-CN',
      systemPrompt: 'You are helpful.',
      crossProviderSkillReuseEnabled: true,
      prompt: 'Check the earlier screenshot.',
      attachments: [],
      archiveRecall: {
        hiddenReason: 'compact',
        hiddenMessageCount: 1,
        messages: [
          createMessage(
            'hidden-user',
            'user',
            'Earlier screenshot is attached here.',
            attachImagesToMessageMeta([imageAttachment]),
          ),
        ],
      },
    }

    const runtime = await createArchiveRecallRuntimeOverrides(request)

    assert.ok(runtime)
    assert.match(runtime?.runtimeArgs.join(' '), /mcp_servers\.chill_vibe_archive\.command=/)
    assert.match(runtime?.runtimeArgs.join(' '), /archive-recall-mcp\.js/)
    assert.ok(runtime?.contextFilePath)
    assert.equal(fs.existsSync(runtime!.contextFilePath), true)

    await runtime?.cleanup()
    assert.equal(fs.existsSync(runtime!.contextFilePath), false)

    delete process.env.CHILL_VIBE_DATA_DIR
  })

  it('skips runtime overrides when there is no compacted archive payload', async () => {
    const request: ChatRequest = {
      provider: 'codex',
      workspacePath: 'D:\\Git\\chill-vibe',
      model: 'gpt-5.4',
      reasoningEffort: 'max',
      thinkingEnabled: true,
      planMode: false,
      language: 'zh-CN',
      systemPrompt: 'You are helpful.',
      crossProviderSkillReuseEnabled: true,
      prompt: 'hello',
      attachments: [],
      archiveRecall: undefined,
    }

    const runtime = await createArchiveRecallRuntimeOverrides(request)
    assert.equal(runtime, null)
  })
})
