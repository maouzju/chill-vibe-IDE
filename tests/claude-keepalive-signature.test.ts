import assert from 'node:assert/strict'
import test from 'node:test'

import { buildClaudeKeepaliveSignature } from '../server/providers.ts'
import type { ChatRequest } from '../shared/schema.ts'

const request = {
  provider: 'claude',
  prompt: 'test',
  workspacePath: process.cwd(),
  attachments: [],
  model: '',
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: '',
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
} satisfies ChatRequest

test('Claude keepalive signature changes with runtime environment and attachment authorization directories', () => {
  const runtime = { args: [], env: { API_KEY: 'first' } }
  const first = buildClaudeKeepaliveSignature(request, true, runtime, ['C:\\images-a\\one.png'])
  const changedEnv = buildClaudeKeepaliveSignature(
    request,
    true,
    { ...runtime, env: { API_KEY: 'second' } },
    ['C:\\images-a\\one.png'],
  )
  const changedAttachmentDirectory = buildClaudeKeepaliveSignature(
    request,
    true,
    runtime,
    ['C:\\images-b\\two.png'],
  )

  assert.notEqual(first, changedEnv)
  assert.notEqual(first, changedAttachmentDirectory)
  assert.equal(
    buildClaudeKeepaliveSignature(
      request,
      true,
      { args: [], env: { SECOND: '2', FIRST: '1' } },
    ),
    buildClaudeKeepaliveSignature(
      request,
      true,
      { args: [], env: { FIRST: '1', SECOND: '2' } },
    ),
  )
})

test('keepalive signature tracks the real --effort argv, not the raw tier', () => {
  const runtime = { args: [], env: {} }
  const sign = (overrides: Partial<ChatRequest>) =>
    buildClaudeKeepaliveSignature({ ...request, ...overrides } as ChatRequest, true, runtime)

  // 关思考(任意档) 与 开思考+low 生成的 argv 逐字节相同（都是 `--effort low`），
  // 所以签名必须也相同。不同会让 acquireForTurn 判定签名不符，把一个还热着、
  // 可能正跑着后台任务的池化子进程 kill 掉，只为用同样的参数重启。见 pitfall #289。
  assert.equal(
    sign({ model: 'claude-opus-4-8', reasoningEffort: 'max', thinkingEnabled: false }),
    sign({ model: 'claude-opus-4-8', reasoningEffort: 'low', thinkingEnabled: true }),
  )

  // 反方向的守卫：ultracode 与普通 xhigh 的 flag 都是 xhigh，只差 `"ultracode": true`
  // 这个 --settings 键，它们绝不能共用同一个池化进程（那才是真正的串档）。
  assert.notEqual(
    sign({ model: 'claude-opus-4-8', reasoningEffort: 'ultracode' }),
    sign({ model: 'claude-opus-4-8', reasoningEffort: 'xhigh' }),
  )

  // auto 省略整个 flag，与任何显式档位都是不同的启动配置。
  assert.notEqual(
    sign({ model: 'claude-opus-4-8', reasoningEffort: 'auto' }),
    sign({ model: 'claude-opus-4-8', reasoningEffort: 'max' }),
  )

  // Fable 5 关不掉思考：auto 与关思考都落在它的 high 默认上，argv 相同 → 签名相同。
  assert.equal(
    sign({ model: 'claude-fable-5', reasoningEffort: 'auto', thinkingEnabled: true }),
    sign({ model: 'claude-fable-5', reasoningEffort: 'high', thinkingEnabled: true }),
  )
})

// 本地模型条目换端点时，keepalive 池必须重启进程：ANTHROPIC_BASE_URL 是 spawn 时定死在
// env 里的，复用旧进程就等于「换了模型但请求还发去上一个端点」。签名已经签了整个
// runtime.env，这条测试守住那个隐式依赖 —— 有人把 runtimeEnv 从签名里摘掉就会红。
test('Claude keepalive signature separates local model entries pointing at different endpoints', () => {
  const localA = {
    args: [],
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_AUTH_TOKEN: 'local' },
  }
  const localB = {
    args: [],
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234', ANTHROPIC_AUTH_TOKEN: 'local' },
  }

  assert.notEqual(
    buildClaudeKeepaliveSignature({ ...request, model: 'qwen3-coder:30b' }, true, localA),
    buildClaudeKeepaliveSignature({ ...request, model: 'qwen3-coder:30b' }, true, localB),
  )

  // 同一个条目内换模型名同样要重启：--model 是启动参数。
  assert.notEqual(
    buildClaudeKeepaliveSignature({ ...request, model: 'qwen3-coder:30b' }, true, localA),
    buildClaudeKeepaliveSignature({ ...request, model: 'qwen3:8b' }, true, localA),
  )
})
