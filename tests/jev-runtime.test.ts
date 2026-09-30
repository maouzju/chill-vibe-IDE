import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildClaudeArgs } from '../server/providers.ts'
import {
  createJevRuntime,
  getJevInstruction,
  jevMcpServerName,
  mergeClaudeMcpConfigs,
} from '../server/jev-runtime.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'
import type { ChatRequest } from '../shared/schema.ts'

// JEV 与 computer use 同一形态（pitfall #383）：开关打开才注入、fail-open；
// 额外约束是 API key 绝不进命令行 / --mcp-config JSON（那是进程列表和日志里都看得到的地方）。

const createRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: 'claude',
  workspacePath: 'D:/Git/chill-vibe',
  model: 'claude-opus-5',
  reasoningEffort: 'medium',
  thinkingEnabled: true,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: defaultSystemPrompt,
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
  prompt: '筛一下哪些文件有网络请求',
  attachments: [],
  ...overrides,
})

const withKeyDir = async (run: (keyFilePath: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-runtime-'))
  try {
    await run(path.join(dir, 'jev', 'api-key'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('createJevRuntime injects nothing unless the setting is on and a key exists', async () => {
  await withKeyDir(async (keyFilePath) => {
    assert.equal(await createJevRuntime(createRequest(), { loadApiKey: async () => 'sk-or-x', keyFilePath }), null)
    assert.equal(
      await createJevRuntime(createRequest({ jevEnabled: true }), { loadApiKey: async () => '  ', keyFilePath }),
      null,
    )
  })
})

test('createJevRuntime wires the same MCP into both CLIs without putting the key on argv', async () => {
  await withKeyDir(async (keyFilePath) => {
    const runtime = await createJevRuntime(createRequest({ jevEnabled: true, provider: 'codex' }), {
      loadApiKey: async () => 'sk-or-secret-key',
      keyFilePath,
    })
    assert.ok(runtime)

    assert.equal(await readFile(keyFilePath, 'utf8'), 'sk-or-secret-key')
    const argv = runtime.codexRuntimeArgs.join(' ')
    assert.ok(argv.includes(`mcp_servers.${jevMcpServerName}.command=`))
    assert.ok(argv.includes('jev-mcp.js'))
    assert.ok(argv.includes('CHILL_VIBE_JEV_KEY_FILE'))
    assert.ok(!argv.includes('sk-or-secret-key'))

    const claudeJson = JSON.stringify(runtime.claudeMcpConfig)
    assert.ok(claudeJson.includes(jevMcpServerName))
    assert.ok(!claudeJson.includes('sk-or-secret-key'))
    assert.ok(runtime.instruction.includes('tool_search'))
  })
})

test('createJevRuntime forwards the optional JEV request URL without putting the key on argv', async () => {
  await withKeyDir(async (keyFilePath) => {
    const runtime = await createJevRuntime(createRequest({ jevEnabled: true, jevApiUrl: 'https://jev.example.test/v1/systemone' }), {
      loadApiKey: async () => 'ts-key',
      keyFilePath,
    })
    assert.ok(runtime)
    const argv = runtime.codexRuntimeArgs.join(' ')
    assert.ok(argv.includes('CHILL_VIBE_JEV_URL'))
    assert.ok(argv.includes('https://jev.example.test/v1/systemone'))
    assert.ok(!argv.includes('ts-key'))
  })
})

test('buildClaudeArgs carries the JEV server alongside computer use in one --mcp-config', async () => {
  await withKeyDir(async (keyFilePath) => {
    const runtime = await createJevRuntime(createRequest({ jevEnabled: true }), {
      loadApiKey: async () => 'ts-key',
      keyFilePath,
    })
    assert.ok(runtime)
    const merged = mergeClaudeMcpConfigs(
      { mcpServers: { chill_vibe_browser: { command: 'node', args: ['/x/cli.js'], env: {} } } },
      runtime.claudeMcpConfig,
    )
    const args = buildClaudeArgs(createRequest({ jevEnabled: true }), [], { computerUseMcpConfig: merged })
    const index = args.indexOf('--mcp-config')
    assert.notEqual(index, -1)
    const config = JSON.parse(args[index + 1] ?? '{}') as { mcpServers: Record<string, unknown> }
    assert.deepEqual(Object.keys(config.mcpServers).sort(), ['chill_vibe_browser', jevMcpServerName].sort())
    assert.equal(mergeClaudeMcpConfigs(undefined, undefined), undefined)
  })
})

test('getJevInstruction stays to a sentence or two in both languages', () => {
  for (const language of ['zh-CN', 'en'] as const) {
    for (const provider of ['claude', 'codex'] as const) {
      const instruction = getJevInstruction(language, provider)
      assert.ok(instruction.includes('jev_ask'))
      assert.ok(instruction.length < 260, `${language}/${provider} instruction too long: ${instruction.length}`)
    }
  }
})
