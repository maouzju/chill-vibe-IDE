import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AppLanguage, ChatRequest, Provider } from '../shared/schema.js'
import { getAppDataDir } from './app-paths.js'
import type { WorkspaceAdminClaudeMcpConfig } from './automation-board-runtime.js'
import { jevKeyFileEnvKey, jevRootEnvKey, jevUrlEnvKey } from './jev-mcp.js'
import { loadState } from './state-store.js'

// JEV 快速判断 MCP 的注入（docs/specs/jev-mcp-toggle），形态照 computer-use-runtime（pitfall #383）：
// 只在 `request.jevEnabled === true` 且设置里填了 key 的回合注入，任何失败都 fail-open。
// 为什么 key 走文件不走 env/参数：Claude 的 --mcp-config 与 Codex 的 -c mcp_servers.*.env 都在
//   进程命令行上，任务管理器 / 日志里一眼可见；所以只把 key 文件路径放进 env，MCP 自己去读。
export const jevMcpServerName = 'chill_vibe_jev'

export type JevRuntime = {
  codexRuntimeArgs: string[]
  claudeMcpConfig: WorkspaceAdminClaudeMcpConfig
  instruction: string
}

type JevRuntimeDeps = {
  loadApiKey?: () => Promise<string>
  keyFilePath?: string
}

const formatTomlString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const formatTomlStringArray = (values: string[]) =>
  `[${values.map((value) => formatTomlString(value)).join(', ')}]`

const getJevMcpScriptPath = () => fileURLToPath(new URL('./jev-mcp.js', import.meta.url))

const getDefaultKeyFilePath = () => path.join(getAppDataDir(), 'jev', 'api-key')

const loadApiKeyFromSettings = async () => (await loadState()).settings.jevApiKey ?? ''

const writeKeyFileIfChanged = async (keyFilePath: string, apiKey: string) => {
  const existing = await readFile(keyFilePath, 'utf8').catch(() => null)
  if (existing === apiKey) {
    return
  }
  await mkdir(path.dirname(keyFilePath), { recursive: true })
  await writeFile(keyFilePath, apiKey, { encoding: 'utf8', mode: 0o600 })
}

const instructionZh = (provider: Provider) =>
  `可用 ${jevMcpServerName} 的 jev_ask 工具：对一批文件/文本并发做是否/选择/打分判断（快且便宜），适合先筛再读；不能写内容或计算。`
  + (provider === 'codex' ? `使用前先 tool_search ${jevMcpServerName}。` : '')

const instructionEn = (provider: Provider) =>
  `The ${jevMcpServerName} jev_ask tool gives fast, cheap yes/no, choice and score judgments over many files or texts at once; use it to triage before reading. It cannot write or compute.`
  + (provider === 'codex' ? ` Call tool_search for ${jevMcpServerName} first.` : '')

export const getJevInstruction = (language: AppLanguage, provider: Provider) =>
  language === 'zh-CN' ? instructionZh(provider) : instructionEn(provider)

/** Claude 只有一条 `--mcp-config` 槽位留给可选 MCP：computer use 与 JEV 合并成一份再传。 */
export const mergeClaudeMcpConfigs = (
  ...configs: Array<WorkspaceAdminClaudeMcpConfig | null | undefined>
): WorkspaceAdminClaudeMcpConfig | undefined => {
  const present = configs.filter((config): config is WorkspaceAdminClaudeMcpConfig => Boolean(config))
  if (present.length === 0) {
    return undefined
  }
  return { mcpServers: Object.assign({}, ...present.map((config) => config.mcpServers)) }
}

export const createJevRuntime = async (
  request: ChatRequest,
  deps: JevRuntimeDeps = {},
): Promise<JevRuntime | null> => {
  if (request.jevEnabled !== true) {
    return null
  }

  const apiKey = (await (deps.loadApiKey ?? loadApiKeyFromSettings)()).trim()
  if (!apiKey) {
    console.warn('[jev] JEV is enabled but no API key is set; the turn runs without the jev_ask tool.')
    return null
  }

  const keyFilePath = deps.keyFilePath ?? getDefaultKeyFilePath()
  await writeKeyFileIfChanged(keyFilePath, apiKey)

  const command = process.execPath
  const args = [getJevMcpScriptPath()]
  const env: Record<string, string> = {
    [jevKeyFileEnvKey]: keyFilePath,
    [jevRootEnvKey]: request.workspacePath,
    ...(request.jevApiUrl?.trim() ? { [jevUrlEnvKey]: request.jevApiUrl.trim() } : {}),
  }
  if (process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = '1'
  }

  const codexRuntimeArgs = [
    '-c',
    `mcp_servers.${jevMcpServerName}.command=${formatTomlString(command)}`,
    '-c',
    `mcp_servers.${jevMcpServerName}.args=${formatTomlStringArray(args)}`,
  ]
  for (const [key, value] of Object.entries(env)) {
    codexRuntimeArgs.push('-c', `mcp_servers.${jevMcpServerName}.env.${key}=${formatTomlString(value)}`)
  }

  return {
    codexRuntimeArgs,
    claudeMcpConfig: { mcpServers: { [jevMcpServerName]: { command, args, env } } },
    instruction: getJevInstruction(request.language, request.provider),
  }
}
