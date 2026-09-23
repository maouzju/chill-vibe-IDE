import assert from 'node:assert/strict'
import test from 'node:test'

import { buildClaudeArgs } from '../server/providers.ts'
import {
  buildComputerUseClaudeMcpConfig,
  buildComputerUseCodexRuntimeArgs,
  computerUseMcpServerName,
  getComputerUseInstruction,
  resolveBrowserMcpLaunch,
} from '../server/computer-use-runtime.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'
import type { ChatRequest } from '../shared/schema.ts'

// 2026-09-21 实测（见 docs/specs/computer-use-toggle/requirements.md 背景）：
// - Claude 2.1.263 没装 Claude in Chrome 扩展时 `--chrome` 什么工具都不给；经 --mcp-config
//   注入 @playwright/mcp 后工具表立刻出现 mcp__chill_vibe_browser__browser_navigate 等。
// - Codex 0.153.4 的 features.computer_use=true 是空操作（桌面版专属插件）；经
//   -c mcp_servers.chill_vibe_browser.* 注入后 tool_search 来源里出现 chill_vibe_browser。
// 所以这里钉的是"两条 CLI 都能拿到同一个 MCP"，而不是各自的原生开关。

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
  prompt: '打开网站看看',
  attachments: [],
  ...overrides,
})

const readSettings = (args: string[]) => {
  const index = args.indexOf('--settings')
  assert.notEqual(index, -1, '--settings 必须存在')
  return JSON.parse(args[index + 1] ?? '{}')
}

const readMcpConfig = (args: string[]) => {
  const index = args.indexOf('--mcp-config')
  if (index === -1) return null
  return JSON.parse(args[index + 1] ?? '{}') as { mcpServers: Record<string, unknown> }
}

const win32Shim = 'C:\\fixture-home\\npm\\mcp-server-playwright.cmd'
const win32Cli = 'C:\\fixture-home\\npm\\node_modules\\@playwright\\mcp\\cli.js'

test('resolveBrowserMcpLaunch prefers the globally installed @playwright/mcp cli.js on win32', async () => {
  const launch = await resolveBrowserMcpLaunch({
    platform: 'win32',
    execPath: 'D:\\apps\\Chill Vibe\\Chill Vibe.exe',
    isElectron: true,
    lookup: async (executable) => (executable === 'mcp-server-playwright' ? [win32Shim] : []),
    exists: async (filePath) => filePath === win32Cli,
  })

  assert.ok(launch, '应当解析出启动方式')
  assert.equal(launch.command, 'D:\\apps\\Chill Vibe\\Chill Vibe.exe')
  assert.equal(launch.args[0], win32Cli)
  // 与 archive-recall 同一条规则：Electron 主程序当 node 用必须带这个 env，否则会再开一个窗口。
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1')
})

test('resolveBrowserMcpLaunch derives the POSIX cli.js path from the bin symlink prefix', async () => {
  const launch = await resolveBrowserMcpLaunch({
    platform: 'linux',
    execPath: '/usr/bin/node',
    isElectron: false,
    lookup: async (executable) =>
      executable === 'mcp-server-playwright' ? ['/usr/local/bin/mcp-server-playwright'] : [],
    exists: async (filePath) => filePath === '/usr/local/lib/node_modules/@playwright/mcp/cli.js',
  })

  assert.ok(launch)
  assert.equal(launch.command, '/usr/bin/node')
  assert.equal(launch.args[0], '/usr/local/lib/node_modules/@playwright/mcp/cli.js')
  assert.equal('ELECTRON_RUN_AS_NODE' in launch.env, false)
})

test('resolveBrowserMcpLaunch falls back to npx when @playwright/mcp is not installed globally', async () => {
  const launch = await resolveBrowserMcpLaunch({
    platform: 'win32',
    execPath: 'C:\\node\\node.exe',
    isElectron: false,
    lookup: async (executable) => (executable === 'npx' ? ['C:\\node\\npx.cmd'] : []),
    exists: async () => false,
  })

  assert.ok(launch)
  assert.equal(launch.command, 'C:\\node\\npx.cmd')
  assert.deepEqual(launch.args.slice(0, 2), ['-y', '@playwright/mcp@latest'])
})

test('resolveBrowserMcpLaunch returns null when neither @playwright/mcp nor npx can be found', async () => {
  const launch = await resolveBrowserMcpLaunch({
    platform: 'win32',
    lookup: async () => [],
    exists: async () => false,
  })
  assert.equal(launch, null)
})

test('buildComputerUseCodexRuntimeArgs emits -c mcp_servers.chill_vibe_browser.* overrides', () => {
  const args = buildComputerUseCodexRuntimeArgs({
    command: 'C:\\node\\node.exe',
    args: [win32Cli],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })

  assert.equal(computerUseMcpServerName, 'chill_vibe_browser')
  const joined = args.join('\n')
  assert.match(joined, /^-c$/m)
  assert.ok(joined.includes(`mcp_servers.${computerUseMcpServerName}.command="C:\\\\node\\\\node.exe"`))
  assert.ok(joined.includes(`mcp_servers.${computerUseMcpServerName}.args=["`))
  assert.ok(joined.includes(`mcp_servers.${computerUseMcpServerName}.env.ELECTRON_RUN_AS_NODE="1"`))
})

test('buildComputerUseClaudeMcpConfig wraps the launch under mcpServers.chill_vibe_browser', () => {
  const config = buildComputerUseClaudeMcpConfig({
    command: '/usr/bin/node',
    args: ['/x/cli.js'],
    env: {},
  })
  assert.deepEqual(config, {
    mcpServers: {
      [computerUseMcpServerName]: { command: '/usr/bin/node', args: ['/x/cli.js'], env: {} },
    },
  })
})

test('claude args carry chrome:true and the browser MCP when computer use is enabled', () => {
  const args = buildClaudeArgs(createRequest({ computerUseEnabled: true }), [], {
    computerUseMcpConfig: buildComputerUseClaudeMcpConfig({
      command: '/usr/bin/node',
      args: ['/x/cli.js'],
      env: {},
    }),
  })

  assert.equal(readSettings(args).chrome, true)
  const mcp = readMcpConfig(args)
  assert.ok(mcp, '开关打开时必须有 --mcp-config')
  assert.ok(computerUseMcpServerName in mcp.mcpServers)
  // 没有超管配置就不能 strict：strict 会把用户自己 settings.json 里的 MCP 全部丢掉。
  assert.equal(args.includes('--strict-mcp-config'), false)
})

test('claude args merge the browser MCP into the same --mcp-config as the workspace admin MCP', () => {
  const args = buildClaudeArgs(createRequest({ computerUseEnabled: true }), [], {
    workspaceAdminMcpConfig: {
      mcpServers: {
        chill_vibe_workspace: { command: '/usr/bin/node', args: ['/admin.js'], env: {} },
      },
    },
    computerUseMcpConfig: buildComputerUseClaudeMcpConfig({
      command: '/usr/bin/node',
      args: ['/x/cli.js'],
      env: {},
    }),
  })

  const occurrences = args.filter((arg) => arg === '--mcp-config').length
  assert.equal(occurrences, 1, '--mcp-config 只能出现一次，两个 server 合并进同一个 JSON')
  const mcp = readMcpConfig(args)
  assert.ok(mcp)
  assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['chill_vibe_browser', 'chill_vibe_workspace'])
  assert.equal(args.includes('--strict-mcp-config'), true)
})

test('claude args leave the chrome key and --mcp-config out when computer use is off', () => {
  const args = buildClaudeArgs(createRequest(), [], {})
  assert.equal('chrome' in readSettings(args), false, '关闭时不能写 chrome 键（省略才是继承用户配置）')
  assert.equal(readMcpConfig(args), null)
})

test('getComputerUseInstruction names the MCP server in both languages and tells Codex to tool_search', () => {
  for (const language of ['zh-CN', 'en'] as const) {
    const claude = getComputerUseInstruction(language, 'claude')
    const codex = getComputerUseInstruction(language, 'codex')
    assert.ok(claude.includes(computerUseMcpServerName))
    assert.ok(codex.includes(computerUseMcpServerName))
    assert.ok(codex.includes('tool_search'))
  }
})
