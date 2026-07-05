import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OllamaManager,
  buildUrgeJudgePrompt,
  parseUrgeJudgeVerdict,
  recommendOllamaModel,
  resolveOllamaBaseUrl,
} from '../server/ollama-manager.ts'

const GB = 1024 ** 3

test('resolveOllamaBaseUrl prefers the env override and falls back to the local default', () => {
  assert.equal(
    resolveOllamaBaseUrl({ CHILL_VIBE_OLLAMA_URL: 'http://127.0.0.1:9999/' } as NodeJS.ProcessEnv),
    'http://127.0.0.1:9999',
  )
  assert.equal(resolveOllamaBaseUrl({} as NodeJS.ProcessEnv), 'http://127.0.0.1:11434')
})

test('recommendOllamaModel scales with total memory', () => {
  assert.equal(recommendOllamaModel(64 * GB).name, 'qwen3:8b')
  assert.equal(recommendOllamaModel(16 * GB).name, 'qwen3:4b')
  assert.equal(recommendOllamaModel(8 * GB).name, 'qwen3:1.7b')
  assert.equal(recommendOllamaModel(64 * GB).totalMemoryGb, 64)
})

test('buildUrgeJudgePrompt embeds the tail of the assistant text', () => {
  const prompt = buildUrgeJudgePrompt('全部测试通过，任务完成。')
  assert.ok(prompt.includes('全部测试通过，任务完成。'))
  assert.ok(prompt.includes('shouldContinue'))

  const long = `${'x'.repeat(9000)}结尾结论`
  const longPrompt = buildUrgeJudgePrompt(long)
  assert.ok(longPrompt.includes('结尾结论'))
  assert.ok(longPrompt.length < 9000)
})

test('buildUrgeJudgePrompt tells the judge that waiting for a user decision means stop', () => {
  const prompt = buildUrgeJudgePrompt('还没提交 git——你要的话说一声"提交"。已解决。')
  // 等待用户拍板（如"要不要提交"）必须优先于"还有未完成事项"判为不催促，
  // 否则会在 agent 明确交还决策权时误鞭策。
  assert.ok(prompt.includes('等待用户'))
  assert.ok(prompt.includes('即使'))
  assert.ok(prompt.includes('优先'))
})

test('parseUrgeJudgeVerdict tolerates fenced JSON and rejects garbage', () => {
  assert.equal(parseUrgeJudgeVerdict('{"shouldContinue": true}'), true)
  assert.equal(parseUrgeJudgeVerdict('```json\n{"shouldContinue": false}\n```'), false)
  assert.equal(parseUrgeJudgeVerdict('前言 {"shouldContinue": false, "reason": "done"} 后记'), false)
  assert.equal(parseUrgeJudgeVerdict('说不清楚'), null)
  assert.equal(parseUrgeJudgeVerdict('{"shouldContinue": "maybe"}'), null)
  assert.equal(parseUrgeJudgeVerdict(''), null)
})

test('OllamaManager.judge posts a structured chat request and parses the verdict', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const manager = new OllamaManager({
    env: {} as NodeJS.ProcessEnv,
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: '{"shouldContinue": false}' } }),
        { status: 200 },
      )
    }) as typeof fetch,
  })

  const verdict = await manager.judge({ model: 'qwen3:4b', text: '已全部完成并验证。' })

  assert.deepEqual(verdict, { ok: true, shouldContinue: false })
  assert.equal(calls.length, 1)
  assert.ok(calls[0]?.url.endsWith('/api/chat'))
  assert.equal(calls[0]?.body.model, 'qwen3:4b')
  assert.equal(calls[0]?.body.stream, false)
  const format = calls[0]?.body.format as { required?: string[] }
  assert.deepEqual(format?.required, ['shouldContinue'])
})

test('OllamaManager.judge reports a failure instead of throwing when Ollama is unreachable', async () => {
  const manager = new OllamaManager({
    env: {} as NodeJS.ProcessEnv,
    fetchImpl: (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as typeof fetch,
  })

  const verdict = await manager.judge({ model: 'qwen3:4b', text: '结论' })

  assert.equal(verdict.ok, false)
  assert.ok(verdict.error)
})
