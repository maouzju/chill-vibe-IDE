import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { AppLanguage, ChatRequest, Provider } from '../shared/schema.js'
import type { WorkspaceAdminClaudeMcpConfig } from './automation-board-runtime.js'

// 症状：用户让模型"直接 Computer Use 帮我操作"，模型回答"我没有电脑操控工具"——浏览器开关
//   （computer-use-runtime）只管网页，桌面上的其它应用两条 CLI 在 IDE 路径里都碰不到。
// 方案（2026-10-31，docs/specs/desktop-control-toggle）：两条 CLI 注入同一个 Windows-MCP
//   （PyPI windows-mcp，基于 UI Automation，能给出控件编号而不只是截图坐标）。
// 为什么关掉 PowerShell / FileSystem / Process / Registry：CLI 自带的 shell 与文件工具受危险命令
//   防护钩子约束，MCP 里再开一个 PowerShell 就是绕过防护的后门，而且对"操控桌面"没有增量。
export const desktopControlMcpServerName = 'chill_vibe_desktop'
export const desktopControlExcludedTools = ['PowerShell', 'FileSystem', 'Process', 'Registry']

// uvx / `uv tool run` 首次要下载 Python 依赖，Codex 默认 10 秒的 MCP 启动超时会把它当失败。
const codexStartupTimeoutSec = 120

export type DesktopMcpLaunch = {
  command: string
  args: string[]
  env: Record<string, string>
}

export type DesktopControlRuntime = {
  codexRuntimeArgs: string[]
  claudeMcpConfig: WorkspaceAdminClaudeMcpConfig
  instruction: string
}

type ResolveOptions = {
  lookup?: (executable: string) => Promise<string[]>
  exists?: (filePath: string) => Promise<boolean>
  homeDir?: string
  platform?: NodeJS.Platform
}

const formatTomlString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const formatTomlStringArray = (values: string[]) =>
  `[${values.map((value) => formatTomlString(value)).join(', ')}]`

const serveArgs = ['serve', '--transport', 'stdio', '--exclude-tools', desktopControlExcludedTools.join(',')]

const serveEnv = (): Record<string, string> => ({ ANONYMIZED_TELEMETRY: 'false' })

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
 * 定位顺序：已安装的 windows-mcp（`uv tool install windows-mcp`，冷启动最快，trampoline 里是绝对路径，
 * 不受 Codex 隔离 USERPROFILE 影响）→ uvx → `uv tool run`。每一项先查 PATH，再查 uv 的默认安装位置
 * `~/.local/bin`（Electron 从开始菜单启动时 PATH 里常常没有它）。
 */
export const resolveDesktopMcpLaunch = async (
  options: ResolveOptions = {},
): Promise<DesktopMcpLaunch | null> => {
  const lookup = options.lookup ?? defaultLookup
  const exists = options.exists ?? defaultExists
  const homeDir = options.homeDir ?? os.homedir()

  const find = async (name: string) => {
    const onPath = await lookup(name)
    const exe = onPath.find((entry) => entry.toLowerCase().endsWith('.exe')) ?? onPath[0]
    if (exe) {
      return exe
    }
    const local = path.win32.join(homeDir, '.local', 'bin', `${name}.exe`)
    return (await exists(local)) ? local : null
  }

  const candidates: Array<[string, string[]]> = [
    ['windows-mcp', serveArgs],
    ['uvx', ['windows-mcp', ...serveArgs]],
    ['uv', ['tool', 'run', 'windows-mcp', ...serveArgs]],
  ]
  for (const [name, args] of candidates) {
    const command = await find(name)
    if (command) {
      return { command, args: [...args], env: serveEnv() }
    }
  }
  return null
}

const instructionZh = (provider: Provider) =>
  `你可以操控用户的 Windows 桌面（computer use）：名为 ${desktopControlMcpServerName} 的 MCP 提供 Screenshot / Snapshot / Click / Type / Scroll / Move / Shortcut / App / Clipboard / WaitFor 等工具，可以截屏、读窗口与控件、点击、输入、按快捷键、启动或切换应用。`
  + (provider === 'codex' ? `这些工具不会预先列在工具表里，需要先用 tool_search 检索 ${desktopControlMcpServerName} 再调用。` : '')
  + '操作前先 Screenshot 或 Snapshot 看清界面，优先按 Snapshot 给出的控件来点；这是用户正在使用的真实鼠标键盘，用户移动鼠标会抢回控制。涉及登录、支付、删除、发送等不可逆或敏感动作先向用户确认。运行命令、读写文件仍用你自带的工具。不要说自己没有电脑操控工具。'

const instructionEn = (provider: Provider) =>
  `You can operate the user's Windows desktop (computer use): the MCP server named ${desktopControlMcpServerName} exposes Screenshot / Snapshot / Click / Type / Scroll / Move / Shortcut / App / Clipboard / WaitFor and more, so you can capture the screen, read windows and controls, click, type, press shortcuts, and launch or switch apps. `
  + (provider === 'codex' ? `These tools are deferred: call tool_search for ${desktopControlMcpServerName} before using them. ` : '')
  + 'Take a Screenshot or Snapshot before acting and prefer the controls Snapshot reports; this is the user\'s real mouse and keyboard, and moving the mouse hands control back to them. Confirm with the user before sign-in, payment, deletion, sending, or other irreversible or sensitive actions. Keep using your built-in tools for commands and files. Never claim you lack computer-control tools.'

export const getDesktopControlInstruction = (language: AppLanguage, provider: Provider) =>
  language === 'zh-CN' ? instructionZh(provider) : instructionEn(provider)

/**
 * 只对 `request.desktopControlEnabled === true` 的 Windows 回合生效；Windows-MCP 找不到时 fail-open：
 * 留一条 warn、不注入，正常聊天不受影响。
 */
export const createDesktopControlRuntime = async (
  request: ChatRequest,
  deps: ResolveOptions = {},
): Promise<DesktopControlRuntime | null> => {
  if (request.desktopControlEnabled !== true) {
    return null
  }

  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    console.warn('[desktop-control] Desktop control is Windows-only; the turn runs without desktop tools.')
    return null
  }

  const launch = await resolveDesktopMcpLaunch(deps)
  if (!launch) {
    console.warn(
      '[desktop-control] Windows-MCP unavailable: neither windows-mcp (uv tool install windows-mcp), uvx nor uv was found; the turn runs without desktop tools.',
    )
    return null
  }

  const codexRuntimeArgs = [
    '-c',
    `mcp_servers.${desktopControlMcpServerName}.command=${formatTomlString(launch.command)}`,
    '-c',
    `mcp_servers.${desktopControlMcpServerName}.args=${formatTomlStringArray(launch.args)}`,
    '-c',
    `mcp_servers.${desktopControlMcpServerName}.startup_timeout_sec=${codexStartupTimeoutSec}`,
  ]
  for (const [key, value] of Object.entries(launch.env)) {
    codexRuntimeArgs.push('-c', `mcp_servers.${desktopControlMcpServerName}.env.${key}=${formatTomlString(value)}`)
  }

  return {
    codexRuntimeArgs,
    claudeMcpConfig: {
      mcpServers: {
        [desktopControlMcpServerName]: { command: launch.command, args: [...launch.args], env: { ...launch.env } },
      },
    },
    instruction: getDesktopControlInstruction(request.language, request.provider),
  }
}
