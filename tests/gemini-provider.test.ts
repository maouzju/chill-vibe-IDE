import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeAppSettings } from '../shared/default-state.ts'
import { getProviderLabel } from '../shared/i18n.ts'
import {
  DEFAULT_GEMINI_MODEL,
  getDefaultModel,
  getModelOptions,
  isModelPickerOptionVisible,
  resolveSlashModel,
} from '../shared/models.ts'
import { appSettingsSchema } from '../shared/schema.ts'
import { buildGeminiArgs, createGeminiStreamParser } from '../server/gemini-runtime.ts'

const baseRequest = {
  provider: 'gemini' as const,
  workspacePath: 'D:/tmp',
  model: 'gemini-3.8-flash',
  prompt: 'hello',
  systemPrompt: '',
  attachments: [],
  language: 'zh-CN' as const,
}

const createSink = () => {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    sink: {
      onSession: (sessionId: string) => calls.push(['session', sessionId]),
      onDelta: (content: string) => calls.push(['delta', content]),
      onLog: (message: string) => calls.push(['log', message]),
      onAssistantMessage: (message: unknown) => calls.push(['assistant', message]),
      onActivity: (activity: unknown) => calls.push(['activity', activity]),
      onDone: (payload?: unknown) => calls.push(['done', payload]),
      onError: (message: string) => calls.push(['error', message]),
    },
  }
}

describe('gemini provider catalog', () => {
  it('lists the latest Gemini models in the picker and defaults to 3.8 Flash', () => {
    const visible = getModelOptions('gemini')
      .filter((option) => isModelPickerOptionVisible(option) && option.model)
      .map((option) => option.model)
    assert.deepEqual(visible, [
      'gemini-4-argon',
      'gemini-3.1-pro-preview',
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
    ])
    assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.8-flash')
    assert.equal(getDefaultModel('gemini'), 'gemini-3.8-flash')
    assert.equal(resolveSlashModel('gemini', 'argon'), 'gemini-4-argon')
    assert.equal(resolveSlashModel('gemini', 'flash'), 'gemini-3.8-flash')
    assert.equal(getProviderLabel('en', 'gemini'), 'Gemini')
  })

  it('upgrades saved settings without a gemini key', () => {
    const legacy = appSettingsSchema.parse({
      requestModels: { codex: 'gpt-6.1-sol', claude: 'claude-opus-5-5' },
    })
    assert.equal(legacy.requestModels.gemini, DEFAULT_GEMINI_MODEL)
    const normalized = normalizeAppSettings({
      requestModels: { codex: 'gpt-6.1-sol', claude: 'claude-opus-5-5' } as never,
    })
    assert.equal(normalized.requestModels.gemini, DEFAULT_GEMINI_MODEL)
    assert.ok(normalized.providerProfiles.gemini)
  })
})

describe('gemini runtime', () => {
  it('builds headless stream-json args with model and resume', () => {
    assert.deepEqual(buildGeminiArgs({ ...baseRequest, sessionId: 'abc-123' }), [
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
      '--model',
      'gemini-3.8-flash',
      '--resume',
      'abc-123',
    ])
    assert.deepEqual(buildGeminiArgs({ ...baseRequest, model: '' }), [
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
    ])
  })

  it('maps stream-json events to sink calls', () => {
    const { calls, sink } = createSink()
    const parser = createGeminiStreamParser(sink)
    parser.handleLine(JSON.stringify({ type: 'init', session_id: 's-1', model: 'gemini-3.8-flash' }))
    parser.handleLine(JSON.stringify({ type: 'message', role: 'user', content: 'hello' }))
    parser.handleLine(JSON.stringify({ type: 'message', role: 'assistant', content: 'Hi', delta: true }))
    parser.handleLine(
      JSON.stringify({ type: 'tool_use', tool_name: 'run_shell_command', tool_id: 't1', parameters: { command: 'ls' } }),
    )
    parser.handleLine(JSON.stringify({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'a.txt' }))
    parser.handleLine('not json')
    parser.handleLine(
      JSON.stringify({
        type: 'result',
        status: 'success',
        stats: { total_tokens: 30, input_tokens: 20, output_tokens: 10, cached: 5, input: 15, duration_ms: 1, tool_calls: 1, models: {} },
      }),
    )

    assert.deepEqual(calls[0], ['session', 's-1'])
    assert.deepEqual(calls[1], ['delta', 'Hi'])
    assert.deepEqual(calls[2], [
      'activity',
      { itemId: 't1', kind: 'command', status: 'in_progress', command: 'ls', output: '', exitCode: null },
    ])
    assert.deepEqual(calls[3], [
      'activity',
      { itemId: 't1', kind: 'command', status: 'completed', command: 'ls', output: 'a.txt', exitCode: 0 },
    ])
    const done = calls.find(([kind]) => kind === 'done')
    assert.ok(done)
    assert.deepEqual((done[1] as { usage: unknown }).usage, {
      used: 20,
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 5,
    })
    assert.equal(parser.settled(), true)
  })

  it('reports a result error and an unexpected exit', () => {
    const failed = createSink()
    const parser = createGeminiStreamParser(failed.sink)
    parser.handleLine(JSON.stringify({ type: 'result', status: 'error', error: { type: 'Auth', message: 'no key' } }))
    assert.deepEqual(failed.calls.at(-1), ['error', 'no key'])

    const crashed = createSink()
    const crashParser = createGeminiStreamParser(crashed.sink)
    crashParser.handleStderrLine('Please set an Auth method')
    crashParser.handleProcessClosed(1)
    assert.equal(crashed.calls.at(-1)?.[0], 'error')
    assert.match(String(crashed.calls.at(-1)?.[1]), /Auth method/)
  })

  // 2026-10-14 真机：假 key 时 result.error.message 是两层转义的 API JSON，原样上屏用户看不懂。
  it('unwraps the nested API error JSON into the real message', () => {
    const inner = JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }, null, 2)
    const wrapped = `[API Error: ${JSON.stringify({ error: { message: inner, code: 400, status: 'Bad Request' } })}]`
    const failed = createSink()
    const parser = createGeminiStreamParser(failed.sink)
    parser.handleLine(JSON.stringify({ type: 'result', status: 'error', error: { type: 'Error', message: wrapped } }))
    assert.deepEqual(failed.calls.at(-1), ['error', 'API key not valid. Please pass a valid API key. (400 INVALID_ARGUMENT)'])
  })

  it('prefers the API message line over stack traces on a crash exit', () => {
    const crashed = createSink()
    const parser = createGeminiStreamParser(crashed.sink)
    parser.handleStderrLine('Error when talking to Gemini API Full report available at: <workspace>/error.json ApiError: {"error":{"message":"quota exceeded"}}')
    parser.handleStderrLine('    at throwErrorIfNotOK (file:///x/index.mjs:1:1)')
    parser.handleStderrLine('    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)')
    parser.handleProcessClosed(1)
    assert.deepEqual(crashed.calls.at(-1), ['error', 'quota exceeded'])
  })
})
