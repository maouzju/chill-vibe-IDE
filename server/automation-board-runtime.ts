import { fileURLToPath } from 'node:url'

import type { AppLanguage } from '../shared/schema.js'

export const automationBoardMcpServerName = 'chill_vibe_board'
export const automationBoardMcpUrlEnvKey = 'CHILL_VIBE_BOARD_MCP_URL'
export const automationBoardMcpTokenEnvKey = 'CHILL_VIBE_BOARD_MCP_TOKEN'
export const automationBoardMcpBoardIdEnvKey = 'CHILL_VIBE_BOARD_MCP_BOARD_ID'

export type AutomationBoardMcpLaunchInput = {
  /** Loopback bridge base URL, e.g. http://127.0.0.1:54321 */
  url: string
  token: string
  boardCardId: string
  /** Absolute path to automation-board-mcp.js. */
  scriptPath: string
  /** Node/Electron executable that will run the script. */
  execPath: string
  /** True on the Electron host, where the exec path needs ELECTRON_RUN_AS_NODE. */
  isElectron: boolean
}

// 与 archive-recall.ts 的同名私有 helper 行为一致（那两个不导出，所以复制而
// 不是 import）：codex 的 `-c key=value` 值就是一段 TOML 字面量，Windows 路径
// 里的反斜杠必须转义，否则 `D:\Git\...\mcp.js` 的 \G 会被 TOML 解析器吃掉。
const formatTomlString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const formatTomlStringArray = (values: string[]) =>
  `[${values.map((value) => formatTomlString(value)).join(', ')}]`

export const getAutomationBoardMcpScriptPath = () =>
  fileURLToPath(new URL('./automation-board-mcp.js', import.meta.url))

const buildAutomationBoardMcpEnv = ({
  url,
  token,
  boardCardId,
  isElectron,
}: Pick<AutomationBoardMcpLaunchInput, 'url' | 'token' | 'boardCardId' | 'isElectron'>) => {
  const envEntries: Record<string, string> = {
    [automationBoardMcpUrlEnvKey]: url,
    [automationBoardMcpTokenEnvKey]: token,
    [automationBoardMcpBoardIdEnvKey]: boardCardId,
  }

  if (isElectron) {
    envEntries.ELECTRON_RUN_AS_NODE = '1'
  }

  return envEntries
}

export const buildAutomationBoardCodexRuntimeArgs = ({
  url,
  token,
  boardCardId,
  scriptPath,
  execPath,
  isElectron,
}: AutomationBoardMcpLaunchInput): string[] => {
  const runtimeArgs = [
    '-c',
    `mcp_servers.${automationBoardMcpServerName}.command=${formatTomlString(execPath)}`,
    '-c',
    `mcp_servers.${automationBoardMcpServerName}.args=${formatTomlStringArray([scriptPath])}`,
  ]

  const envEntries = buildAutomationBoardMcpEnv({ url, token, boardCardId, isElectron })
  for (const [key, value] of Object.entries(envEntries)) {
    runtimeArgs.push(
      '-c',
      `mcp_servers.${automationBoardMcpServerName}.env.${key}=${formatTomlString(value)}`,
    )
  }

  return runtimeArgs
}

export type AutomationBoardClaudeMcpConfig = {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
}

export const buildAutomationBoardClaudeMcpConfig = ({
  url,
  token,
  boardCardId,
  scriptPath,
  execPath,
  isElectron,
}: AutomationBoardMcpLaunchInput): AutomationBoardClaudeMcpConfig => ({
  mcpServers: {
    [automationBoardMcpServerName]: {
      command: execPath,
      args: [scriptPath],
      env: buildAutomationBoardMcpEnv({ url, token, boardCardId, isElectron }),
    },
  },
})

const supervisorInstructionZh =
  '你是这个工作区自动化看板的监工。看板有三条泳道：standby（待办）、running（正在执行）、done（已完成），'
  + '每一项都是一个独立的需求，由它自己的 agent 在自己的会话里执行。'
  + `你有 5 个 ${automationBoardMcpServerName} MCP 工具：`
  + 'list_board_items 列出全部需求（含原始需求原文、所在泳道、运行状态、已静默多少分钟）；'
  + 'read_board_item 读某一项最近的转录，用来判断它到底交付了没有；'
  + 'move_board_item 把某项换道（移到 running 会开始执行，移到 standby/done 会中断执行）；'
  + 'send_board_item_message 把一句话发进那个需求自己的聊天里 —— 这就是"鞭策"，'
  + '消息会像用户亲自输入一样出现在那张卡的对话里；'
  + 'set_board_item_wake_timer 给某项挂计划唤醒（mode=duration 就是"过 N 分钟再回来看"）。'
  + '工作方式：先 list_board_items 看全局，需要细看再 read_board_item。'
  + '如果一个 agent 正在等子任务或等别人先完成，优先用 set_board_item_wake_timer 过一会儿再看，不要现在就催；'
  + '只有确实长时间没下文（例如超过半小时）才用 send_board_item_message 鞭策它继续做。'
  + '确认某个需求真的交付完了，就用 move_board_item 把它移到 done。'
  + '写工具返回的只是"命令已投递"，不代表已生效 —— 要确认结果就再调一次 list_board_items。'
  + '不要替这些 agent 自己动手改代码，你的职责是检查、鞭策和调度。'

const supervisorInstructionEn =
  'You are the supervisor of this workspace\'s automation board. The board has three lanes: standby, running, and done. '
  + 'Each board item is a separate requirement executed by its own agent in its own chat session. '
  + `You have 5 ${automationBoardMcpServerName} MCP tools: `
  + 'list_board_items lists every requirement (original requirement text, lane, run status, how many minutes it has been silent); '
  + 'read_board_item reads one item\'s recent transcript so you can judge whether it actually delivered; '
  + 'move_board_item changes an item\'s lane (moving to running starts execution, moving to standby/done interrupts it); '
  + 'send_board_item_message posts a message into that requirement\'s own chat — this is what "鞭策" (nudging) means here, '
  + 'and the message appears in that card\'s conversation exactly as if the user had typed it; '
  + 'set_board_item_wake_timer arms a wake timer on an item (mode=duration means "check back after N minutes"). '
  + 'How to work: start with list_board_items, then read_board_item when you need detail. '
  + 'If an agent is legitimately waiting on sub-tasks or on another agent, prefer set_board_item_wake_timer to check back later instead of nagging it now; '
  + 'only use send_board_item_message when an item has genuinely gone quiet for a long time (for example more than half an hour). '
  + 'When a requirement has genuinely been delivered, move it to done with move_board_item. '
  + 'Write tools only report that the command was delivered, not that it took effect — call list_board_items again to confirm. '
  + 'Do not do these agents\' coding work yourself; your job is to inspect, nudge, and schedule.'

export const getAutomationBoardSupervisorInstruction = (language: AppLanguage) =>
  language === 'en' ? supervisorInstructionEn : supervisorInstructionZh
