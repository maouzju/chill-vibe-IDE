import process from 'node:process'

import {
  automationBoardMirrorEntryLimit,
  automationBoardMirrorEntryMaxChars,
  automationBoardMirrorPreviewMaxChars,
  automationBoardMirrorRequirementMaxChars,
  type AutomationBoardCommand,
  type AutomationBoardMirror,
  type ChatRequest,
} from '../shared/schema.js'
import {
  createAutomationBoardBridge,
  type AutomationBoardBridge,
  type AutomationBoardBridgeRuntimeInfo,
  type AutomationBoardTranscriptEntry,
} from './automation-board-bridge.js'
import {
  buildAutomationBoardClaudeMcpConfig,
  buildAutomationBoardCodexRuntimeArgs,
  getAutomationBoardMcpScriptPath,
  getAutomationBoardSupervisorInstruction,
  type AutomationBoardClaudeMcpConfig,
} from './automation-board-runtime.js'

/**
 * 看板监工运行时的进程内状态。
 *
 * 三条刻意的设计约束：
 *  1. **懒启动**：桥接的 HTTP 监听只在第一次真正有监工回合时才创建，普通用户
 *     从不开自动触发就永远不会多出一个监听端口（照 pitfall 77/79 的教训，
 *     任何在 import 期就动手的单例都会绕过 Electron 的运行时环境准备）。
 *  2. **镜像截断只在这一处**：requirement / preview / 转录条目的字符与条数预算
 *     都在 publish 里执行，任何调用方都无法绕过它把整段转录推给模型。
 *  3. **桥接自身绝不改 state**：写命令一律经 dispatcher 转发给渲染进程复用
 *     电脑端 handler —— 与手机监工同一条规矩。
 */
const mirrors = new Map<string, AutomationBoardMirror>()

let bridge: AutomationBoardBridge | null = null
let bridgeStartup: Promise<AutomationBoardBridgeRuntimeInfo> | null = null
let commandDispatcher: ((command: AutomationBoardCommand) => boolean) | null = null

export const setAutomationBoardCommandDispatcher = (
  dispatcher: ((command: AutomationBoardCommand) => boolean) | null,
) => {
  commandDispatcher = dispatcher
}

const truncate = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`

export const publishAutomationBoardMirror = (mirror: AutomationBoardMirror) => {
  mirrors.set(mirror.boardCardId, {
    ...mirror,
    items: mirror.items.map((item) => ({
      ...item,
      requirement: truncate(item.requirement, automationBoardMirrorRequirementMaxChars),
      lastMessagePreview: truncate(item.lastMessagePreview, automationBoardMirrorPreviewMaxChars),
      recentEntries: item.recentEntries
        .slice(-automationBoardMirrorEntryLimit)
        .map((entry) => ({
          ...entry,
          content: truncate(entry.content, automationBoardMirrorEntryMaxChars),
        })),
    })),
  })
}

export const forgetAutomationBoardMirror = (boardCardId: string) => {
  mirrors.delete(boardCardId)
}

export const readAutomationBoardMirror = (boardCardId: string): AutomationBoardMirror | null =>
  mirrors.get(boardCardId) ?? null

const readAutomationBoardItemTranscript = async (
  cardId: string,
  limit: number,
): Promise<AutomationBoardTranscriptEntry[] | null> => {
  for (const mirror of mirrors.values()) {
    const item = mirror.items.find((entry) => entry.cardId === cardId)
    if (item) {
      return item.recentEntries.slice(-limit)
    }

    if (mirror.supervisorCardId === cardId) {
      // 监工自己不是 item，读它没有意义，但也不该报 404 让模型困惑。
      return []
    }
  }

  return null
}

const ensureAutomationBoardBridge = async (): Promise<AutomationBoardBridgeRuntimeInfo> => {
  if (!bridge) {
    bridge = createAutomationBoardBridge({
      readBoardMirror: readAutomationBoardMirror,
      readItemTranscript: readAutomationBoardItemTranscript,
      dispatchCommand: (command) => commandDispatcher?.(command) ?? false,
    })
  }

  bridgeStartup ??= bridge.start()

  try {
    return await bridgeStartup
  } catch (error) {
    // 启动失败不能把失败的 promise 永久缓存住，否则一次瞬时的端口问题会让
    // 之后每次监工回合都直接复用同一个 rejection。
    bridgeStartup = null
    throw error
  }
}

export const stopAutomationBoardBridge = async () => {
  const current = bridge
  bridge = null
  bridgeStartup = null
  mirrors.clear()
  await current?.stop()
}

export type AutomationBoardSupervisorRuntime = {
  /** codex：追加到 `codex app-server` argv 的 `-c mcp_servers.*` 组。 */
  codexRuntimeArgs: string[]
  /** claude：`--mcp-config` 的 JSON 载荷。 */
  claudeMcpConfig: AutomationBoardClaudeMcpConfig
  /** 追加到系统提示的一段说明（工具怎么用、"鞭策"是什么意思）。 */
  instruction: string
}

/**
 * 只对标记了 `automationBoardSupervisor` 的回合生效 —— 普通聊天卡永远拿不到
 * 看板工具，这是权限边界，不只是优化。
 */
export const createAutomationBoardSupervisorRuntime = async (
  request: ChatRequest,
): Promise<AutomationBoardSupervisorRuntime | null> => {
  const supervisor = request.automationBoardSupervisor
  if (!supervisor) {
    return null
  }

  const runtimeInfo = await ensureAutomationBoardBridge()
  const launch = {
    url: runtimeInfo.url,
    token: runtimeInfo.token,
    boardCardId: supervisor.boardCardId,
    scriptPath: getAutomationBoardMcpScriptPath(),
    execPath: process.execPath,
    isElectron: Boolean(process.versions.electron),
  }

  return {
    codexRuntimeArgs: buildAutomationBoardCodexRuntimeArgs(launch),
    claudeMcpConfig: buildAutomationBoardClaudeMcpConfig(launch),
    instruction: getAutomationBoardSupervisorInstruction(request.language),
  }
}
