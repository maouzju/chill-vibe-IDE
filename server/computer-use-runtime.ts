import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'

import type { AppLanguage, ChatRequest, Provider } from '../shared/schema.js'
import type { WorkspaceAdminClaudeMcpConfig } from './automation-board-runtime.js'

// 症状：用户在 IDE 里让模型"打开网站登录并复制 key"，模型回答"当前会话没有 Computer Use /
//   浏览器控制工具"。
// 根因（2026-09-21 实测两条 CLI）：
//   · Claude 2.1.263 的 `--chrome` 只在装了 Claude in Chrome 扩展 + native host 时接入工具，
//     本机没装时 `claude -p --chrome` 的 mcp__ 工具表为空。
//   · Codex 0.153.4 的 `features.computer_use` / `browser_use` 默认已是 true，但那是桌面版专属
//     插件（computer-use@openai-bundled，`codex plugin add` 报 not found），exec / app-server
//     的工具表里没有任何 computer 工具，显式 `-c features.computer_use=true` 也是空操作。
// 为什么不能各走原生开关：两边都没有可靠的原生路径，唯一在两条 CLI 上都实测拿到浏览器工具的
//   办法是注入同一个 Playwright MCP（Claude 走 --mcp-config，Codex 走 -c mcp_servers.*）。
//   Claude 这边额外写 `chrome: true`，让装了扩展的用户自动走原生 Claude in Chrome。
export const computerUseMcpServerName = 'chill_vibe_browser'

export type BrowserMcpLaunch = {
  command: string
  args: string[]
  env: Record<string, string>
}

export type ComputerUseRuntime = {
  /** codex：追加到 `codex app-server` argv 的 `-c mcp_servers.*` 组。 */
  codexRuntimeArgs: string[]
  /** claude：合并进 `--mcp-config` 的 JSON 载荷。 */
  claudeMcpConfig: WorkspaceAdminClaudeMcpConfig
  /** 追加到系统提示的一段说明。 */
  instruction: string
}

const formatTomlString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const formatTomlStringArray = (values: string[]) =>
  `[${values.map((value) => formatTomlString(value)).join(', ')}]`

const playwrightMcpShimName = 'mcp-server-playwright'
const playwrightMcpPackagePath = ['@playwright', 'mcp', 'cli.js']

const defaultLookup = async (executable: string): Promise<string[]> =>
  new Promise((resolve) => {
    const tool = process.platform === 'win32' ? 'where.exe' : 'which'
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(tool, [executable], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      resolve([])
      return
    }
    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('close', () => {
      resolve(
        Buffer.concat(chunks)
          .toString('utf8')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      )
    })
    child.on('error', () => resolve([]))
  })

const defaultExists = async (filePath: string) => {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 从 npm 全局 shim 反推 `@playwright/mcp/cli.js`：
 *   win32  `<prefix>/mcp-server-playwright.cmd`    → `<prefix>/node_modules/@playwright/mcp/cli.js`
 *   POSIX  `<prefix>/bin/mcp-server-playwright`     → `<prefix>/lib/node_modules/@playwright/mcp/cli.js`
 * 为什么不直接跑 shim / npx：Codex 隔离 USERPROFILE 后 npx 的缓存目录不可靠，而且 .cmd shim
 * 在 Codex 侧要不要经 shell 启动说不准；绝对 node + cli.js 在两条 CLI 上都实测能起。
 */
const deriveCliCandidates = (shimPath: string, platform: NodeJS.Platform) => {
  // 按目标平台选 path 实现：单测在 Windows 上跑 POSIX 用例时不能把 / 折成 反斜杠。
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const shimDir = pathApi.dirname(shimPath)
  if (platform === 'win32') {
    return [pathApi.join(shimDir, 'node_modules', ...playwrightMcpPackagePath)]
  }
  return [
    pathApi.join(shimDir, '..', 'lib', 'node_modules', ...playwrightMcpPackagePath),
    pathApi.join(shimDir, 'node_modules', ...playwrightMcpPackagePath),
  ]
}

export const resolveBrowserMcpLaunch = async (options: {
  lookup?: (executable: string) => Promise<string[]>
  exists?: (filePath: string) => Promise<boolean>
  execPath?: string
  isElectron?: boolean
  platform?: NodeJS.Platform
} = {}): Promise<BrowserMcpLaunch | null> => {
  const lookup = options.lookup ?? defaultLookup
  const exists = options.exists ?? defaultExists
  const platform = options.platform ?? process.platform
  const execPath = options.execPath ?? process.execPath
  const isElectron = options.isElectron ?? Boolean(process.versions.electron)

  const shims = await lookup(playwrightMcpShimName)
  for (const shim of shims) {
    for (const candidate of deriveCliCandidates(shim, platform)) {
      if (await exists(candidate)) {
        return {
          command: execPath,
          args: [candidate],
          // 与 archive-recall 同一条规则：Electron 主程序当 node 用必须带这个 env。
          env: isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        }
      }
    }
  }

  const npxCandidates = await lookup('npx')
  const npx = npxCandidates.find((entry) => {
    const base = (platform === 'win32' ? path.win32 : path.posix).basename(entry).toLowerCase()
    return platform === 'win32' ? base === 'npx.cmd' || base === 'npx' : base === 'npx'
  }) ?? npxCandidates[0]
  if (npx) {
    return { command: npx, args: ['-y', '@playwright/mcp@latest'], env: {} }
  }

  return null
}

export const buildComputerUseCodexRuntimeArgs = (launch: BrowserMcpLaunch): string[] => {
  const runtimeArgs = [
    '-c',
    `mcp_servers.${computerUseMcpServerName}.command=${formatTomlString(launch.command)}`,
    '-c',
    `mcp_servers.${computerUseMcpServerName}.args=${formatTomlStringArray(launch.args)}`,
  ]
  for (const [key, value] of Object.entries(launch.env)) {
    runtimeArgs.push('-c', `mcp_servers.${computerUseMcpServerName}.env.${key}=${formatTomlString(value)}`)
  }
  return runtimeArgs
}

export const buildComputerUseClaudeMcpConfig = (
  launch: BrowserMcpLaunch,
): WorkspaceAdminClaudeMcpConfig => ({
  mcpServers: {
    [computerUseMcpServerName]: {
      command: launch.command,
      args: [...launch.args],
      env: { ...launch.env },
    },
  },
})

const instructionZh = (provider: Provider) =>
  `你可以使用浏览器（computer use）：名为 ${computerUseMcpServerName} 的 MCP 提供 browser_navigate / browser_snapshot / browser_click / browser_type / browser_fill_form / browser_take_screenshot 等工具，可以替用户打开网页、点击、填表、读取页面状态。`
  + (provider === 'codex'
    ? `这些工具不会预先列在工具表里，需要先用 tool_search 检索 ${computerUseMcpServerName} 再调用。`
    : `如果同时存在 mcp__claude-in-chrome__ 开头的工具，优先用它们（能操作用户已登录的 Chrome 标签页）。`)
  + '操作前先 browser_snapshot 看清页面；涉及登录、支付、删除、发送等不可逆或敏感动作，先向用户确认。不要说自己没有浏览器控制工具。'

const instructionEn = (provider: Provider) =>
  `You can use a browser (computer use): the MCP server named ${computerUseMcpServerName} exposes browser_navigate / browser_snapshot / browser_click / browser_type / browser_fill_form / browser_take_screenshot and more, so you can open pages, click, fill forms, and read page state on the user's behalf. `
  + (provider === 'codex'
    ? `These tools are deferred: call tool_search for ${computerUseMcpServerName} before using them. `
    : 'If tools prefixed mcp__claude-in-chrome__ are also present, prefer them (they drive the user\'s signed-in Chrome tabs). ')
  + 'Take a browser_snapshot before acting; confirm with the user before sign-in, payment, deletion, sending, or other irreversible or sensitive actions. Never claim you lack browser-control tools.'

export const getComputerUseInstruction = (language: AppLanguage, provider: Provider) =>
  language === 'zh-CN' ? instructionZh(provider) : instructionEn(provider)

/**
 * 只对 `request.computerUseEnabled === true` 的回合生效；Playwright MCP 找不到时 fail-open：
 * 留一条 warn、不注入、正常聊天不受影响（模型只是拿不到浏览器工具）。
 */
export const createComputerUseRuntime = async (
  request: ChatRequest,
): Promise<ComputerUseRuntime | null> => {
  if (request.computerUseEnabled !== true) {
    return null
  }

  const launch = await resolveBrowserMcpLaunch()
  if (!launch) {
    console.warn(
      '[computer-use] Browser MCP unavailable: neither a global @playwright/mcp (npm i -g @playwright/mcp) nor npx was found; the turn runs without browser tools.',
    )
    return null
  }

  return {
    codexRuntimeArgs: buildComputerUseCodexRuntimeArgs(launch),
    claudeMcpConfig: buildComputerUseClaudeMcpConfig(launch),
    instruction: getComputerUseInstruction(request.language, request.provider),
  }
}
