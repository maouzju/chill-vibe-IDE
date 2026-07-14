import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import fs from 'fs'
import path from 'path'
import os from 'os'

import {
  classifyClaudeSessionTailCompletion,
  getClaudeNativeTurnCompletion,
} from '../server/native-turn-completion.ts'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-turn-completion-test-'))
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const sessionId = 'cccccccc-0000-0000-0000-000000000001'

const assistantEntry = (options: {
  blocks: Array<Record<string, unknown>>
  stopReason?: string | null
  isSidechain?: boolean
  model?: string
}) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: options.isSidechain ?? false,
    message: {
      role: 'assistant',
      model: options.model ?? 'claude-fable-5',
      content: options.blocks,
      stop_reason: options.stopReason === undefined ? 'end_turn' : options.stopReason,
    },
    sessionId,
  })

const userPromptEntry = (text: string) =>
  JSON.stringify({
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content: text },
    sessionId,
  })

const toolResultEntry = () =>
  JSON.stringify({
    type: 'user',
    isSidechain: false,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
    },
    sessionId,
  })

const metadataEntries = [
  JSON.stringify({ type: 'last-prompt', sessionId }),
  JSON.stringify({ type: 'ai-title', sessionId }),
  JSON.stringify({ type: 'mode', sessionId }),
  JSON.stringify({ type: 'attachment', sessionId }),
  JSON.stringify({ type: 'system', isMeta: false, sessionId }),
]

const completedTurnLines = [
  userPromptEntry('修一下这个 bug'),
  assistantEntry({ blocks: [{ type: 'text', text: '已解决' }], stopReason: 'end_turn' }),
]

describe('classifyClaudeSessionTailCompletion', () => {
  it('text assistant with end_turn at the tail means the turn completed', () => {
    const content = `${completedTurnLines.join('\n')}\n`
    assert.equal(classifyClaudeSessionTailCompletion(content), 'completed')
  })

  it('metadata residue after the final text assistant is skipped', () => {
    const content = `${[...completedTurnLines, ...metadataEntries].join('\n')}\n`
    assert.equal(classifyClaudeSessionTailCompletion(content), 'completed')
  })

  it('a refusal stop is still a finished turn', () => {
    const content = `${[
      userPromptEntry('问个问题'),
      assistantEntry({ blocks: [{ type: 'text', text: '这个我不能做' }], stopReason: 'refusal' }),
    ].join('\n')}\n`
    assert.equal(classifyClaudeSessionTailCompletion(content), 'completed')
  })

  it('a tool_use assistant at the tail means the turn is still running', () => {
    const content = `${[
      ...completedTurnLines,
      userPromptEntry('继续'),
      assistantEntry({
        blocks: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }],
        stopReason: 'tool_use',
      }),
    ].join('\n')}\n`
    assert.equal(classifyClaudeSessionTailCompletion(content), 'incomplete')
  })

  it('a tool_result user entry at the tail means the turn is still running', () => {
    const content = `${[
      ...completedTurnLines,
      userPromptEntry('继续'),
      assistantEntry({
        blocks: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }],
        stopReason: 'tool_use',
      }),
      toolResultEntry(),
    ].join('\n')}\n`
    assert.equal(classifyClaudeSessionTailCompletion(content), 'incomplete')
  })

  it('text emitted before a pending tool call (stop_reason tool_use) is not a finished turn', () => {
    const content = `${[
      userPromptEntry('跑一下测试'),
      assistantEntry({ blocks: [{ type: 'text', text: '先看看状态。' }], stopReason: 'tool_use' }),
    ].join('\n')}\n`
    assert.equal(classifyClaudeSessionTailCompletion(content), 'incomplete')
  })

  it('a thinking-only assistant at the tail is not a finished turn', () => {
    const content = `${[
      userPromptEntry('想一下'),
      assistantEntry({ blocks: [{ type: 'thinking', thinking: '想到一半' }], stopReason: null }),
    ].join('\n')}\n`
    assert.equal(classifyClaudeSessionTailCompletion(content), 'incomplete')
  })

  it('a user prompt with no reply yet is not a finished turn', () => {
    const content = `${[
      ...completedTurnLines,
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' }, sessionId }),
      userPromptEntry('新需求来了'),
      ...metadataEntries,
    ].join('\n')}\n`
    assert.equal(classifyClaudeSessionTailCompletion(content), 'incomplete')
  })

  it('sidechain entries are ignored when finding the tail', () => {
    const content = `${[
      userPromptEntry('调子代理干活'),
      assistantEntry({
        blocks: [{ type: 'tool_use', id: 'tool-1', name: 'Task', input: {} }],
        stopReason: 'tool_use',
      }),
      assistantEntry({
        blocks: [{ type: 'text', text: '子代理的结论' }],
        stopReason: 'end_turn',
        isSidechain: true,
      }),
    ].join('\n')}\n`
    assert.equal(classifyClaudeSessionTailCompletion(content), 'incomplete')
  })

  it('synthetic assistant residue does not count as the real tail', () => {
    const content = `${[
      ...completedTurnLines,
      assistantEntry({
        blocks: [{ type: 'text', text: '<synthetic>' }],
        stopReason: null,
        model: '<synthetic>',
      }),
    ].join('\n')}\n`
    assert.equal(classifyClaudeSessionTailCompletion(content), 'completed')
  })

  it('empty or unparsable content is unknown', () => {
    assert.equal(classifyClaudeSessionTailCompletion(''), 'unknown')
    assert.equal(classifyClaudeSessionTailCompletion('not json\nstill not json\n'), 'unknown')
  })
})

describe('getClaudeNativeTurnCompletion', () => {
  const writeSessionFile = (content: string) => {
    const sourcePath = path.join(tmpDir, `${sessionId}.jsonl`)
    fs.writeFileSync(sourcePath, content, 'utf8')
    return sourcePath
  }

  it('reads the native session file and classifies its tail', async () => {
    const sourcePath = writeSessionFile(`${completedTurnLines.join('\n')}\n`)
    assert.equal(
      await getClaudeNativeTurnCompletion(sessionId, () => sourcePath),
      'completed',
    )
  })

  it('returns unknown when no session file exists', async () => {
    assert.equal(await getClaudeNativeTurnCompletion(sessionId, () => null), 'unknown')
  })
})
