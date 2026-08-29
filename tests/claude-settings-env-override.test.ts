import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildClaudeArgs } from '../server/providers.ts'
import { createDefaultState } from '../shared/default-state.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'
import type { ChatRequest } from '../shared/schema.ts'

const createRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: 'claude',
  workspacePath: 'D:/Git/chill-vibe',
  model: 'claude-opus-4-8',
  reasoningEffort: 'medium',
  thinkingEnabled: true,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: defaultSystemPrompt,
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
  prompt: '修复这个问题',
  attachments: [],
  ...overrides,
})

const readSettings = (args: string[]) => {
  const index = args.indexOf('--settings')
  assert.notEqual(index, -1, '--settings 必须存在')
  return JSON.parse(args[index + 1] ?? '{}')
}

// 症状：用户在设置里配好本地模型（或任意自定义 provider 端点），发消息后 CLI 起得来、
//   system/init 也发了，却始终不向配置的端点发请求 —— 本地模型表现为 120s 超时，
//   云端中转表现为拿着 A 站的 key 去打 B 站导致 401 authentication_failed。
// 根因（2026-08-29 用透明代理实测坐实）：`~/.claude/settings.json` 的 `env` 字段
//   优先级高于进程环境变量。resolveProviderRuntime 只把 ANTHROPIC_BASE_URL/API_KEY
//   注入到 spawn 的 env 里，而 `--settings` 这个深合并层从没写过 `env` 键 ——
//   按 lodash mergeWith 语义，省略的键一律从 userSettings 继承，于是用户级 env
//   原封不动地赢下全部注入。代理侧观测：注入 baseUrl 的那次收到 0 个请求。
// 为什么不能改用隔离的 CLAUDE_CONFIG_DIR：那会同时丢掉用户的 CLAUDE.md、skills、
//   MCP 配置，代价远大于收益。--settings 能精确只压 env 这一个键。
test('claude --settings carries the injected env so user-level settings.json cannot override it', () => {
  const args = buildClaudeArgs(createRequest(), [], {
    settingsEnvOverride: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
      ANTHROPIC_API_KEY: 'local',
      ANTHROPIC_AUTH_TOKEN: 'local',
    },
  })

  const settings = readSettings(args)
  assert.equal(settings.env?.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434')
  assert.equal(settings.env?.ANTHROPIC_API_KEY, 'local')
  // AUTH_TOKEN 必须一起覆盖：用户 settings.json 里常驻的是它，只压 API_KEY 会让
  // CLI 拿着用户的云端 token 去打本地端点。
  assert.equal(settings.env?.ANTHROPIC_AUTH_TOKEN, 'local')
})

// 路由关闭 / 无 profile 时 resolveProviderRuntime 返回空注入，此时必须完全不碰
// `env` 键 —— 写一个空对象也不行，那会在合并层把用户自己配的端点擦成未定义。
test('claude --settings omits env entirely when nothing was injected', () => {
  const args = buildClaudeArgs(createRequest(), [], {})
  const settings = readSettings(args)
  assert.equal('env' in settings, false, '未注入时不能出现 env 键')
})

// 上面两条只证明「buildClaudeArgs 收到 settingsEnvOverride 时会正确落到 --settings」，
// 下面那条只证明「resolveProviderRuntime 把注入暴露了出来」—— 中间那截把两者接起来的
// 接线（launchClaudeSingleShotRun / launchClaudeKeepaliveRun 里的
// `settingsEnvOverride: runtime.claudeSettingsEnv`）却没有任何断言看着：把这两行删掉，
// 全套 Node 测试依然 100% 绿，而 120s 超时 / 401 的 bug 会原样回来。
//
// 所以这里钉的是**每一个** buildClaudeArgs 调用点，而不是那两行的字面量：将来新增一条
// 启动路径却忘了透传，同样会红。手法与 tests/updater.test.ts 里
// 「hands the sentinel writer to installUpdate」同构 —— 真实 launcher 需要活的 CLI 进程，
// 只能靠读源码来钉接线。
test('every buildClaudeArgs launch site forwards the runtime env injection', async () => {
  const source = await readFile(new URL('../server/providers.ts', import.meta.url), 'utf8')

  // 提取从 `buildClaudeArgs(` 起、括号配平为止的完整调用表达式，避免固定窗口切歪。
  const extractCall = (startIndex: number) => {
    const open = source.indexOf('(', startIndex)
    let depth = 0

    for (let cursor = open; cursor < source.length; cursor += 1) {
      if (source[cursor] === '(') depth += 1
      else if (source[cursor] === ')') {
        depth -= 1
        if (depth === 0) return source.slice(startIndex, cursor + 1)
      }
    }

    return source.slice(startIndex)
  }

  const callSites = [...source.matchAll(/buildClaudeArgs\(/g)]
    .map((match) => match.index ?? 0)
    // 排除函数自身的定义（`export const buildClaudeArgs = (` 不带这个形状，但保险起见）。
    .filter((index) => !/export const buildClaudeArgs/.test(source.slice(Math.max(0, index - 60), index)))
    .map((index) => ({ index, call: extractCall(index) }))

  assert.ok(
    callSites.length >= 2,
    `预期至少两个 buildClaudeArgs 调用点（单发与 keepalive），实际 ${callSites.length} 个 —— 启动路径可能被重构了，请同步这条断言。`,
  )

  for (const { index, call } of callSites) {
    const line = source.slice(0, index).split('\n').length

    assert.match(
      call,
      /settingsEnvOverride:\s*runtime\.claudeSettingsEnv/,
      `server/providers.ts:${line} 的 buildClaudeArgs 调用没有透传 runtime.claudeSettingsEnv；` +
        `用户 ~/.claude/settings.json 的 env 会重新赢下注入，本地模型回到 120s 超时、中转回到 401。`,
    )
  }
})

test('resolveProviderRuntime exposes the claude env injection for the settings layer', async () => {
  const tmpDir = path.join(
    os.tmpdir(),
    `chill-vibe-settings-env-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await mkdir(tmpDir, { recursive: true })
  process.env.CHILL_VIBE_DATA_DIR = tmpDir

  try {
    const { saveState } = await import('../server/state-store.ts')
    const { resolveProviderRuntime } = await import('../server/providers.ts')
    const state = createDefaultState('')

    state.settings.cliRoutingEnabled = true
    // 关掉弹性代理，否则 baseUrl 会被换成本地代理端口，断言就盯不住真实端点了。
    state.settings.resilientProxyEnabled = false
    state.settings.localModelEntries = [
      {
        id: 'local-1',
        label: 'Ollama qwen',
        harness: 'claude',
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: '',
        model: 'qwen3:0.6b',
      },
    ]
    await saveState(state)

    const runtime = await resolveProviderRuntime('claude', { localModelId: 'local-1' })

    // 既有契约：spawn 的 env 仍然要带（CLI 之外的下游、以及没有 settings.json 的机器靠它）。
    assert.equal(runtime.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434')
    // 新契约：同一份注入必须以结构化形式暴露出来，供 --settings 压制用户级配置。
    assert.equal(runtime.claudeSettingsEnv?.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434')
    assert.equal(runtime.claudeSettingsEnv?.ANTHROPIC_API_KEY, 'local')
    assert.equal(runtime.claudeSettingsEnv?.ANTHROPIC_AUTH_TOKEN, 'local')
  } finally {
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})
