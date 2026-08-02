import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import fs from 'fs'
import path from 'path'
import os from 'os'

import {
  classifyCodexSessionTailCompletion,
  classifyClaudeSessionTailCompletion,
  getCodexNativeTurnCompletion,
  getClaudeNativeTurnCompletion,
  type NativeTurnCompletion,
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

const codexEvent = (type: string, turnId: string) =>
  JSON.stringify({
    timestamp: '2026-07-28T01:00:00.000Z',
    type: 'event_msg',
    payload: { type, turn_id: turnId },
  })

describe('classifyCodexSessionTailCompletion', () => {
  it('the latest completed root task means the native Codex turn completed', () => {
    const content = `${[
      codexEvent('task_started', 'turn-1'),
      codexEvent('task_complete', 'turn-1'),
    ].join('\n')}\n`

    assert.equal(classifyCodexSessionTailCompletion(content), 'completed')
  })

  it('a later started task means the native Codex turn is still incomplete', () => {
    const content = `${[
      codexEvent('task_started', 'turn-1'),
      codexEvent('task_complete', 'turn-1'),
      codexEvent('task_started', 'turn-2'),
    ].join('\n')}\n`

    assert.equal(classifyCodexSessionTailCompletion(content), 'incomplete')
  })

  it('a newer user turn never inherits the previous task_complete marker', () => {
    const content = `${[
      codexEvent('task_started', 'turn-1'),
      codexEvent('task_complete', 'turn-1'),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
      }),
    ].join('\n')}\n`

    assert.equal(classifyCodexSessionTailCompletion(content), 'incomplete')
  })

  it('an interrupted latest task remains resumable instead of being treated as completed', () => {
    const content = `${[
      codexEvent('task_started', 'turn-1'),
      codexEvent('task_interrupted', 'turn-1'),
    ].join('\n')}\n`

    assert.equal(classifyCodexSessionTailCompletion(content), 'incomplete')
  })

  it('ignores unrelated rollout bookkeeping and returns unknown without task state', () => {
    assert.equal(
      classifyCodexSessionTailCompletion(`${JSON.stringify({ type: 'session_meta', payload: {} })}\n`),
      'unknown',
    )
  })
})

describe('getCodexNativeTurnCompletion', () => {
  const writeRolloutFile = (content: string) => {
    const sourcePath = path.join(tmpDir, `rollout-${sessionId}.jsonl`)
    fs.writeFileSync(sourcePath, content, 'utf8')
    return sourcePath
  }

  it('reads the native rollout file and classifies its latest task', async () => {
    const sourcePath = writeRolloutFile(`${[
      codexEvent('task_started', 'turn-1'),
      codexEvent('task_complete', 'turn-1'),
    ].join('\n')}\n`)

    assert.equal(
      await getCodexNativeTurnCompletion(sessionId, () => sourcePath),
      'completed',
    )
  })

  it('returns unknown when no rollout file exists', async () => {
    assert.equal(await getCodexNativeTurnCompletion(sessionId, () => null), 'unknown')
  })
})

type TailWindowOptions = {
  initialWindowBytes?: number
  maxWindowBytes?: number
}

// Recovery fact-checks run on the Electron main thread while a card is already
// stuck, so the read has to stay bounded no matter how long the session grew.
// These tests both forbid whole-file reads and account for every byte the
// classifier actually pulls off disk.
const withNativeReadAccounting = async <T>(
  run: () => Promise<T>,
): Promise<{ value: T; bytesRead: number; wholeFileReadAttempts: number }> => {
  const originalOpen = fs.promises.open
  const originalReadFile = fs.promises.readFile
  let bytesRead = 0
  let wholeFileReadAttempts = 0

  fs.promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args)
    const boundRead = handle.read.bind(handle) as (
      ...readArgs: unknown[]
    ) => Promise<{ bytesRead: number }>
    const patchedRead = async (...readArgs: unknown[]) => {
      const result = await boundRead(...readArgs)
      bytesRead += result.bytesRead
      return result
    }
    Object.defineProperty(handle, 'read', { configurable: true, value: patchedRead })
    return handle
  }) as typeof fs.promises.open

  fs.promises.readFile = (async () => {
    wholeFileReadAttempts += 1
    throw new Error('native turn completion must not read the whole session file')
  }) as typeof fs.promises.readFile

  try {
    const value = await run()
    return { value, bytesRead, wholeFileReadAttempts }
  } finally {
    fs.promises.open = originalOpen
    fs.promises.readFile = originalReadFile
  }
}

describe('bounded native session tail reads', () => {
  const writeTmpFile = (name: string, content: string) => {
    const sourcePath = path.join(tmpDir, name)
    fs.writeFileSync(sourcePath, content, 'utf8')
    return sourcePath
  }

  const claudeFillerLine = (index: number) =>
    JSON.stringify({ type: 'progress', sessionId, index, blob: 'x'.repeat(240) })

  const codexReasoningLine = (index: number) =>
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', index, summary: [{ type: 'summary_text', text: 'y'.repeat(160) }] },
    })

  // A user prompt whose visible text quotes a whole assistant entry: if a window
  // boundary ever cut this line and the fragment were classified, the verdict
  // would flip. It must stay inert.
  const claudeDecoyLine = userPromptEntry(
    `顺手看看 ${JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '假的' }], stop_reason: 'end_turn' },
    })} 这段`,
  )

  const codexDecoyLine = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: `日志里写着 ${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}`,
        },
      ],
    },
  })

  const sweepWindowSizes = async (
    sourcePath: string,
    read: (options: TailWindowOptions) => Promise<NativeTurnCompletion>,
    expected: NativeTurnCompletion,
  ) => {
    const size = fs.statSync(sourcePath).size
    for (let windowBytes = 1; windowBytes <= size + 3; windowBytes += 1) {
      const verdict = await read({ initialWindowBytes: windowBytes, maxWindowBytes: size * 4 + 16 })
      assert.equal(
        verdict,
        expected,
        `a ${windowBytes}B first window over a ${size}B file changed the verdict`,
      )
    }
  }

  it('classifies a large Claude session from its tail without reading the whole file', async () => {
    const filler = Array.from({ length: 800 }, (_, index) => claudeFillerLine(index))
    const sourcePath = writeTmpFile(
      'large-claude.jsonl',
      `${[...filler, ...completedTurnLines].join('\n')}\n`,
    )
    const size = fs.statSync(sourcePath).size
    assert.ok(size > 200 * 1024, `expected a large fixture, got ${size} bytes`)

    const { value, bytesRead, wholeFileReadAttempts } = await withNativeReadAccounting(() =>
      getClaudeNativeTurnCompletion(sessionId, () => sourcePath),
    )

    assert.equal(value, 'completed')
    assert.equal(wholeFileReadAttempts, 0)
    assert.ok(bytesRead < size / 2, `expected a bounded tail read, read ${bytesRead} of ${size} bytes`)
  })

  it('grows the tail window until a far-from-tail Codex task_started is in range', async () => {
    const sourcePath = writeTmpFile(
      'far-marker-codex.jsonl',
      `${[
        codexEvent('task_started', 'turn-2'),
        ...Array.from({ length: 400 }, (_, index) => codexReasoningLine(index)),
      ].join('\n')}\n`,
    )
    const size = fs.statSync(sourcePath).size
    assert.equal(classifyCodexSessionTailCompletion(fs.readFileSync(sourcePath, 'utf8')), 'incomplete')

    const { value, bytesRead, wholeFileReadAttempts } = await withNativeReadAccounting(() =>
      getCodexNativeTurnCompletion(sessionId, () => sourcePath, {
        initialWindowBytes: 1024,
        maxWindowBytes: size * 4,
      }),
    )

    assert.equal(value, 'incomplete')
    assert.equal(wholeFileReadAttempts, 0)
    assert.ok(bytesRead > 1024, `the window must grow past its initial size, read ${bytesRead} bytes`)
  })

  it('stops growing at the configured cap and stays fail-open', async () => {
    const sourcePath = writeTmpFile(
      'capped-codex.jsonl',
      `${[
        codexEvent('task_started', 'turn-2'),
        ...Array.from({ length: 400 }, (_, index) => codexReasoningLine(index)),
      ].join('\n')}\n`,
    )
    const size = fs.statSync(sourcePath).size

    const { value, bytesRead } = await withNativeReadAccounting(() =>
      getCodexNativeTurnCompletion(sessionId, () => sourcePath, {
        initialWindowBytes: 256,
        maxWindowBytes: 1024,
      }),
    )

    assert.equal(value, 'unknown')
    assert.ok(bytesRead < size / 4, `the cap must bound the read, read ${bytesRead} of ${size} bytes`)
  })

  it('reads a file smaller than the first window byte-for-byte like a whole-file read', async () => {
    const content = `${completedTurnLines.join('\n')}\n`
    const sourcePath = writeTmpFile('small-claude.jsonl', content)

    const { value, bytesRead } = await withNativeReadAccounting(() =>
      getClaudeNativeTurnCompletion(sessionId, () => sourcePath),
    )

    assert.equal(value, classifyClaudeSessionTailCompletion(content))
    assert.equal(bytesRead, Buffer.byteLength(content, 'utf8'))
  })

  it('never lets a Claude window boundary cut inside a line change the verdict', async () => {
    const content = `${[
      userPromptEntry('修一下这个 bug'),
      claudeDecoyLine,
      assistantEntry({ blocks: [{ type: 'text', text: '已解决，收工。' }], stopReason: 'end_turn' }),
    ].join('\n')}\n`
    const sourcePath = writeTmpFile('boundary-claude.jsonl', content)
    assert.equal(classifyClaudeSessionTailCompletion(content), 'completed')

    await sweepWindowSizes(
      sourcePath,
      (options) => getClaudeNativeTurnCompletion(sessionId, () => sourcePath, options),
      'completed',
    )
  })

  it('never lets a Codex window boundary cut inside a line change the verdict', async () => {
    const content = `${[
      codexEvent('task_started', 'turn-1'),
      codexDecoyLine,
      codexEvent('task_complete', 'turn-1'),
    ].join('\n')}\n`
    const sourcePath = writeTmpFile('boundary-codex.jsonl', content)
    assert.equal(classifyCodexSessionTailCompletion(content), 'completed')

    await sweepWindowSizes(
      sourcePath,
      (options) => getCodexNativeTurnCompletion(sessionId, () => sourcePath, options),
      'completed',
    )
  })

  it('treats an empty native session file as unknown', async () => {
    const sourcePath = writeTmpFile('empty.jsonl', '')

    assert.equal(await getClaudeNativeTurnCompletion(sessionId, () => sourcePath), 'unknown')
    assert.equal(await getCodexNativeTurnCompletion(sessionId, () => sourcePath), 'unknown')
  })

  it('treats a missing native session file as unknown', async () => {
    const sourcePath = path.join(tmpDir, 'does-not-exist.jsonl')

    assert.equal(await getClaudeNativeTurnCompletion(sessionId, () => sourcePath), 'unknown')
    assert.equal(await getCodexNativeTurnCompletion(sessionId, () => sourcePath), 'unknown')
  })
})
