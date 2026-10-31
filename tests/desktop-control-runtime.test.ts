import assert from 'node:assert/strict'
import test from 'node:test'

import { buildClaudeArgs } from '../server/providers.ts'
import { buildComputerUseClaudeMcpConfig } from '../server/computer-use-runtime.ts'
import {
  createDesktopControlRuntime,
  desktopControlExcludedTools,
  desktopControlMcpServerName,
  getDesktopControlInstruction,
  resolveDesktopMcpLaunch,
} from '../server/desktop-control-runtime.ts'
import { mergeClaudeMcpConfigs } from '../server/jev-runtime.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'
import type { ChatRequest } from '../shared/schema.ts'

// 2026-10-31（docs/specs/desktop-control-toggle）：两条 CLI 在 IDE 路径里都没有原生桌面 computer use，
// 唯一可行的是注入 Windows-MCP。这里钉住：定位顺序、关掉绕过安全防护的工具、两条 CLI 都拿到同一个 MCP。

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
  prompt: '打开记事本',
  attachments: [],
  ...overrides,
})

const home = 'C:\\Users\\fixture'
const localBin = (name: string) => `${home}\\.local\\bin\\${name}.exe`

const assertServeArgs = (args: string[]) => {
  const serveIndex = args.indexOf('serve')
  assert.notEqual(serveIndex, -1, '必须以 serve 子命令启动')
  assert.deepEqual(args.slice(serveIndex, serveIndex + 3), ['serve', '--transport', 'stdio'])
  const excludeIndex = args.indexOf('--exclude-tools')
  assert.notEqual(excludeIndex, -1, '必须关掉绕过安全防护的工具')
  assert.deepEqual(args[excludeIndex + 1]?.split(','), ['PowerShell', 'FileSystem', 'Process', 'Registry'])
}

test('resolveDesktopMcpLaunch prefers an installed windows-mcp executable', async () => {
  const launch = await resolveDesktopMcpLaunch({
    platform: 'win32',
    homeDir: home,
    lookup: async (executable) =>
      executable === 'windows-mcp'
        ? ['D:\\tools\\windows-mcp.exe']
        : executable === 'uvx'
          ? ['D:\\tools\\uvx.exe']
          : [],
    exists: async () => false,
  })

  assert.ok(launch)
  assert.equal(launch.command, 'D:\\tools\\windows-mcp.exe')
  assert.equal(launch.args[0], 'serve')
  assertServeArgs(launch.args)
  assert.equal(launch.env.ANONYMIZED_TELEMETRY, 'false')
})

test('resolveDesktopMcpLaunch falls back to uvx, then uv tool run', async () => {
  const viaUvx = await resolveDesktopMcpLaunch({
    platform: 'win32',
    homeDir: home,
    lookup: async (executable) => (executable === 'uvx' ? ['D:\\tools\\uvx.exe'] : []),
    exists: async () => false,
  })
  assert.ok(viaUvx)
  assert.equal(viaUvx.command, 'D:\\tools\\uvx.exe')
  assert.equal(viaUvx.args[0], 'windows-mcp')
  assertServeArgs(viaUvx.args)

  const viaUv = await resolveDesktopMcpLaunch({
    platform: 'win32',
    homeDir: home,
    lookup: async (executable) => (executable === 'uv' ? ['D:\\tools\\uv.exe'] : []),
    exists: async () => false,
  })
  assert.ok(viaUv)
  assert.equal(viaUv.command, 'D:\\tools\\uv.exe')
  assert.deepEqual(viaUv.args.slice(0, 3), ['tool', 'run', 'windows-mcp'])
  assertServeArgs(viaUv.args)
})

test('resolveDesktopMcpLaunch checks ~/.local/bin when PATH has nothing', async () => {
  const launch = await resolveDesktopMcpLaunch({
    platform: 'win32',
    homeDir: home,
    lookup: async () => [],
    exists: async (filePath) => filePath === localBin('uv'),
  })
  assert.ok(launch)
  assert.equal(launch.command, localBin('uv'))
})

test('resolveDesktopMcpLaunch returns null when nothing is available', async () => {
  const launch = await resolveDesktopMcpLaunch({
    platform: 'win32',
    homeDir: home,
    lookup: async () => [],
    exists: async () => false,
  })
  assert.equal(launch, null)
})

test('createDesktopControlRuntime is off unless the request opts in, and only on Windows', async () => {
  const deps = {
    platform: 'win32' as const,
    homeDir: home,
    lookup: async (executable: string) => (executable === 'windows-mcp' ? ['D:\\tools\\windows-mcp.exe'] : []),
    exists: async () => false,
  }
  assert.equal(await createDesktopControlRuntime(createRequest(), deps), null)
  assert.equal(
    await createDesktopControlRuntime(createRequest({ desktopControlEnabled: true }), { ...deps, platform: 'darwin' }),
    null,
  )
  assert.ok(await createDesktopControlRuntime(createRequest({ desktopControlEnabled: true }), deps))
})

test('createDesktopControlRuntime emits Codex -c overrides with a long startup timeout and a Claude MCP config', async () => {
  const runtime = await createDesktopControlRuntime(
    createRequest({ provider: 'codex', desktopControlEnabled: true }),
    {
      platform: 'win32',
      homeDir: home,
      lookup: async (executable) => (executable === 'uvx' ? ['C:\\uv\\uvx.exe'] : []),
      exists: async () => false,
    },
  )
  assert.ok(runtime)
  assert.equal(desktopControlMcpServerName, 'chill_vibe_desktop')
  const joined = runtime.codexRuntimeArgs.join(' ')
  assert.ok(joined.includes(`mcp_servers.${desktopControlMcpServerName}.command="C:\\\\uv\\\\uvx.exe"`))
  assert.ok(joined.includes(`mcp_servers.${desktopControlMcpServerName}.args=["windows-mcp", "serve"`))
  assert.ok(joined.includes(`mcp_servers.${desktopControlMcpServerName}.env.ANONYMIZED_TELEMETRY="false"`))
  assert.ok(joined.includes(`mcp_servers.${desktopControlMcpServerName}.startup_timeout_sec=120`))

  const server = runtime.claudeMcpConfig.mcpServers[desktopControlMcpServerName] as {
    command: string
    args: string[]
    env: Record<string, string>
  }
  assert.equal(server.command, 'C:\\uv\\uvx.exe')
  assertServeArgs(server.args)
  assert.deepEqual(desktopControlExcludedTools, ['PowerShell', 'FileSystem', 'Process', 'Registry'])
})

test('Claude --mcp-config carries both browser and desktop servers when both toggles are on', async () => {
  const desktop = await createDesktopControlRuntime(createRequest({ desktopControlEnabled: true }), {
    platform: 'win32',
    homeDir: home,
    lookup: async (executable) => (executable === 'windows-mcp' ? ['D:\\tools\\windows-mcp.exe'] : []),
    exists: async () => false,
  })
  assert.ok(desktop)
  const merged = mergeClaudeMcpConfigs(
    buildComputerUseClaudeMcpConfig({ command: 'C:\\node\\node.exe', args: ['C:\\x\\cli.js'], env: {} }),
    desktop.claudeMcpConfig,
  )
  const args = buildClaudeArgs(createRequest({ computerUseEnabled: true, desktopControlEnabled: true }), [], {
    computerUseMcpConfig: merged,
  })
  const index = args.indexOf('--mcp-config')
  assert.notEqual(index, -1)
  const config = JSON.parse(args[index + 1] ?? '{}') as { mcpServers: Record<string, unknown> }
  assert.ok('chill_vibe_browser' in config.mcpServers)
  assert.ok(desktopControlMcpServerName in config.mcpServers)
})

test('getDesktopControlInstruction names the MCP server in both languages and tells Codex to tool_search', () => {
  for (const language of ['zh-CN', 'en'] as const) {
    const claude = getDesktopControlInstruction(language, 'claude')
    const codex = getDesktopControlInstruction(language, 'codex')
    assert.ok(claude.includes(desktopControlMcpServerName))
    assert.ok(codex.includes(desktopControlMcpServerName))
    assert.ok(codex.includes('tool_search'))
    assert.ok(!claude.includes('tool_search'))
  }
})

test('createDesktopControlRuntime is skipped on read-only and plan-mode turns', async () => {
  for (const overrides of [{ readOnly: true }, { planMode: true }] as const) {
    const runtime = await createDesktopControlRuntime(
      createRequest({ desktopControlEnabled: true, ...overrides }),
      { platform: 'win32', homeDir: home, lookup: async () => ['windows-mcp'], exists: async () => true },
    )
    assert.equal(runtime, null)
  }
})
